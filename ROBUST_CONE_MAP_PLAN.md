# Robust Cone Step Mapping — implementation and conformance plan

This document is the normative contract and audit record for the independent WebGL2 implementation of Bán et al., *Robust Cone Step Mapping* (EGSR 2024). The local upstream snapshot used for comparison is `sample/robust-cone-map-master`. Legacy GPU Gems RCS remains a separate selectable implementation. Unreal integration is deferred; its pseudocode is specified below.

## 1. Current decision

The Clamp, square, mip-0 path implements the reference falling-edge cone construction, 3×3 conservative correction, cell-max search, and binary refinement. Three correctness defects found during the source audit were fixed:

- Robust generation now uses the exact R8 height field exported in PNG. AI R16F depth is quantized first; generation, preview, and export no longer use different height fields.
- Clamp tracing discards a final UV outside `[0,1]`, matching the reference and preventing border texels from stretching to infinity at grazing angles.
- Binary refinement returns the final bracket midpoint, matching `Refinement.slang`, rather than the inside endpoint.
- Cancellation exposes a zero-cone packed texture and disables Save; partial R32F work is never decoded/exported as RGB24.

“Reference-equivalent” in this document means: square texture, Clamp addressing, mip 0, linear data, bilinear sampling, R8 height and G8 exported cone. Wrap is a useful extension, but is not supplied or proven by the upstream implementation.

## 2. Normative data contract

### Exported PNG

| Channel | Meaning | Encoding |
|---|---|---|
| R | height, `0` bottom to `1` top | UNORM8 |
| G | corrected relaxed-cone tangent ratio | UNORM8, truncated downward |
| B | reserved | 0 |
| A | opaque | 255 |

The PNG must be imported as linear data: sRGB disabled, no color transform, bilinear filter, mip 0. Addressing must equal generation. Ordinary image mips are not conservative and are unsupported.

The robust generator deliberately computes from the already quantized R8 height canvas. This makes the generated guarantee apply to the saved R channel. Cone export uses `floor(c*255)/255`, never nearest rounding.

### Internal WebGL representation

- Raw cone: `R32F`, ping-pong during generation.
- Corrected cone: conservative value packed into RGB8 as a 24-bit unsigned integer using downward truncation.
- Preview manually decodes four packed texels and bilinearly interpolates them. Decode is linear, so it preserves the intended bilinear cone value apart from the conservative 24-bit truncation.
- The RGB24 format is internal only; it is not the PNG contract.

### Geometry and coordinates

- Only square processed maps are accepted; the UI resamples every input to `N×N`.
- Texel coordinates are centers: `(ij + 0.5) / N`.
- `height=1` is the front/top surface; tracing depth is `1-height`, with `t=0` at the front plate and `t=1` at the back plate.
- Depth/relief scale affects the view ray, not preprocessing cone ratios.

## 3. Reference-to-implementation mapping

| Upstream source | Local implementation | Status / intentional difference |
|---|---|---|
| `Conemap.cs.slang::main_new_fallingEdge` | `RobustConeMapGenerator._makeCells`, `ROBUST_SHADERS.generateFS` | Same four outward directions and Chebyshev bands. WebGL batches a global cell list. |
| `updateMinTan` | `generateFS` candidate loop | Same distance, height, existing-cone rejects and four-height falling-edge predicate. |
| `WriteConeMap` | `correctFS`, `exportFS` | No sqrt lookup. Downward quantization. Internal 24-bit; export 8-bit. |
| `main_postprocess_max` | `correctFS` | Same 3×3 minimum; Clamp path clamps neighbor indices. |
| `FindIntersection.slang::findIntersection_coneStepMapping` | `SHADERS.viewFS` robust branch | Algebraically equivalent depth-normalized cone step plus cell-max boundary step. |
| `Refinement.slang::refineIntersection_binarySearch` | `viewFS` eight-step binary loop | Uses last outside/current inside bracket and returns final midpoint. |
| `Parallax.ps.slang` final bounds check | `viewFS` Clamp discard | Outside final UV is discarded; Wrap remains periodic. |

