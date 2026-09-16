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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PARTS = ["closure.ts", "cases.ts", "rubrics.ts", "bands.ts", "agreement.ts"];

/** Concatenated source of the eval layer. Part order follows the pre-split
 *  file layout. */
export function evalLayerSources(root = process.cwd()): string {
	return PARTS.map((p) => readFileSync(join(root, "src", "evolution", "eval-layer", p), "utf8")).join("\n");
}
