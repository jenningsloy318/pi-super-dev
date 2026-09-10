/**
 * S1 (v0.3.85) — control-contract-shapes: schema-generated instances through
 * their REAL engine-side verifiers/consumers.
 *
 * Root cause this file kills (C2, run 2026-09-09): the judge evidence schema
 * (`render/schemas.ts`, Type.Array(Type.String())) and its verifier
 * (`stages/judge.ts`, reads ev.file/ev.quote) drifted silently for 14
 * versions — 3,496 passing tests could not see it because every test
 * hand-built its own fixture instead of GENERATING one from the schema (P6
 * violation). This file derives instances from the TypeBox definitions
 * themselves and runs them through the real consumers, so the contract pair
 * can never drift without a failing test.
 *
 * Enumeration (S1-a): STAGE_MODELS ∪ the STANDALONE control exports
 * (JudgeControlData, FileClassifyControlData, TddCoverageControlData) — the
 * standalone schemas live in NO stage model (schemas.ts STAGE_MODELS has no
 * judge entry), so a STAGE_MODELS-only enumeration silently excludes the C2
 * seam. An exhaustiveness guard (S1-c) fails when a NEW *ControlData export
 * has no verifier pairing here.
 *
 * P2 grammar table for the F1 canonical string arm ("<path>: <quote>", split
 * on the FIRST colon+space) — one row per enumerated form:
 *   | form                                   | expected class                |
 *   |----------------------------------------|-------------------------------|
 *   | canonical "<path>: <quote>"            | verifies                      |
 *   | bare quote (no ": " prefix)            | evidence-unattributed         |
 *   | "path: 12" numeric (colon+space)       | quote < QUOTE_MIN (natural)   |
 *   | "path:12" (no space)                   | evidence-unattributed         |
 *   | short non-numeric quote after split    | quote bounds                  |
 *   | quote containing ": " (first-split)    | verifies (remainder keeps it) |
 *   | path containing ": " (first-split)     | evidence-unattributed (arm    |
 *   |                                        | truncated, resolves to no file)|
 *   | "C:\..." (colon not followed by space) | evidence-unattributed         |
 *   | "C:\x: quote" (prefix arm)             | evidence-unattributed         |
 *   | empty/whitespace string (mixed array)  | evidence-unattributed (item)  |
 *   | all-whitespace array                   | malformed (B4, array-level)   |
 *   | quote > QUOTE_MAX                       | quote bounds                  |
 *   | absolute host path "/…: quote"         | containment failure           |
 *   | "/dev/zero: quote"                     | containment failure, no hang  |
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
	STAGE_MODELS,
	JudgeControlData,
	FileClassifyControlData,
	TddCoverageControlData,
} from "../src/render/schemas.ts";
import { renderStage } from "../src/render/render.ts";
import {
	verifyJudgeEvidence,
	runJudge,
	resetJudgeBudgets,
	type JudgeVerdictWire,
} from "../src/stages/judge.ts";
import { buildRedBoundaryPrompt, redBoundaryResultFromAgent } from "../src/test-artifacts.ts";
import { resolveTddScenarioCoverage } from "../src/stages/implementation.ts";
import type { StageContext, AgentResult } from "../src/types.ts";

// ─── minimal-instance machinery (schema-derived, never hand-built) ──────────

/**
 * Minimal sample for a pattern-constrained string. Value.Create refuses
 * pattern strings without a `default`, so the schema is cloned with defaults
 * derived HERE. The enumerable grammar: literal chars, \d/\w/\s escapes,
 * escaped literals, character classes, and the {m}, {m,}, {m,n}, star, plus, and
 * optional quantifiers, plus stripped anchors. Groups, alternation, and the dot
 * are OUTSIDE the enumerated grammar and THROW — a new schema pattern must
 * extend this table (P2: the alternative is silently skipping the schema,
 * the exact S1 failure mode).
 */
