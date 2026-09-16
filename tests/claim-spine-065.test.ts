/**
 * 065 core-wave deterministic acceptance tests — the write-claim spine and its
 * four gates (docs/requirements/065-first-pass-satisfiability.md §7 D-F-E,
 * fixtures A–L). Every fixture reproduces a class observed in the omisis
 * double-replan run 2026-09-14T11-40-21-540Z or a grammar-table row. No
 * LLM-behavior claims (the 059 convention).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	extractWriteClaims,
	classifySegment,
	stage9EntryGate,
	entryContradictions,
	entryContradictionFindingText,
	readAmendmentFamilyEntries,
	amendmentExemptFiles,
	writeClaimClosureFindings,
	governedProtectedTokens,
	isUsablePathToken,
} from "../src/review/claim-spine.ts";
import { extractContractInventory } from "../src/review/contract-surface.ts";
import { specAmendmentFamilyFindings } from "../src/review/contract-validators.ts";
import { scanImmutabilityIdiomsWithRejects } from "../src/stages/plan-feasibility.ts";

let wt: string;
beforeEach(() => {
	wt = mkdtempSync(join(tmpdir(), "sd-065-spine-"));
});
afterEach(() => {
	try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
});

function writeWt(rel: string, content: string): void {
	const p = join(wt, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content);
}

/** The spec dir for the "self" spec (063-style path). */
const SELF_SPEC = "docs/specifications/26-capability-backend-substrate";

// ─── J: grammar-table rows (065 §4.1 — one test per row) ────────────────────

describe("065 §4.1 grammar table (fixture J)", () => {
	it("row 1 — verb-governed write: 'X §4 gains the note' ⇒ WRITE(X)", () => {
		const r = classifySegment("docs/requirements/22-public-interface.md §4 gains the data/cache runtime-state note", "f.md:1", "spec");
		expect(r.writes.map((w) => w.path)).toEqual(["docs/requirements/22-public-interface.md"]);
		expect(r.protects).toEqual([]);
	});

	it("row 2 — verb-governed protect with LIST governance: 'A, B, C stay byte-untouched' ⇒ PROTECT(all three)", () => {
		const r = classifySegment("src/stages.ts, src/orchestrator.ts, src/screen-phase1.ts stay byte-untouched", "f.md:1", "spec");
		expect(r.protects.sort()).toEqual(["src/orchestrator.ts", "src/screen-phase1.ts", "src/stages.ts"].sort());
		expect(r.writes).toEqual([]);
	});

	it("row 3 — post-positioned qualifier: 'the guard pins python/omisis/_fetchers.py byte-untouched' ⇒ PROTECT(_fetchers.py)", () => {
		const r = classifySegment("the deliverable requireNotContains guard pins python/omisis/_fetchers.py byte-untouched (no screen domain joins)", "f.md:1", "spec");
		expect(r.protects).toEqual(["python/omisis/_fetchers.py"]);
	});

	it("row 4 — mixed single sentence (semicolon-split): one WRITE + one PROTECT, different tokens", () => {
		const seg = "docs/requirements/22-public-interface.md §4 gains the data/cache note; the deliverable guard pins python/omisis/_fetchers.py byte-untouched";
		// classifySegment gets ONE segment; the extractor splits on ';' — exercise both halves.
		const a = classifySegment("docs/requirements/22-public-interface.md §4 gains the data/cache note", "f.md:1", "spec");
		const b = classifySegment("the deliverable guard pins python/omisis/_fetchers.py byte-untouched", "f.md:1", "spec");
		expect(a.writes.map((w) => w.path)).toEqual(["docs/requirements/22-public-interface.md"]);
		expect(b.protects).toEqual(["python/omisis/_fetchers.py"]);
	});

	it("row 5 — list context: 'Files edited: a.ts, tests/b.test.ts (NEW), docs/c.md' ⇒ WRITE(every listed token)", () => {
		const r = classifySegment("Files edited: src/runtime-dispatch.ts, src/tools/data_analyst.ts, tests/screen-deterministic-dispatch.test.ts, docs/requirements/07-staged-execution.md", "f.md:1", "spec");
		expect(r.writes.map((w) => w.path).sort()).toEqual([
			"docs/requirements/07-staged-execution.md",
			"src/runtime-dispatch.ts",
			"src/tools/data_analyst.ts",
			"tests/screen-deterministic-dispatch.test.ts",
		].sort());
	});

	it("row 6 — negation: 'must not gain' / 'without touching' ⇒ no claim", () => {
		expect(classifySegment("the module must not gain a new domain join in src/schemas.ts", "f.md:1", "spec").writes).toEqual([]);
		expect(classifySegment("proceed without touching python/omisis/_fetchers.py", "f.md:1", "spec").writes.map((w) => w.path)).toEqual([]);
	});

	it("row 7 — noun form: 'the byte-untouched guard' ⇒ no protect claim from the noun alone", () => {
		const r = classifySegment("the byte-untouched guard holds for src/schemas.ts", "f.md:1", "spec");
		// "the byte-untouched guard" is a NOUN; no verb governs the token as protect
		// — but "holds" is not in the protect grammar either, so nothing mints.
		expect(r.protects).toEqual([]);
	});

	it("row 9 — template/invalid tokens rejected", () => {
		expect(isUsablePathToken("${wiredFile}")).toBe(false);
		expect(isUsablePathToken("${pathspec}")).toBe(false);
		expect(isUsablePathToken("wiredFile")).toBe(false); // bare identifier
		expect(isUsablePathToken("src/schemas.ts")).toBe(true);
	});

	it("row 8 — concept reference via conceptMap", () => {
		const map = new Map([["package layout", ["docs/requirements/22-public-interface.md"]]]);
		const r = classifySegment("spec 22's package layout gains the data/cache runtime-state note", "f.md:1", "requirements", map);
		expect(r.conceptWrites.map((w) => w.path)).toEqual(["docs/requirements/22-public-interface.md"]);
	});
});

