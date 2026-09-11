/**
 * EVAL LAYER (P1) — golden cases + rubrics + validation-gate machinery
 * (docs/requirements/sdlc-tips-adoption.md: D1/D2/D7, DEC-5/6/7/13,
 * §8.1/§8.2/§8.5 folds).
 *
 * P2-documented seam: everything here runs on SYNTHETIC data in temp dirs —
 * no test ever touches ~/.super-dev (the loaders take injected dirs; the
 * template writers require an explicit dir).
 *
 * Contract under test:
 *  - DEC-6 closure table: composed from the REAL runtime vocabularies
 *    (helpers.ts / prototype.ts / judge.ts / fault-classification.ts) —
 *    every real enum value accepted, fabricated ones rejected, and a
 *    source-scan tripwire pins the import graph (P6 single grammar).
 *  - Schema: all seven golden-case fields validated; every failure mode
 *    loud + skipped (missing canary, bad verdict, unknown stage/agent,
 *    outside-repo source, caseVersion < 1, …).
 *  - Loaders: cold start empty; multi-file; per-case loud skip; id ==
 *    file basename (one case per file structural); template writers emit
 *    validator-passing skeletons.
 *  - Gate: agreement math, calibration deciles, bootstrap CI determinism,
 *    n<8 directional-only posture, named policy constants, bandKey shape.
 *
 * Review round F1–F10 (owner-adjudicated): three-arm target grammar
 * (compound | stage-only | agent-only); rubric mustNot optional on the wire;
 * scorer-row dedup with honest duplicate accounting; n=0-before-n<8 gate
 * ordering; bootstrap only at n≥8; conservative target→verdict-family
 * mapping (fail-open default); id/rubricId == file basename; source
 * stat+realpath containment; wx template writes; optional caseSet +
 * caseSetOf derivation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	VERDICT_CLOSURE, TARGET_STAGES, TARGET_AGENTS, makeCanary,
	validateGoldenCase, loadGoldenCases, type GoldenCase,
	validateRubric, loadRubrics, RUBRIC_SCALE,
	writeGoldenCaseTemplate, writeRubricTemplate,
	bandKey, caseSetOf,
	validateGateLabels, loadGateLabels, type GateLabels,
	computeGateAgreement, gatePasses,
	TARGET_VERDICT_FAMILIES, VERDICT_FAMILY_VALUES, targetVerdictFamilies, allowedVerdictsForTarget,
	GATE_MIN_AGREEMENT, GATE_MIN_MATCHED_PAIRS, GATE_BOOTSTRAP_RESAMPLES, GATE_BOOTSTRAP_SEED,
	type ScorerVerdictRow, type MaintainerVerdict,
} from "../src/evolution/eval-layer.ts";
// The REAL vocabularies, imported from their owners — the closure table must
// be composed of exactly these (P6).
import { REVIEW_VERDICT_VALUES } from "../src/helpers.ts";
import { PROTOTYPE_VERDICT_VALUES } from "../src/stages/prototype.ts";
import { JUDGE_EVAL_VERDICT_VALUES } from "../src/stages/judge.ts";
import { FAULT_CLASS_VALUES } from "../src/fault-classification.ts";
import { MIN_PRIOR_RUNS } from "../src/evolution/sigma-bands.ts";

const ALL_FAMILY_VALUES = [...REVIEW_VERDICT_VALUES, ...PROTOTYPE_VERDICT_VALUES, ...JUDGE_EVAL_VERDICT_VALUES, ...FAULT_CLASS_VALUES];

// ─── temp-dir plumbing (hermetic — never ~/.super-dev) ──────────────────────

let tmpRoot: string;
beforeAll(() => { tmpRoot = mkdtempSync(join(tmpdir(), "sd-eval-layer-")); });
afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

/** Fresh subdirectory per test; returns [dir, capturedLogLines]. */
function newDir(name: string): { dir: string; lines: string[] } {
	const dir = join(tmpRoot, name);
	mkdirSync(dir, { recursive: true });
	return { dir, lines: [] };
}

function writeJson(dir: string, file: string, value: unknown): void {
	writeFileSync(join(dir, file), JSON.stringify(value, null, "\t"), "utf8");
}

// ─── fixtures ───────────────────────────────────────────────────────────────

/** A wire-form golden case known valid; `over` merges last (callers embedding
 *  a custom scenario must embed the canary for the id they choose). The
 *  default target/verdict pair sits in the prototype family (F6). */
function caseWire(over: Record<string, unknown> = {}): Record<string, unknown> {
	const id = (over.id as string) ?? "gc-0001";
	return {
		id,
		title: "Prototype loop terminates at the round cap",
		source: "docs/requirements/sdlc-tips-adoption.md",
		target: "prototype|prototype-runner",
		scenario: `28+ rounds of unmatched verdict strings (postmortem 0001 case 3 shape).\n${makeCanary(String(id))}`,
		expected: { verdict: "pass", mustHold: ["loop exits at the round cap"], mustNot: [] },
		caseVersion: 1,
		...over,
	};
}

/** A parsed-form golden case for seam tests (per-target breakdown, caseSetOf). */
const BASE_GC: GoldenCase = {
	id: "gc-x",
	title: "t",
	source: "docs/requirements/sdlc-tips-adoption.md",
	target: { raw: "prototype|prototype-runner", arm: "compound", stage: "prototype", agent: "prototype-runner" },
	scenario: "s",
	expected: { verdict: "pass" },
	caseVersion: 1,
};

function rubricWire(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		rubricId: "rubric-1",
		version: "2.0.1",
		dimensions: [{ name: "termination", guidance: "does the loop terminate honestly", mustHold: ["round cap reached OR verdict match"], mustNot: ["unbounded re-asking"] }],
		scale: RUBRIC_SCALE,
		...over,
	};
}

function row(caseId: string, verdict: string, confidence: number, caseVersion = 1): ScorerVerdictRow {
	return { caseId, caseVersion, verdict, confidence };
}