function patternSample(pattern: string): string {
	const body = pattern.replace(/^\^/, "").replace(/\$$/, "");
	let out = "";
	let i = 0;
	while (i < body.length) {
		let atom: string;
		if (body[i] === "\\") {
			const esc = body[i + 1] ?? "";
			i += 2;
			atom = esc === "d" ? "0" : (esc === "w" || esc === "s") ? "a" : esc;
		} else if (body[i] === "[") {
			const end = body.indexOf("]", i);
			if (end === -1) throw new Error(`control-contract-shapes: pattern not enumerable (unterminated character class): ${pattern}`);
			let cls = body.slice(i + 1, end);
			if (cls.startsWith("^")) cls = cls.slice(1);
			atom = cls.startsWith("\\d") ? "0" : (cls.length > 0 ? cls[0]! : "x");
			i = end + 1;
		} else if (body[i] === "(" || body[i] === ")" || body[i] === "|" || body[i] === ".") {
			throw new Error(`control-contract-shapes: pattern not enumerable (groups/alternation/dot — extend the enumerated grammar): ${pattern}`);
		} else {
			atom = body[i]!;
			i += 1;
		}
		let min = 1;
		const q = body[i];
		if (q === "*" || q === "?") { min = 0; i += 1; }
		else if (q === "+") { min = 1; i += 1; }
		else if (q === "{") {
			const end = body.indexOf("}", i);
			if (end === -1) throw new Error(`control-contract-shapes: pattern not enumerable (unterminated quantifier): ${pattern}`);
			const spec = body.slice(i + 1, end);
			const m = /^(\d+)(?:,(\d*))?$/.exec(spec);
			if (!m) throw new Error(`control-contract-shapes: pattern not enumerable (quantifier {${spec}}): ${pattern}`);
			min = Number(m[1]);
			i = end + 1;
		}
		out += atom.repeat(min);
	}
	if (!new RegExp(pattern).test(out)) {
		throw new Error(`control-contract-shapes: derived sample "${out}" does not match ${pattern} — extend patternSample's enumerated grammar`);
	}
	return out;
}

/** Copy ALL own properties — including TypeBox's NON-ENUMERABLE `~kind`
 *  markers (settings.enumerableKind defaults to false). An Object.entries /
 *  spread clone silently drops them, every kind guard in Value.Create then
 *  fails, and the generator returns undefined (observed: "must be object"
 *  failures three assertions downstream — never clone TypeBox schemas with
 *  entries/spread). */
function copyAllProps(target: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(target)) out[key] = target[key];
	return out;
}

/** Deep-clone a schema giving every pattern-string node a matching default
 *  (Value.Create refuses pattern strings without one). */
function withPatternDefaults(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(withPatternDefaults);
	if (!node || typeof node !== "object") return node;
	const src = node as Record<string, unknown>;
	const out = copyAllProps(src);
	for (const key of Object.getOwnPropertyNames(src)) {
		const value = src[key] as Record<string, unknown> | null;
		if (value && typeof value === "object" && !Array.isArray(value) && value.type === "string" && typeof value.pattern === "string" && value.default === undefined) {
			const decorated = copyAllProps(value);
			decorated.default = patternSample(value.pattern as string);
			out[key] = decorated;
		} else {
			out[key] = withPatternDefaults(src[key]);
		}
	}
	return out;
}

/** Minimal instance DERIVED from the schema (typebox Value.Create over the
 *  pattern-decorated clone): required keys only, minItems-length arrays,
 *  first-variant unions, minimum-bound numbers, false booleans. */
function minimalInstance(schema: TSchema): unknown {
	return Value.Create(withPatternDefaults(schema) as TSchema);
}

// ─── fixtures ────────────────────────────────────────────────────────────────

let wt = "";
/** Real lines in the temp worktree file — canonical-arm rows quote these. */
const LINE1 = 'export const canary = "grammar-table fixture line for canonical evidence";';
const LINE2 = 'export const colonLine = { key: "a quote whose own text contains a colon-space" };';

beforeEach(() => {
	wt = mkdtempSync(join(tmpdir(), "sd-s1-shapes-"));
	resetJudgeBudgets();
	mkdirSync(join(wt, "src"), { recursive: true });
	writeFileSync(join(wt, "src", "real.ts"), `${LINE1}\n${LINE2}\n`);
	// exists WITH the quote on purpose: the "path containing ': '" row must
	// fail ONLY because the first-split truncates the file arm — a last-split
	// implementation would recover this path and verify, failing the row.
	writeFileSync(join(wt, "src", "w i: ld.ts"), `${LINE1}\n`);
});
afterEach(() => {
	try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
});

function makeJudgeCtx(agentImpl?: () => Partial<AgentResult>): { ctx: StageContext; calls: Array<Record<string, unknown>> } {
	const calls: Array<Record<string, unknown>> = [];
	const logs: string[] = [];
	const ctx = {
		task: "t",
		options: {},
		state: {},
		budget: { check: () => true },
		log: (m: string) => logs.push(m),
		agent: async (call: Record<string, unknown>) => {
			calls.push(call);
			return { text: "", control: null, ...(agentImpl?.() ?? {}) } as AgentResult;
		},
		helper: async () => ({ text: "", control: null }) as never,
	} as unknown as StageContext;
	return { ctx, calls };
}

