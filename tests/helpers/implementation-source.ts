/**
 * The implementation stage was split into 4 cohesive modules at v0.4.16
 * (src/stages/implementation/{red-evidence,phase-reentry,phase-status,stage}.ts,
 * re-exported by index.ts), with run-prepare.ts extracted from stage.ts at
 * v0.4.26. Source-contract tests that reason about the stage's source as ONE
 * body must read every part — otherwise a pin that lives in a sibling module
 * silently reads as absent.
 *
 * The scan surface is DERIVED FROM DISK and includes every non-index part in
 * the directory, so a future split or a literal landing in any part is caught
 * automatically (the v0.4.26 preamble extraction would otherwise have been
 * invisible here — the class the v0.4.23 fold closed for the eval layer).
 * Sorted alphabetically for determinism; every pin is order-insensitive
 * (contains/regex over the concatenated body) — do not add an order-sensitive
 * assertion without making the order explicit first.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PARTS = readdirSync(join(process.cwd(), "src", "stages", "implementation"))
	.filter((f) => f.endsWith(".ts") && f !== "index.ts")
	.sort();

/** Concatenated source of the implementation stage (every non-index part,
 *  alphabetical). */
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