function label(caseId: string, expectedByHuman: string, caseVersion = 1): MaintainerVerdict {
	return { caseId, caseVersion, expectedByHuman };
}

// ─── canary (§8.1) ──────────────────────────────────────────────────────────

describe("makeCanary (§8.1 contamination tripwire)", () => {
	it("is deterministic in the case id and GUID-shaped", () => {
		expect(makeCanary("gc-0001")).toBe(makeCanary("gc-0001"));
		expect(makeCanary("gc-0001")).not.toBe(makeCanary("gc-0002"));
		expect(makeCanary("gc-0001")).toMatch(/^canary-guid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});

// ─── DEC-6 closure table ────────────────────────────────────────────────────

describe("verdict closure table (DEC-6)", () => {
	it("family vocabularies are pinned (contract tables — literals live in tests only)", () => {
		expect(REVIEW_VERDICT_VALUES).toEqual(["Approved", "Approved with Comments", "Changes Requested", "Blocked"]);
		expect(PROTOTYPE_VERDICT_VALUES).toEqual(["pass", "fail"]);
		expect(JUDGE_EVAL_VERDICT_VALUES).toEqual(["accepted", "discarded"]);
		expect(FAULT_CLASS_VALUES).toEqual(["environmental-blocker", "product-defect", "unclassified"]);
	});

	it("closure == exactly the union of the real families (no extras, no omissions)", () => {
		expect([...VERDICT_CLOSURE].sort()).toEqual([...ALL_FAMILY_VALUES].sort());
	});

	it("every REAL enum value is accepted as expected.verdict on a target that resolves to its family (F6)", () => {
		const familyTargets = {
			review: "verify|code-reviewer",
			prototype: "prototype|prototype-runner",
			judge: "judge",
			fault: "red-boundary-classifier",
		};
		const families: Array<{ target: string; values: readonly string[] }> = [
			{ target: familyTargets.review, values: REVIEW_VERDICT_VALUES },
			{ target: familyTargets.prototype, values: PROTOTYPE_VERDICT_VALUES },
			{ target: familyTargets.judge, values: JUDGE_EVAL_VERDICT_VALUES },
			{ target: familyTargets.fault, values: FAULT_CLASS_VALUES },
		];
		for (const { target, values } of families) {
			for (const verdict of values) {
				const check = validateGoldenCase(caseWire({ target, expected: { verdict } }));
				expect(check.ok, `verdict "${verdict}" on target "${target}" must validate`).toBe(true);
			}
		}
	});

	it("fabricated verdicts are rejected loudly (closure floor fires first)", () => {
		for (const verdict of ["PASSED", "Changes Approved", "changes requested", "PROTOTYPE_SKIPPED", "Accepted", "defect", "product-defects", ""]) {
			const check = validateGoldenCase(caseWire({ expected: { verdict } }));
			expect(check.ok, `verdict "${verdict}" must be rejected`).toBe(false);
			if (!check.ok) expect(check.reasons.join(" ")).toContain("expected.verdict");
		}
	});

	it("prototype runtime list == schemas.ts PrototypeData union literals (P6 dynamic cross-check)", async () => {
		const { PrototypeData } = await import("../src/render/schemas.ts");
		const literals = (PrototypeData as { properties: { verdict: { anyOf?: Array<{ const: string }> } } }).properties.verdict.anyOf?.map((e) => e.const) ?? [];
		expect([...literals].sort()).toEqual([...PROTOTYPE_VERDICT_VALUES].sort());
	});

	it("source-scan tripwire: eval-layer imports the real vocabularies and never re-types a closure literal (P6)", () => {
		const src = readFileSync(fileURLToPath(new URL("../src/evolution/eval-layer.ts", import.meta.url)), "utf8");
		// The closure is COMPOSED from the imported family constants…
		for (const spread of ["...REVIEW_VERDICT_VALUES", "...PROTOTYPE_VERDICT_VALUES", "...JUDGE_EVAL_VERDICT_VALUES", "...FAULT_CLASS_VALUES"]) {
			expect(src).toContain(spread);
		}
		// …which come from their owner modules…
		for (const specifier of ['"../helpers.ts"', '"../stages/prototype.ts"', '"../stages/judge.ts"', '"../fault-classification.ts"', '"../graph/edges.ts"', '"../agents/register-agents.ts"', '"./sigma-bands.ts"']) {
			expect(src).toContain(specifier);
		}
		for (const symbol of ["REVIEW_VERDICT_VALUES", "PROTOTYPE_VERDICT_VALUES", "JUDGE_EVAL_VERDICT_VALUES", "FAULT_CLASS_VALUES", "STAGE_IDS", "REGISTERED_AGENTS", "MIN_PRIOR_RUNS"]) {
			expect(src).toContain(symbol);
		}
		// …and no closure value is ever re-typed as a string literal in the module.
		for (const value of ALL_FAMILY_VALUES) {
			expect(src.includes(`"${value}"`), `eval-layer.ts must not re-type the closure literal "${value}"`).toBe(false);
		}
	});
});

// ─── F6 target→verdict-family mapping ───────────────────────────────────────

describe("TARGET_VERDICT_FAMILIES (F6 conservative mapping, fail-open default)", () => {
	it("mapping keys are real stages/agents; families map to the real vocabularies", () => {
		for (const key of Object.keys(TARGET_VERDICT_FAMILIES.stage)) expect(TARGET_STAGES).toContain(key);
		for (const key of Object.keys(TARGET_VERDICT_FAMILIES.agent)) expect(TARGET_AGENTS).toContain(key);
		expect(VERDICT_FAMILY_VALUES.review).toBe(REVIEW_VERDICT_VALUES);
		expect(VERDICT_FAMILY_VALUES.prototype).toBe(PROTOTYPE_VERDICT_VALUES);
		expect(VERDICT_FAMILY_VALUES.judge).toBe(JUDGE_EVAL_VERDICT_VALUES);
		expect(VERDICT_FAMILY_VALUES.fault).toBe(FAULT_CLASS_VALUES);
		expect([...VERDICT_CLOSURE].sort()).toEqual([...VERDICT_FAMILY_VALUES.review, ...VERDICT_FAMILY_VALUES.prototype, ...VERDICT_FAMILY_VALUES.judge, ...VERDICT_FAMILY_VALUES.fault].sort());
	});

	it("targetVerdictFamilies resolves arms (suffix rule, compound union, empty = unmapped)", () => {
		expect(targetVerdictFamilies({ stage: "verify", agent: "code-reviewer" })).toEqual(["review"]);
		expect(targetVerdictFamilies({ stage: "prototype", agent: "judge" })).toEqual(["prototype", "judge"]);
		expect(targetVerdictFamilies({ stage: "setup" })).toEqual([]);
		expect(targetVerdictFamilies({ agent: "adversarial-reviewer" })).toEqual(["review"]); // "-reviewer" suffix rule
		expect(targetVerdictFamilies({ agent: "implementer" })).toEqual([]); // unmapped agent
	});

	it("allowedVerdictsForTarget: family union; unmapped fail-opens to the FULL closure", () => {
		expect(allowedVerdictsForTarget({ agent: "judge" })).toEqual([...JUDGE_EVAL_VERDICT_VALUES]);
		expect([...allowedVerdictsForTarget({ stage: "prototype", agent: "judge" })].sort()).toEqual([...PROTOTYPE_VERDICT_VALUES, ...JUDGE_EVAL_VERDICT_VALUES].sort());
		expect(allowedVerdictsForTarget({ agent: "orchestrator" })).toEqual([...VERDICT_CLOSURE]);
	});

	it("unmapped targets fail-open: every closure value is admitted (F6)", () => {
		for (const verdict of ALL_FAMILY_VALUES) {
			const check = validateGoldenCase(caseWire({ target: "orchestrator", expected: { verdict } }));
			expect(check.ok, `verdict "${verdict}" on unmapped target must validate (fail-open)`).toBe(true);
		}
	});

	it("mapped targets REJECT verdicts from other families, loudly (F6)", () => {
		// judge (agent-only) — the ruling's example home for judge verdicts
		expect(validateGoldenCase(caseWire({ target: "judge", expected: { verdict: "accepted" } })).ok).toBe(true);
		const judgeReject = validateGoldenCase(caseWire({ target: "judge", expected: { verdict: "pass" } }));
		expect(judgeReject.ok).toBe(false);
		if (!judgeReject.ok) expect(judgeReject.reasons.join(" ")).toContain("not admitted by target");
		// prototype target rejects judge and review verdicts
		expect(validateGoldenCase(caseWire({ target: "prototype|prototype-runner", expected: { verdict: "accepted" } })).ok).toBe(false);
		expect(validateGoldenCase(caseWire({ target: "prototype|prototype-runner", expected: { verdict: "Approved" } })).ok).toBe(false);
		// review stage-only target rejects prototype verdicts
		expect(validateGoldenCase(caseWire({ target: "verify", expected: { verdict: "pass" } })).ok).toBe(false);
		// fault agent target rejects review verdicts
		expect(validateGoldenCase(caseWire({ target: "red-boundary-classifier", expected: { verdict: "Blocked" } })).ok).toBe(false);
		// compound with one mapped + one unmapped arm: the mapped arm governs
		expect(validateGoldenCase(caseWire({ target: "verify|implementer", expected: { verdict: "Approved" } })).ok).toBe(true);
		expect(validateGoldenCase(caseWire({ target: "verify|implementer", expected: { verdict: "pass" } })).ok).toBe(false);
		// compound with arms in DIFFERENT families: either family admits
		expect(validateGoldenCase(caseWire({ target: "prototype|judge", expected: { verdict: "accepted" } })).ok).toBe(true);
		expect(validateGoldenCase(caseWire({ target: "prototype|judge", expected: { verdict: "pass" } })).ok).toBe(true);
		expect(validateGoldenCase(caseWire({ target: "prototype|judge", expected: { verdict: "Approved" } })).ok).toBe(false);
	});
});

// ─── golden-case schema (DEC-6 seven fields + optional caseSet) ─────────────

describe("validateGoldenCase", () => {
	it("accepts the known-valid fixture", () => {
		const check = validateGoldenCase(caseWire());
		expect(check.ok).toBe(true);
		if (check.ok) {
			expect(check.value.target).toEqual({ raw: "prototype|prototype-runner", arm: "compound", stage: "prototype", agent: "prototype-runner" });
			expect(check.value.caseVersion).toBe(1);
			expect(check.value.expected.mustHold).toEqual(["loop exits at the round cap"]);
			expect(check.value.caseSet).toBeUndefined();
		}
	});

	it("three-arm grammar: stage-only and agent-only targets parse (F1)", () => {
		const stageOnly = validateGoldenCase(caseWire({ target: "spec", expected: { verdict: "Approved" } }));
		expect(stageOnly.ok).toBe(true);
		if (stageOnly.ok) expect(stageOnly.value.target).toEqual({ raw: "spec", arm: "stage", stage: "spec" });
		const agentOnly = validateGoldenCase(caseWire({ target: "judge", expected: { verdict: "discarded" } }));
		expect(agentOnly.ok).toBe(true);
		if (agentOnly.ok) expect(agentOnly.value.target).toEqual({ raw: "judge", arm: "agent", agent: "judge" });
		const compound = validateGoldenCase(caseWire({ target: "prototype|prototype-runner" }));
		expect(compound.ok).toBe(true);
		if (compound.ok) expect(compound.value.target).toEqual({ raw: "prototype|prototype-runner", arm: "compound", stage: "prototype", agent: "prototype-runner" });
	});

	it("rejects a missing canary loudly (§8.1)", () => {
		const check = validateGoldenCase(caseWire({ scenario: "scenario with no canary at all" }));
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.reasons.join(" ")).toContain("canary");
	});

	it("rejects unknown target stage / agent against the closed sets", () => {
		const stage = validateGoldenCase(caseWire({ target: "not-a-stage|implementer" }));
		expect(stage.ok).toBe(false);
		if (!stage.ok) expect(stage.reasons.join(" ")).toContain("target.stage");
		const agent = validateGoldenCase(caseWire({ target: "spec|not-an-agent" }));
		expect(agent.ok).toBe(false);
		if (!agent.ok) expect(agent.reasons.join(" ")).toContain("target.agent");
		expect(TARGET_STAGES).toContain("prototype");
		expect(TARGET_AGENTS).toContain("prototype-runner");
	});

	it("rejects malformed target strings (separator grammar + single-unmapped)", () => {
		for (const target of ["a|b|c", "|implementer", "spec|", "", "not-a-stage"]) {
			const check = validateGoldenCase(caseWire({ target }));
			expect(check.ok, `target "${target}" must be rejected`).toBe(false);
			if (!check.ok) expect(check.reasons.join(" ")).toContain("target");
		}
	});

	it("rejects sources outside the repo or missing in-repo", () => {
		for (const source of ["../outside-the-repo.md", "/etc/passwd", "docs/requirements/does-not-exist.md"]) {
			const check = validateGoldenCase(caseWire({ source }));
			expect(check.ok, `source "${source}" must be rejected`).toBe(false);
			if (!check.ok) expect(check.reasons.join(" ")).toContain("source:");
		}
	});

	it("source must be a regular FILE — directories rejected (F8)", () => {
		const { dir } = newDir("src-dir");
		mkdirSync(join(dir, "docs")); // a directory inside the injected repo root
		const check = validateGoldenCase(caseWire({ source: "docs" }), { repoRoot: dir });
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.reasons.join(" ")).toContain("not a regular file");
	});

	it("source symlink escaping the repo root is rejected on the REAL path (F8)", () => {
		const outside = newDir("src-outside");
		const inside = newDir("src-inside");
		writeFileSync(join(outside.dir, "secret.md"), "outside", "utf8");
		symlinkSync(join(outside.dir, "secret.md"), join(inside.dir, "escape.md"));
		const check = validateGoldenCase(caseWire({ source: "escape.md" }), { repoRoot: inside.dir });
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.reasons.join(" ")).toContain("symlink target resolves outside");
		// a real in-root (injected-root) file still passes
		writeFileSync(join(inside.dir, "real.md"), "x", "utf8");
		expect(validateGoldenCase(caseWire({ source: "real.md" }), { repoRoot: inside.dir }).ok).toBe(true);
	});

	it("rejects caseVersion < 1 / non-integer", () => {
		for (const caseVersion of [0, -1, 1.5, "1", true, null]) {
			const check = validateGoldenCase(caseWire({ caseVersion }));
			expect(check.ok, `caseVersion ${JSON.stringify(caseVersion)} must be rejected`).toBe(false);
			if (!check.ok) expect(check.reasons.join(" ")).toContain("caseVersion");
		}
	});

	it("requires every one of the seven fields", () => {
		for (const key of ["id", "title", "source", "target", "scenario", "expected", "caseVersion"]) {
			const wire = caseWire();
			delete wire[key];
			const check = validateGoldenCase(wire);
			expect(check.ok, `missing ${key} must be rejected`).toBe(false);
			if (!check.ok) expect(check.reasons.join(" ")).toContain(key);
		}
	});

	it("caseSet: optional, non-empty when present, no band-key separator (F10)", () => {
		const withSet = validateGoldenCase(caseWire({ caseSet: "core" }));
		expect(withSet.ok).toBe(true);
		if (withSet.ok) expect(withSet.value.caseSet).toBe("core");
		for (const bad of ["", "a::b"]) {
			const check = validateGoldenCase(caseWire({ caseSet: bad }));
			expect(check.ok, `caseSet ${JSON.stringify(bad)} must be rejected`).toBe(false);
			if (!check.ok) expect(check.reasons.join(" ")).toContain("caseSet");
		}
	});

	it("rejects malformed mustHold/mustNot assertion lists", () => {
		for (const bad of [["ok", 42], "not-an-array", [""]]) {
			const check = validateGoldenCase(caseWire({ expected: { verdict: "pass", mustHold: bad } }));
			expect(check.ok, `mustHold ${JSON.stringify(bad)} must be rejected`).toBe(false);
			if (!check.ok) expect(check.reasons.join(" ")).toContain("expected.mustHold");
		}
	});

	it("non-object case is rejected", () => {
		for (const bad of [null, [], "text", 42]) {
			expect(validateGoldenCase(bad).ok).toBe(false);
		}
	});
});

