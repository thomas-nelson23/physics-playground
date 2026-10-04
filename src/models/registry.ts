import type { ModelDefinition } from "./types";
import { particles } from "./particles";
import { boids } from "./boids";
import { life } from "./life";

/**
 * Every model the app offers. To add a model, create a file in this folder
 * that exports a `ModelDefinition` and add it to this list.
 */
export const models: ModelDefinition[] = [particles, boids, life];

export function findModel(id: string): ModelDefinition | undefined {
  return models.find((m) => m.id === id);
}
