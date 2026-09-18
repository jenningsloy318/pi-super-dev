/**
 * The sequential gate-suite core — contract test for the v0.4.41 extraction
 * (increment 13 of the stage.ts split).
 *
 * UNLIKE increments 7–12 this region has NO loop exits: it is sequential
 * data-prep with side effects, extracted as ONE WIDE RECORD. The contracts to
 * pin: the record shape (every downstream loop binding derives from it), the
 * spec-10 claimed-files bridge (the deduped UNION), the deliverable skipTests
 * wiring (!buildGreen), and — the load-bearing new seam — the CROSS-PHASE LEAK
 * DELTA: inline the leak block mutated the phase-scoped boundary stats
 * directly; the module returns {revertHits, owners, files} and the caller
 * applies the same increment/union semantics (the values the no-progress
 * valve reads).
 *
 * Real git repos for the leak revert; build-runner mocked for verdict control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

vi.mock("../src/build-runner.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/build-runner.ts")>();
	return {
		...orig,
		runBuildGate: vi.fn(() => ({
			pass: true, buildSuccess: true, allTestsPass: true, typecheckSuccess: true, inScopePass: false,
			ran: ["mock"], errors: [], outOfScopeErrors: [], baselineCheck: undefined,
		})),
		runDeliverableCheck: vi.fn(() => ({ pass: true, missing: [], ran: [] })),
		resetDeliverableCheckCache: vi.fn(),
	};
});

import { runGateSuite } from "../src/stages/implementation/gate-suite.ts";
import { ChangeTracker } from "../src/tracking.ts";
import { runBuildGate, runDeliverableCheck } from "../src/build-runner.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

const buildGateMock = vi.mocked(runBuildGate);
const deliverableMock = vi.mocked(runDeliverableCheck);

const repos: string[] = [];

function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src/prod.ts"), "export const A = 1;\n");
	writeFileSync(join(repo, "src/later-feature.ts"), "export const L = 1;\n"); // committed — later phase's deliverable
	git("add", "-A");
	git("commit", "-qm", "seed");
	repos.push(repo);
	return repo;
}

const gitOf = (repo: string, ...args: string[]) => String(spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout ?? "");

const ctxOf = (out: { logs: string[] }): StageContext => ({
	task: "t", options: {}, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
} as unknown as StageContext);

const baseInput = (over: Partial<Parameters<typeof runGateSuite>[0]> = {}) => ({
	ctx: ctxOf({ logs: [] }),
	state: {} as PipelineState,
	worktreePath: "",
	defaultBranch: undefined as string | undefined,
	language: "typescript",
	phaseId: "phase-01",
	attempt: 1,
	phase: { deliverables: { requireFiles: ["src/prod.ts"] } },
	phases: [
		{ name: "wire-prod", deliverables: { requireFiles: ["src/prod.ts"] } },
		{ name: "wire-later", deliverables: { requireFiles: ["src/later-feature.ts"] } },
	] as Array<Record<string, unknown>>,
	idx: 0,
	testFiles: [],
	projectStructured: { filesCreated: [], filesModified: [], filesDeleted: [] },
	rawStructured: { filesCreated: [], filesModified: [], filesDeleted: [] },
	tracker: null,
	announceActivity: () => {},
	attemptDetail: (n: number) => `attempt ${n}`,
	...over,
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("gate suite (v0.4.41 increment-13 extraction)", () => {
	it("a clean greenfield attempt → the full record with an EMPTY leak delta", async () => {
		const repo = makeRepo("sd-gs-clean-");
		const out = runGateSuite(baseInput({ worktreePath: repo, phase: { deliverables: { requireFiles: ["src/prod.ts"] } } }));
		expect(out.gate.pass).toBe(true);
		expect(out.buildGreen).toBe(true);
		expect(out.deliverableCheck.pass).toBe(true);
		expect(out.changeGate.pass).toBe(true); // no tracker → trivial pass
		expect(out.symbolGate.pass).toBe(true);
		expect(out.leak).toEqual({ revertHits: 0, owners: [], files: [] });
		expect(out.declaredScope).toContain("src/prod.ts");
	});

	it("the spec-10 bridge: the implementer's created files UNION into requireFiles (deduped)", () => {
		const repo = makeRepo("sd-gs-bridge-");
		const out = runGateSuite(baseInput({
			worktreePath: repo,
			phase: { deliverables: { requireFiles: ["src/prod.ts", "src/claimed.ts"] } },
			projectStructured: { filesCreated: ["src/claimed.ts", "src/extra.ts"], filesModified: [], filesDeleted: [] },
		}));
		expect(out.bridgedDeliverables.requireFiles).toEqual(["src/prod.ts", "src/claimed.ts", "src/extra.ts"]); // deduped, first-seen order
	});

	it("a FAILED build gate wires skipTests:true into the deliverable check (the deferred test-lister)", () => {
		const repo = makeRepo("sd-gs-skip-");
		buildGateMock.mockReturnValueOnce({
			pass: false, buildSuccess: false, allTestsPass: false, typecheckSuccess: false, inScopePass: false,
			ran: ["mock"], errors: ["tsc error"], outOfScopeErrors: [], baselineCheck: undefined,
		});
		const out = runGateSuite(baseInput({ worktreePath: repo }));
		expect(out.buildGreen).toBe(false);
		expect(deliverableMock.mock.calls[0]![2]).toMatchObject({ skipTests: true });
	});

	it("the CROSS-PHASE LEAK: a tracked change to a LATER phase's declared file → BLOCKING revert + the boundary DELTA", () => {
		const repo = makeRepo("sd-gs-leak-");
		writeFileSync(join(repo, "src/later-feature.ts"), "LEAKED EDIT\n"); // tracked, phase-02's deliverable
		const logs: string[] = [];
		const specDir = mkdtempSync(join(tmpdir(), "sd-gs-spec-"));
		repos.push(specDir);
		const tracker = new ChangeTracker(specDir, repo);
		tracker.begin("phase", "phase-01");
		const out = runGateSuite(baseInput({
			ctx: ctxOf({ logs }),
			worktreePath: repo,
			phase: { deliverables: { requireFiles: ["src/prod.ts"] } }, // phase-01 scope: prod only
			tracker,
		}));
		// the leak DELTA — the caller's union input, exactly what inline accumulated
		expect(out.leak).toEqual({ revertHits: 1, owners: ["wire-later"], files: ["src/later-feature.ts"] });
		// the BLOCKING log names owner + files + the approval route
		expect(logs.some((l) => l.includes("BLOCKING: changed-not-claimed file(s) src/later-feature.ts"))).toBe(true);
		expect(logs.some((l) => l.includes("DECLARED DELIVERABLES of later phase(s) wire-later"))).toBe(true);
		// the leaked edit was REVERTED on disk (pre-commit, effective)
		expect(gitOf(repo, "status", "--porcelain").trim()).toBe("");
	});

	it("a change INSIDE the phase's own declared scope never leaks (co-owned files belong here)", () => {
		const repo = makeRepo("sd-gs-own-");
		writeFileSync(join(repo, "src/later-feature.ts"), "CO-OWNED EDIT\n");
		const out = runGateSuite(baseInput({
			worktreePath: repo,
			phase: { deliverables: { requireFiles: ["src/prod.ts", "src/later-feature.ts"] } }, // co-owned
		}));
		expect(out.leak).toEqual({ revertHits: 0, owners: [], files: [] });
		// and the edit SURVIVES (no revert)
		expect(gitOf(repo, "status", "--porcelain")).toContain("src/later-feature.ts");
	});

	it("the RC12c out-of-scope audit logs a NON-BLOCKING finding line (visible drift, never silent)", () => {
		const repo = makeRepo("sd-gs-rc12c-");
		writeFileSync(join(repo, "src/undeclared.ts"), "WORKAROUND\n");
		const logs: string[] = [];
		// a real tracker is needed for trackerOutofScopeEdits to see the edit
		const specDir = mkdtempSync(join(tmpdir(), "sd-gs-spec-"));
		repos.push(specDir);
		const tracker = new ChangeTracker(specDir, repo);
		tracker.begin("phase", "phase-01");
		runGateSuite(baseInput({
			ctx: ctxOf({ logs }),
			worktreePath: repo,
			tracker,
			testFiles: [],
		}));
		expect(logs.some((l) => l.includes("out-of-scope edits (non-blocking, recorded)"))).toBe(true);
	});
});
