/**
 * The eval layer was split into 5 cohesive modules at v0.4.20
 * (src/evolution/eval-layer/{closure,cases,rubrics,bands,agreement}.ts,
 * re-exported by index.ts). Source-contract tests that reason about the
 * layer's source as ONE body — the P6 single-grammar tripwire — must read all
 * five parts, otherwise a pin that lives in a sibling module silently reads
 * as absent.
 *
 * Order mirrors the pre-split file layout (closure → cases → rubrics → bands
 * → agreement) so region-order-sensitive assertions still hold.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Derived from disk (not a hand-maintained list): a future part or a literal
// landing in the barrel is caught automatically. Sorted for determinism; every
// tripwire pin is order-insensitive (contains).
const LAYER_DIR = fileURLToPath(new URL("../../src/evolution/eval-layer/", import.meta.url));
const PARTS = readdirSync(LAYER_DIR).filter((f) => f.endsWith(".ts") && f !== "index.ts").sort();

/** Concatenated source of the eval layer. Part order follows the pre-split
 *  file layout. */
export function evalLayerSources(): string {
	return PARTS.map((p) => readFileSync(join(LAYER_DIR, p), "utf8")).join("\n");
}