// ─── A + D: the inversion fixtures (replan-1 shape / self-contradiction) ─────

describe("fixture A — the replan-1 pin inversion is dead at birth", () => {
	it("'extends tests/foo.py … never touching the registry' mints NO protection on foo.py", () => {
		// The plan's own phase-3 prose (the exact incident shape).
		const statement = "Verification-hardening phase (extends python/tests/test_screen_ops.py; fixes python/omisis/screen.py in place if RED — never touching the registry surface)";
		const governed = governedProtectedTokens(statement, ["python/tests/test_screen_ops.py", "python/omisis/screen.py"]);
		// The write target (extends …) must NEVER protect; "never touching the
		// registry surface" names no path token ⇒ nothing governs a protect.
		expect(governed).toEqual([]);
	});

	it("end-to-end: plan text with the inversion + a porcelain test on ANOTHER file — foo.py stays unprotected", () => {
		writeWt("tests/hardening-contract.test.ts", [
			'it("holds", () => {',
			'\tconst dirty = execSync("git status --porcelain -- src/registry.ts").toString();',
			'\texpect(dirty, "src/registry.ts must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		writeWt(`${SELF_SPEC}/10-implementation-plan.md`, [
			"## Phase 2",
			"deliverables.requireFiles: python/tests/test_screen_ops.py",
			"## Phase 3",
			"Verification-hardening phase (extends python/tests/test_screen_ops.py; fixes python/omisis/screen.py in place if RED — never touching the registry surface).",
		].join("\n"));
		const inv = extractContractInventory(wt);
		expect(inv.protectedFiles.has("src/registry.ts")).toBe(true);
		expect(inv.protectedFiles.has("python/tests/test_screen_ops.py")).toBe(false);
	});
});

describe("fixture D — self-contradiction blocked at entry; legitimate self-protection stands", () => {
	it("self-spec 'X stays byte-untouched' + write-claim on X ⇒ Gate E blocks with both loci", () => {
		writeWt("tests/other-contract.test.ts", ""); // no foreign pins
		writeWt(`${SELF_SPEC}/09-specification.md`, "The module lands in src/new_thing.ts. The legacy file src/legacy.ts stays byte-untouched in git.\n");
		writeWt(`${SELF_SPEC}/10-implementation-plan.md`, "Phase 1 edits src/legacy.ts to add the compat shim.\n");
		const inv = extractContractInventory(wt);
		// The self-spec's own "stays byte-untouched" mints a pin (self-scan —
		// legitimate SOURCE; the CONTRADICTION is Gate E's to catch).
		expect(inv.protectedFiles.has("src/legacy.ts")).toBe(true);
		const { claims } = extractWriteClaims([{ text: "Phase 1 edits src/legacy.ts to add the compat shim.", locusPrefix: "10-implementation-plan.md" }], "spec");
		expect(claims.map((c) => c.path)).toContain("src/legacy.ts");
		const gate = entryContradictions({ writeClaims: claims, inventory: inv, specDirectory: join(wt, SELF_SPEC) });
		expect(gate.contradictions).toHaveLength(1);
		expect(gate.contradictions[0].path).toBe("src/legacy.ts");
		const text = entryContradictionFindingText(gate.contradictions[0]);
		expect(text.title).toContain("write×protect");
		expect(text.title).toContain("src/legacy.ts");
	});

	it("without the write-claim, the self-protection stands (no finding)", () => {
		writeWt(`${SELF_SPEC}/09-specification.md`, "The legacy file src/legacy.ts stays byte-untouched in git.\n");
		writeWt(`${SELF_SPEC}/10-implementation-plan.md`, "Phase 1 creates src/new_thing.ts only.\n");
		const inv = extractContractInventory(wt);
		expect(inv.protectedFiles.has("src/legacy.ts")).toBe(true);
		const { claims } = extractWriteClaims([{ text: "Phase 1 creates src/new_thing.ts only.", locusPrefix: "10-implementation-plan.md" }], "spec");
		const gate = entryContradictions({ writeClaims: claims, inventory: inv, specDirectory: join(wt, SELF_SPEC) });
		expect(gate.contradictions).toHaveLength(0);
	});
});

