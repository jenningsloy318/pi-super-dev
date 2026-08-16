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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { specDoc, specDocs } from "../prompts.ts";
import type { SetupControl } from "../types.ts";
import { appendToKnowledge } from "./knowledge.ts";

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

/** Validate data against a TypeBox schema. Returns error strings (empty = valid).
 *
 *  Extra/unknown keys are TOLERATED: some stage schemas carry
 *  `additionalProperties: false` so they are STRICT-CAPABLE for the
 *  structured_output tool's constrained sampling (Feature 2) — that flag is
 *  NOT a render-validator directive. The templates render only the declared
 *  keys, so an extra key the model emitted is harmless to the doc; rejecting it
 *  here would fail a render (and its gate) on a harmless property. Required-key
 *  and type errors are still reported as before. */
export function validateData(schema: StageModel["schema"], data: unknown): string[] {
	const errors: string[] = [];
	for (const err of Value.Errors(schema, data)) {
		const e = err as unknown as { path?: string; message: string };
		if (e.message === "must not have additional properties") continue;
		errors.push(`${e.path ?? "$"}: ${e.message}`);
	}
	return errors;
}

/** Augment data with computed fields the template needs (e.g. totalScenarios for
 *  BDD). These are DETERMINISTIC — never trust the model to count correctly.
 *  Every doc also gets `generatedAt`: the exact render/write moment (ISO 8601,
 *  UTC, ms precision) — the agent's `date` is a self-reported calendar date;
 *  `generatedAt` is the pipeline-stamped creation time the user can rely on. */
function augmentData(stageId: string, data: Record<string, unknown>): Record<string, unknown> {
	const augmented: Record<string, unknown> = { ...data, generatedAt: new Date().toISOString() };
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

/** A doc reserved for a stage: the resolved absolute path + its `NN-<slug>.md`
 *  basename (for concise logging). */
export interface ReservedDoc {
	slug: string;
	path: string;
	name: string;
}

/**
 * Resolve — at STAGE START, before the agent runs — the EXACT `NN-<slug>.md`
 * path(s) this stage will write: the primary doc plus every `additionalDocs`
 * entry for a multi-doc stage (e.g. spec → specification / implementation-plan /
 * task-list). Paths are STABLE across retries (specDoc reuses an existing
 * per-slug file), so a stage that re-runs targets the same files instead of
 * drifting the index. Returns [] for a stage with no render model. Pure aside
 * from the filesystem READ specDoc performs; never writes.
 */
export function reserveStageDocs(setup: SetupControl, stageId: string): ReservedDoc[] {
	const model = STAGE_MODELS[stageId];
	if (!model) return [];
	const slugs = [model.slug, ...(model.additionalDocs?.map((d) => d.slug) ?? [])];
	// Resolve ALL of the stage's slugs together so a multi-doc stage (spec →
	// specification + implementation-plan + task-list) gets DISTINCT consecutive
	// indices. Resolving each slug independently made them collide on the same
	// index on a fresh run (08-specification / 08-implementation-plan / 08-task-list).
	const paths = specDocs(setup, slugs);
	return slugs.map((slug, i) => {
		const path = paths[i]!;
		return { slug, path, name: path.slice(path.lastIndexOf("/") + 1) };
	});
}

/** Validate the agent's data against the stage's schema, render the doc, and write
 *  it to the spec dir. Returns the doc path (or null on validation/render failure).
 *  Reusable by both writerTask (spec-review) and inline verify tasks (code-review,
 *  adversarial-review) so any task can use the render pipeline. */
export function renderAndWrite(
	setup: SetupControl,
	log: (m: string) => void,
	stageId: string,
	control: Record<string, unknown> | null,
): string | null {
	const model = STAGE_MODELS[stageId];
	if (!model || !control) return null;
	// Reserve the EXACT doc path(s) up front and log them, so every render (any
	// stage, any retry) writes to a deterministic, stream-visible NN-<slug>.md.
	// reserved[0] is the primary doc; the rest align with model.additionalDocs by
	// slug order. Reservation is idempotent (reuses an existing per-slug file), so
	// a re-run overwrites in place instead of allocating a new index.
	const reserved = reserveStageDocs(setup, stageId);
	const docPath = reserved[0]?.path ?? specDoc(setup, model.slug);
	log(`${stageId}: doc → ${docPath.slice(docPath.lastIndexOf("/") + 1)}`);
	const rendered = renderStage(stageId, control);
	if (rendered.errors.length > 0) {
		log(`${stageId}: render validation errors — ${rendered.errors.join("; ")}`);
		return null;
	}
	if (rendered.markdown) {
		writeFileSync(docPath, rendered.markdown);
		control.docPath = docPath;
		log(`${stageId}: rendered ${docPath} (${rendered.markdown.length} bytes)`);
		// Multi-doc: render additional docs from the same data (e.g. spec → 3 docs),
		// each to its RESERVED path (matched by slug so order can't drift).
		if (model.additionalDocs) {
			for (const extra of model.additionalDocs) {
				const extraPath = reserved.find((r) => r.slug === extra.slug)?.path ?? specDoc(setup, extra.slug);
				const extraMd = render(loadTemplate(extra.template), augmentData(stageId, control));
				writeFileSync(extraPath, extraMd);
				const key = extra.slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + "Path";
				control[key] = extraPath;
				log(`${stageId}: rendered ${extraPath} (${extraMd.length} bytes)`);
			}
		}
		// Spec-specific gate compatibility
		if (stageId === "spec") {
			control.specificationPath = docPath;
			control.phaseCount = String((control.phases as unknown[])?.length ?? 0);
		}
		// Auto-accumulate this stage's raw data to .knowledge.md
		appendToKnowledge(setup.specDirectory, stageId, control);
		return docPath;
	}
	return null;
}