// ─── golden-case loader (DEC-5) ─────────────────────────────────────────────

describe("loadGoldenCases", () => {
	it("cold start: missing dir is an empty dataset, never an error", () => {
		const { dir, lines } = newDir("cold-start");
		const loaded = loadGoldenCases(join(dir, "does-not-exist"), { log: (l) => lines.push(l) });
		expect(loaded.cases).toEqual([]);
		expect(loaded.skipped).toEqual([]);
		expect(lines).toEqual([]);
	});

	it("loads multiple files; non-JSON files are ignored", () => {
		const { dir } = newDir("multi");
		writeJson(dir, "gc-a.json", caseWire({ id: "gc-a" }));
		writeJson(dir, "gc-b.json", caseWire({ id: "gc-b", target: "verify|code-reviewer", expected: { verdict: "Changes Requested" } }));
		writeFileSync(join(dir, "readme.txt"), "not a case", "utf8");
		const loaded = loadGoldenCases(dir, { log: () => {} });
		expect(loaded.cases.map((c) => c.id).sort()).toEqual(["gc-a", "gc-b"]);
		expect(loaded.skipped).toEqual([]);
	});

	it("skips an invalid case LOUDLY (file + field + reason) and keeps the rest", () => {
		const { dir, lines } = newDir("loud-skip");
		writeJson(dir, "gc-a.json", caseWire({ id: "gc-a" }));
		writeJson(dir, "gc-bad.json", caseWire({ id: "gc-bad", expected: { verdict: "PASSED" } }));
		writeJson(dir, "gc-c.json", caseWire({ id: "gc-c" }));
		const loaded = loadGoldenCases(dir, { log: (l) => lines.push(l) });
		expect(loaded.cases.map((c) => c.id)).toEqual(["gc-a", "gc-c"]);
		expect(loaded.skipped).toHaveLength(1);
		expect(loaded.skipped[0]!.file).toBe("gc-bad.json");
		expect(loaded.skipped[0]!.reasons.join(" ")).toContain("expected.verdict");
		expect(lines.join("\n")).toContain("gc-bad.json");
	});

	it("skips unparseable JSON loudly", () => {
		const { dir } = newDir("bad-json");
		writeFileSync(join(dir, "broken.json"), "{ not json", "utf8");
		const loaded = loadGoldenCases(dir, { log: () => {} });
		expect(loaded.cases).toEqual([]);
		expect(loaded.skipped[0]!.file).toBe("broken.json");
		expect(loaded.skipped[0]!.reasons.join(" ")).toContain("unparseable JSON");
	});

	it("enforces id == file basename (F7): mismatched file skipped loudly", () => {
		const { dir } = newDir("fname-case");
		writeJson(dir, "gc-a.json", caseWire({ id: "gc-a" }));
		writeJson(dir, "renamed.json", caseWire({ id: "gc-b" }));
		const loaded = loadGoldenCases(dir, { log: () => {} });
		expect(loaded.cases.map((c) => c.id)).toEqual(["gc-a"]);
		expect(loaded.skipped[0]!.file).toBe("renamed.json");
		expect(loaded.skipped[0]!.reasons.join(" ")).toContain("does not match the file name");
	});
});

