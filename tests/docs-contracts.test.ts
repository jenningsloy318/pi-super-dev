/**
 * P0 (dsh-09 v3): docs contracts — the plan-doc Status lifecycle (dsh-08 L-2)
 * and the defensive-patterns/postmortem invariants, machine-checked.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REQ_DIR = join(import.meta.dirname, "..", "docs", "requirements");

describe("docs contracts (P0)", () => {
	const files = readdirSync(REQ_DIR).filter((f) => f.endsWith(".md"));

	it("every requirements doc carries a Status line in its first 5 lines", () => {
		const missing: string[] = [];
		for (const f of files) {
			const head = readFileSync(join(REQ_DIR, f), "utf8").split("\n").slice(0, 5);
			if (!head.some((l) => /^>?\s*Status:/i.test(l))) missing.push(f);
		}
		expect(missing).toEqual([]);
	});

	it("every implemented Status claim cites a commit", () => {
		const offenders: string[] = [];
		for (const f of files) {
			const head = readFileSync(join(REQ_DIR, f), "utf8").split("\n").slice(0, 5).join(" ");
			const m = head.match(/Status:\s*\*?\*?implemented/i);
			// "(this commit)" is the one legal hash-free citation: the doc shipping WITH
		// its implementing commit cannot know its own hash.
		if (m && !/[0-9a-f]{7,}/.test(head) && !head.includes("(this commit")) offenders.push(f);
		}
		expect(offenders).toEqual([]);
	});

	it("defensive-patterns: rule 6 exists with its exact contract wording, rules numbered contiguously", () => {
		const body = readFileSync(join(REQ_DIR, "defensive-patterns.md"), "utf8");
		expect(body).toContain("A verdict pin and a triage defer must never disagree about who can act");
		const nums = [...body.matchAll(/^\d+\.\s+\*\*/gm)].map((m) => Number(m[0]));
		// contiguous 1..N in order (matchAll gives the leading number of each rule heading)
		const ruleNums = [...body.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => Number(m[1]));
		expect(ruleNums).toEqual(ruleNums.map((_, i) => i + 1));
	});

	it("postmortem-0001: both case studies and the vocabulary table are present", () => {
		const body = readFileSync(join(REQ_DIR, "postmortem-0001-verify-loop-dead-state.md"), "utf8");
		expect(body).toContain("Case study 1");
		expect(body).toContain("Case study 2");
		expect(body).toContain("## Loop vocabulary");
		expect(body).toContain("## Degradation ladder");
		expect(body).toContain("blocked-on-decisions");
	});
});
