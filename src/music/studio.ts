import type { ModRoute, ModelDefinition, NoteEvent, NoteRole, ParamSpec, ParamValues } from "../models/types";
import { renderParamControls, type ParamControls } from "../ui/controls";
import { AudioEngine, BeatDetector, type Waveform } from "./audio";
import { dispatchMidi, openMidi, type MidiInputs } from "./midi";
import { applyModulation, macroSpecs, modulatable, ModSources, SOURCES, sourceLabel } from "./modulation";
import { DRUMS, ROOTS, SCALES, Sequencer, STEPS, TONE_ROWS, defaultPattern, type SequencerState } from "./sequencer";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface GlobalSettings {
  seq: SequencerState;
  volume: number;
  thru: boolean;
  decay: number;
  inputs: string[];
  /** CC number -> target: `macro#<slot>` (any model) or `<modelId>/<paramKey>`. */
  bindings: Record<string, string>;
  dockHidden: boolean;
  /** Master switch: when off, no routes push and no notes reach the model. */
  musicOn: boolean;
  /** Scales every route on every model, 0..2. */
  intensity: number;
}

/**
 * Bump when models' default routes change enough that saved per-model
 * settings should be replaced by the new defaults.
 */
const MODEL_SETTINGS_VERSION = 2;

interface ModelSettings {
  v: number;
  macros: Record<string, number>;
  routes: ModRoute[];
  /** Note reactions switched off for this model. */
  muted: NoteRole[];
}

const ROLE_LABELS: Record<NoteRole, string> = { kick: "Kick", snare: "Snare", hat: "Hi-hat", tone: "Melody notes" };

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable; settings then last for this session only.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

/**
 * Everything musical: the sequencer, MIDI, the audio player, and the
 * per-model macros and modulation routes, plus the music panel UI. The host
 * calls `frame` once per animation frame and `apply` to get the parameter
 * values the model should use.
 */
export class Studio {
  readonly audio = new AudioEngine();
  readonly sources = new ModSources();
  readonly seq: Sequencer;
  private midi: MidiInputs | null = null;
  private beats = new BeatDetector();
  private pending: NoteEvent[] = [];
  private settings: GlobalSettings;

  private def: ModelDefinition | null = null;
  private base: ParamValues = {};
  private modelSettings: ModelSettings = { v: MODEL_SETTINGS_VERSION, macros: {}, routes: [], muted: [] };
  private macroOut: Record<string, number> = {};
  private paramControls: ParamControls | null = null;
  private macroControls: ParamControls | null = null;
  private onBaseChanged: (spec: ParamSpec) => void = () => {};

  private learning = false;
  private learnTarget: string | null = null;
  private ledTimer = 0;
  private gridCells: HTMLElement[][] = [];
  private meterBars: Record<string, HTMLElement> = {};
  private lastStepShown = -2;
  /** Live source bars in the matrix, refreshed while the Modulation tab is open. */
  private sourceMeters: { bar: HTMLElement; source: () => string }[] = [];
  /** Music that was playing when the simulation was paused, to resume with it. */
  private pausedMusic: { seq: boolean; file: boolean } | null = null;
  private player: HTMLAudioElement | null = null;

  constructor() {
    const saved = load<Partial<GlobalSettings>>("music:global") ?? {};
    const seq = { ...defaultPattern(), ...(saved.seq ?? {}) };
    this.settings = {
      volume: 0.7, thru: true, decay: 0.25, inputs: [], bindings: {}, dockHidden: false, musicOn: true, intensity: 1,
      ...saved,
      seq,
    };
    this.seq = new Sequencer(this.audio, seq);
    this.audio.setVolume(this.settings.volume);
    this.sources.decay = this.settings.decay;
    this.buildDock();
    void this.initMidi();
  }

  private saveGlobal(): void {
    save("music:global", this.settings);
  }

  // ---- Per-model state ---------------------------------------------------