// ─── rubric artifacts (D2 / DEC-7 / §8.2) ───────────────────────────────────

describe("rubric validation + loading", () => {
	it("accepts the known-valid rubric and stamps its version verbatim", () => {
		const { dir } = newDir("rubric-ok");
		writeJson(dir, "rubric-1.json", rubricWire());
		const loaded = loadRubrics(dir, { log: () => {} });
		expect(loaded.skipped).toEqual([]);
		expect(loaded.rubrics).toHaveLength(1);
		expect(loaded.rubrics[0]!.version).toBe("2.0.1");
		expect(loaded.rubrics[0]!.scale).toBe(RUBRIC_SCALE);
		expect(loaded.rubrics[0]!.dimensions[0]!.mustNot).toEqual(["unbounded re-asking"]);
		expect(validateRubric(rubricWire()).ok).toBe(true);
	});

	it("cold start: missing dir is empty, never an error", () => {
		const { dir } = newDir("rubric-cold");
		const loaded = loadRubrics(join(dir, "nope"), { log: () => {} });
		expect(loaded.rubrics).toEqual([]);
		expect(loaded.skipped).toEqual([]);
	});

	it("dimension mustNot is optional on the wire, normalized to [] (F2)", () => {
		const check = validateRubric({ rubricId: "r", version: "1", dimensions: [{ name: "d", guidance: "g", mustHold: ["a"] }], scale: RUBRIC_SCALE });
		expect(check.ok).toBe(true);
		if (check.ok) expect(check.value.dimensions[0]!.mustNot).toEqual([]);
	});

	it("skips malformed rubrics loudly (scale / dimensions / version / mustHold / guidance)", () => {
		const { dir, lines } = newDir("rubric-bad");
		writeJson(dir, "bad-scale.json", rubricWire({ rubricId: "bad-scale", scale: "1-5" }));
		writeJson(dir, "empty-dims.json", rubricWire({ rubricId: "empty-dims", dimensions: [] }));
		writeJson(dir, "no-version.json", rubricWire({ rubricId: "no-version", version: "" }));
		writeJson(dir, "no-musthold.json", rubricWire({ rubricId: "no-musthold", dimensions: [{ name: "d", guidance: "g", mustHold: [], mustNot: [] }] }));
		writeJson(dir, "no-guidance.json", rubricWire({ rubricId: "no-guidance", dimensions: [{ name: "d", guidance: "", mustHold: ["a"], mustNot: [] }] }));
		const loaded = loadRubrics(dir, { log: (l) => lines.push(l) });
		expect(loaded.rubrics).toEqual([]);
		expect(loaded.skipped).toHaveLength(5);
		const allReasons = loaded.skipped.map((s) => `${s.file}: ${s.reasons.join(" ")}`).join("\n");
		expect(allReasons).toContain("bad-scale.json");
		expect(allReasons).toContain("scale");
		expect(allReasons).toContain("empty-dims.json");
		expect(allReasons).toContain("dimensions");
		expect(allReasons).toContain("no-version.json");
		expect(allReasons).toContain("version");
		expect(allReasons).toContain("no-musthold.json");
		expect(allReasons).toContain("mustHold");
		expect(allReasons).toContain("no-guidance.json");
		expect(allReasons).toContain("guidance");
		expect(lines.length).toBeGreaterThan(0);
	});

	it("enforces rubricId == file basename (F7): mismatched file skipped loudly", () => {
		const { dir } = newDir("rubric-fname");
		writeJson(dir, "rubric-1.json", rubricWire());
		writeJson(dir, "copy.json", rubricWire());
		const loaded = loadRubrics(dir, { log: () => {} });
		expect(loaded.rubrics).toHaveLength(1);
		expect(loaded.skipped[0]!.file).toBe("copy.json");
		expect(loaded.skipped[0]!.reasons.join(" ")).toContain("does not match the file name");
	});
});

