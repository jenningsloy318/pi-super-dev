/**
 * H4 (AC-04 / SCENARIO-008/009): STAGE_CALL_PREFIXES coverage —
 *
 * 1. SCENARIO-009 drift-guard TRIPWIRE: enumerate every `pipeline.` call-id
 *    literal in the sources of `src/stages/` + `src/replan/` (block/line
 *    comments stripped; template heads cut at the first `${` so
 *    `pipeline.prototype.r${…}` normalizes to `pipeline.prototype.`) and assert
 *    each is covered by a prefix of its owning stage's STAGE_CALL_PREFIXES
 *    entry, by the unconditional judge/replan invalidation union, or maps to a
 *    deliberate `[]`. Any newly introduced `pipeline.…` call id fails here
 *    until registered (the uncovered-literal list must stay empty).
 * 2. SCENARIO-008: the debug/assessment/prototype prefixes (+ the deliberate
 *    `classify: []` per drift resolution D2) exist exactly as designed.
 * 3. Behavioral: invalidateResumeCache(downstreamOf("requirements")) drops the
 *    prototype/debug/assessment rows.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE_CALL_PREFIXES, ALWAYS_INVALIDATED_PREFIXES, invalidateResumeCache } from "../src/replan/replan.ts";
import { downstreamOf } from "../src/graph/edges.ts";

const SRC_ROOT = join(import.meta.dirname, "..", "src");

/** Every non-test .ts source under src/stages + src/replan. */
function sourceFiles(): string[] {
	const out: string[] = [];
	for (const dir of ["stages", "replan"]) {
		const root = join(SRC_ROOT, dir);
		for (const name of readdirSync(root)) {
			if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
			out.push(join(root, name));
		}
	}
	return out;
}

/** Strip block comments (incl. the `pipeline.<callId>@<scope>#<n>` doc
 *  example in replan.ts) and full-line `//` comments. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");
}

/** The normalized `pipeline.` call-id literals used by agent/emission sites.
 *  A template literal's HEAD (up to the first `${`) is its stable prefix. */
function stageCallLiterals(): string[] {
	const found = new Set<string>();
	const consider = (content: string): void => {
		if (!content.startsWith("pipeline.")) return;
		const head = content.includes("${") ? content.slice(0, content.indexOf("${")) : content;
		if (head) found.add(head);
	};
	for (const file of sourceFiles()) {
		const text = stripComments(readFileSync(file, "utf8"));
		for (const m of text.matchAll(/"([^"\n]*)"/g)) consider(m[1]!);
		for (const m of text.matchAll(/'([^'\n]*)'/g)) consider(m[1]!);
		for (const m of text.matchAll(/`([^`]*)`/g)) consider(m[1]!);
	}
	return [...found].sort();
}

/** The union of every invalidating prefix (per-stage entries + the AC-05
 *  unconditional judge/replan union — exactly what invalidateResumeCache uses). */
const ALL_PREFIXES = [...new Set([...Object.values(STAGE_CALL_PREFIXES).flat(), ...ALWAYS_INVALIDATED_PREFIXES])];

/** Longest stage-key match after `pipeline.` — the literal's owning stage. */
function owningStage(literal: string): string | null {
	const rest = literal.slice("pipeline.".length);
	const keys = Object.keys(STAGE_CALL_PREFIXES).filter((k) => rest === k || rest.startsWith(k));
	if (keys.length === 0) return null;
	return keys.sort((a, b) => b.length - a.length)[0] ?? null;
}

function uncoveredLiterals(literals: string[]): string[] {
	const out: string[] = [];
	for (const lit of literals) {
		// `pipeline.${stageId}` pass-through ids (e.g. countStageRounds over a
		// dynamic stage) enumerate the static writer ids — already covered below.
		if (lit === "pipeline.") continue;
		const owner = owningStage(lit);
		if (owner !== null && (STAGE_CALL_PREFIXES[owner] ?? []).length === 0) continue; // deliberate [] mapping
		if (ALL_PREFIXES.some((p) => lit === p || lit.startsWith(p))) continue;
		out.push(lit);
	}
	return out;
}

describe("STAGE_CALL_PREFIXES coverage — SCENARIO-009 drift-guard tripwire", () => {
	it("every pipeline. call-id literal in src/stages + src/replan is covered (uncovered list empty)", () => {
		const literals = stageCallLiterals();
		// sanity: the tripwire actually sees the known emission shapes
		for (const must of ["pipeline.debug", "pipeline.assessment", "pipeline.prototype.", "pipeline.classify", "pipeline.judge.", "pipeline.replan.lead", "pipeline.requirements"]) {
			expect(literals, `tripwire must see ${must}`).toContain(must);
		}
		expect(uncoveredLiterals(literals), "uncovered pipeline. literals (register them in STAGE_CALL_PREFIXES or map the stage deliberately to [])").toEqual([]);
	});

	it("the deliberate [] mappings are exactly the audited set (a new [] entry trips this pin)", () => {
		expect(Object.keys(STAGE_CALL_PREFIXES).filter((k) => STAGE_CALL_PREFIXES[k]!.length === 0).sort()).toEqual(["classify", "merge-verify", "preMergeBuild"]);
	});
});

describe("STAGE_CALL_PREFIXES entries — SCENARIO-008", () => {
	it("contributes debug / assessment / prototype prefixes and the deliberate classify: [] (D2)", () => {
		expect(STAGE_CALL_PREFIXES.debug).toEqual(["pipeline.debug"]);
		expect(STAGE_CALL_PREFIXES.assessment).toEqual(["pipeline.assessment"]);
		expect(STAGE_CALL_PREFIXES.prototype).toEqual(["pipeline.prototype."]);
		expect(STAGE_CALL_PREFIXES.classify).toEqual([]);
	});

	it("invalidateResumeCache drops the prototype/debug/assessment rows for owner=requirements (downstreamOf)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-prefix-"));
		try {
			writeFileSync(join(d, ".resume-cache.jsonl"), [
				'{"key":"pipeline.debug@root#1","result":{}}',
				'{"key":"pipeline.assessment@root#2","result":{}}',
				'{"key":"pipeline.prototype.r01@root#3","result":{}}',
			].join("\n") + "\n");
			const dropped = invalidateResumeCache(d, downstreamOf("requirements"));
			expect(dropped).toBe(3);
			expect(readFileSync(join(d, ".resume-cache.jsonl"), "utf8").trim()).toBe("");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
