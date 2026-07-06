/**
 * The render pipeline: typed data → schema validation → computed-field
 * augmentation → template render → gate-compliant markdown.
 *
 * This is the deterministic layer that frees the agent from format concerns.
 * The agent produces CONTENT (structured data conforming to a TypeBox schema);
 * renderStage validates it, augments computed fields, and renders it through a
 * Jinja-subset template. The result is consistently formatted every time.
 */

import { render } from "./template-engine.ts";
import { STAGE_MODELS, type StageModel } from "./schemas.ts";
import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");
const templateCache = new Map<string, string>();

function loadTemplate(name: string): string {
	const cached = templateCache.get(name);
	if (cached !== undefined) return cached;
	const body = readFileSync(join(TEMPLATES_DIR, name), "utf8");
	templateCache.set(name, body);
	return body;
}

export interface RenderResult {
	markdown: string;
	errors: string[];
}

/** Validate data against a TypeBox schema. Returns error strings (empty = valid). */
export function validateData(schema: StageModel["schema"], data: unknown): string[] {
	const errors: string[] = [];
	for (const err of Value.Errors(schema, data)) {
		const e = err as unknown as { path?: string; message: string };
		errors.push(`${e.path ?? "$"}: ${e.message}`);
	}
	return errors;
}

/** Augment data with computed fields the template needs (e.g. totalScenarios for
 *  BDD). These are DETERMINISTIC — never trust the model to count correctly. */
function augmentData(stageId: string, data: Record<string, unknown>): Record<string, unknown> {
	const augmented = { ...data };
	if (stageId === "bdd") {
		const features = (augmented.features as Array<{ scenarios: unknown[] }>) ?? [];
		augmented.totalScenarios = features.reduce((sum, f) => sum + (f.scenarios?.length ?? 0), 0);
		const traceability = augmented.traceability as Array<unknown> | undefined;
		augmented.totalACs = traceability?.length ?? 0;
	}
	return augmented;
}

/** Validate the agent's data against the stage's schema, augment computed fields,
 *  and render through the stage's template. Returns the markdown (or errors). */
export function renderStage(stageId: string, data: unknown): RenderResult {
	const model = STAGE_MODELS[stageId];
	if (!model) throw new Error(`renderStage: unknown stage "${stageId}". Known: ${Object.keys(STAGE_MODELS).join(", ")}`);

	const errors = validateData(model.schema, data);
	if (errors.length > 0) return { markdown: "", errors };

	const augmented = augmentData(stageId, data as Record<string, unknown>);
	const template = loadTemplate(model.template);
	const markdown = render(template, augmented);
	return { markdown, errors: [] };
}