// ─── seed scaffolding (DEC-7: skeletons only, zero content generation) ──────

describe("template writers", () => {
	it("writeGoldenCaseTemplate emits a skeleton that passes its own loader (canary pre-embedded)", () => {
		const { dir } = newDir("tpl-case");
		const path = writeGoldenCaseTemplate(dir, "gc-seed-1");
		expect(path).toBe(join(dir, "gc-seed-1.json"));
		const loaded = loadGoldenCases(dir, { log: () => {} });
		expect(loaded.skipped).toEqual([]);
		expect(loaded.cases).toHaveLength(1);
		expect(loaded.cases[0]!.id).toBe("gc-seed-1");
		expect(loaded.cases[0]!.scenario).toContain(makeCanary("gc-seed-1"));
		expect(loaded.cases[0]!.caseVersion).toBe(1);
	});

	it("writeRubricTemplate emits a skeleton that passes its own loader", () => {
		const { dir } = newDir("tpl-rubric");
		const path = writeRubricTemplate(dir, "rubric-seed-1");
		expect(path).toBe(join(dir, "rubric-seed-1.json"));
		const loaded = loadRubrics(dir, { log: () => {} });
		expect(loaded.skipped).toEqual([]);
		expect(loaded.rubrics).toHaveLength(1);
		expect(loaded.rubrics[0]!.rubricId).toBe("rubric-seed-1");
		expect(loaded.rubrics[0]!.version).toBe("0.1.0");
	});

	it("refuses to overwrite an existing file (never clobber; wx backstop)", () => {
		const { dir } = newDir("tpl-clobber");
		writeGoldenCaseTemplate(dir, "gc-x");
		expect(() => writeGoldenCaseTemplate(dir, "gc-x")).toThrow(/refusing to overwrite/);
		writeRubricTemplate(dir, "rubric-x");
		expect(() => writeRubricTemplate(dir, "rubric-x")).toThrow(/refusing to overwrite/);
	});

	it("refuses path-separator ids", () => {
		const { dir } = newDir("tpl-bad-id");
		expect(() => writeGoldenCaseTemplate(dir, "a/b")).toThrow();
		expect(() => writeRubricTemplate(dir, "a/b")).toThrow();
	});
});

