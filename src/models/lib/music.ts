/**
 * Helpers shared by models that react to notes, so the same pitch gets the
 * same colour whichever model is showing.
 */

/** Hue in degrees for a MIDI note's pitch class: C is blue, going round the colour wheel by semitone. */
export function noteHue(note: number): number {
  return (210 + (((note % 12) + 12) % 12) * 30) % 360;
}

/** A stable pseudo-random 0..1 from a note number, for picking a second coordinate. */
export function noteHash(note: number): number {
  const s = Math.sin(note * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
