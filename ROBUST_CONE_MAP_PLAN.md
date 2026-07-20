# Robust Cone Step Mapping implementation plan

This change keeps the existing GPU Gems 3 relaxed-cone implementation intact and adds the EGSR 2024 implementation as a separate selectable pipeline. Unreal Engine material support is explicitly out of scope for this phase.

## Phase 1 — Isolate the implementation

- [x] Add a generation-method selector: `Legacy approximate RCS` / `Robust RCS (EGSR 2024)`.
- [x] Put robust generation shaders in `js/robust-shaders.js`.
- [x] Put the robust generator and its render-target lifecycle in `js/robust-generator.js`.
- [x] Switch generator instances only at the UI/application boundary; do not add robust branches to the legacy generator.

## Phase 2 — Exact relaxed-cone constraints

- [x] Enumerate bilinear cells around every cone apex in increasing Chebyshev-distance bands.
- [x] Test the four cell heights for a limiting/falling edge as described by Algorithm 2.
- [x] Update the cone ratio only from limiting cells.
- [x] Stop once the next band is guaranteed to lie below the current cone.
- [x] Support both clamped and tiled height maps.

## Phase 3 — Bilinear interpolation correction

- [x] Run a separate 3x3 minimum-filter pass over generated cone ratios.
- [x] Use the corrected texture for preview and export.
- [x] Quantize exported 8-bit cone ratios downward so serialization cannot widen a cone.

## Phase 4 — Robust preview tracing

- [x] Add cell-max stepping to the WebGL preview.
- [x] Select legacy or cell-max tracing independently of the stored cone texture implementation.
- [x] Preserve the existing binary root refinement.

## Phase 5 — Integration and validation

- [x] Adapt controls and help text when the selected generation method changes.
- [x] Keep cancellation, progress, preview, and PNG export working for both generators.
- [ ] Add deterministic impulse/ridge regression fixtures (browser smoke validation is complete).
- [x] Run syntax checks and a browser smoke test.
- [x] Document algorithm, output guarantees, performance expectations, and attribution.

## Deferred

- Unreal Engine material/custom-node implementation.
- Performance comparison against the Falcor reference application.

## Unreal Engine implementation pseudocode

This section is for the later Unreal Material Custom-node implementation. It consumes the exported PNG, not the WebGL-only internal RGB packing.

### Texture contract

```text
R = height [0,1], where 1 is the highest surface
G = corrected relaxed-cone ratio [0,1]
B = unused
A = 1
```

Recommended Unreal texture settings:

- Disable sRGB and use a linear-data/mask compression mode.
- Use bilinear filtering.
- Addressing must match generation: Wrap for tiled maps, Clamp otherwise.
- Initially force mip 0. Ordinary image mips do not preserve robust cone guarantees.
- Sample height and cone together so both values use identical UV/filtering.

Suggested Custom-node inputs:

```text
Texture2D ConeMap
SamplerState ConeMapSampler
float2 UV
float3 ViewTS          // pixel-to-camera direction in tangent space
float DepthScale
float2 TextureSize     // mip-0 width and height
int MaxConeSteps
int BinarySteps
```

Return the corrected UV. A debug version should also expose hit, intersection depth, and iteration count.

### Cell-max robust tracing

