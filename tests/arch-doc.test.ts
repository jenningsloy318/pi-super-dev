/**
 * P4 (dsh-09 v3 Phase P): the generated architecture doc cannot drift — the
 * committed docs/ARCHITECTURE.md must equal renderArchitectureDoc() output.
 * On mismatch the failure message names the one-command regen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderArchitectureDoc } from "../src/render/arch-doc.ts";

const DOC = join(import.meta.dirname, "..", "docs", "ARCHITECTURE.md");

describe("generated architecture doc (P4)", () => {
	it("the committed doc equals the render from edges.ts + raci.ts", () => {
		const committed = readFileSync(DOC, "utf8");
		const rendered = renderArchitectureDoc();
		if (committed !== rendered) {
			throw new Error("docs/ARCHITECTURE.md is stale — run `npm run arch:doc` and commit the result (the doc must never be hand-edited).");
		}
	});

	it("renders the stage table, edges, and invalidation sets", () => {
		const body = renderArchitectureDoc();
		expect(body).toContain("## Stage table (RACI over the skeleton)");
		expect(body).toContain("## Dependency edges");
		expect(body).toContain("## Invalidation sets (D3 — downstreamOf, full reachability)");
		// every stage appears as a table row key
		expect((body.match(/^\| `/gm) ?? []).length).toBeGreaterThanOrEqual(17);
	});
});