// ─── S1-c: the verifier-pairing map + exhaustiveness guard ───────────────────

/** Every STANDALONE control schema export paired with its real engine-side
 *  verifier/consumer (exercised in the describes below). A NEW *ControlData
 *  export without a row here fails the guard — that is the C2 seam closing. */
const STANDALONE_CONTROL_PAIRINGS = {
	JudgeControlData: { schema: JudgeControlData, verifier: "verifyJudgeEvidence (src/stages/judge.ts)" },
	FileClassifyControlData: { schema: FileClassifyControlData, verifier: "redBoundaryResultFromAgent (src/test-artifacts.ts)" },
	TddCoverageControlData: { schema: TddCoverageControlData, verifier: "resolveTddScenarioCoverage (src/stages/implementation.ts)" },
} as const;

describe("S1-c exhaustiveness guard", () => {
	it("every *ControlData export in schemas.ts has a pairing here; no stale pairings", () => {
		const src = readFileSync("src/render/schemas.ts", "utf8");
		const exported = [...src.matchAll(/export const (\w*ControlData)\b/g)].map((m) => m[1]!);
		expect(exported.length).toBeGreaterThanOrEqual(3);
		const unpaired = exported.filter((n) => !(n in STANDALONE_CONTROL_PAIRINGS));
		expect(unpaired, "add the new control schema to STANDALONE_CONTROL_PAIRINGS with its real engine-side verifier — a control schema without a verifier pairing is the C2 seam").toEqual([]);
		const stale = Object.keys(STANDALONE_CONTROL_PAIRINGS).filter((n) => !exported.includes(n));
		expect(stale, "pairing references an export that no longer exists").toEqual([]);
	});

	it("the standalone control schemas are NOT stage models — a STAGE_MODELS-only enumeration would silently exclude them", () => {
		for (const [name, pairing] of Object.entries(STANDALONE_CONTROL_PAIRINGS)) {
			const inStageModels = Object.values(STAGE_MODELS).some((m) => m.schema === pairing.schema);
			expect(inStageModels, `${name} unexpectedly present in STAGE_MODELS`).toBe(false);
		}
	});
});

// ─── S1-b: STAGE_MODELS schemas through the real render pipeline ─────────────

describe("S1-b STAGE_MODELS: schema-generated minimal instances render through the real pipeline", () => {
	for (const [stageId, model] of Object.entries(STAGE_MODELS)) {
		it(`${stageId}: minimalInstance(${stageId} schema) → renderStage → 0 errors, non-empty markdown`, () => {
			const instance = minimalInstance(model.schema);
			const out = renderStage(stageId, instance);
			expect(out.errors).toEqual([]);
			expect(out.markdown.length).toBeGreaterThan(0);
		});
	}
});

// ─── S1-b/d: JudgeControlData ↔ verifyJudgeEvidence (the C2 seam) ────────────

describe("S1-d judge evidence: BOTH arms end-to-end against a real temp file", () => {
	it("schema-generated minimal instance reaches the verifier and lands in the malformed class (a schema alone cannot fabricate a verifiable quote)", () => {
		const generated = minimalInstance(JudgeControlData) as { diagnosis: string; route: string; confidence: number; evidence: unknown[] };
		// the union's FIRST variant is the object arm — Create produces records
		expect(generated.evidence).toEqual([{ file: "", quote: "" }]);
		const failures = verifyJudgeEvidence(generated as unknown as JudgeVerdictWire, wt, []);
		expect(failures.join(" ")).toContain("malformed");
	});

	it("object arm CONSTRUCTED against the real file verifies", () => {
		const failures = verifyJudgeEvidence({ diagnosis: "d", route: "re-author-tests", confidence: 0.9, evidence: [{ file: "src/real.ts", quote: LINE1 }] }, wt, []);
		expect(failures).toEqual([]);
	});

	it("canonical-string arm CONSTRUCTED against the real file verifies and is normalized IN PLACE to {file, quote} records", () => {
		const v: JudgeVerdictWire = { diagnosis: "d", route: "re-author-tests", confidence: 0.9, evidence: [`src/real.ts: ${LINE1}`] };
		expect(verifyJudgeEvidence(v, wt, [])).toEqual([]);
		expect(v.evidence).toEqual([{ file: "src/real.ts", quote: LINE1 }]);
	});

	it("a schema-generated arbitrary string (degraded bare-quote mode) fails as evidence-unattributed", () => {
		const arms = (JudgeControlData as unknown as { properties: { evidence: { items: { anyOf: TSchema[] } } } }).properties.evidence.items.anyOf;
		expect(arms.map((a) => (a as { type?: string }).type)).toEqual(["object", "string"]);
		// the generator's minimal string is "" — pad to a realistic non-canonical
		// quote so the assertion targets the ATTRIBUTION path (an empty string in
		// a 1-item array is the B4 malformed class, a different row below).
		const created: unknown = Value.Create(arms[1]!);
		const arbitrary = String(created).trim() || "arbitrary schema-generated bare quote with no path";
		const failures = verifyJudgeEvidence({ diagnosis: "d", route: "re-author-tests", confidence: 0.9, evidence: [arbitrary] }, wt, []);
		expect(failures.join(" ")).toContain("evidence-unattributed");
	});
});

