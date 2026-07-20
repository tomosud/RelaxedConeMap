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