  /** Called when the host loads a model. `base` is the slider-bound values object. */
  setModel(def: ModelDefinition, base: ParamValues, controls: ParamControls, onBaseChanged: (spec: ParamSpec) => void): void {
    this.def = def;
    this.base = base;
    this.paramControls = controls;
    this.onBaseChanged = onBaseChanged;
    const saved = load<ModelSettings>(`music:model:${def.id}`);
    // Settings saved before the current defaults existed are replaced, so new default routes show up.
    this.modelSettings = saved && saved.v === MODEL_SETTINGS_VERSION ? { ...saved, muted: saved.muted ?? [] } : this.defaultModelSettings(def);
    // Drop anything that points at parameters the model no longer has.
    const valid = new Set(this.targets().map((t) => t.id));
    this.modelSettings.routes = this.modelSettings.routes.filter((r) => valid.has(r.target));
    this.macroOut = {};
    this.renderMacros();
    this.renderRoutes();
    this.renderBindings();
  }

  private defaultModelSettings(def: ModelDefinition): ModelSettings {
    const macros: Record<string, number> = {};
    for (const m of def.macros ?? []) macros[m.key] = 0;
    return { v: MODEL_SETTINGS_VERSION, macros, routes: (def.modulations ?? []).map((r) => ({ ...r })), muted: [] };
  }

  private saveModel(): void {
    if (this.def) save(`music:model:${this.def.id}`, this.modelSettings);
  }

  private renderMacros(): void {
    const macros = this.def?.macros ?? [];
    $("macros-section").hidden = macros.length === 0;
    this.macroControls = renderParamControls($("macros"), macroSpecs(macros, this.def?.params ?? []), this.modelSettings.macros, () => this.saveModel(), "macro:");
  }

  /** Everything a route can push: macros first, then number parameters. */
  private targets(): { id: string; label: string }[] {
    if (!this.def) return [];
    return [
      ...(this.def.macros ?? []).map((m) => ({ id: `macro:${m.key}`, label: `Macro: ${m.label}` })),
      ...modulatable(this.def).map((p) => ({ id: p.key, label: p.label })),
    ];
  }

  // ---- Per-frame ---------------------------------------------------------

  /** Advance sources and collect the notes that should reach the model this frame. */
  frame(nowSeconds: number, dt: number): NoteEvent[] {
    const bands = this.audio.bands();
    if (this.audio.filePlaying && ($("audio-beats") as HTMLInputElement).checked) {
      const v = this.beats.feed(bands.bass, nowSeconds);
      if (v > 0) this.pending.push({ note: 36, velocity: v, role: "kick", x: 0.5, source: "audio" });
    }
    const events = [...this.seq.drain(), ...this.pending];
    this.pending = [];
    for (const ev of events) this.sources.trigger(ev);
    this.sources.update(dt, this.seq.beats(nowSeconds), bands);
    this.updatePlayhead();
    this.updateMeters();
    return events;
  }

  /** Whether the model's own reaction to this kind of note is switched on. */
  reacts(role: NoteRole): boolean {
    return this.settings.musicOn && !this.modelSettings.muted.includes(role);
  }

  /**
   * Pause or resume the music along with the simulation. Pausing stops the
   * sequencer and the audio file; resuming restarts whatever was playing.
   */
  setPaused(paused: boolean): void {
    if (paused) {
      const file = !!this.player && !this.player.paused;
      this.pausedMusic = { seq: this.seq.playing, file };
      if (this.seq.playing) this.toggleSequencer();
      if (file) this.player!.pause();
      this.audio.allNotesOff();
    } else if (this.pausedMusic) {
      if (this.pausedMusic.seq && !this.seq.playing) this.toggleSequencer();
      if (this.pausedMusic.file && this.player) void this.player.play();
      this.pausedMusic = null;
    }
  }