// ─── S1-f: P2 grammar table for the canonical string arm ─────────────────────

interface GrammarRow {
	name: string;
	items: () => string[];
	/** substring expected in the joined failures; null → expect NO failures */
	expect: string | null;
	/** substring that must NOT appear in the joined failures */
	absent?: string;
}

const grammarRows: GrammarRow[] = [
	{
		name: "canonical \"<path>: <quote>\" verifies against the real file",
		items: () => [`src/real.ts: ${LINE1}`],
		expect: null,
	},
	{
		name: "bare quote (no \": \" prefix) → evidence-unattributed",
		items: () => ["the oracle failed for a reason no enumerated class covers"],
		expect: "evidence-unattributed",
	},
	{
		name: "\"path: 12\" numeric (colon+space) → quote below QUOTE_MIN dies naturally",
		items: () => ["src/real.ts: 12"],
		expect: "outside 8-200",
	},
	{
		name: "\"path:12\" without space → no canonical prefix → evidence-unattributed",
		items: () => ["src/real.ts:12"],
		expect: "evidence-unattributed",
	},
	{
		name: "short non-numeric quote after split → quote bounds",
		items: () => ["src/real.ts: short"],
		expect: "outside 8-200",
	},
	{
		name: "quote containing \": \" — FIRST split only: file arm intact, remainder keeps its \": \"",
		items: () => [`src/real.ts: ${LINE2}`],
		expect: null,
	},
	{
		name: "path containing \": \" — FIRST split truncates the file arm → the truncated prefix resolves to no file → evidence-unattributed (never recovered via last-split)",
		items: () => [`src/w i: ld.ts: ${LINE1}`],
		expect: "evidence-unattributed",
		absent: "quote not found",
	},
	{
		name: "Windows drive-letter path, colon not followed by space → whole string is the quote arm → evidence-unattributed",
		items: () => ["C:\\Users\\dev\\project\\src\\a.ts"],
		expect: "evidence-unattributed",
	},
	{
		name: "Windows drive-letter WITH \": \" → prefix arm resolves nowhere → evidence-unattributed",
		items: () => ["C:\\x: quoted content from that windows file"],
		expect: "evidence-unattributed",
	},
	{
		name: "empty string in a MIXED array → item-level evidence-unattributed (not array-level malformed)",
		items: () => ["", `src/real.ts: ${LINE1}`],
		expect: "evidence-unattributed",
		absent: "malformed",
	},
	{
		name: "all-whitespace string array → malformed (B4 preserved through entry normalization)",
		items: () => ["   ", " \t "],
		expect: "malformed",
	},
	{
		name: "quote > QUOTE_MAX after split → quote bounds",
		items: () => [`src/real.ts: ${"q".repeat(201)}`],
		expect: "outside 8-200",
	},
	{
		name: "absolute host path with a REAL host quote → containment failure (High #3)",
		items: () => {
			const hostFile = join(process.cwd(), "package.json");
			const line = readFileSync(hostFile, "utf8").split("\n").map((l) => l.trim()).find((l) => l.length >= 8 && l.length <= 200) ?? "pi-super-dev";
			return [`${hostFile}: ${line}`];
		},
		expect: "outside the worktree",
	},
	// /dev/zero exists on POSIX CI; on platforms without it the row is skipped
	...(existsSync("/dev/zero") ? [{
		name: "\"/dev/zero: quote\" → containment failure BEFORE any read (bounded, never hangs)",
		items: () => ["/dev/zero: 0000000000000000"],
		expect: "outside the worktree",
	}] as GrammarRow[] : []),
];