// ─── C: phantom rejection at BOTH resolution arms ────────────────────────────

describe("fixture C — phantoms rejected at both arms", () => {
	it("porcelain-pathspec arm: `git status --porcelain -- ${wiredFile}` mints NOTHING (reject visible)", () => {
		const src = 'const dirty = execSync(`git status --porcelain -- ${wiredFile}`).toString();\nexpect(dirty, "wired byte-untouched").toBe("");';
		const { hits, rejects } = scanImmutabilityIdiomsWithRejects(src);
		expect(hits.map((h) => h.path)).toEqual([]);
		expect(rejects).toContain("${wiredFile}");
	});

	it("window arm: literalPathTokens template tokens are P10-counted rejects", () => {
		// The md arm's governed resolution consults segmentPathTokens, which
		// rejects templates; a doc whose only token is a template anchors nothing.
		writeWt(`${SELF_SPEC}/07-design.md`, 'The module `src/real.ts` stays byte-untouched; the wiring file ${pathspec} also holds.\n');
		const inv = extractContractInventory(wt);
		expect(inv.protectedFiles.has("src/real.ts")).toBe(true);
		expect(inv.protectedFiles.has("${pathspec}")).toBe(false);
	});
});

// ─── B + H: the replan-2 shape (prose exemption + demandable-set scope) ──────

