import { SILENT_MUSIC, type ModRoute, type ModelDefinition, type MusicFrame, type NoteEvent, type ParamSpec, type ParamValues, type ReactionSource } from "../models/types";
import { noteHue } from "../models/lib/music";
import { renderParamControls, type ParamControls } from "../ui/controls";
import { AudioEngine, BeatDetector, type Waveform } from "./audio";
import { dispatchMidi, openMidi, type MidiInputs } from "./midi";
import { applyModulation, macroSpecs, modulatable, ModSources, SOURCES, sourceLabel } from "./modulation";
import { DRUMS, ROOTS, SCALES, STEPS, STYLES, Sequencer, sanitizeState, type SequencerState } from "./sequencer";

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
const MODEL_SETTINGS_VERSION = 3;

interface ModelSettings {
  v: number;
  macros: Record<string, number>;
  routes: ModRoute[];
  /** Built-in reactions switched off for this model. */
  muted: ReactionSource[];
}

/** The generator's live controls, shown as sliders and mappable with MIDI learn. */
const GEN_SPECS: ParamSpec[] = [
  { kind: "number", key: "drumDensity", label: "Drum density", min: 0, max: 1, step: 0.01, default: 0.5,
    description: "How many drum hits play. Low keeps the backbone; high fills in ghost notes and rolls." },
  { kind: "number", key: "melodyDensity", label: "Melody density", min: 0, max: 1, step: 0.01, default: 0.45,
    description: "How many melody notes play. Low leaves long held notes; high fills in runs between them." },
  { kind: "number", key: "variation", label: "Variation", min: 0, max: 1, step: 0.01, default: 0.35,
    description: "How much the pattern changes each bar, and how often it plays a fill." },
  { kind: "number", key: "range", label: "Melody range", min: 2, max: 16, step: 1, default: 8,
    description: "How many scale notes the melody wanders across." },
];

const REACTION_LABELS: Record<ReactionSource, string> = {
  kick: "Kick", snare: "Snare", hat: "Hi-hat", tone: "Melody notes",
  level: "Sound level", bass: "Bass", mid: "Mids", treble: "Treble", spectrum: "Spectrum", beat: "Beat",
};