  /** Fill `out` with modulated values and update the slider markers. */
  apply(out: ParamValues): void {
    if (!this.def) return;
    const depth = this.settings.musicOn ? this.settings.intensity : 0;
    applyModulation(this.def, this.base, this.modelSettings.macros, this.modelSettings.routes, this.sources, out, this.macroOut, depth);
    this.paramControls?.showModulation(out);
    this.macroControls?.showModulation(this.macroOut);
  }

  // ---- MIDI ---------------------------------------------------------------

  private async initMidi(): Promise<void> {
    this.midi = await openMidi((data) => this.onMidi(data));
    if (this.midi.kind === "none") {
      $("midi-inputs").textContent = "MIDI isn't available in this browser. It works in the desktop app.";
      return;
    }
    await this.refreshInputs(true);
  }

  private async refreshInputs(reconnect = false): Promise<void> {
    const box = $("midi-inputs");
    if (!this.midi) return;
    let names: string[] = [];
    try {
      names = await this.midi.list();
    } catch (e) {
      box.textContent = String(e);
      return;
    }
    box.replaceChildren();
    if (names.length === 0) {
      box.textContent = "No MIDI inputs found. Plug in a device and press Refresh.";
      return;
    }
    for (const name of names) {
      const input = el("input", { type: "checkbox", checked: this.settings.inputs.includes(name) });
      const status = el("span", { className: "muted" });
      input.addEventListener("change", () => void this.setInput(name, input.checked, status, input));
      box.append(el("label", { className: "check" }, input, ` ${name} `, status));
      if (reconnect && input.checked) void this.setInput(name, true, status, input);
    }
  }

  private async setInput(name: string, on: boolean, status: HTMLElement, box: HTMLInputElement): Promise<void> {
    try {
      if (on) await this.midi!.connect(name);
      else await this.midi!.disconnect(name);
      status.textContent = "";
      const set = new Set(this.settings.inputs);
      if (on) set.add(name);
      else set.delete(name);
      this.settings.inputs = [...set];
      this.saveGlobal();
    } catch (e) {
      status.textContent = String(e);
      box.checked = false;
    }
  }

  private onMidi(data: ArrayLike<number>): void {
    const text = dispatchMidi(data, {
      noteOn: (ev) => {
        this.pending.push(ev);
        if (this.settings.thru) {
          if (ev.role === "tone") this.audio.noteOn(ev.note, ev.velocity);
          else this.audio.hit(ev.role, ev.note, ev.velocity, 0);
        }
      },
      noteOff: (note) => {
        this.sources.release(note);
        this.audio.noteOff(note);
      },
      cc: (n, v) => this.onCc(n, v),
      pitchBend: (v) => this.sources.pitchBend(v),
    });
    if (text) {
      $("midi-last").textContent = `Last message: ${text}`;
      const led = $("midi-led");
      led.classList.add("on");
      window.clearTimeout(this.ledTimer);
      this.ledTimer = window.setTimeout(() => led.classList.remove("on"), 120);
    }
  }

  private onCc(n: number, v: number): void {
    this.sources.cc(n, v);
    if (this.learning && this.learnTarget) {
      for (const [cc, t] of Object.entries(this.settings.bindings)) {
        if (t === this.learnTarget) delete this.settings.bindings[cc];
      }
      this.settings.bindings[n] = this.learnTarget;
      this.saveGlobal();
      this.setLearning(false);
      this.renderBindings();
    }
    const binding = this.settings.bindings[n];
    if (!binding || !this.def) return;
    if (binding.startsWith("macro#")) {
      const m = this.def.macros?.[Number(binding.slice(6))];
      if (!m) return;
      this.modelSettings.macros[m.key] = v;
      this.macroControls?.refresh();
      this.saveModel();
    } else {
      const [modelId, key] = binding.split("/");
      if (modelId !== this.def.id) return;
      const spec = this.def.params.find((p) => p.key === key);
      if (!spec) return;
      if (spec.kind === "number") {
        const raw = spec.min + v * (spec.max - spec.min);
        this.base[key] = Math.min(spec.max, Math.max(spec.min, Math.round(raw / spec.step) * spec.step));
      } else if (spec.kind === "boolean") {
        this.base[key] = v >= 0.5;
      } else {
        this.base[key] = spec.options[Math.min(spec.options.length - 1, Math.floor(v * spec.options.length))].value;
      }
      if (this.base[key] === this.lastCcValue[key]) return;
      this.lastCcValue[key] = this.base[key];
      this.paramControls?.refresh();
      this.onBaseChanged(spec);
    }
  }
  private lastCcValue: ParamValues = {};