describe("S1-f P2 grammar table: canonical string evidence", () => {
	const verifyStrings = (items: string[]): string[] =>
		verifyJudgeEvidence({ diagnosis: "grammar table", route: "re-author-tests", confidence: 0.9, evidence: items }, wt, []);

	for (const row of grammarRows) {
		it(row.name, () => {
			const joined = verifyStrings(row.items()).join(" ");
			if (row.expect === null) expect(joined).toBe("");
			else expect(joined).toContain(row.expect);
			if (row.absent !== undefined) expect(joined).not.toContain(row.absent);
		});
	}

	it("object arm (unchanged): verifies against the real file; a nonexistent file fails as 'file not found', NOT evidence-unattributed", () => {
		expect(verifyJudgeEvidence({ diagnosis: "d", route: "re-author-tests", confidence: 0.9, evidence: [{ file: "src/real.ts", quote: LINE1 }] }, wt, [])).toEqual([]);
		const joined = verifyJudgeEvidence({ diagnosis: "d", route: "re-author-tests", confidence: 0.9, evidence: [{ file: "no/such.ts", quote: LINE1 }] }, wt, []).join(" ");
		expect(joined).toContain("file not found");
		expect(joined).not.toContain("evidence-unattributed");
	});

	it("boundedRead caps the read ITSELF: a quote beyond VERIFY_FILE_CAP (8MB) is not found; one within it verifies", () => {
		const CAP = 8 * 1024 * 1024; // judge.ts VERIFY_FILE_CAP
		writeFileSync(join(wt, "big.ts"), "WITHIN_CAP_MARKER_ABCDEFGH = 1;\n" + "a".repeat(CAP) + "\nBEYOND_CAP_MARKER_ABCDEFGH = 2;\n");
		const within = verifyJudgeEvidence({ diagnosis: "d", route: "re-author-tests", confidence: 0.9, evidence: [{ file: "big.ts", quote: "WITHIN_CAP_MARKER_ABCDEFGH = 1;" }] }, wt, []);
		expect(within).toEqual([]);
		const beyond = verifyJudgeEvidence({ diagnosis: "d", route: "re-author-tests", confidence: 0.9, evidence: [{ file: "big.ts", quote: "BEYOND_CAP_MARKER_ABCDEFGH = 2;" }] }, wt, []);
		expect(beyond.join(" ")).toContain("quote not found");
	});
});

// ─── S1-e: timeout override through the full runJudge path ───────────────────

describe("S1-e judge timeout override", () => {
	it("SUPER_DEV_JUDGE_TIMEOUT_MS=1 reaches the agent call end-to-end (NEVER the 20-min default); the canonical-string evidence arm routes through the FULL judge path", async () => {
		process.env.SUPER_DEV_JUDGE_TIMEOUT_MS = "1";
		try {
			const { ctx, calls } = makeJudgeCtx(() => ({
				control: {
					diagnosis: "the canonical string arm verifies against the real file",
					route: "re-author-tests",
					confidence: 0.9,
					evidence: [`src/real.ts: ${LINE1}`],
				} as Record<string, unknown>,
			}));
			const out = await runJudge(ctx, { scope: "s1-timeout", signature: "sig-s1-timeout", worktreePath: wt, context: "c", allowedRoutes: ["re-author-tests"] });
			expect(out.status).toBe("routed");
			expect((calls[0] as { timeoutMs?: number }).timeoutMs).toBe(1);
		} finally {
			delete process.env.SUPER_DEV_JUDGE_TIMEOUT_MS;
			resetJudgeBudgets();
		}
	});
});

// ─── S1-b: FileClassifyControlData ↔ redBoundaryResultFromAgent ──────────────