describe("fixture B — the replan-2 shape: prose exemption cannot hide the file", () => {
	it("Gate W fails with BOTH loci when the pinned sibling doc is only in docUpdates prose", () => {
		// A sibling spec's test pins the shared doc (a FOREIGN pin).
		writeWt("tests/interface-contract.test.ts", [
			'it("22 layout frozen", () => {',
			'\tconst dirty = execSync("git status --porcelain -- docs/requirements/22-public-interface.md").toString();',
			'\texpect(dirty, "docs/requirements/22-public-interface.md must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		// The spec declares the amendment ONLY in docUpdates prose (the incident
		// shape: sharedFile was .gitignore, the doc path was buried in prose).
		const control = { amendmentFamily: [{ sharedFile: ".gitignore", pinsMoved: [], exemptions: [], docUpdates: ["docs/requirements/22-public-interface.md — §4 gains the data/cache note"] }] };
		const docTexts = [{ text: "docs/requirements/22-public-interface.md §4 gains the data/cache runtime-state note (AC-14).", locusPrefix: "10-implementation-plan.md" }];
		const inv = extractContractInventory(wt);
		const findings = writeClaimClosureFindings({ stage: "spec", control, docTexts, inventory: inv, level: "concrete" });
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0].kind).toBe("blocking");
		expect(findings[0].message).toContain("docs/requirements/22-public-interface.md");
		expect(findings[0].message).toContain("prose docUpdates do not exempt");
	});

	it("after the sharedFile entry is added, the closure passes", () => {
		writeWt("tests/interface-contract.test.ts", [
			'it("22 layout frozen", () => {',
			'\tconst dirty = execSync("git status --porcelain -- docs/requirements/22-public-interface.md").toString();',
			'\texpect(dirty, "docs/requirements/22-public-interface.md must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		const control = { amendmentFamily: [{ sharedFile: "docs/requirements/22-public-interface.md", pinsMoved: [], exemptions: [], docUpdates: [] }, { sharedFile: ".gitignore", pinsMoved: [], exemptions: [], docUpdates: [] }] };
		const docTexts = [{ text: "docs/requirements/22-public-interface.md §4 gains the data/cache runtime-state note (AC-14).", locusPrefix: "10-implementation-plan.md" }];
		const inv = extractContractInventory(wt);
		expect(writeClaimClosureFindings({ stage: "spec", control, docTexts, inventory: inv, level: "concrete" })).toEqual([]);
	});
});

describe("fixture H — Gate R demandable-set scope (self-minted + beyond-cap do NOT block)", () => {
	it("specAmendmentFamilyFindings with design family declared: uncovered spec write-claim BLOCKS (the conditioned skip)", () => {
		writeWt("tests/interface-contract.test.ts", [
			'it("22 frozen", () => {',
			'\tconst dirty = execSync("git status --porcelain -- docs/requirements/22-public-interface.md").toString();',
			'\texpect(dirty, "docs/requirements/22-public-interface.md must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		const inv = extractContractInventory(wt);
		const claims = extractWriteClaims([{ text: "docs/requirements/22-public-interface.md §4 gains the note.", locusPrefix: "10-implementation-plan.md" }], "spec").claims;
		const findings = specAmendmentFamilyFindings({
			specControl: { layerW: "1" },
			designControl: { amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: [], exemptions: [], docUpdates: [] }] },
			slice: { empty: false, block: "", pinCount: 0, truncated: false, unmappedConcepts: [], files: [], pinIds: [] },
			inventory: inv,
			specWriteClaims: claims,
		});
		expect(findings.some((f) => f.kind === "blocking" && f.message.includes("22-public-interface.md"))).toBe(true);
	});

	it("design family COVERING the write-claim keeps the skip (no finding)", () => {
		writeWt("tests/interface-contract.test.ts", [
			'it("22 frozen", () => {',
			'\tconst dirty = execSync("git status --porcelain -- docs/requirements/22-public-interface.md").toString();',
			'\texpect(dirty, "docs/requirements/22-public-interface.md must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		const inv = extractContractInventory(wt);
		const claims = extractWriteClaims([{ text: "docs/requirements/22-public-interface.md §4 gains the note.", locusPrefix: "10-implementation-plan.md" }], "spec").claims;
		const findings = specAmendmentFamilyFindings({
			specControl: { layerW: "1" },
			designControl: { amendmentFamily: [{ sharedFile: "docs/requirements/22-public-interface.md", pinsMoved: [], exemptions: [], docUpdates: [] }] },
			slice: { empty: true, block: "", pinCount: 0, truncated: false, unmappedConcepts: [], files: [], pinIds: [] },
			inventory: inv,
			specWriteClaims: claims,
		});
		expect(findings).toEqual([]);
	});

	it("absent specWriteClaims keeps the HISTORICAL skip (no new deadlock on pre-W replays)", () => {
		const findings = specAmendmentFamilyFindings({
			specControl: undefined,
			designControl: { amendmentFamily: [{ sharedFile: "src/schemas.ts", pinsMoved: [], exemptions: [], docUpdates: [] }] },
			slice: { empty: true, block: "", pinCount: 0, truncated: false, unmappedConcepts: [], files: [], pinIds: [] },
			inventory: extractContractInventory(wt),
		});
		expect(findings).toEqual([]);
	});
});

// ─── D7: the unified .knowledge.json reader ──────────────────────────────────

describe("D7 — the ONE amendmentFamily reader (fail-closed preserved)", () => {
	it("design ?? spec resolution order", () => {
		writeWt(`${SELF_SPEC}/.knowledge.json`, JSON.stringify({ stages: { design: { data: { amendmentFamily: [{ sharedFile: "src/a.ts", pinsMoved: [], exemptions: [], docUpdates: [] }] } }, spec: { data: { amendmentFamily: [{ sharedFile: "src/b.ts", pinsMoved: [], exemptions: [], docUpdates: [] }] } } } }));
		const notes: string[] = [];
		const entries = readAmendmentFamilyEntries(join(wt, SELF_SPEC), notes);
		expect(entries.map((e) => e.sharedFile)).toEqual(["src/a.ts"]); // design wins
		expect(amendmentExemptFiles(join(wt, SELF_SPEC)).has("src/b.ts")).toBe(false);
	});

	it("spec fallback when design declared none", () => {
		writeWt(`${SELF_SPEC}/.knowledge.json`, JSON.stringify({ stages: { spec: { data: { amendmentFamily: [{ sharedFile: "src/b.ts", pinsMoved: [], exemptions: [], docUpdates: [] }] } } } }));
		expect(amendmentExemptFiles(join(wt, SELF_SPEC)).has("src/b.ts")).toBe(true);
	});

	it("malformed entry ⇒ ZERO entries + the P10 note (greppable phrasing preserved)", () => {
		writeWt(`${SELF_SPEC}/.knowledge.json`, JSON.stringify({ stages: { design: { data: { amendmentFamily: [{ sharedFile: "", pinsMoved: [], exemptions: [], docUpdates: [] }] } } } }));
		const notes: string[] = [];
		expect(readAmendmentFamilyEntries(join(wt, SELF_SPEC), notes)).toEqual([]);
		expect(notes.some((n) => n.includes("malformed amendmentFamily entry") && n.includes("fail-closed"))).toBe(true);
	});

	it("unparseable JSON ⇒ zero entries + note", () => {
		writeWt(`${SELF_SPEC}/.knowledge.json`, "{not json");
		const notes: string[] = [];
		expect(readAmendmentFamilyEntries(join(wt, SELF_SPEC), notes)).toEqual([]);
		expect(notes.some((n) => n.includes("unparseable"))).toBe(true);
	});
});

// ─── F: the starved-slice temporal case ──────────────────────────────────────

describe("fixture F — a pin minted from the task list AFTER the stamp still reaches the gates", () => {
	it("fresh post-render walk sees output-minted pins (the HIGH-1(c) hole)", () => {
		// At stamp time the tree had NO pin on the doc; the task list is then
		// written (the replan-1 regeneration) minting one. Gate W walks FRESH.
		writeWt("tests/interface-contract.test.ts", ""); // no foreign pin yet
		// ... the writer renders 11-task-list.md with protection wording over a
		// file ANOTHER part of the bundle writes:
		writeWt(`${SELF_SPEC}/11-task-list.md`, "Land docs/requirements/22-public-interface.md §4 gains the data/cache note; the guard pins python/omisis/_fetchers.py byte-untouched.\n");
		writeWt(`${SELF_SPEC}/09-specification.md`, "AC-14: docs/requirements/22-public-interface.md §4 gains the data/cache runtime-state note.\n");
		// Simulate the pin materializing post-stamp: a sibling test now pins it.
		writeWt("tests/interface-contract.test.ts", [
			'it("22 frozen", () => {',
			'\tconst dirty = execSync("git status --porcelain -- docs/requirements/22-public-interface.md").toString();',
			'\texpect(dirty, "docs/requirements/22-public-interface.md must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		const inv = extractContractInventory(wt); // the FRESH walk
		expect(inv.protectedFiles.has("docs/requirements/22-public-interface.md")).toBe(true);
		const findings = writeClaimClosureFindings({ stage: "spec", control: undefined, docTexts: [{ text: "docs/requirements/22-public-interface.md §4 gains the data/cache note.", locusPrefix: "09-specification.md" }], inventory: inv, level: "concrete" });
		expect(findings.some((f) => f.message.includes("22-public-interface.md"))).toBe(true);
	});
});

// ─── G + E-regression: entry-gate end-to-end + exemptions honored ────────────

describe("entry gate end-to-end (fixtures A/E/G regression)", () => {
	it("clean plan: no findings; DEC-5 absent-tree fail-open", () => {
		writeWt("tests/hardening-contract.test.ts", [
			'it("holds", () => {',
			'\tconst dirty = execSync("git status --porcelain -- src/registry.ts").toString();',
			'\texpect(dirty, "src/registry.ts must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: join(wt, SELF_SPEC),
			phases: [{ name: "p1", deliverables: { requireFiles: ["src/new_thing.ts"] } }],
			requirementsControl: { acceptanceCriteria: [{ id: "AC-01", statement: "The module lands in src/new_thing.ts." }] },
			bddScenarioIds: new Set(["SCENARIO-001"]),
			docTexts: [{ text: "Phase 1 creates src/new_thing.ts.", locusPrefix: "10-implementation-plan.md" }],
		});
		expect(gate.findings).toEqual([]);
		expect(stage9EntryGate({ worktreePath: undefined, specDirectory: undefined, phases: [], requirementsControl: undefined, bddScenarioIds: new Set(), docTexts: [] }).findings).toEqual([]);
	});

	it("G — concept-reference write claim via conceptMap reaches Gate E", () => {
		writeWt("tests/interface-contract.test.ts", [
			'it("22 frozen", () => {',
			'\tconst dirty = execSync("git status --porcelain -- docs/requirements/22-public-interface.md").toString();',
			'\texpect(dirty, "docs/requirements/22-public-interface.md must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		writeWt("repo-invariants.json", JSON.stringify({ mapping: { "package layout": ["docs/requirements/22-public-interface.md"] }, concepts: ["package layout"] }));
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: join(wt, SELF_SPEC),
			phases: [],
			requirementsControl: { acceptanceCriteria: [{ id: "AC-14", statement: "spec 22's package layout gains the data/cache runtime-state note." }] },
			bddScenarioIds: new Set(),
			docTexts: [],
		});
		expect(gate.findings.some((f) => f.kind === "write-protect" && f.title.includes("22-public-interface.md"))).toBe(true);
	});

	it("I — the finding text carries the replan routing shape (two loci, no judge call)", () => {
		writeWt("tests/interface-contract.test.ts", [
			'it("22 frozen", () => {',
			'\tconst dirty = execSync("git status --porcelain -- docs/requirements/22-public-interface.md").toString();',
			'\texpect(dirty, "docs/requirements/22-public-interface.md must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: join(wt, SELF_SPEC),
			phases: [{ name: "p1", deliverables: { requireFiles: ["docs/requirements/22-public-interface.md"] } }],
			requirementsControl: undefined,
			bddScenarioIds: new Set(),
			docTexts: [],
		});
		const wp = gate.findings.find((f) => f.kind === "write-protect");
		expect(wp).toBeDefined();
		expect(wp!.detail).toContain("revise the spec");
		expect(wp!.detail).toContain("065 Gate E");
	});
});

// ─── L: D-F-F plan compile-time checks ───────────────────────────────────────

describe("fixture L — D-F-F plan compile-time checks", () => {
	it("forward reference: an earlier phase's clause file only a LATER phase creates", () => {
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: undefined,
			phases: [
				{ name: "early", deliverables: { requireContains: [{ file: "src/gen/output.ts", pattern: "EXPORTED" }] } },
				{ name: "late", deliverables: { requireFiles: ["src/gen/output.ts"] } },
			],
			requirementsControl: undefined,
			bddScenarioIds: new Set(),
			docTexts: [],
		});
		const f = gate.findings.find((x) => x.kind === "forward-file-reference");
		expect(f).toBeDefined();
		expect(f!.title).toContain("early");
		expect(f!.title).toContain("LATER");
	});

	it("unsatisfiable: content-clause file neither on disk nor produced by any phase", () => {
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: undefined,
			phases: [{ name: "p1", deliverables: { requireContains: [{ file: "src/never-created.ts", pattern: "EXPORTED" }] } }],
			requirementsControl: undefined,
			bddScenarioIds: new Set(),
			docTexts: [],
		});
		expect(gate.findings.some((x) => x.kind === "forward-file-reference" && x.title.includes("neither on disk"))).toBe(true);
	});

	it("requireTests files are EXCLUDED from the forward-reference check (the TDD flow authors them)", () => {
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: undefined,
			phases: [{ name: "p1", deliverables: { requireTests: ["tests/red-authored-by-phase.test.ts"] } }],
			requirementsControl: undefined,
			bddScenarioIds: new Set(),
			docTexts: [],
		});
		expect(gate.findings.filter((x) => x.kind === "forward-file-reference")).toEqual([]);
	});

	it("create-collision: two phases both declare the same NEW file", () => {
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: undefined,
			phases: [
				{ name: "a", deliverables: { requireFiles: ["src/shared-new.ts"] } },
				{ name: "b", deliverables: { requireFiles: ["src/shared-new.ts"] } },
			],
			requirementsControl: undefined,
			bddScenarioIds: new Set(),
			docTexts: [],
		});
		// B3 (grill round 1): create-collision DROPPED — sequential phases make
		// "A creates, B extends" the canonical TDD handoff, not a conflict.
		expect(gate.findings.some((x) => x.kind === "forward-file-reference" && x.title.includes("src/shared-new.ts"))).toBe(false);
	});

	it("existing file in two phases' requireFiles is NOT a collision (modification handoff)", () => {
		writeWt("src/existing.ts", "export const x = 1;\n");
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: undefined,
			phases: [
				{ name: "a", deliverables: { requireFiles: ["src/existing.ts"] } },
				{ name: "b", deliverables: { requireFiles: ["src/existing.ts"] } },
			],
			requirementsControl: undefined,
			bddScenarioIds: new Set(),
			docTexts: [],
		});
		expect(gate.findings.filter((x) => x.title.includes("src/existing.ts")).length).toBe(0);
	});

	it("unresolvable requireScenarios", () => {
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: undefined,
			phases: [{ name: "p1", deliverables: { requireScenarios: ["SCENARIO-999"] } }],
			requirementsControl: undefined,
			bddScenarioIds: new Set(["SCENARIO-001"]),
			docTexts: [],
		});
		expect(gate.findings.some((x) => x.kind === "unresolvable-scenario" && x.title.includes("SCENARIO-999"))).toBe(true);
	});

	it("uncovered AC write-mandate", () => {
		writeWt("tests/interface-contract.test.ts", [
			'it("22 frozen", () => {',
			'\tconst dirty = execSync("git status --porcelain -- docs/requirements/22-public-interface.md").toString();',
			'\texpect(dirty, "docs/requirements/22-public-interface.md must stay byte-untouched").toBe("");',
			"});",
		].join("\n"));
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: undefined,
			phases: [{ name: "p1", deliverables: { requireFiles: ["src/other.ts"] } }],
			requirementsControl: { acceptanceCriteria: [{ id: "AC-14", statement: "docs/requirements/22-public-interface.md §4 gains the data/cache note." }] },
			bddScenarioIds: new Set(),
			docTexts: [],
		});
		expect(gate.findings.some((x) => x.kind === "uncovered-ac-write" && x.title.includes("AC-14") && x.title.includes("22-public-interface.md"))).toBe(true);
	});
});