  private setLearning(on: boolean): void {
    this.learning = on;
    this.learnTarget = null;
    $("midi-learn").classList.toggle("active", on);
    $("midi-learn").textContent = on ? "Cancel learn" : "MIDI learn";
    document.body.classList.toggle("learning", on);
    document.querySelectorAll(".param.learn-target").forEach((e) => e.classList.remove("learn-target"));
    $("midi-learn-help").textContent = on
      ? "Now click a slider or macro in the sidebar, then move a knob on your controller."
      : "Click MIDI learn, click a slider or macro, then move a knob on your controller.";
  }

  /** Translate a sidebar row's data-target into a binding target. */
  private bindingFor(rowTarget: string): string | null {
    if (!this.def) return null;
    if (rowTarget.startsWith("macro:")) {
      const i = (this.def.macros ?? []).findIndex((m) => m.key === rowTarget.slice(6));
      return i >= 0 ? `macro#${i}` : null;
    }
    return `${this.def.id}/${rowTarget}`;
  }

  private bindingLabel(target: string): string | null {
    if (!this.def) return null;
    if (target.startsWith("macro#")) {
      const i = Number(target.slice(6));
      const m = this.def.macros?.[i];
      return m ? `Macro ${i + 1} (${m.label})` : `Macro ${i + 1}`;
    }
    const [modelId, key] = target.split("/");
    if (modelId !== this.def.id) return null;
    return this.def.params.find((p) => p.key === key)?.label ?? null;
  }

  private renderBindings(): void {
    const box = $("midi-bindings");
    box.replaceChildren();
    const rows = Object.entries(this.settings.bindings)
      .map(([cc, t]) => [cc, t, this.bindingLabel(t)] as const)
      .filter(([, , label]) => label !== null);
    if (rows.length === 0) {
      box.append(el("p", { className: "muted", textContent: "No knobs mapped for this model yet. Macro mappings carry over to every model." }));
      return;
    }
    for (const [cc, target, label] of rows) {
      const remove = el("button", { type: "button", textContent: "Remove", className: "small" });
      remove.addEventListener("click", () => {
        delete this.settings.bindings[cc];
        this.saveGlobal();
        this.renderBindings();
      });
      box.append(el("div", { className: "binding" }, el("span", { textContent: `CC ${cc}` }), el("span", { textContent: `→ ${label}` }), remove));
      void target;
    }
  }

  // ---- UI -------------------------------------------------------------------