// ─── band key (M2 fold — P1 pins the shape) + caseSetOf (F10) ───────────────

describe("bandKey + caseSetOf", () => {
	it("bandKey shape is pinned: caseSet::case-vN::rubric-vVERSION", () => {
		expect(bandKey("core-suite", 2, "1.3.0")).toBe("core-suite::case-v2::rubric-v1.3.0");
		expect(bandKey("s", 10, "v9")).toBe("s::case-v10::rubric-vv9");
	});

	it("bandKey throws on malformed inputs (never a silently corrupt drift-history key)", () => {
		expect(() => bandKey("", 1, "v")).toThrow(/caseSet/);
		expect(() => bandKey("a::b", 1, "v")).toThrow(/caseSet/);
		expect(() => bandKey("a", 0, "v")).toThrow(/caseVersion/);
		expect(() => bandKey("a", 1.5, "v")).toThrow(/caseVersion/);
		expect(() => bandKey("a", 1, "")).toThrow(/rubricVersion/);
		expect(() => bandKey("a", 1, "x::y")).toThrow(/rubricVersion/);
	});

	it("caseSetOf: explicit stamp wins; else stage arm, else agent arm, else fallback (F10)", () => {
		expect(caseSetOf(BASE_GC)).toBe("prototype"); // stage arm of the compound
		expect(caseSetOf({ ...BASE_GC, target: { raw: "verify|code-reviewer", arm: "compound", stage: "verify", agent: "code-reviewer" } })).toBe("verify");
		expect(caseSetOf({ ...BASE_GC, target: { raw: "judge", arm: "agent", agent: "judge" } })).toBe("judge");
		expect(caseSetOf({ ...BASE_GC, caseSet: "core" })).toBe("core"); // explicit override
		expect(caseSetOf({ ...BASE_GC, target: { raw: "?", arm: "stage" } }, "fb")).toBe("fb"); // degenerate target → fallback
	});

	it("bandKey round-trip via caseSetOf (F10)", () => {
		expect(bandKey(caseSetOf(BASE_GC), BASE_GC.caseVersion, "0.1.0")).toBe("prototype::case-v1::rubric-v0.1.0");
		expect(bandKey(caseSetOf({ ...BASE_GC, caseSet: "core" }), 2, "1.0.0")).toBe("core::case-v2::rubric-v1.0.0");
	});
});

// ─── gate labels (D7 / DEC-13① / L3) ────────────────────────────────────────

describe("gate labels", () => {
	it("loads a valid labels file", () => {
		const { dir } = newDir("labels-ok");
		writeJson(dir, "gate-1.json", { gateId: "gate-1", created: "2026-09-11T00:00:00Z", maintainerVerdicts: [label("gc-a", "Approved"), label("gc-b", "pass", 2)] });
		const loaded = loadGateLabels(dir, { log: () => {} });
		expect(loaded.skipped).toEqual([]);
		expect(loaded.labels).toHaveLength(1);
		expect(loaded.labels[0]!.maintainerVerdicts).toEqual([label("gc-a", "Approved"), label("gc-b", "pass", 2)]);
	});

	it("cold start: missing dir is empty, never an error", () => {
		const { dir } = newDir("labels-cold");
		const loaded = loadGateLabels(join(dir, "nope"), { log: () => {} });
		expect(loaded.labels).toEqual([]);
		expect(loaded.skipped).toEqual([]);
	});

	it("skips bad ENTRIES loudly, file survives with its good entries", () => {
		const { dir, lines } = newDir("labels-entries");
		writeJson(dir, "gate-1.json", {
			gateId: "gate-1",
			created: "2026-09-11T00:00:00Z",
			maintainerVerdicts: [
				label("gc-a", "Approved"),
				label("gc-b", "Sort Of Approved"), // not in the DEC-6 closure
				label("gc-c", "Blocked", 0), // caseVersion < 1
				label("gc-a", "Blocked"), // duplicate (gc-a, 1)
			],
		});
		const loaded = loadGateLabels(dir, { log: (l) => lines.push(l) });
		expect(loaded.skipped).toEqual([]);
		expect(loaded.labels).toHaveLength(1);
		expect(loaded.labels[0]!.maintainerVerdicts).toEqual([label("gc-a", "Approved")]);
		expect(lines.join("\n")).toContain("maintainerVerdicts[1]");
		expect(lines.join("\n")).toContain("maintainerVerdicts[3]");
	});

	it("skips the whole file when gateId ≠ file basename", () => {
		const { dir } = newDir("labels-basename");
		writeJson(dir, "other-name.json", { gateId: "gate-1", created: "2026-09-11T00:00:00Z", maintainerVerdicts: [label("gc-a", "Approved")] });
		const loaded = loadGateLabels(dir, { log: () => {} });
		expect(loaded.labels).toEqual([]);
		expect(loaded.skipped[0]!.file).toBe("other-name.json");
		expect(loaded.skipped[0]!.reasons.join(" ")).toContain("does not match the file name");
	});

	it("validator rejects file-level shape failures", () => {
		expect(validateGateLabels({ created: "x", maintainerVerdicts: [] }).ok).toBe(false);
		expect(validateGateLabels({ gateId: "g", maintainerVerdicts: [] }).ok).toBe(false);
		expect(validateGateLabels({ gateId: "g", created: "x", maintainerVerdicts: "nope" }).ok).toBe(false);
		expect(validateGateLabels(null).ok).toBe(false);
	});
});