/** The modulation source whose live value the matrix shows next to each reaction. */
const REACTION_METERS: Record<ReactionSource, string> = {
  kick: "kick", snare: "snare", hat: "hat", tone: "tone",
  level: "level", bass: "bass", mid: "mid", treble: "treble", spectrum: "level", beat: "lfoBeat",
};

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
  private genControls: ParamControls | null = null;
  private padCtx: CanvasRenderingContext2D | null = null;
  private viewCtx: CanvasRenderingContext2D | null = null;
  /** Version and playhead the pattern view last drew, to skip redundant redraws. */
  private viewDrawn = "";
  private meterBars: Record<string, HTMLElement> = {};
  /** Live source bars in the matrix, refreshed while the Modulation tab is open. */
  private sourceMeters: { bar: HTMLElement; source: () => string }[] = [];
  /** Music that was playing when the simulation was paused, to resume with it. */
  private pausedMusic: { seq: boolean; file: boolean } | null = null;
  private player: HTMLAudioElement | null = null;
  /** The music feed handed to the model each frame; reused to avoid garbage. */
  private feed: MusicFrame = { ...SILENT_MUSIC, spectrum: new Float32Array(SILENT_MUSIC.spectrum.length), wave: new Float32Array(SILENT_MUSIC.wave.length) };
  private beatsNow = 0;
  private lastTone = { hue: 210, pitch: 0.5 };

  constructor() {
    const saved = load<Partial<GlobalSettings>>("music:global") ?? {};
    const seq = sanitizeState(saved.seq);
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
    for (const ev of events) {
      this.sources.trigger(ev);
      if (ev.role === "tone") this.lastTone = { hue: noteHue(ev.note), pitch: ev.x };
    }
    this.beatsNow = this.seq.beats(nowSeconds);
    this.sources.update(dt, this.beatsNow, bands);
    this.drawView();
    this.updateMeters();
    return events;
  }

  /** Whether the model's own reaction to this kind of note is switched on. */
  reacts(role: ReactionSource): boolean {
    return this.settings.musicOn && !this.modelSettings.muted.includes(role);
  }

  /**
   * The continuous music feed for the model this frame: envelopes, bands,
   * spectrum and beat, scaled by Intensity, with switched-off reactions zeroed.
   */
  music(): MusicFrame {
    const f = this.feed;
    const depth = this.settings.musicOn ? this.settings.intensity : 0;
    const muted = this.modelSettings.muted;
    const val = (r: ReactionSource, v: number) => (muted.includes(r) ? 0 : v * depth);
    const src = this.sources;
    f.kick = val("kick", src.get("kick"));
    f.snare = val("snare", src.get("snare"));
    f.hat = val("hat", src.get("hat"));
    f.tone = val("tone", src.get("tone"));
    f.level = val("level", src.get("level"));
    f.bass = val("bass", src.get("bass"));
    f.mid = val("mid", src.get("mid"));
    f.treble = val("treble", src.get("treble"));
    const shape = muted.includes("spectrum") ? 0 : depth;
    for (let i = 0; i < f.spectrum.length; i++) f.spectrum[i] = this.audio.spectrum[i] * shape;
    for (let i = 0; i < f.wave.length; i++) f.wave[i] = this.audio.scope[i] * shape;
    f.beats = this.beatsNow;
    // The beat pulse only means something while the sequencer keeps time.
    const phase = this.beatsNow - Math.floor(this.beatsNow);
    f.pulse = this.seq.playing ? val("beat", (1 - phase) ** 3) : 0;
    f.hue = this.lastTone.hue;
    f.pitch = this.lastTone.pitch;
    f.energy = Math.max(f.level, f.kick * 0.7 + f.snare * 0.45 + f.tone * 0.35 + f.hat * 0.15);
    return f;
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
    if (!binding) return;
    if (binding.startsWith("gen#")) {
      this.setGen(binding.slice(4), v);
      return;
    }
    if (!this.def) return;
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
      ? "Now click a slider or macro in the sidebar (or a sequencer slider), then move a knob on your controller."
      : "Click MIDI learn, click a slider or macro, then move a knob on your controller. Sequencer sliders can be mapped too.";
  }

  /** Translate a sidebar row's data-target into a binding target. */
  private bindingFor(rowTarget: string): string | null {
    if (rowTarget.startsWith("gen:")) return `gen#${rowTarget.slice(4)}`;
    if (!this.def) return null;
    if (rowTarget.startsWith("macro:")) {
      const i = (this.def.macros ?? []).findIndex((m) => m.key === rowTarget.slice(6));
      return i >= 0 ? `macro#${i}` : null;
    }
    return `${this.def.id}/${rowTarget}`;
  }

  private bindingLabel(target: string): string | null {
    if (target.startsWith("gen#")) {
      const spec = GEN_SPECS.find((p) => p.key === target.slice(4));
      return spec ? `Sequencer: ${spec.label}` : null;
    }
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
    const style = $<HTMLSelectElement>("seq-style");
    for (const [id, st] of Object.entries(STYLES)) style.append(el("option", { value: id, textContent: st.label }));
    style.value = s.seq.style;
    style.addEventListener("change", () => { s.seq.style = style.value; this.seq.version++; this.saveGlobal(); style.blur(); });
    const scale = $<HTMLSelectElement>("seq-scale");
    for (const [id, sc] of Object.entries(SCALES)) scale.append(el("option", { value: id, textContent: sc.label }));
    scale.value = s.seq.scale;
    scale.addEventListener("change", () => { s.seq.scale = scale.value; this.saveGlobal(); scale.blur(); });
    const root = $<HTMLSelectElement>("seq-root");
    ROOTS.forEach((r, i) => root.append(el("option", { value: String(i), textContent: r })));
    root.value = String(s.seq.root);
    root.addEventListener("change", () => { s.seq.root = Number(root.value); this.saveGlobal(); root.blur(); });
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

    // Generator
    this.genControls = renderParamControls($("gen-sliders"), GEN_SPECS, s.seq as unknown as ParamValues, () => this.saveGlobal(), "gen:");
    // The panel is short, so descriptions show as tooltips here instead of under each slider.
    for (const row of $("gen-sliders").querySelectorAll<HTMLElement>(".param[data-target]")) {
      row.title = GEN_SPECS.find((p) => `gen:${p.key}` === row.dataset.target)?.description ?? "";
    }
    $("gen-new").addEventListener("click", () => { this.seq.newIdea(); this.saveGlobal(); });
    $("gen-fill").addEventListener("click", () => this.seq.fill());
    const hold = $<HTMLButtonElement>("gen-hold");
    hold.classList.toggle("active", s.seq.hold);
    hold.addEventListener("click", () => {
      s.seq.hold = !s.seq.hold;
      hold.classList.toggle("active", s.seq.hold);
      this.saveGlobal();
    });
    this.buildPad();
    this.viewCtx = $<HTMLCanvasElement>("gen-view").getContext("2d");

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
    const pickTarget = (e: PointerEvent) => {
      if (!this.learning) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>(".param[data-target]");
      if (!row) return;
      const target = this.bindingFor(row.dataset.target!);
      if (!target) return;
      document.querySelectorAll(".param.learn-target").forEach((x) => x.classList.remove("learn-target"));
      row.classList.add("learn-target");
      this.learnTarget = target;
    };
    $("sidebar").addEventListener("pointerdown", pickTarget);
    $("gen-sliders").addEventListener("pointerdown", pickTarget);

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

  /** Set a generator control from a 0..1 knob position (MIDI CC). */
  private setGen(key: string, v: number): void {
    const spec = GEN_SPECS.find((p) => p.key === key);
    if (!spec || spec.kind !== "number") return;
    const value = Math.round((spec.min + v * (spec.max - spec.min)) / spec.step) * spec.step;
    (this.settings.seq as unknown as Record<string, number>)[key] = Math.min(spec.max, Math.max(spec.min, value));
    this.genControls?.refresh();
    this.saveGlobal();
  }

  /** The XY pad: left-right is drum density, bottom-top is melody density. */
  private buildPad(): void {
    const pad = $<HTMLCanvasElement>("gen-pad");
    const dpr = window.devicePixelRatio || 1;
    pad.width = pad.height = Math.round(150 * dpr);
    this.padCtx = pad.getContext("2d");
    this.padCtx?.scale(dpr, dpr);
    let dragging = false;
    const set = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const clamp = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
      this.settings.seq.drumDensity = clamp((e.clientX - r.left) / r.width);
      this.settings.seq.melodyDensity = clamp(1 - (e.clientY - r.top) / r.height);
      this.genControls?.refresh();
    };
    pad.addEventListener("pointerdown", (e) => {
      dragging = true;
      pad.setPointerCapture(e.pointerId);
      set(e);
    });
    pad.addEventListener("pointermove", (e) => dragging && set(e));
    const end = () => {
      if (!dragging) return;
      dragging = false;
      this.saveGlobal();
    };
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);
  }

  /** Redraw the pad and the bar view while the Sequencer tab is open. */
  private drawView(): void {
    const canvas = this.viewCtx?.canvas;
    if (!canvas || canvas.offsetParent === null || $("dock").classList.contains("collapsed")) return;
    this.drawPad();
    const seq = this.settings.seq;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const key = [this.seq.version, this.seq.current, seq.drumDensity, seq.melodyDensity, seq.range, seq.style, w, h, dpr].join("|");
    if (key === this.viewDrawn) return;
    this.viewDrawn = key;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = this.viewCtx!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0d1117";
    g.fillRect(0, 0, w, h);
    const bar = this.seq.view();
    const labelW = 40, gap = 2;
    const colW = (w - labelW) / STEPS;
    const drumRowH = 14;
    const drumTop = h - DRUMS.length * (drumRowH + gap);
    const melTop = 4, melH = drumTop - 10 - melTop;
    const half = Math.max(1, Math.floor(seq.range / 2));

    // Beat columns and playhead.
    for (let i = 0; i < STEPS; i++) {
      const x = labelW + i * colW;
      g.fillStyle = i === this.seq.current ? "#30363d" : i % 4 === 0 ? "#1c2128" : "#161b22";
      g.fillRect(x + 1, 0, colW - gap, h);
      if (bar.fill && i >= 12) {
        g.fillStyle = "rgba(210, 168, 255, 0.08)";
        g.fillRect(x + 1, 0, colW - gap, h);
      }
    }
    // Melody: a block per note, height by pitch, held until the next note.
    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillStyle = "#8b949e";
    g.fillText("Melody", 2, melTop + melH / 2);
    const noteH = Math.max(3, melH / (2 * half + 1));
    for (let i = 0; i < STEPS; i++) {
      const d = bar.melody[i];
      if (d === null) continue;
      let len = 1;
      while (len < 4 && i + len < STEPS && bar.melody[i + len] === null) len++;
      const y = melTop + ((half - d) / (2 * half)) * (melH - noteH);
      const x = labelW + i * colW + 1;
      g.fillStyle = "rgba(88, 166, 255, 0.25)";
      g.fillRect(x, y, len * colW - gap, noteH);
      g.fillStyle = i === this.seq.current ? "#a5d6ff" : "#58a6ff";
      g.fillRect(x, y, colW - gap, noteH);
    }
    // Drums: hat, snare, kick.
    DRUMS.forEach((d, r) => {
      const y = drumTop + r * (drumRowH + gap);
      g.fillStyle = "#8b949e";
      g.fillText(d.label, 2, y + drumRowH / 2);
      for (let i = 0; i < STEPS; i++) {
        const hit = bar.drums[r][i];
        if (!hit.on) continue;
        g.globalAlpha = 0.35 + 0.65 * hit.velocity;
        g.fillStyle = i === this.seq.current ? "#ffc58a" : "#f0883e";
        g.fillRect(labelW + i * colW + 1, y, colW - gap, drumRowH);
      }
      g.globalAlpha = 1;
    });
  }

  private drawPad(): void {
    const g = this.padCtx;
    if (!g) return;
    const size = 150, seq = this.settings.seq;
    const grad = g.createLinearGradient(0, size, size, 0);
    grad.addColorStop(0, "#161b22");
    grad.addColorStop(1, "#2d2346");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    g.strokeStyle = "#30363d";
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = Math.round((i * size) / 4) + 0.5;
      g.beginPath();
      g.moveTo(p, 0); g.lineTo(p, size);
      g.moveTo(0, p); g.lineTo(size, p);
      g.stroke();
    }
    const x = seq.drumDensity * size, y = (1 - seq.melodyDensity) * size;
    // The dot swells with the drums and glows with the melody.
    const kick = this.sources.get("kick"), tone = this.sources.get("tone");
    g.fillStyle = `rgba(210, 168, 255, ${0.15 + 0.35 * tone})`;
    g.beginPath();
    g.arc(x, y, 14 + 10 * kick, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#d2a8ff";
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
  }

  private updateMeters(): void {
    if ($("dock").classList.contains("collapsed")) return;
    for (const k in this.meterBars) this.meterBars[k].style.width = `${this.sources.get(k) * 100}%`;
    for (const m of this.sourceMeters) {
      if (!m.bar.isConnected || m.bar.offsetParent === null) continue;
      m.bar.style.width = `${Math.min(1, Math.abs(this.sources.get(m.source()))) * 100}%`;
    }
  }

  /** Draw the modulation matrix: the model's built-in reactions, then its routes. */
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

  /** List the model's built-in reactions, each with a switch and a live meter. */
  private renderReactions(): void {
    const box = $("mod-reactions");
    box.replaceChildren();
    const reactions = this.def?.reactions ?? [];
    if (reactions.length === 0) {
      box.append(el("p", { className: "muted", textContent: "This model doesn't react to music by itself; routes are how music reaches it." }));
      return;
    }
    for (const r of reactions) {
      const input = el("input", { type: "checkbox", checked: !this.modelSettings.muted.includes(r.source) });
      input.addEventListener("change", () => {
        const muted = new Set(this.modelSettings.muted);
        if (input.checked) muted.delete(r.source);
        else muted.add(r.source);
        this.modelSettings.muted = [...muted];
        this.saveModel();
      });
      const fill = el("div", { className: "meter-fill" });
      this.sourceMeters.push({ bar: fill, source: () => REACTION_METERS[r.source] });
      box.append(el("label", { className: "reaction" }, input, el("span", { className: "reaction-role", textContent: REACTION_LABELS[r.source] }), el("div", { className: "meter-track" }, fill), el("span", { className: "muted", textContent: r.text })));
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
