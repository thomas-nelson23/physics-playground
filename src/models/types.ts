/**
 * The contract every simulation model implements.
 *
 * A model owns its own state, advances it in `step`, and draws it in
 * `render`. The host app handles the canvas, the animation loop, the
 * parameter UI, and routing pointer input, so a new model only has to
 * describe its parameters and implement these methods.
 */

/** Fields every parameter kind shares. */
interface ParamCommon {
  key: string;
  label: string;
  /** One short sentence shown under the control, saying what it does. */
  description?: string;
  /**
   * Sidebar heading the parameter is listed under, e.g. "Gravity" or "Look".
   * Parameters with the same group are shown together, in the order the
   * groups first appear.
   */
  group?: string;
  /** Re-run `reset` when this parameter changes (e.g. particle count). */
  resetOnChange?: boolean;
}

export type ParamSpec = ParamCommon &
  (
  | {
      kind: "number";
      min: number;
      max: number;
      step: number;
      default: number;
    }
  | {
      kind: "boolean";
      default: boolean;
    }
  | {
      /** A dropdown of named options, e.g. a preset or a brush material. */
      kind: "choice";
      options: { value: string; label: string }[];
      default: string;
    }
  );

export type ParamValues = Record<string, number | boolean | string>;

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

/** What kind of hit a note is. Drum sounds are told apart so models can react to the beat. */
export type NoteRole = "kick" | "snare" | "hat" | "tone";

/**
 * A musical event, from the built-in sequencer, a MIDI device, or a beat
 * detected in an audio file. Models may react to it in `onNote`.
 */
export interface NoteEvent {
  /** MIDI note number (60 = middle C). */
  note: number;
  /** 0..1 */
  velocity: number;
  role: NoteRole;
  /**
   * Where the note sits in its range, 0 = lowest, 1 = highest. Models use it
   * as a position (e.g. left-to-right) so melodies spread across the canvas.
   */
  x: number;
  source: "sequencer" | "midi" | "audio";
}

/**
 * A macro is one 0..1 knob that pushes several parameters at once. At 0 the
 * parameters keep their slider values; at 1 each moves by `amount` times its
 * full range (negative amounts move it down).
 */
export interface MacroSpec {
  key: string;
  label: string;
  targets: { param: string; amount: number }[];
}

/**
 * A modulation route: a music source (see src/music/modulation.ts for the
 * list) pushes a target, which is a number parameter's key or `macro:<key>`.
 * `amount` is a fraction of the target's range, -1..1.
 */
export interface ModRoute {
  source: string;
  target: string;
  amount: number;
  /** Switched off in the matrix but kept, so it can be turned back on. */
  off?: boolean;
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
  /** Optional: react to a note or drum hit, e.g. spawn something where the note lands. */
  onNote?(note: NoteEvent, params: ParamValues): void;
  /** Optional: short status text shown in the sidebar (e.g. body count). */
  stats?(): string;
}

export interface ModelDefinition {
  id: string;
  name: string;
  category: "Particle physics" | "Mechanics" | "Waves & fluids" | "Algorithmic" | "Sound & music" | "Custom";
  description: string;
  /** One line telling the user how to interact with the canvas. */
  hint?: string;
  params: ParamSpec[];
  /**
   * Fixed simulation timestep in seconds. The host runs `step` at this rate
   * regardless of display refresh rate so results are reproducible.
   */
  fixedDt?: number;
  /** Performance knobs shown above the parameters; MIDI-learnable and modulatable. */
  macros?: MacroSpec[];
  /** Modulation routes the model starts with, so music does something out of the box. */
  modulations?: ModRoute[];
  /**
   * What `onNote` does for each kind of hit, listed in the modulation matrix
   * so the user can see (and switch off) the built-in reactions.
   */
  reactions?: { role: NoteRole; text: string }[];
  create(): SimulationModel;
}

export function defaultParams(def: ModelDefinition): ParamValues {
  const values: ParamValues = {};
  for (const p of def.params) values[p.key] = p.default;
  return values;
}
