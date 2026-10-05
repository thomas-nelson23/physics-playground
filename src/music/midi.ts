import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NoteEvent, NoteRole } from "../models/types";

export interface MidiHandlers {
  noteOn(ev: NoteEvent, channel: number): void;
  noteOff(note: number): void;
  cc(controller: number, value: number): void;
  pitchBend(value: number): void;
}

/** General MIDI drum notes, for pads sending on channel 10. */
function drumRole(note: number): NoteRole {
  if (note === 35 || note === 36) return "kick";
  if (note === 38 || note === 40 || note === 37 || note === 39) return "snare";
  if (note === 42 || note === 44 || note === 46 || (note >= 49 && note <= 59)) return "hat";
  return note < 41 ? "kick" : "snare";
}

/** Decode one MIDI message and call the matching handler. */
export function dispatchMidi(data: ArrayLike<number>, h: MidiHandlers): string | null {
  if (data.length < 2) return null;
  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  const d1 = data[1];
  const d2 = data.length > 2 ? data[2] : 0;
  if (status === 0x90 && d2 > 0) {
    const role: NoteRole = channel === 9 ? drumRole(d1) : "tone";
    // Spread the five octaves around middle C across the canvas.
    const x = Math.min(1, Math.max(0, (d1 - 36) / 60));
    h.noteOn({ note: d1, velocity: d2 / 127, role, x, source: "midi" }, channel);
    return `Note ${d1} on, velocity ${d2}, channel ${channel + 1}`;
  }
  if (status === 0x80 || status === 0x90) {
    h.noteOff(d1);
    return null;
  }
  if (status === 0xb0) {
    h.cc(d1, d2 / 127);
    return `CC ${d1} = ${d2}, channel ${channel + 1}`;
  }
  if (status === 0xe0) {
    h.pitchBend(((d2 << 7) | d1) / 8192 - 1);
    return `Pitch bend, channel ${channel + 1}`;
  }
  return null;
}

/**
 * MIDI input. In the desktop app the Rust side owns the ports (the system
 * webviews don't implement Web MIDI); in a browser during development we
 * fall back to Web MIDI where it exists.
 */
export interface MidiInputs {
  readonly kind: "native" | "web" | "none";
  list(): Promise<string[]>;
  connect(name: string): Promise<void>;
  disconnect(name: string): Promise<void>;
}

export async function openMidi(onMessage: (data: ArrayLike<number>) => void): Promise<MidiInputs> {
  if (isTauri()) {
    await listen<{ port: string; data: number[] }>("midi-message", (e) => onMessage(e.payload.data));
    return {
      kind: "native",
      list: () => invoke<string[]>("midi_inputs"),
      connect: (name) => invoke("midi_connect", { name }),
      disconnect: (name) => invoke("midi_disconnect", { name }),
    };
  }
  if ("requestMIDIAccess" in navigator) {
    try {
      const access = await navigator.requestMIDIAccess();
      const byName = () => new Map([...access.inputs.values()].map((i) => [i.name ?? i.id, i]));
      const handler = (e: MIDIMessageEvent) => e.data && onMessage(e.data);
      return {
        kind: "web",
        list: async () => [...byName().keys()],
        connect: async (name) => {
          const input = byName().get(name);
          if (!input) throw new Error(`MIDI input "${name}" is not connected`);
          input.onmidimessage = handler;
        },
        disconnect: async (name) => {
          const input = byName().get(name);
          if (input) input.onmidimessage = null;
        },
      };
    } catch {
      // Permission denied; fall through to "none".
    }
  }
  return {
    kind: "none",
    list: async () => [],
    connect: async () => { throw new Error("MIDI isn't available here"); },
    disconnect: async () => {},
  };
}