// ─── K: scan-cap loud partial semantics ──────────────────────────────────────

describe("fixture K — scan cap is loud, partial-but-authoritative", () => {
	it("a capped inventory surfaces the partial note in Gate E scan lines", () => {
		// Simulate the capped-inventory error line the extractor emits at the cap.
		const cappedInventory = extractContractInventory(wt);
		cappedInventory.errors.push("scan cap reached (2000 files) — inventory incomplete (P8 bound)");
		const gate = entryContradictions({ writeClaims: [], inventory: cappedInventory, specDirectory: undefined });
		expect(gate.scanLines.some((l) => l.includes("PARTIAL but authoritative"))).toBe(true);
	});
});

// ─── module hygiene ──────────────────────────────────────────────────────────

describe("spine hygiene", () => {
	it("extractWriteClaims is pure and deterministic (same input ⇒ same output)", () => {
		const texts = [{ text: "docs/requirements/22-public-interface.md §4 gains the note. Files edited: src/a.ts, tests/b.test.ts", locusPrefix: "doc.md" }];
		const a = extractWriteClaims(texts, "spec");
		const b = extractWriteClaims(texts, "spec");
		expect(a).toEqual(b);
		expect(a.claims.length).toBeGreaterThanOrEqual(3);
	});

	it("existsSync import used (tree-shaken smoke)", () => {
		expect(typeof existsSync).toBe("function");
	});
});