The upstream per-apex loop can break an entire band. The batched WebGL implementation still submits all bands and rejects individual candidates with the same cone bound. This is correctness-equivalent but slower; the former plan’s claim that generation stopped at a band was inaccurate.

## 4. Implemented phases

- [x] Keep Legacy and Robust generators separate; select only at the application boundary.
- [x] Exact falling-edge candidate test for the Clamp square path.
- [x] Conservative 3×3 bilinear interpolation correction.
- [x] Downward 24-bit internal and 8-bit export quantization.
- [x] Same R8 height field for robust generation, preview, and export.
- [x] Cell-max robust tracing and valid last-outside/current-inside refinement bracket.
- [x] Reference midpoint refinement and Clamp final-UV discard.
- [x] Safe cancellation: no partial preview/export and Save remains disabled.
- [x] Debug statistics for raw/corrected cone and magenta iteration-cap misses.
- [x] Photo drag/drop and image paste thumbnail workflow; direct height input remains separate.

## 5. Extensions and limits

- Wrap generation/tracing is an independent periodic extension. It is not claimed as upstream conformance until a toroidal CPU oracle and seam fixtures pass.
- Only square mip-0 textures are supported. Conservative mip generation is future work.
- `EXT_color_buffer_float` is required for raw R32F accumulation. Unsupported devices currently fail initialization instead of silently falling back.
- A plane-based parallax method cannot create a true displaced silhouette or side wall. Very shallow views can still reveal finite-step and sampling limits, but Clamp border smearing is now removed.
- The fixed shader batch (`ivec4[128]`) fits the WebGL2 minimum fragment-uniform requirement, but adaptive sizing from `MAX_FRAGMENT_UNIFORM_VECTORS` remains a portability improvement.
- Robust generation enumerates every global candidate batch; it prioritizes auditability over the reference compute shader’s per-apex early termination performance.

## 6. Validation matrix

### Completed smoke checks

- [x] JavaScript syntax and `git diff --check`.
- [x] Chromium GLSL compilation and 512×512 generation for Clamp and Wrap.
- [x] Raw/corrected readback contains finite values and no invalid values.
- [x] Visual cone, height, relief, and iteration debug modes.

### Required conformance tests

These remain explicit acceptance work; smoke tests are not presented as a mathematical proof.

- [ ] CPU port of upstream Algorithm 2 versus GPU raw texels on flat, impulse, X/Y/diagonal ridge, saddle, monotone ramp, checker, and seeded random maps.
- [ ] 3×3 corrected result versus a CPU boundary-aware minimum oracle.
- [ ] PNG round trip: exported R equals generation R8 height, and exported G never exceeds the corrected internal cone.
- [ ] Dense/exact bilinear root oracle over random rays: no robust step skips the first intersection.
- [ ] Clamp ray-exit, vertical, axis-aligned, grazing, iteration-cap, and non-hit fixtures.
- [ ] Wrap seam/toroidal oracle before describing Wrap as proven robust.
- [ ] Abort, WebGL context loss, missing extension, every UI resolution, and Legacy non-regression.
- [ ] Golden comparison with upstream Falcor output where a reproducible fixture/configuration is available.

## 7. Unreal Engine pseudocode (deferred implementation)

The function returns UV, hit state, intersection depth, and iteration count. A UV-only function cannot correctly define miss handling or Pixel Depth Offset.

