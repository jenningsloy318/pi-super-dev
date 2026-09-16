/**
 * Concatenated source of the artifact-convergence stage. The monolith was split
 * at v0.4.17e into validators / feedback / rounds / node / nodes; source-contract
 * tests that pin textual anchors read this concatenation instead of the
 * re-export barrel (the barrel is 7 lines of `export {} from` and would hollow
 * every pin). Part order follows the pre-split file layout.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PARTS = ["validators.ts", "feedback.ts", "rounds.ts", "node.ts", "nodes.ts"];

export function artifactConvergenceSources(root = process.cwd()): string {
	return PARTS.map((part) => readFileSync(join(root, "src", "stages", "artifact-convergence", part), "utf8")).join("\n");
}
