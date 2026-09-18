/**
 * The implementer dispatch + structured-claim parse — contract test for the
 * v0.4.49 extraction (increment 21 of the stage.ts split, the CALL half of
 * the implementer round).
 *
 * THE CONTRACTS: the record carries {impl, projectStructured (the filtered
 * footprint), rawStructured (the RAW parse — the change-tracker probe's
 * audit-parity input), implDefects, implTextTail}; the by-ref
 * needsResearchArchive gets the bounded P8 push (oldest drop first, logged);
 * the filesModified carry appends first-seen; the HEAD-drift advisory on a
 * real self-committing repo; and the streaming log reflects errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { PipelineState, StageContext } from "../src/types.ts";

vi.mock("../src/convergence-ledger.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/convergence-ledger.ts")>();
	return { ...orig, recordConvergenceFindings: vi.fn() };
});

import { dispatchImplementer, type ImplementerDispatchInput } from "../src/stages/implementation/implementer-dispatch.ts";
import { recordConvergenceFindings } from "../src/convergence-ledger.ts";
import { RESEARCH_ASSIST_ARCHIVE_CAP } from "../src/stages/research-assist.ts";

const recordMock = vi.mocked(recordConvergenceFindings);

const repos: string[] = [];
function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src/seed.ts"), "export const S = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	repos.push(repo);
	return repo;
}

const ctxOf = (agent?: unknown): StageContext => ({
	task: "t", options: {}, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: () => {}, phase: () => {}, events: new EventEmitter(), results: [],
	agent: agent ?? (async () => ({ control: {} })),
} as unknown as StageContext);

const baseInput = (over: Partial<ImplementerDispatchInput> = {}): ImplementerDispatchInput => ({
	ctx: ctxOf(),
	state: {} as PipelineState,
	worktreePath: "",
	phaseId: "phase-01",
	attempt: 1,
	implPrompt: "do the work",
	needsResearchArchive: [],
	filesModified: [],
	attemptDetail: (n: number) => `attempt ${n}`,
	announceActivity: () => {},
	emitStep: () => {},
	inStepScope: async (_seq: number, _label: string, fn: () => Promise<unknown>) => fn() as never,
	nextStepSeq: () => 1,
	...over,
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("implementer dispatch (v0.4.49 increment-21 extraction)", () => {
	it("the record: structured claims parsed, internal-runtime claims FILTERED from projectStructured but KEPT in rawStructured", async () => {
		const ctx = ctxOf(async () => ({
			control: { filesCreated: ["src/real.ts", "notes/.resume-cache.jsonl"], filesModified: [], filesDeleted: [], testDefects: [] },
		}));
		const out = await dispatchImplementer(baseInput({ ctx }));
		expect(out.projectStructured.filesCreated).toEqual(["src/real.ts"]); // filtered
		expect(out.rawStructured.filesCreated).toEqual(["src/real.ts", "notes/.resume-cache.jsonl"]); // raw parity
		expect(out.implDefects).toEqual([]);
	});

	it("implDefects parses the structured test-defect channel", async () => {
		const ctx = ctxOf(async () => ({
			control: { filesCreated: [], filesModified: [], filesDeleted: [], testDefects: [{ testFile: "tests/a.test.ts", reason: "unsatisfiable assertion" }] },
		}));
		const out = await dispatchImplementer(baseInput({ ctx }));
		expect(out.implDefects.length).toBe(1);
	});

	it("the needsResearch archive: entries pushed by-ref with the honest log; the P8 cap drops OLDEST first", async () => {
		const logs: string[] = [];
		const ctx = ctxOf(async () => ({ control: { filesCreated: [], filesModified: [], filesDeleted: [], needsResearch: [{ question: "q-new", why: "the runner cannot express it" }] } }));
		ctx.log = (l: string) => logs.push(l);
		const archive: Array<{ question: string; why: string }> = Array.from({ length: RESEARCH_ASSIST_ARCHIVE_CAP }, (_, i) => ({ question: `q-${i}`, why: `w-${i}` }));
		await dispatchImplementer(baseInput({ ctx, needsResearchArchive: archive as never }));
		expect(archive.length).toBe(RESEARCH_ASSIST_ARCHIVE_CAP); // bounded
		expect(archive[archive.length - 1]).toMatchObject({ question: "q-new" }); // newest last
		expect(archive[0]).toMatchObject({ question: "q-1" }); // q-0 (oldest) dropped
		expect(logs.some((l) => l.includes("dropped 1 oldest needsResearch entr(ies)"))).toBe(true);
	});

	it("the gate-suite probe reads the RAW structured parse — source contract (audit parity, v0.4.41 C1)", () => {
		const stageSrc = readFileSync(join(import.meta.dirname, "..", "src", "stages", "implementation", "stage.ts"), "utf8");
		// a silent swap to projectStructured (filtered) would degrade change-tracker.jsonl claim exactness
		expect(stageSrc).toContain("rawStructured: implRound.rawStructured,");
	});

	it("the filesModified carry appends first-seen (created ∪ modified, deleted EXCLUDED)", async () => {
		const ctx = ctxOf(async () => ({
			control: { filesCreated: ["src/new.ts"], filesModified: ["src/existing.ts"], filesDeleted: ["src/gone.ts"] },
		}));
		const filesModified = ["src/prior.ts", "src/existing.ts"]; // existing.ts overlaps — the includes() guard must skip it
		await dispatchImplementer(baseInput({ ctx, filesModified }));
		expect(filesModified).toEqual(["src/prior.ts", "src/existing.ts", "src/new.ts"]); // no src/gone.ts, no dup src/existing.ts
	});

	it("the HEAD-drift advisory: a self-committing implementer is detected + recorded, never blocking (real git)", async () => {
		const repo = makeRepo("sd-id-drift-");
		const ctx = ctxOf(async () => {
			writeFileSync(join(repo, "src/landed.ts"), "export const L = 1;\n");
			spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
			spawnSync("git", ["-C", repo, "commit", "-qm", "self"], { encoding: "utf8" });
			return { control: { filesCreated: ["src/landed.ts"], filesModified: [], filesDeleted: [] } };
		});
		const out = await dispatchImplementer(baseInput({ ctx, worktreePath: repo }));
		expect(recordMock).toHaveBeenCalledTimes(1);
		expect(recordMock.mock.calls[0]![1]).toMatchObject({ severity: "low", blocking: false, sourceGate: "self-commit" });
		expect(out.impl).toBeTruthy(); // never blocked
	});

	it("an errored implementer: the streaming log names the error + the step glyph fails", async () => {
		const logs: string[] = [];
		const steps: Array<[string, string]> = [];
		const ctx = ctxOf(async () => ({ control: null, error: "timed out" }));
		ctx.log = (l: string) => logs.push(l);
		await dispatchImplementer(baseInput({ ctx, emitStep: (label: string, status: string) => steps.push([label, status]) }));
		expect(logs.some((l) => l.includes("implementer (attempt 1) error=timed out"))).toBe(true);
		expect(steps[1]).toEqual(["Implementation (attempt 1)", "failed"]);
	});
});
