# Physics Playground

An interactive desktop app for exploring physics and algorithmic models on a live canvas. Pick a model, tweak its parameters with sliders, and poke at it with the mouse.

![Boids model](docs/screenshot.png)

Built with [Tauri 2](https://tauri.app) (Rust shell, native webview) and TypeScript + Canvas 2D. macOS is the first target; Linux builds from the same code (`.deb` and AppImage).

## Models

| Model | Category | Interaction |
| --- | --- | --- |
| Particles & gravity | Particle physics | Drag to fling a body, Shift for a heavy one |
| Flocking (boids) | Algorithmic | Hold to attract, right-click or Shift to scatter |
| Game of Life | Algorithmic | Click or drag to draw cells |

Keyboard: `Space` play/pause, `R` reset, `.` single step while paused.

## Running it

Prerequisites: Node 20+, Rust (stable, via [rustup](https://rustup.rs)), and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS (on macOS that's just Xcode Command Line Tools: `xcode-select --install`).

```sh
npm install
npm run tauri dev     # desktop app with hot reload
npm run dev           # or just the UI in a browser at http://localhost:1420
```

Build a distributable:

```sh
npm run tauri build   # macOS: .app + .dmg   Linux: .deb + .AppImage
```

On Linux, install the webview deps first:

```sh
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

## Adding a model

Every model implements `SimulationModel` from [`src/models/types.ts`](src/models/types.ts). The host app owns the canvas, the fixed-timestep loop, the parameter sliders and pointer routing, so a model only describes its parameters and implements `reset`, `step` and `render` (plus optional `onPointer`, `resize` and `stats`).

1. Create `src/models/myModel.ts` exporting a `ModelDefinition`:

   ```ts
   import type { ModelDefinition, SimulationModel } from "./types";

   class MyModel implements SimulationModel {
     reset(view, params) { /* build state */ }
     step(dt, params) { /* advance state by dt seconds */ }
     render(g, view, params) { /* draw with the 2D context */ }
   }

   export const myModel: ModelDefinition = {
     id: "my-model",
     name: "My model",
     category: "Custom",
     description: "What it shows.",
     params: [
       { kind: "number", key: "strength", label: "Strength", min: 0, max: 10, step: 0.1, default: 1 },
     ],
     create: () => new MyModel(),
   };
   ```

2. Add it to the list in [`src/models/registry.ts`](src/models/registry.ts).

Sliders and checkboxes are generated from `params` automatically. Mark a param `resetOnChange: true` if changing it should rebuild the simulation (e.g. a particle count).

## Project layout

```
src/
  main.ts            app shell: canvas, loop, input, model switching
  models/
    types.ts         the model interface
    registry.ts      list of available models
    particles.ts     n-body gravity + collisions
    boids.ts         flocking
    life.ts          Conway's Game of Life
  ui/controls.ts     builds parameter controls from a model's spec
src-tauri/           Rust/Tauri desktop shell and bundle config
```
