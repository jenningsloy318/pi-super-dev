/**
 * The eval layer was split into 5 cohesive modules at v0.4.20
 * (src/evolution/eval-layer/{closure,cases,rubrics,bands,agreement}.ts,
 * re-exported by index.ts). Source-contract tests that reason about the
 * layer's source as ONE body — the P6 single-grammar tripwire — must read all
 * five parts AND the barrel, otherwise a pin that lives in a sibling module
 * (or a DEC-6 closure literal re-typed in the barrel) silently reads as
 * absent.
 *
 * The scan surface is derived from disk and INCLUDES index.ts: the barrel is
 * part of the layer's source, so a literal landing there is caught too. Part
 * order is alphabetical (readdirSync().sort()), which is safe because every
 * tripwire pin is order-insensitive (contains/includes) — do not add a
 * region-order-sensitive assertion without making the order explicit.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Derived from disk (not a hand-maintained list): a future part or a literal
// landing in the barrel is caught automatically. Sorted for determinism; every
// tripwire pin is order-insensitive (contains). The barrel IS included — its
// only quoted strings are module specifiers, which match no closure value.
const LAYER_DIR = fileURLToPath(new URL("../../src/evolution/eval-layer/", import.meta.url));
const PARTS = readdirSync(LAYER_DIR).filter((f) => f.endsWith(".ts")).sort();

/** Concatenated source of the eval layer (parts + barrel, alphabetical). */
export function evalLayerSources(): string {
	return PARTS.map((p) => readFileSync(join(LAYER_DIR, p), "utf8")).join("\n");
}