```hlsl
float2 RobustConeStepUV(
    Texture2D ConeMap, SamplerState ConeMapSampler,
    float2 UV, float3 ViewTS, float DepthScale,
    float2 TextureSize, int MaxConeSteps, int BinarySteps)
{
    const float VZ_EPS = 1e-4;
    const float DIR_EPS = 1e-8;
    const float STEP_EPS = 1e-5;
    const float HIT_EPS = 1e-5;

    // t=0 at the height-volume top; t=1 at its bottom.
    // ViewTS points pixel -> camera, so reverse its XY projection.
    float vz = max(ViewTS.z, VZ_EPS);
    float2 rayUVPerDepth = -(ViewTS.xy / vz) * abs(DepthScale);
    float rayRatio = length(rayUVPerDepth);

    float t = 0.0;
    float previousT = 0.0;
    bool hit = false;

    [loop]
    for (int iteration = 0; iteration < MaxConeSteps; ++iteration)
    {
        float2 sampleUV = UV + rayUVPerDepth * t;

        // Robust generation already baked the 3x3 minimum correction.
        float2 hc = Texture2DSampleLevel(
            ConeMap, ConeMapSampler, sampleUV, 0).rg;

        float surfaceDepth = 1.0 - saturate(hc.r);
        float gap = surfaceDepth - t;
        if (gap <= HIT_EPS) { hit = true; break; }

        float coneRatio = max(hc.g, 1e-7);
        float coneStep = coneRatio * gap /
            max(rayRatio + coneRatio, DIR_EPS);

        // Texel centers define the secondary bilinear-cell grid.
        float2 cellCenter =
            (floor(sampleUV * TextureSize - 0.5) + 1.0) / TextureSize;
        float2 wall = cellCenter +
            sign(rayUVPerDepth) * 0.5 / TextureSize;

        float2 wallDistance = float2(1e20, 1e20);
        if (abs(rayUVPerDepth.x) > DIR_EPS)
        {
            float tx = (wall.x - sampleUV.x) / rayUVPerDepth.x;
            if (tx > 0.0) wallDistance.x = tx;
        }
        if (abs(rayUVPerDepth.y) > DIR_EPS)
        {
            float ty = (wall.y - sampleUV.y) / rayUVPerDepth.y;
            if (ty > 0.0) wallDistance.y = ty;
        }

        float cellStep = min(wallDistance.x, wallDistance.y);
        float stepT = coneStep;
        if (cellStep < 1e19)
            stepT = max(coneStep, cellStep + STEP_EPS);

        previousT = t;
        t = min(t + stepT, 1.0);
        if (t >= 1.0) break;
    }

    // Only refine a genuinely bracketed intersection. Reaching the iteration
    // cap while still outside the height field is not a hit.
    float2 endUV = UV + rayUVPerDepth * t;
    float endSurfaceDepth = 1.0 - Texture2DSampleLevel(
        ConeMap, ConeMapSampler, endUV, 0).r;
    hit = hit || (t >= endSurfaceDepth);
    if (!hit) return endUV;

    float lo = previousT; // outside/above
    float hi = t;         // inside/on surface

    [loop]
    for (int refinement = 0; refinement < BinarySteps; ++refinement)
    {
        float mid = 0.5 * (lo + hi);
        float2 midUV = UV + rayUVPerDepth * mid;
        float midSurfaceDepth = 1.0 - Texture2DSampleLevel(
            ConeMap, ConeMapSampler, midUV, 0).r;
        if (mid < midSurfaceDepth) lo = mid;
        else                       hi = mid;
    }

    return UV + rayUVPerDepth * hi;
}
```

### Material connection outline

```text
CameraVectorWS
  -> TransformVector(World to Tangent)
  -> RobustConeStepUV Custom node
  -> corrected UV
      -> Base Color / Normal / ORM texture samples
      -> optional Pixel Depth Offset
```

Implementation requirements:

1. Keep `surfaceDepth = 1 - height` consistent with generation.
2. Texture addressing must match the generator's Tiling option.
3. Sample cone data as linear data, never through sRGB conversion.
4. Cell-max uses the cone-map resolution, not screen resolution.
5. Do not repeat the 3x3 correction in the material; it is already baked.
6. Do not clamp cone ratios to the legacy `0.002`; use only a tiny progress guard such as `1e-7`.
7. Regular auto-generated mips are unsafe. Conservative mips need a separate generation/validation design.

### Temporary Unreal debug outputs

```text
Debug 0: corrected UV
Debug 1: sampled cone ratio as grayscale
Debug 2: iterationCount / MaxConeSteps
Debug 3: hit = green, iteration-cap miss = magenta
Debug 4: frac(sampleUV * TextureSize), showing cell position
Debug 5: abs(coneStep - cellStep), showing cell-max-limited areas
```

Validation maps should include a one-texel impulse, thin X/Y/diagonal ridges, a clamped non-tiled boundary, and a tiled map with exactly matching opposite edges.