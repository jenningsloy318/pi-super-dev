/**
 * The implementation stage was split into 4 cohesive modules at v0.4.16
 * (src/stages/implementation/{red-evidence,phase-reentry,phase-status,stage}.ts,
 * re-exported by index.ts). Source-contract tests that reason about the stage's
 * source as ONE body must read all four parts — otherwise a pin that lives in a
 * sibling module silently reads as absent.
 *
 * Order mirrors the pre-split file layout so line-order-sensitive assertions
 * (e.g. "declared before it is used") still hold.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PARTS = ["red-evidence.ts", "phase-reentry.ts", "phase-status.ts", "stage.ts"];

/** Concatenated source of the implementation stage, in pre-split order. */
export function implementationSources(root = process.cwd()): string {
	return PARTS.map((p) => readFileSync(join(root, "src", "stages", "implementation", p), "utf8")).join("\n");
}

/** The stage body — the 063/v0.3.x contract pins (control shape, wiring) live here. */
export function implementationStageSource(root = process.cwd()): string {
	return readFileSync(join(root, "src", "stages", "implementation", "stage.ts"), "utf8");
}

// ─── verify (v0.4.17c split: evidence/boundary/steps/nodes) ───────────────
const VERIFY_PARTS = ["evidence.ts", "boundary.ts", "steps.ts", "nodes.ts"];

/** Concatenated source of the verify stage, in pre-split order. */
export function verifySources(root = process.cwd()): string {
	return VERIFY_PARTS.map((p) => readFileSync(join(root, "src", "stages", "verify", p), "utf8")).join("\n");
}
