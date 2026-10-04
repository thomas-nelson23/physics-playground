import { models, findModel } from "./models/registry";
import { defaultParams, type ModelDefinition, type ParamValues, type PointerInput, type SimulationModel, type Viewport } from "./models/types";
import { renderParamControls } from "./ui/controls";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("canvas");
const stage = $<HTMLElement>("stage");
const g = canvas.getContext("2d")!;
const select = $<HTMLSelectElement>("model-select");
const description = $<HTMLElement>("model-description");
const hint = $<HTMLElement>("model-hint");
const paramsEl = $<HTMLElement>("params");
const playPause = $<HTMLButtonElement>("play-pause");
const stepBtn = $<HTMLButtonElement>("step");
const resetBtn = $<HTMLButtonElement>("reset");
const statsEl = $<HTMLElement>("stats");

const MAX_STEPS_PER_FRAME = 8;

let def: ModelDefinition;
let model: SimulationModel;
let params: ParamValues;
let view: Viewport = { width: 1, height: 1 };
let running = true;
let accumulator = 0;
let lastTime = performance.now();
let fps = 0;

// ---- Model selection -------------------------------------------------------

function populateModelSelect(): void {
  const byCategory = new Map<string, ModelDefinition[]>();
  for (const m of models) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }
  for (const [category, list] of byCategory) {
    const group = document.createElement("optgroup");
    group.label = category;
    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      group.append(opt);
    }
    select.append(group);
  }
}

function loadModel(id: string): void {
  def = findModel(id) ?? models[0];
  select.value = def.id;
  params = defaultParams(def);
  model = def.create();
  model.reset(view, params);
  accumulator = 0;
  description.textContent = def.description;
  hint.textContent = def.hint ?? "No canvas interaction for this model.";
  renderParamControls(paramsEl, def.params, params, (spec) => {
    if (spec.resetOnChange) model.reset(view, params);
  });
  try {
    localStorage.setItem("lastModel", def.id);
  } catch {
    // Storage can be unavailable; remembering the model is only a convenience.
  }
}

// ---- Canvas sizing ---------------------------------------------------------

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = stage.getBoundingClientRect();
  view = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  canvas.width = Math.round(view.width * dpr);
  canvas.height = Math.round(view.height * dpr);
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!model) return;
  if (model.resize) model.resize(view);
  else model.reset(view, params);
}

// ---- Input -----------------------------------------------------------------

function sendPointer(type: PointerInput["type"], e: PointerEvent): void {
  if (!running && type === "move" && e.buttons === 0) return;
  const rect = canvas.getBoundingClientRect();
  model.onPointer?.(
    {
      type,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      button: e.button,
      pressed: e.buttons !== 0,
      shift: e.shiftKey,
    },
    params,
  );
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  sendPointer("down", e);
});
canvas.addEventListener("pointermove", (e) => sendPointer("move", e));
canvas.addEventListener("pointerup", (e) => sendPointer("up", e));
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

function setRunning(value: boolean): void {
  running = value;
  playPause.textContent = running ? "Pause" : "Play";
  stepBtn.disabled = running;
}

playPause.addEventListener("click", () => setRunning(!running));
stepBtn.addEventListener("click", () => model.step(def.fixedDt ?? 1 / 60, params));
resetBtn.addEventListener("click", () => model.reset(view, params));
select.addEventListener("change", () => loadModel(select.value));

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === "Space") { e.preventDefault(); setRunning(!running); }
  else if (e.key === "r") model.reset(view, params);
  else if (e.key === "." && !running) model.step(def.fixedDt ?? 1 / 60, params);
});

// ---- Main loop -------------------------------------------------------------

function frame(now: number): void {
  const elapsed = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;
  fps = fps * 0.9 + (elapsed > 0 ? 1 / elapsed : 0) * 0.1;

  if (running) {
    // Fixed-timestep integration keeps physics stable on 60Hz and 120Hz screens alike.
    const dt = def.fixedDt ?? 1 / 60;
    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= dt && steps < MAX_STEPS_PER_FRAME) {
      model.step(dt, params);
      accumulator -= dt;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // drop time rather than spiral
  }

  g.fillStyle = "#0d1117";
  g.fillRect(0, 0, view.width, view.height);
  model.render(g, view, params);

  const extra = model.stats?.();
  statsEl.textContent = `${Math.round(fps)} fps${extra ? ` · ${extra}` : ""}`;
  requestAnimationFrame(frame);
}

// ---- Boot ------------------------------------------------------------------

populateModelSelect();
resize();
let initial = models[0].id;
try {
  initial = localStorage.getItem("lastModel") ?? initial;
} catch {
  // Fall back to the first model.
}
loadModel(initial);
setRunning(true);
new ResizeObserver(resize).observe(stage);
requestAnimationFrame(frame);
