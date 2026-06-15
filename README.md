# Relaxed Cone Map Generator

https://tomosud.github.io/RelaxedConeMap/

A browser-based tool that generates **cone maps for Relaxed Cone Step Mapping** from height map images or photos, then previews the result as a 3D relief surface.
Both generation and preview rendering run on **WebGL2 (GPU)**, with no server-side processing required.

> Relaxed Cone Step Mapping is based on GPU Gems 3, Chapter 18:
> [Relaxed Cone Stepping for Relief Mapping](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-18-relaxed-cone-stepping-relief-mapping)
> by F. Policarpo and M. M. Oliveira.
> It accelerates relief mapping raymarching with precomputed cone ratios, allowing large safe steps and accurate surface detail with fewer iterations.

---

## Features

- Generate a **cone map PNG** from a height map image
- Estimate **AI depth** from a photo or regular image, then use it as a height map
- Inspect the generated result immediately in a **3D relief preview**
- Import the generated cone map into an **Unreal Engine material**

---

## Usage (PC / Desktop)

1. Open the tool page, either online or locally with `run_local.bat`.
2. Drop a **height map image** onto the left panel, or use **Try Sample Terrain**.
   - If you only have a regular photo, use the photo depth-estimation option to let AI estimate depth and convert it into a height map.
3. Adjust resolution, channel, inversion, and wrapping settings as needed.
4. Click **Generate (GPU)**. The preview updates while generation is running.
5. Inspect the relief in the preview on the right.
   - **Drag:** rotate
   - **Mouse wheel:** zoom
   - Display mode, light direction, depth scale, and related options can be adjusted from the panel.
6. Export the result when ready.
   - **Save Cone Map PNG:** downloads the generated PNG file.
   - **Open Unreal Material Text:** opens paste-ready Unreal material text on a separate page.

### Unreal Engine Import

The desktop UI includes an **Open Unreal Material Text** button.

1. Click the button to open a separate page containing the Unreal material text.
2. Click **Select All and Copy**, or use `Ctrl+A` then `Ctrl+C`.
3. Open the **Material Editor** in Unreal Engine and paste into the graph with **`Ctrl+V`**.
4. The Relaxed Cone Step Mapping node setup will be created in the material graph.

After pasting, assign the generated cone map PNG as the material texture.

---

## Usage (Mobile)

On mobile, the tool switches to a simplified full-screen workflow focused on generating a 3D preview directly from a photo.

1. On the start screen, choose **Take Photo** or **Choose Photo**.
2. The selected photo is processed with AI depth estimation, then a cone map is generated automatically.
3. When generation finishes, the app switches to the full-screen 3D preview.
4. **Tilt the device** to move the viewpoint. iOS Safari requires sensor permission on first use.
5. Use the bottom slider to adjust **Depth**.

---

## Desktop and Mobile Differences

| Item | PC / Desktop | Mobile |
|---|---|---|
| Layout | Left control panel plus large preview on the right | Simplified full-screen preview |
| Main input flow | Image drop, sample terrain, depth estimation | Photo capture or photo selection with depth estimation |
| View controls | Drag to rotate, wheel to zoom | Device tilt sensor moves the viewpoint |
| Preview modes | Relief, height map, cone map, raymarch iterations | Relief only for lighter rendering |
| Lighting | Shadows, specular, auto-rotating light | Shadows and specular disabled for performance |
| Cone map PNG export | Supported | Not exposed in the mobile workflow |
| Unreal material import | Supported with desktop-only button | Hidden |

> The mobile version disables heavier preview features such as shadows, specular highlights, and display-mode switching to keep rendering responsive.
> Use the desktop version for detailed tuning, cone map export, and Unreal Engine import.

---

## Parameters

| Parameter | Meaning |
|---|---|
| Resolution | Output cone map size. Higher values add detail but take longer to generate. |
| Channel | Input image channel used as height: luminance, R, G, B, or A. |
| Invert Height | Enable when the source uses black as high and white as low, such as some depth maps. |
| Tiling (Wrap) | Enable for tileable materials so calculations wrap across image edges. Disable for one-off images. |
| Search Radius | How many surrounding texels are inspected. Larger values are more accurate but heavier. |
| Ray Search Steps | Number of forward samples per offset. Higher values improve accuracy. |
| Depth Scale | Relief depth used in the preview. |
| Tile Count | How many times the same pattern repeats on the preview surface. |
| Cone Steps | Cone-stepping iteration count used in the preview. More steps are more accurate but heavier. |

High resolution with a large search radius can take tens of seconds to generate.
Progress is shown in the UI, generation can be canceled, and the interface remains responsive.

---

## Output Cone Map PNG Format

The output is a square PNG matching the selected resolution.

| Channel | Contents |
|---|---|
| R | Height (0-1) |
| G | Cone ratio (0-1), where 1.0 means unconstrained |
| B / A | Unused |

---

## Running Locally

Double-click `run_local.bat` to start the local server. Python 3 is required.
It opens `http://localhost:8765/` automatically.

> Some features, including Unreal material text loading and depth estimation, will not work correctly when opening files directly with `file://`.
> Use `run_local.bat` so the app runs through a local web server.

Browser requirements: a WebGL2-capable version of Chrome, Edge, Firefox, or Safari.

---

## File Layout

```text
index.html              UI
style.css
js/shaders.js           GLSL for generation and preview
js/generator.js         Cone map generation pipeline
js/viewer.js            3D preview
js/depth.js             AI depth estimation (ONNX Runtime Web)
js/main.js              UI wiring, sample terrain, PNG and material I/O
model/                  Depth estimation model
unreal_material/        Paste-ready Unreal material text
run_local.bat           Local test server using Python http.server
```

---

## References

- F. Policarpo and M. M. Oliveira, ["Relaxed Cone Stepping for Relief Mapping"](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-18-relaxed-cone-stepping-relief-mapping), GPU Gems 3, Chapter 18.
- J. Dummer, "Cone Step Mapping: An Iterative Ray-Heightfield Intersection Algorithm".

## License

MIT