// ─── agreement computation (§8.2 calibration, §8.5 bootstrap) ───────────────

describe("computeGateAgreement", () => {
	it("perfect agreement: rate 1, degenerate CI [1,1], gate calibrated", () => {
		const rows = Array.from({ length: 8 }, (_, i) => row(`gc-${i + 1}`, "Approved", 0.9));
		const labels = Array.from({ length: 8 }, (_, i) => label(`gc-${i + 1}`, "Approved"));
		const a = computeGateAgreement(rows, labels);
		expect(a.matchedPairs).toBe(8);
		expect(a.agreed).toBe(8);
		expect(a.agreementRate).toBe(1);
		expect(a.bootstrap).not.toBeNull();
		expect(a.bootstrap!.ciLow).toBe(1);
		expect(a.bootstrap!.ciHigh).toBe(1);
		expect(a.unmatchedScorerRows).toBe(0);
		expect(a.unmatchedLabels).toBe(0);
		expect(a.duplicateScorerRows).toBe(0);
		expect(gatePasses(a)).toMatchObject({ passes: true, posture: "calibrated" });
	});

	it("partial agreement: exact rate, per-decile calibration, miscalibrated posture", () => {
		// rows 1..10: confidence 0.05..0.95 (one per decile); rows 1-5 agree.
		const rows = Array.from({ length: 10 }, (_, i) => row(`gc-${i + 1}`, i < 5 ? "Approved" : "Changes Requested", (i + 1) * 0.1 - 0.05));
		const labels = Array.from({ length: 10 }, (_, i) => label(`gc-${i + 1}`, "Approved"));
		const a = computeGateAgreement(rows, labels);
		expect(a.matchedPairs).toBe(10);
		expect(a.agreementRate).toBe(0.5);
		expect(a.calibration).toHaveLength(10);
		a.calibration.forEach((b, i) => {
			expect(b.n).toBe(1);
			expect(b.low).toBeCloseTo(i / 10, 10);
			expect(b.agreementRate).toBe(i < 5 ? 1 : 0);
		});
		expect(a.calibrationExcluded).toBe(0);
		const decision = gatePasses(a);
		expect(decision.passes).toBe(false);
		expect(decision.posture).toBe("miscalibrated");
	});

	it("zero matches (caseVersion mismatch = unmatched, never silently mixed — M2 fold); n=0 reason is honest (F4)", () => {
		const a = computeGateAgreement([row("gc-1", "Approved", 0.9, 2)], [label("gc-1", "Approved", 1)]);
		expect(a.matchedPairs).toBe(0);
		expect(a.agreementRate).toBeNull();
		expect(a.bootstrap).toBeNull();
		expect(a.unmatchedScorerRows).toBe(1);
		expect(a.unmatchedLabels).toBe(1);
		expect(a.perTarget).toEqual([]);
		const decision = gatePasses(a);
		expect(decision.posture).toBe("directional-only");
		expect(decision.reasons.join(" ")).toContain("no matched pairs");
	});

	it("duplicate scorer rows are counted, never re-paired (F3)", () => {
		const rows = Array.from({ length: 10 }, () => row("gc-1", "Approved", 0.9));
		const a = computeGateAgreement(rows, [label("gc-1", "Approved")]);
		expect(a.matchedPairs).toBe(1);
		expect(a.duplicateScorerRows).toBe(9);
		expect(a.agreementRate).toBe(1);
		expect(a.agreed).toBe(1);
		expect(gatePasses(a).posture).toBe("directional-only");
	});

	it("bootstrap is null below GATE_MIN_MATCHED_PAIRS (§8.5 — no CI on a directional-only sample, F5)", () => {
		const a = computeGateAgreement([row("gc-1", "Approved", 0.9)], [label("gc-1", "Approved")]);
		expect(a.matchedPairs).toBe(1);
		expect(a.agreementRate).toBe(1);
		expect(a.bootstrap).toBeNull();
	});

	it("malformed scorer rows are named, not silently dropped (P10)", () => {
		const rows: unknown[] = [
			row("gc-1", "Approved", 0.9),
			{ caseId: "", caseVersion: 1, verdict: "Approved", confidence: 0.9 },
			{ caseId: "gc-2", caseVersion: 1, verdict: 42, confidence: 0.9 },
			{ caseId: "gc-3", caseVersion: 1.5, verdict: "Approved", confidence: 0.9 },
		];
		const a = computeGateAgreement(rows as ScorerVerdictRow[], [label("gc-1", "Approved"), label("gc-2", "Approved"), label("gc-3", "Approved")]);
		expect(a.malformedScorerRows).toBe(3);
		expect(a.matchedPairs).toBe(1);
		// Labels whose row was malformed are unconsumed → unmatched.
		expect(a.unmatchedLabels).toBe(2);
		expect(a.duplicateScorerRows).toBe(0);
	});

	it("unusable confidence is excluded from calibration but still counts for agreement", () => {
		const rows = [row("gc-1", "Approved", 1.5), row("gc-2", "Approved", -0.1), row("gc-3", "Approved", Number.NaN)];
		const labels = [label("gc-1", "Approved"), label("gc-2", "Approved"), label("gc-3", "Approved")];
		const a = computeGateAgreement(rows, labels);
		expect(a.matchedPairs).toBe(3);
		expect(a.agreementRate).toBe(1);
		expect(a.bootstrap).toBeNull(); // n=3 < 8 (F5)
		expect(a.calibrationExcluded).toBe(3);
		expect(a.calibration.every((b) => b.n === 0 && b.agreementRate === null)).toBe(true);
	});

	it("per-target breakdown via the cases argument; unknown target for caseless rows", () => {
		const caseA: GoldenCase = { ...BASE_GC, id: "gc-a" };
		const caseB: GoldenCase = { ...BASE_GC, id: "gc-b", target: { raw: "verify|code-reviewer", arm: "compound", stage: "verify", agent: "code-reviewer" } };
		const rows = [row("gc-a", "pass", 0.9), row("gc-b", "fail", 0.9), row("gc-z", "Approved", 0.9)];
		const labels = [label("gc-a", "pass"), label("gc-b", "pass"), label("gc-z", "Approved")];
		const a = computeGateAgreement(rows, labels, [caseA, caseB]);
		expect(a.perTarget).toEqual([
			{ target: "prototype|prototype-runner", matched: 1, agreed: 1, agreementRate: 1 },
			{ target: "unknown", matched: 1, agreed: 1, agreementRate: 1 },
			{ target: "verify|code-reviewer", matched: 1, agreed: 0, agreementRate: 0 },
		]);
	});

	it("accepts a full GateLabels object or a bare verdict array", () => {
		const rows = [row("gc-1", "Approved", 0.9)];
		const labels: GateLabels = { gateId: "g", created: "2026-09-11T00:00:00Z", maintainerVerdicts: [label("gc-1", "Approved")] };
		expect(computeGateAgreement(rows, labels).agreementRate).toBe(1);
		expect(computeGateAgreement(rows, labels.maintainerVerdicts).agreementRate).toBe(1);
	});

	it("bootstrap CI is deterministic for a fixed seed (§8.5) and brackets the rate", () => {
		const rows = Array.from({ length: 10 }, (_, i) => row(`gc-${i + 1}`, i < 5 ? "Approved" : "Changes Requested", 0.5));
		const labels = Array.from({ length: 10 }, (_, i) => label(`gc-${i + 1}`, "Approved"));
		const first = computeGateAgreement(rows, labels);
		const second = computeGateAgreement(rows, labels);
		expect(first.bootstrap).toEqual(second.bootstrap); // default seed → identical
		const explicit = computeGateAgreement(rows, labels, [], { seed: 42 });
		expect(computeGateAgreement(rows, labels, [], { seed: 42 }).bootstrap).toEqual(explicit.bootstrap);
		expect(explicit.bootstrap!.seed).toBe(42);
		expect(first.bootstrap!.resamples).toBe(GATE_BOOTSTRAP_RESAMPLES);
		expect(first.bootstrap!.seed).toBe(GATE_BOOTSTRAP_SEED);
		expect(first.bootstrap!.ciLow).toBeLessThanOrEqual(first.agreementRate!);
		expect(first.bootstrap!.ciHigh).toBeGreaterThanOrEqual(first.agreementRate!);
		expect(first.bootstrap!.ciLow).toBeGreaterThanOrEqual(0);
		expect(first.bootstrap!.ciHigh).toBeLessThanOrEqual(1);
	});
});