```hlsl
struct RobustHit
{
    float2 UV;
    float T;
    float Hit;
    float Iterations;
};

RobustHit TraceRobustCone(
    Texture2D ConeMap, SamplerState ConeSampler,
    float2 UV, float3 PixelToCameraTS,
    float DepthScale, float2 TextureSize,
    int MaxConeSteps, int BinarySteps,
    bool WrapAddress)
{
    const float DIR_EPS = 1e-8;
    const float VIEW_EPS = 1e-5;
    const float CELL_EPS = 1e-5;
    RobustHit result = { UV, 0, 0, 0 };

    // Contract: tangent +Z points out of the surface, PixelToCameraTS points
    // from the pixel to camera, and DepthScale must be positive.
    if (PixelToCameraTS.z <= VIEW_EPS || DepthScale <= 0) return result;

    float2 ray = -(PixelToCameraTS.xy / PixelToCameraTS.z) * DepthScale;
    float rayRatio = length(ray);
    float t = 0;
    float previousT = 0;
    bool hit = false;
    int count = 0;

    [loop] for (int i = 0; i < MaxConeSteps; ++i)
    {
        float2 sampleUV = UV + ray * t;
        if (!WrapAddress && any(sampleUV < 0) || any(sampleUV > 1)) break;

        float2 hc = ConeMap.SampleLevel(ConeSampler, sampleUV, 0).rg;
        float surfaceDepth = 1 - saturate(hc.r);
        float gap = surfaceDepth - t;
        if (gap <= 0) { hit = true; break; } // establishes inside endpoint

        float cone = max(hc.g, 1e-7);
        float coneStep = cone * gap / max(rayRatio + cone, DIR_EPS);

        float2 center = (floor(sampleUV * TextureSize - 0.5) + 1) / TextureSize;
        float2 wall = center + float2(ray.x < 0 ? -1 : 1,
                                     ray.y < 0 ? -1 : 1) * 0.5 / TextureSize;
        float2 wallStep = 1e20.xx;
        if (abs(ray.x) > DIR_EPS) {
            float tx = (wall.x - sampleUV.x) / ray.x;
            if (tx > 0) wallStep.x = tx;
        }
        if (abs(ray.y) > DIR_EPS) {
            float ty = (wall.y - sampleUV.y) / ray.y;
            if (ty > 0) wallStep.y = ty;
        }

        previousT = t;
        t += max(coneStep, min(wallStep.x, wallStep.y) + CELL_EPS);
        count = i + 1;
        if (t >= 1) {
            t = 1;
            float2 endHC = ConeMap.SampleLevel(ConeSampler, UV + ray, 0).rg;
            hit = t >= 1 - endHC.r;
            break;
        }
    }

    float2 finalUV = UV + ray * t;
    if (!hit || (!WrapAddress && any(finalUV < 0) || any(finalUV > 1))) {
        result.UV = finalUV; result.T = t; result.Iterations = count;
        return result; // material chooses clip/fallback/debug magenta
    }

    float lo = previousT; // outside
    float hi = t;         // inside
    [loop] for (int j = 0; j < BinarySteps; ++j) {
        float mid = 0.5 * (lo + hi);
        float h = ConeMap.SampleLevel(ConeSampler, UV + ray * mid, 0).r;
        if (mid < 1 - h) lo = mid; else hi = mid;
    }

    result.T = 0.5 * (lo + hi); // reference midpoint
    result.UV = UV + ray * result.T;
    result.Hit = 1;
    result.Iterations = count;
    return result;
}
```

Unreal import/usage requirements:

1. Use a Texture Object plus explicit Sampler State; disable sRGB and lossy color compression that changes R/G data.
2. Force mip 0 until conservative mips exist. Virtual Textures are unsupported by this pseudocode.
3. Match Clamp/Wrap exactly. For Clamp, feed `Hit` to Clip or use an explicit fallback; never shade an out-of-range clamped UV.
4. Respect Unreal’s tangent basis and material UV V orientation. Validate mirrored UVs and non-uniform object scale with fixtures.
5. Sample height and cone together from the same texture/filter operation.
6. Pixel Depth Offset requires converting `result.T * DepthScale` through the actual tangent/world/view geometry; do not connect `T` directly.
7. Provide debug modes: cone grayscale, iteration count, hit green/miss magenta, cell coordinates, and cone-step versus cell-step.

## 8. Audit record

2026-07-21: compared local WebGL code with upstream `Conemap.cs.slang`, `FindIntersection.slang`, `Refinement.slang`, and `Parallax.ps.slang`. Three independent reviews covered generator math/data format, tracer/refinement, and plan/test/Unreal completeness. The fixes listed in §1 were applied. Remaining unchecked items are clearly separated from completed implementation claims above.
