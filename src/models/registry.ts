import type { ModelDefinition } from "./types";
import { particles } from "./particles";
import { orbits } from "./orbits";
import { charges } from "./charges";
import { cloth } from "./cloth";
import { pendulum } from "./pendulum";
import { waves } from "./waves";
import { fluid } from "./fluid";
import { boids } from "./boids";
import { life } from "./life";
import { reaction } from "./reaction";
import { sand } from "./sand";
import { slime } from "./slime";

/**
 * Every model the app offers. To add a model, create a file in this folder
 * that exports a `ModelDefinition` and add it to this list. The model menu
 * groups by category in the order categories first appear here.
 */
export const models: ModelDefinition[] = [
  particles, orbits, charges,
  cloth, pendulum,
  waves, fluid,
  boids, life, reaction, sand, slime,
];

export function findModel(id: string): ModelDefinition | undefined {
  return models.find((m) => m.id === id);
}