  private buildDock(): void {
    const s = this.settings;
    const tabs = document.querySelectorAll<HTMLButtonElement>("#dock-tabs [data-tab]");
    for (const t of tabs) {
      t.addEventListener("click", () => {
        tabs.forEach((b) => b.classList.toggle("active", b === t));
        document.querySelectorAll<HTMLElement>("#dock-body .tab").forEach((p) => (p.hidden = p.dataset.tab !== t.dataset.tab));
        if ($("dock").classList.contains("collapsed")) this.setDockHidden(false);
      });
    }
    $("dock-toggle").addEventListener("click", () => this.setDockHidden(!$("dock").classList.contains("collapsed")));
    this.setDockHidden(s.dockHidden);

    // Transport
    const play = $<HTMLButtonElement>("seq-play");
    play.addEventListener("click", () => this.toggleSequencer());
    const tempo = $<HTMLInputElement>("seq-tempo");
    tempo.value = String(s.seq.tempo);
    tempo.addEventListener("change", () => {
      s.seq.tempo = Math.min(240, Math.max(40, Number(tempo.value) || 120));
      tempo.value = String(s.seq.tempo);
      this.saveGlobal();
    });

    // Sequencer settings
    const scale = $<HTMLSelectElement>("seq-scale");
    for (const [id, sc] of Object.entries(SCALES)) scale.append(el("option", { value: id, textContent: sc.label }));
    scale.value = s.seq.scale;
    scale.addEventListener("change", () => { s.seq.scale = scale.value; this.saveGlobal(); this.labelRows(); scale.blur(); });
    const root = $<HTMLSelectElement>("seq-root");
    ROOTS.forEach((r, i) => root.append(el("option", { value: String(i), textContent: r })));
    root.value = String(s.seq.root);
    root.addEventListener("change", () => { s.seq.root = Number(root.value); this.saveGlobal(); this.labelRows(); root.blur(); });
    const wave = $<HTMLSelectElement>("seq-wave");
    wave.addEventListener("change", () => { this.audio.waveform = wave.value as Waveform; wave.blur(); });
    const swing = $<HTMLInputElement>("seq-swing");
    swing.value = String(s.seq.swing);
    swing.addEventListener("input", () => { s.seq.swing = Number(swing.value); this.saveGlobal(); });
    const volume = $<HTMLInputElement>("seq-volume");
    volume.value = String(s.volume);
    volume.addEventListener("input", () => { s.volume = Number(volume.value); this.audio.setVolume(s.volume); this.saveGlobal(); });
    const sound = $<HTMLInputElement>("seq-sound");
    sound.checked = s.seq.sound;
    sound.addEventListener("change", () => { s.seq.sound = sound.checked; this.saveGlobal(); });
    $("seq-random").addEventListener("click", () => { this.seq.randomize(); this.saveGlobal(); this.paintGrid(); });
    $("seq-clear").addEventListener("click", () => { this.seq.clear(); this.saveGlobal(); this.paintGrid(); });
    this.buildGrid();

    // Modulation
    $("mod-add").addEventListener("click", () => {
      const targets = this.targets();
      if (targets.length === 0) return;
      // Start from a sound and a slider that nothing uses yet, so a new route does something visible.
      const routes = this.modelSettings.routes;
      const source = ["kick", "snare", "hat", "tone", "lfoBar", "bass", "env"].find((id) => !routes.some((r) => r.source === id)) ?? "kick";
      const target = targets.find((t) => !routes.some((r) => r.target === t.id)) ?? targets[0];
      routes.push({ source, target: target.id, amount: 0.5 });
      this.saveModel();
      this.renderRoutes();
    });
    $("mod-defaults").addEventListener("click", () => {
      if (!this.def) return;
      this.modelSettings = this.defaultModelSettings(this.def);
      this.saveModel();
      this.renderMacros();
      this.renderRoutes();
    });
    const decay = $<HTMLInputElement>("mod-decay");
    const decayOut = $("mod-decay-readout");
    decay.value = String(s.decay);
    decayOut.textContent = `${s.decay.toFixed(2)} s`;
    decay.addEventListener("input", () => {
      s.decay = this.sources.decay = Number(decay.value);
      decayOut.textContent = `${s.decay.toFixed(2)} s`;
      this.saveGlobal();
    });
    const intensity = $<HTMLInputElement>("mod-intensity");
    const intensityOut = $("mod-intensity-readout");
    intensity.value = String(s.intensity);
    intensityOut.textContent = `${Math.round(s.intensity * 100)}%`;
    intensity.addEventListener("input", () => {
      s.intensity = Number(intensity.value);
      intensityOut.textContent = `${Math.round(s.intensity * 100)}%`;
      this.saveGlobal();
    });
    const enabled = $<HTMLInputElement>("mod-enabled");
    enabled.checked = s.musicOn;
    enabled.addEventListener("change", () => {
      s.musicOn = enabled.checked;
      document.querySelector(".mod-layout")?.classList.toggle("bypassed", !s.musicOn);
      this.saveGlobal();
    });
    document.querySelector(".mod-layout")?.classList.toggle("bypassed", !s.musicOn);

    // MIDI
    $("midi-refresh").addEventListener("click", () => void this.refreshInputs());
    const thru = $<HTMLInputElement>("midi-thru");
    thru.checked = s.thru;
    thru.addEventListener("change", () => { s.thru = thru.checked; this.saveGlobal(); });
    $("midi-learn").addEventListener("click", () => this.setLearning(!this.learning));
    $("sidebar").addEventListener("pointerdown", (e) => {
      if (!this.learning) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>(".param[data-target]");
      if (!row) return;
      const target = this.bindingFor(row.dataset.target!);
      if (!target) return;
      document.querySelectorAll(".param.learn-target").forEach((x) => x.classList.remove("learn-target"));
      row.classList.add("learn-target");
      this.learnTarget = target;
    });

    // Audio file
    const file = $<HTMLInputElement>("audio-file");
    const audioPlay = $<HTMLButtonElement>("audio-play");
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (!f) return;
      const player = (this.player = this.audio.loadFile(f));
      $("audio-name").textContent = f.name;
      audioPlay.disabled = false;
      player.addEventListener("play", () => (audioPlay.textContent = "Pause"));
      player.addEventListener("pause", () => (audioPlay.textContent = "Play"));
      void player.play().catch((e) => ($("audio-name").textContent = `Can't play ${f.name}: ${e}`));
    });
    audioPlay.addEventListener("click", () => {
      const player = this.player;
      if (!player) return;
      if (player.paused) void player.play();
      else player.pause();
    });
    const meters = $("meters");
    for (const k of ["level", "bass", "mid", "treble"]) {
      const bar = el("div", { className: "meter-fill" });
      meters.append(el("div", { className: "meter" }, el("span", { textContent: sourceLabel(k) }), el("div", { className: "meter-track" }, bar)));
      this.meterBars[k] = bar;
    }
  }

  private setDockHidden(hidden: boolean): void {
    $("dock").classList.toggle("collapsed", hidden);
    $("dock-toggle").textContent = hidden ? "Show" : "Hide";
    if (this.settings.dockHidden !== hidden) {
      this.settings.dockHidden = hidden;
      this.saveGlobal();
    }
  }

  toggleSequencer(): void {
    const play = $<HTMLButtonElement>("seq-play");
    if (this.seq.playing) this.seq.stop();
    else this.seq.start();
    play.textContent = this.seq.playing ? "Stop" : "Play";
    play.classList.toggle("playing", this.seq.playing);
  }

  private buildGrid(): void {
    const gridEl = $("seq-grid");
    gridEl.replaceChildren();
    this.gridCells = [];
    let paint: boolean | null = null;
    window.addEventListener("pointerup", () => (paint = null));
    // Rows top to bottom: highest tone first, then the drums.
    const rows: { label: string; cells: boolean[]; tone: boolean }[] = [];
    for (let r = TONE_ROWS - 1; r >= 0; r--) rows.push({ label: "", cells: this.seq.state.tones[r], tone: true });
    for (const [i, d] of DRUMS.entries()) rows.push({ label: d.label, cells: this.seq.state.drums[i], tone: false });
    rows.forEach((row, ri) => {
      const rowEl = el("div", { className: `seq-row${row.tone ? "" : " drum"}` });
      rowEl.append(el("span", { className: "seq-label", textContent: row.label }));
      const cells: HTMLElement[] = [];
      for (let i = 0; i < STEPS; i++) {
        const cell = el("div", { className: `seq-cell${i % 4 === 0 ? " bar" : ""}` });
        const set = (v: boolean) => {
          const arr = this.rowArray(ri);
          arr[i] = v;
          cell.classList.toggle("on", v);
        };
        cell.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          paint = !this.rowArray(ri)[i];
          set(paint);
          this.saveGlobal();
          if (paint && !this.seq.playing) this.preview(ri);
        });
        cell.addEventListener("pointerenter", () => {
          if (paint === null) return;
          set(paint);
          this.saveGlobal();
        });
        cells.push(cell);
        rowEl.append(cell);
      }
      this.gridCells.push(cells);
      gridEl.append(rowEl);
    });
    this.labelRows();
    this.paintGrid();
  }

  /** The live array behind a grid row (the state object can be replaced by clear). */
  private rowArray(ri: number): boolean[] {
    if (ri < TONE_ROWS) return this.seq.state.tones[TONE_ROWS - 1 - ri];
    return this.seq.state.drums[ri - TONE_ROWS];
  }

  private preview(ri: number): void {
    if (!this.seq.state.sound) return;
    if (ri < TONE_ROWS) this.audio.hit("tone", this.seq.rowNote(TONE_ROWS - 1 - ri), 0.7, 0);
    else {
      const d = DRUMS[ri - TONE_ROWS];
      this.audio.hit(d.role, d.note, 0.8, 0);
    }
  }

  private labelRows(): void {
    const labels = $("seq-grid").querySelectorAll<HTMLElement>(".seq-label");
    for (let ri = 0; ri < TONE_ROWS; ri++) {
      const note = this.seq.rowNote(TONE_ROWS - 1 - ri);
      labels[ri].textContent = `${ROOTS[note % 12]}${Math.floor(note / 12) - 1}`;
    }
  }

  private paintGrid(): void {
    this.gridCells.forEach((cells, ri) => {
      const arr = this.rowArray(ri);
      cells.forEach((c, i) => c.classList.toggle("on", arr[i]));
    });
  }

  private updatePlayhead(): void {
    const step = this.seq.current;
    if (step === this.lastStepShown) return;
    for (const cells of this.gridCells) {
      if (this.lastStepShown >= 0) cells[this.lastStepShown].classList.remove("now");
      if (step >= 0) cells[step].classList.add("now");
    }
    this.lastStepShown = step;
  }

  private updateMeters(): void {
    if ($("dock").classList.contains("collapsed")) return;
    for (const k in this.meterBars) this.meterBars[k].style.width = `${this.sources.get(k) * 100}%`;
    for (const m of this.sourceMeters) {
      if (!m.bar.isConnected || m.bar.offsetParent === null) continue;
      m.bar.style.width = `${Math.min(1, Math.abs(this.sources.get(m.source()))) * 100}%`;
    }
  }

  /** Draw the modulation matrix: the model's note reactions, then its routes. */
  private renderRoutes(): void {
    this.sourceMeters = [];
    this.renderReactions();
    const box = $("mod-routes");
    box.replaceChildren();
    const targets = this.targets();
    if (this.modelSettings.routes.length === 0) {
      box.append(el("p", { className: "muted", textContent: "No routes. Add one to let a sound or controller push a slider." }));
    }
    this.modelSettings.routes.forEach((route, i) => {
      const on = el("input", { type: "checkbox", checked: !route.off, title: "Switch this route on or off" });
      const source = el("select");
      const groups = new Map<string, HTMLOptGroupElement>();
      for (const s of SOURCES) {
        let g = groups.get(s.group);
        if (!g) {
          g = el("optgroup", { label: s.group });
          groups.set(s.group, g);
          source.append(g);
        }
        g.append(el("option", { value: s.id, textContent: s.label }));
      }
      const ccGroup = groups.get("MIDI")!;
      for (const n of this.sources.ccList()) ccGroup.append(el("option", { value: `cc:${n}`, textContent: `CC ${n}` }));
      if (![...source.options].some((o) => o.value === route.source)) {
        ccGroup.append(el("option", { value: route.source, textContent: sourceLabel(route.source) }));
      }
      source.value = route.source;
      source.addEventListener("change", () => { route.source = source.value; this.routesChanged(); source.blur(); });

      const meterFill = el("div", { className: "meter-fill" });
      this.sourceMeters.push({ bar: meterFill, source: () => route.source });
      const meter = el("div", { className: "meter-track", title: "What this sound is doing right now" }, meterFill);

      const target = el("select");
      for (const t of targets) target.append(el("option", { value: t.id, textContent: t.label }));
      target.value = route.target;
      target.addEventListener("change", () => { route.target = target.value; this.routesChanged(); target.blur(); });

      const amount = el("input", { type: "range", min: "-1", max: "1", step: "0.05", value: String(route.amount), title: "How far it pushes, as a share of the slider's range. Double-click to zero." });
      const readout = el("span", { className: "readout", textContent: formatAmount(route.amount) });
      const setAmount = (v: number) => {
        route.amount = v;
        readout.textContent = formatAmount(v);
        this.routesChanged();
      };
      amount.addEventListener("input", () => setAmount(Number(amount.value)));
      amount.addEventListener("dblclick", () => { amount.value = "0"; setAmount(0); });
      const remove = el("button", { type: "button", textContent: "×", className: "small", title: "Remove route" });
      remove.addEventListener("click", () => {
        this.modelSettings.routes.splice(i, 1);
        this.routesChanged();
        this.renderRoutes();
      });
      const row = el("div", { className: `route${route.off ? " off" : ""}` }, on, source, meter, el("span", { className: "muted", textContent: "→" }), target, amount, readout, remove);
      on.addEventListener("change", () => {
        route.off = !on.checked || undefined;
        row.classList.toggle("off", !on.checked);
        this.routesChanged();
      });
      box.append(row);
    });
    this.showRouteBadges();
  }

  private routesChanged(): void {
    this.saveModel();
    this.showRouteBadges();
  }

  /** List the model's built-in note reactions, each with a switch and a live hit meter. */
  private renderReactions(): void {
    const box = $("mod-reactions");
    box.replaceChildren();
    const reactions = this.def?.reactions ?? [];
    if (reactions.length === 0) {
      box.append(el("p", { className: "muted", textContent: "This model doesn't react to notes directly; routes are how music reaches it." }));
      return;
    }
    for (const r of reactions) {
      const input = el("input", { type: "checkbox", checked: !this.modelSettings.muted.includes(r.role) });
      input.addEventListener("change", () => {
        const muted = new Set(this.modelSettings.muted);
        if (input.checked) muted.delete(r.role);
        else muted.add(r.role);
        this.modelSettings.muted = [...muted];
        this.saveModel();
      });
      const fill = el("div", { className: "meter-fill" });
      this.sourceMeters.push({ bar: fill, source: () => r.role });
      box.append(el("label", { className: "reaction" }, input, el("span", { className: "reaction-role", textContent: ROLE_LABELS[r.role] }), el("div", { className: "meter-track" }, fill), el("span", { className: "muted", textContent: r.text })));
    }
  }

  /** Under each sidebar slider, name the routes pushing it. */
  private showRouteBadges(): void {
    const params: Record<string, string[]> = {};
    const macros: Record<string, string[]> = {};
    for (const r of this.modelSettings.routes) {
      if (r.off || r.amount === 0) continue;
      const text = `${sourceLabel(r.source)} ${formatAmount(r.amount)}`;
      const [bucket, key] = r.target.startsWith("macro:") ? [macros, r.target.slice(6)] : [params, r.target];
      (bucket[key] ??= []).push(text);
    }
    const join = (m: Record<string, string[]>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.join(", ")]));
    this.paramControls?.showRoutes(join(params));
    this.macroControls?.showRoutes(join(macros));
  }
}

function formatAmount(v: number): string {
  return `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;
}
