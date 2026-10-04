/**
 * The contract every simulation model implements.
 *
 * A model owns its own state, advances it in `step`, and draws it in
 * `render`. The host app handles the canvas, the animation loop, the
 * parameter UI, and routing pointer input, so a new model only has to
 * describe its parameters and implement these methods.
 */

export type ParamSpec =
  | {
      kind: "number";
      key: string;
      label: string;
      min: number;
      max: number;
      step: number;
      default: number;
      /** Re-run `reset` when this parameter changes (e.g. particle count). */
      resetOnChange?: boolean;
    }
  | {
      kind: "boolean";
      key: string;
      label: string;
      default: boolean;
      resetOnChange?: boolean;
    };

export type ParamValues = Record<string, number | boolean>;

export interface Viewport {
  width: number;
  height: number;
}

export interface PointerInput {
  type: "down" | "move" | "up";
  x: number;
  y: number;
  /** 0 = primary, 2 = secondary, as in PointerEvent.button. */
  button: number;
  /** True while any button is held. */
  pressed: boolean;
  shift: boolean;
}

export interface SimulationModel {
  /** (Re)create the model's state for the given viewport and parameters. */
  reset(view: Viewport, params: ParamValues): void;
  /** Advance the simulation by `dt` seconds. */
  step(dt: number, params: ParamValues): void;
  /** Draw the current state. The canvas is already cleared. */
  render(g: CanvasRenderingContext2D, view: Viewport, params: ParamValues): void;
  /** Optional: react to mouse / touch input on the canvas. */
  onPointer?(input: PointerInput, params: ParamValues): void;
  /** Optional: keep state valid when the canvas size changes. */
  resize?(view: Viewport): void;
  /** Optional: short status text shown in the sidebar (e.g. body count). */
  stats?(): string;
}

export interface ModelDefinition {
  id: string;
  name: string;
  category: "Particle physics" | "Algorithmic" | "Custom";
  description: string;
  /** One line telling the user how to interact with the canvas. */
  hint?: string;
  params: ParamSpec[];
  /**
   * Fixed simulation timestep in seconds. The host runs `step` at this rate
   * regardless of display refresh rate so results are reproducible.
   */
  fixedDt?: number;
  create(): SimulationModel;
}

export function defaultParams(def: ModelDefinition): ParamValues {
  const values: ParamValues = {};
  for (const p of def.params) values[p.key] = p.default;
  return values;
}