// ─── grill round 1 fold: the gate-found holes (B1/B2/B3/A1/A2/A3/A5/A6) ─────

describe("065 grill round 1 folds", () => {
	it("B1 — comma-mixed single segment: WRITE and PROTECT co-exist, write token NOT swallowed", () => {
		const r = classifySegment(
			"docs/requirements/22-public-interface.md gains the data/cache note, and src/legacy.ts stays byte-untouched in git",
			"09-specification.md:1",
			"spec",
		);
		expect(r.writes.map((w) => w.path)).toContain("docs/requirements/22-public-interface.md");
		expect(r.protects).toContain("src/legacy.ts");
		expect(r.protects).not.toContain("docs/requirements/22-public-interface.md");
	});

	it("B1 — period-separated sentence pair never protects the write target (segments parity)", () => {
		const governed = governedProtectedTokens(
			"The module lands in src/new_thing.ts. The legacy file src/legacy.ts stays byte-untouched in git.",
			["src/new_thing.ts", "src/legacy.ts"],
		);
		expect(governed).toContain("src/legacy.ts");
		expect(governed).not.toContain("src/new_thing.ts");
	});

	it("B1 — end-to-end: the same pair in an md spec doc mints a pin on legacy ONLY", () => {
		writeWt(`${SELF_SPEC}/09-specification.md`, [
			"# spec",
			"The module lands in src/new_thing.ts. The legacy file src/legacy.ts stays byte-untouched in git.",
		].join("\n"));
		const inv = extractContractInventory(wt);
		expect(inv.protectedFiles.has("src/legacy.ts")).toBe(true);
		expect(inv.protectedFiles.has("src/new_thing.ts")).toBe(false);
	});

	it("A3 — same-token both-governance mints BOTH (the self-contradiction stays visible to Gate E)", () => {
		const r = classifySegment("src/x.ts gains a hook and src/x.ts stays byte-untouched in git", "09-specification.md:1", "spec");
		expect(r.writes.map((w) => w.path)).toContain("src/x.ts");
		expect(r.protects).toContain("src/x.ts");
	});

	it("B2 — double negation repro: both exempted paths stay OUT of writes, order-independent, pure", () => {
		const seg = "extends src/a.ts and src/b.ts without touching docs/x.md and docs/y.md";
		const r1 = classifySegment(seg, "10-implementation-plan.md:1", "spec");
		expect(r1.writes.map((w) => w.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(r1.writes.map((w) => w.path)).not.toContain("docs/x.md");
		expect(r1.writes.map((w) => w.path)).not.toContain("docs/y.md");
		// purity: a second run over a DIFFERENT segment with the same negation
		// shape yields identical classification (no lastIndex carryover).
		const r2 = classifySegment("extends src/c.ts without touching docs/z.md", "10-implementation-plan.md:2", "spec");
		expect(r2.writes.map((w) => w.path)).toEqual(["src/c.ts"]);
		const r3 = classifySegment(seg, "10-implementation-plan.md:3", "spec");
		expect(r3.writes.map((w) => w.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("A1 — Gate W self-minted branch fires (repo-relative claim doc == pin.owningSpec)", () => {
		// The spec's OWN artifact both writes and protects the same file.
		writeWt(`${SELF_SPEC}/09-specification.md`, "src/shared.ts gains the hook. src/shared.ts stays byte-untouched in git.\n");
		const inv = extractContractInventory(wt);
		expect(inv.protectedFiles.has("src/shared.ts")).toBe(true);
		const findings = writeClaimClosureFindings({
			stage: "spec",
			level: "concrete",
			docTexts: [{ text: "src/shared.ts gains the hook. src/shared.ts stays byte-untouched in git.", locusPrefix: "docs/specifications/26-capability-backend-substrate/09-specification.md" }],
			control: undefined,
			inventory: inv,
		});
		expect(findings.some((f) => f.kind === "blocking" && f.message.includes("OWN artifact"))).toBe(true);
		// and the family entry must NOT license it (checked BEFORE familyFiles skip):
		const withFamily = writeClaimClosureFindings({
			stage: "spec",
			level: "concrete",
			docTexts: [{ text: "src/shared.ts gains the hook. src/shared.ts stays byte-untouched in git.", locusPrefix: "docs/specifications/26-capability-backend-substrate/09-specification.md" }],
			control: { amendmentFamily: [{ sharedFile: "src/shared.ts", docUpdates: [], exemptions: [], pinsMoved: [] }] },
			inventory: inv,
		});
		expect(withFamily.some((f) => f.message.includes("no family declaration licenses this"))).toBe(true);
	});

	it("A2 — md-arm protect grammar now covers 'never touching' (single spelling)", () => {
		writeWt(`${SELF_SPEC}/07-design.md`, "The bridge extends src/tools/data_analyst.ts; the registry surfaces never touch python/omisis/_fetchers.py.\n");
		const inv = extractContractInventory(wt);
		expect(inv.protectedFiles.has("python/omisis/_fetchers.py")).toBe(true);
		expect(inv.protectedFiles.has("src/tools/data_analyst.ts")).toBe(false);
	});

	it("A6 — malformed family entry surfaces at Gate W as a repair demand", () => {
		writeWt(`${SELF_SPEC}/09-specification.md`, "src/pinned.ts gains the note.\n");
		writeWt("tests/pin.test.ts", 'it("p", () => { expect(execSync("git status --porcelain -- src/pinned.ts").toString(), "src/pinned.ts stays byte-untouched").toBe(""); });\n');
		const inv = extractContractInventory(wt);
		const findings = writeClaimClosureFindings({
			stage: "spec",
			level: "concrete",
			docTexts: [{ text: "src/pinned.ts gains the note.", locusPrefix: "docs/specifications/26-capability-backend-substrate/09-specification.md" }],
			control: { amendmentFamily: [{ sharedFile: "src/pinned.ts", docUpdates: [], exemptions: [], pinsMoved: [] }, { sharedFile: "", docUpdates: [], exemptions: [], pinsMoved: [] }] },
			inventory: inv,
		});
		expect(findings.some((f) => f.kind === "blocking" && f.message.includes("Gate E honors ZERO exemptions"))).toBe(true);
	});

	it("B3 — sequential create-then-extend across phases yields NO entry finding (canonical TDD handoff)", () => {
		const gate = stage9EntryGate({
			worktreePath: wt,
			specDirectory: undefined,
			phases: [
				{ name: "create", deliverables: { requireFiles: ["src/handoff.ts"] } },
				{ name: "extend", deliverables: { requireFiles: ["src/handoff.ts"], requireContains: [{ file: "src/handoff.ts", pattern: "hook" }] } },
			],
			requirementsControl: undefined,
			bddScenarioIds: new Set(),
			docTexts: [],
		});
		expect(gate.findings.filter((x) => x.title.includes("src/handoff.ts")).length).toBe(0);
	});

	it("F-4 — phantom rejects are LOUD (P10): the ts-arm pathspec is rejected and named (residual hole closed)", () => {
		writeWt("tests/financials-contract.test.ts", [
			"const dirty = execSync(`git status --porcelain -- ${wiredFile}`, { encoding: \"utf8\" }).trim();",
			"expect(dirty, `${wiredFile} must stay byte-untouched`).toBe(\"\");",
		].join("\n"));
		const { rejects } = scanImmutabilityIdiomsWithRejects("const dirty = execSync(`git status --porcelain -- ${wiredFile}`).trim(); expect(dirty, \"stays byte-untouched\").toBe(\"\");");
		expect(rejects).toContain("${wiredFile}");
		const inv = extractContractInventory(wt);
		expect(inv.protectedFiles.has("${wiredFile}")).toBe(false);
		expect(inv.scanLines.some((l) => l.includes("wiredFile") && l.includes("rejected token"))).toBe(true);
	});
});

// ─── v0.4.8 (live spec-26 post-mortem): the grammar lesson is prompt-pinned ───

describe("065 v0.4.8 — write-claim grammar teaching (live-run 5-round burn)", () => {
	it("design AND spec prompts carry the WRITE-CLAIM GRAMMAR block (3 rules + exemption trap)", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync("src/prompts.ts", "utf8");
		for (const fn of ["buildDesignPrompt", "buildSpecPrompt"]) {
			const body = src.slice(src.indexOf(`function ${fn}`));
			const end = body.indexOf("\nexport function");
			const seg = body.slice(0, end > 0 ? end : 4000);
			expect(seg).toContain("WRITE-CLAIM GRAMMAR (065");
			expect(seg).toContain("self-contradiction no amendmentFamily entry can license");
			expect(seg).toContain("re-mints the pin");
			expect(seg).toContain("cite it by pinId");
		}
	});

	it("the self-contradiction finding names the exemption-restate trap (round-4/5 fix)", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync("src/review/claim-spine.ts", "utf8");
		expect(src).toContain("TRAP: if this pin sits inside an exemption/justification you wrote");
		expect(src).toContain(`never quoting the immutability idiom`);
	});
});