describe("S1-b FileClassifyControlData ↔ redBoundaryResultFromAgent (engine-derived allowed/source)", () => {
	it("schema-generated instance through the real consumer: allowed and source are DERIVED, never model fields", () => {
		// classifications has no minItems, so Create yields [] — generate the
		// ITEM from the schema's own items node (still schema-derived, not hand-built)
		const itemsNode = (FileClassifyControlData as unknown as { properties: { classifications: { items: TSchema } } }).properties.classifications.items;
		const item = minimalInstance(itemsNode) as { path: string; category: string; confidence: number; reason: string };
		// Create fills the union's first literal ("test") and 0-confidence — the
		// model-facing per-item shape is exactly {path, category, confidence, reason}
		expect(item).toEqual({ path: "", category: "test", confidence: 0, reason: "" });
		expect("allowed" in item).toBe(false); // engine-derived — not model-facing
		expect("source" in item).toBe(false);
		const ctl = minimalInstance(FileClassifyControlData) as {
			classifications: Array<{ path: string; category: string; confidence: number; reason: string }>;
			forbiddenFiles: string[];
			ambiguousFiles: string[];
			allAllowed: boolean;
		};
		ctl.classifications = [item];
		const requested = "src/runtime/manifest.ts";
		item.path = requested; // one-field fixup: bind the generated row to a real requested path
		const result = redBoundaryResultFromAgent([requested], ctl);
		// allowed is derived from category + MIN_AGENT_CONFIDENCE (0 < 0.7 → deny);
		// source is stamped by the engine — the schema no longer even HAS these fields
		expect(result.classifications[0]).toMatchObject({ path: requested, category: "test", source: "agent", allowed: false });
		expect(result.forbiddenFiles).toEqual([requested]);
		expect(result.allAllowed).toBe(false);
	});

	it("schema per-item keys == the keys buildRedBoundaryPrompt requests; category vocabulary unified on BOTH sides (the code-review Critical)", () => {
		const prompt = buildRedBoundaryPrompt({ changedFiles: ["src/x.ts"], testFiles: [], phaseName: "p", redStatus: "red" });
		// total parse — no non-null assertions on a possibly-absent shape entry
		const line = prompt.split("\n").find((l) => l.includes("classifications: [{"));
		expect(line, "buildRedBoundaryPrompt must keep its classifications item-shape line").toBeDefined();
		const inner = /\[\{(.+)\}\]/.exec(line ?? "")?.[1] ?? "";
		expect(inner, "the classifications item shape must be parseable").not.toBe("");
		const promptKeys = inner.split(",").map((s) => s.trim().split(":")[0]!.trim()).filter(Boolean);
		const schemaItem = (FileClassifyControlData as unknown as { properties: { classifications: { items: { properties: Record<string, unknown> } } } }).properties.classifications.items.properties;
		expect(Object.keys(schemaItem).sort()).toEqual([...new Set(promptKeys)].sort());
		const categoryIdx = (line ?? "").indexOf("category:");
		const categoryTail = categoryIdx >= 0 ? line!.slice(categoryIdx + "category:".length) : "";
		expect(categoryTail, "the category vocabulary must be present").not.toBe("");
		const promptVocab = [...categoryTail.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
		const schemaVocab = (schemaItem.category as { anyOf: Array<{ const: string }> }).anyOf.map((e) => e.const);
		expect([...new Set(promptVocab)].sort()).toEqual([...schemaVocab].sort());
	});
});

// ─── S1-b: TddCoverageControlData ↔ resolveTddScenarioCoverage ───────────────

describe("S1-b TddCoverageControlData ↔ resolveTddScenarioCoverage (the real engine-side verifier)", () => {
	it("schema-generated instance through the real verifier: the engine-side DIFF is authoritative, never the model's own boolean", async () => {
		const ctl = minimalInstance(TddCoverageControlData) as Record<string, unknown>;
		const calls: Array<Record<string, unknown>> = [];
		const ctx = {
			task: "t",
			options: {},
			state: {},
			budget: { check: () => true },
			log: () => { /* quiet */ },
			agent: async (call: Record<string, unknown>) => {
				calls.push(call);
				return { text: "", control: ctl } as AgentResult;
			},
			helper: async () => ({ text: "", control: null }) as never,
		} as unknown as StageContext;
		const result = await resolveTddScenarioCoverage({
			ctx,
			cwd: wt,
			phaseId: "p1",
			phaseName: "Phase 1",
			phase: {},
			expectedScenarios: ["SCENARIO-001"],
			testFiles: [],
			specControl: null,
			bddControl: null,
		});
		// the call wires the SAME schema this test generated from (the pairing is real)
		expect(calls[0]?.schema).toBe(TddCoverageControlData);
		// Create gives coveredScenarios: [] — the diff over the expected baseline
		// decides: not covered, the scenario is reported missing
		expect(result.allCovered).toBe(false);
		expect(result.missingScenarios).toEqual(["SCENARIO-001"]);
	});
});