// ─── gate policy (DEC-13① — D4② premise gate) ───────────────────────────────

describe("gatePasses policy constants + postures", () => {
	it("thresholds are named constants, aligned with the σ-band floor (§8.5)", () => {
		expect(GATE_MIN_AGREEMENT).toBe(0.8);
		expect(GATE_MIN_MATCHED_PAIRS).toBe(MIN_PRIOR_RUNS);
		expect(GATE_MIN_MATCHED_PAIRS).toBe(8);
		expect(GATE_BOOTSTRAP_RESAMPLES).toBe(1000);
		expect(Number.isInteger(GATE_BOOTSTRAP_SEED)).toBe(true);
	});

	it("n < 8 is directional-only whatever the rate; no bootstrap below the floor", () => {
		const rows = Array.from({ length: 7 }, (_, i) => row(`gc-${i + 1}`, "Approved", 0.9));
		const labels = Array.from({ length: 7 }, (_, i) => label(`gc-${i + 1}`, "Approved"));
		const a = computeGateAgreement(rows, labels);
		expect(a.agreementRate).toBe(1);
		expect(a.bootstrap).toBeNull();
		const decision = gatePasses(a);
		expect(decision.passes).toBe(false);
		expect(decision.posture).toBe("directional-only");
		expect(decision.reasons.join(" ")).toContain("directional");
	});

	it("calibrated at the threshold boundary (rate exactly 0.8, n=10)", () => {
		const rows = Array.from({ length: 10 }, (_, i) => row(`gc-${i + 1}`, i < 8 ? "Approved" : "Changes Requested", 0.9));
		const labels = Array.from({ length: 10 }, (_, i) => label(`gc-${i + 1}`, "Approved"));
		const decision = gatePasses(computeGateAgreement(rows, labels));
		expect(decision.passes).toBe(true);
		expect(decision.posture).toBe("calibrated");
	});

	it("miscalibrated below the threshold on a sufficient sample", () => {
		const rows = Array.from({ length: 10 }, (_, i) => row(`gc-${i + 1}`, i < 7 ? "Approved" : "Changes Requested", 0.9));
		const labels = Array.from({ length: 10 }, (_, i) => label(`gc-${i + 1}`, "Approved"));
		const decision = gatePasses(computeGateAgreement(rows, labels));
		expect(decision.passes).toBe(false);
		expect(decision.posture).toBe("miscalibrated");
		expect(decision.reasons.join(" ")).toContain("fix the rubric/mapping");
	});
});
