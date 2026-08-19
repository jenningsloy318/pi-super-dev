/**
 * Phase 1 (Track 30) — unit tests for src/fault-classification.ts.
 *
 *   T1.1 deterministic classification floor      (SCENARIO-001/002/003, AC-01)
 *   T1.3 stripVolatileNoise                      (SCENARIO-018/019, AC-06/AC-08)
 *   T1.4 canonical dirt inventory                (SCENARIO-008/009, AC-03)
 *   T1.5 quarantine primitive + kill-switch      (AC-13, primitive half of SCENARIO-028)
 *   T1.6 environment-fault ledger primitives     (SCENARIO-025, AC-12)
 *
 * RED-first (SCENARIO-031): each describe block lands BEFORE its
 * implementation and is verified failing on the pre-fix tree.
 *
 * Truth-table cases build the synthetic [baseline-verify] block with the REAL
 * prefix string imported from gates.ts (T1.2 hoist) — single-sourced, no drift
 * between the classifier and the gate (D-11).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BASELINE_VERIFY_ERROR_PREFIX } from "../src/build-runner/gates.ts";
import { HARNESS_BOOKKEEPING_FILES } from "../src/helpers.ts";
import {
	classifyGateFault,
	isBaselineVerifySyntheticError,
	stripVolatileNoise,
	isExcludedFromQuarantine,
	collectDirtPaths,
	quarantineDirt,
	dirtyQuarantineEnabled,
	DIRTY_QUARANTINE_KILL_SWITCH,
	environmentFaultLedgerPath,
	appendEnvironmentFault,
	readEnvironmentFaultCount,
} from "../src/fault-classification.ts";

/** Pass-through child_process argv recorder (rc8-rc12 cpMock pattern): every
 *  spawnSync call is recorded, then delegated to the REAL spawnSync — so the
 *  real-git fixtures keep working while the argv stream stays auditable
 *  (AC-13: only `stash push` may ever mutate the worktree). */
const cpRecorder = vi.hoisted(() => ({
	calls: [] as Array<{ cmd: string; args: string[]; cwd?: string }>,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		spawnSync: (cmd: string, argv?: readonly string[], opts?: { cwd?: string }) => {
			cpRecorder.calls.push({ cmd, args: Array.isArray(argv) ? [...argv] : [], cwd: opts?.cwd });
			return (actual.spawnSync as typeof import("node:child_process").spawnSync)(cmd, argv, opts as never);
		},
	};
});

/** Real-git temp-repo helper (tests/setup.test.ts pattern — local IO only). */
function gitRun(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function mkGitRepo(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	gitRun(dir, ["init", "-q", "-b", "main"]);
	gitRun(dir, ["config", "user.email", "t@t"]);
	gitRun(dir, ["config", "user.name", "t"]);
	return dir;
}

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** Byte-form of the gate's synthetic block: prefix + " " + evidence (gates.ts). */
const syntheticBlock = (evidence: string) => `${BASELINE_VERIFY_ERROR_PREFIX} ${evidence}`;

const OWN_SCOPE_GREEN = { deliverablePass: true, changePass: true, symbolPass: true, tddClean: true } as const;

const OOS_BLOCK = "FAIL\tgithub.com/macotestdashboard/backend-service/internal/services/snow\t14.439s";
const BASELINE_EVIDENCE = "pnpm run test (whole suite) PASSES at baseline 45b865ef — the failure is new on this branch";

describe("classifyGateFault — deterministic classification floor (SCENARIO-001/002/003, AC-01)", () => {
	it("golden env-blocker row: out-of-scope block + synthetic block, baseline=regression, own-scope green, FOREIGN DIRT PRESENT ⇒ environmental-blocker with [quarantine+re-gate, judge] (SCENARIO-001 + v0.2.6 G1)", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK, syntheticBlock(BASELINE_EVIDENCE)],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "regression", evidence: BASELINE_EVIDENCE },
			ownScope: { ...OWN_SCOPE_GREEN },
			foreignDirtCount: 1,
		});
		expect(r.faultClass).toBe("environmental-blocker");
		expect(r.actuators).toEqual(["quarantine+re-gate", "judge"]);
	});

	it("v0.2.6 G1 — the SAME environmental shape with ZERO foreign dirt ⇒ product-defect (runs 01-47 / 05-09: a clean-at-phase-start tree cannot have an environment fault; the out-of-scope regression is this phase's own doing)", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK, syntheticBlock(BASELINE_EVIDENCE)],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "regression", evidence: BASELINE_EVIDENCE },
			ownScope: { ...OWN_SCOPE_GREEN },
			foreignDirtCount: 0,
		});
		expect(r.faultClass).toBe("product-defect");
		expect(r.actuators).toEqual(["implementer-retry"]);
	});

	it("v0.2.6 G1 — undefined foreignDirtCount (no provenance signal) is treated as ZERO: unknown provenance can never support an environment claim or a worktree mutation", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK, syntheticBlock(BASELINE_EVIDENCE)],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "regression", evidence: BASELINE_EVIDENCE },
			ownScope: { ...OWN_SCOPE_GREEN },
		});
		expect(r.faultClass).toBe("product-defect");
		expect(r.actuators).toEqual(["implementer-retry"]);
	});

	it("v0.2.6 G1 — foreign dirt does NOT rescue a non-regression or own-scope-red shape: baseline=preexisting with foreign dirt stays unclassified", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK, syntheticBlock(BASELINE_EVIDENCE)],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "preexisting", evidence: BASELINE_EVIDENCE },
			ownScope: { ...OWN_SCOPE_GREEN },
			foreignDirtCount: 3,
		});
		expect(r.faultClass).toBe("unclassified");
	});

	it("v0.2.6 G1 — foreign dirt does NOT rescue own-scope red evidence (deliverable failed): stays unclassified even with foreign dirt", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK, syntheticBlock(BASELINE_EVIDENCE)],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "regression", evidence: BASELINE_EVIDENCE },
			ownScope: { ...OWN_SCOPE_GREEN, deliverablePass: false },
			foreignDirtCount: 3,
		});
		expect(r.faultClass).toBe("unclassified");
	});

	it("synthetic block is excluded from the failure tally — not counted as an in-scope product failure (SCENARIO-001)", () => {
		// Only the synthetic block + the out-of-scope member, WITH foreign dirt;
		// the synthetic entry must NOT flip the row away from environmental.
		const r = classifyGateFault({
			errors: [OOS_BLOCK, syntheticBlock(BASELINE_EVIDENCE)],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "regression", evidence: BASELINE_EVIDENCE },
			ownScope: { ...OWN_SCOPE_GREEN },
			foreignDirtCount: 1,
		});
		expect(r.faultClass).toBe("environmental-blocker");
	});

	it("genuine in-scope error ⇒ product-defect with [implementer-retry] (SCENARIO-002)", () => {
		const r = classifyGateFault({
			errors: ["FAIL src/auth/login.test.ts\nexpected 200 to be 401"],
			outOfScopeErrors: [],
			baselineCheck: { status: "regression", evidence: "irrelevant" },
			ownScope: { ...OWN_SCOPE_GREEN },
		});
		expect(r.faultClass).toBe("product-defect");
		expect(r.actuators).toEqual(["implementer-retry"]);
	});

	it("mixed in-scope + out-of-scope ⇒ product-defect (SCENARIO-002)", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK, "FAIL src/auth/login.test.ts\nexpected 200 to be 401"],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "regression", evidence: BASELINE_EVIDENCE },
			ownScope: { ...OWN_SCOPE_GREEN },
		});
		expect(r.faultClass).toBe("product-defect");
		expect(r.actuators).toEqual(["implementer-retry"]);
	});

	it("absent baselineCheck ⇒ unclassified, never environmental-blocker (SCENARIO-003)", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK],
			outOfScopeErrors: [OOS_BLOCK],
			ownScope: { ...OWN_SCOPE_GREEN },
		});
		expect(r.faultClass).toBe("unclassified");
		expect(r.actuators).toEqual(["implementer-retry"]);
	});

	it("baselineCheck=preexisting ⇒ unclassified (truth-table row 2 otherwise-arm)", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "preexisting", evidence: "also fails at baseline" },
			ownScope: { ...OWN_SCOPE_GREEN },
		});
		expect(r.faultClass).toBe("unclassified");
	});

	it("baselineCheck=unknown ⇒ unclassified", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "unknown", evidence: "timeout" },
			ownScope: { ...OWN_SCOPE_GREEN },
		});
		expect(r.faultClass).toBe("unclassified");
	});

	it("own-scope red ⇒ unclassified, never environmental-blocker (SCENARIO-003)", () => {
		const r = classifyGateFault({
			errors: [OOS_BLOCK, syntheticBlock(BASELINE_EVIDENCE)],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "regression", evidence: BASELINE_EVIDENCE },
			ownScope: { deliverablePass: false, changePass: true, symbolPass: true, tddClean: true },
		});
		expect(r.faultClass).toBe("unclassified");
		expect(r.actuators).toEqual(["implementer-retry"]);
	});

	it("empty errors ⇒ unclassified (truth-table row 3)", () => {
		const r = classifyGateFault({
			errors: [],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "regression", evidence: BASELINE_EVIDENCE },
			ownScope: { ...OWN_SCOPE_GREEN },
		});
		expect(r.faultClass).toBe("unclassified");
	});

	it("in-scope error that merely QUOTES the prefix words mid-string ⇒ product-defect — no fuzzy absorption (SCENARIO-002/AC-01)", () => {
		const quoted = `expected gate to mention [baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch: mid-string, not startsWith`;
		const r = classifyGateFault({
			errors: [OOS_BLOCK, quoted],
			outOfScopeErrors: [OOS_BLOCK],
			baselineCheck: { status: "regression", evidence: BASELINE_EVIDENCE },
			ownScope: { ...OWN_SCOPE_GREEN },
		});
		expect(r.faultClass).toBe("product-defect");
	});
});

/** A SCENARIO-016 replica line (run 01-02-50 provenance, BDD §fixture):
 *  go-test output block with every AC-06 noise class present. Tabs in the
 *  FAIL/ok lines are the real `go test` separators. */
function snowReplica(opts: { time: string; uuid: string; jsonDuration: string; failPkg: string; okSub: string; unit: string; testLineDuration: string; memoHit: boolean }): string {
	return [
		`backend-service: go test ./... FAILED (exit 1):`,
		`{"time":"${opts.time}","level":"INFO","msg":"[resolve-team] completed trackingID=${opts.uuid} documentType=message total=2 resolved=1 notFound=1 duration=${opts.jsonDuration}","service_name":"backend-service","hostname":"JV4MPQJ4M2"}`,
		`FAIL`,
		`FAIL\tgithub.com/macotestdashboard/backend-service/internal/services/${opts.failPkg}\t14.439s`,
		`ok  \tgithub.com/macotestdashboard/backend-service/internal/services/${opts.failPkg}/odata\t3.695s`,
		`ok  \tgithub.com/macotestdashboard/backend-service/internal/services/unittest\t(cached)`,
		`--- FAIL: TestEnrichment_AreaCandidates_ClusterMatch_MatchType (${opts.testLineDuration})`,
		`FAIL; [baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch: pnpm run test (whole suite) PASSES at baseline 45b865ef — the failure is new on this branch${opts.memoHit ? " [cached]" : ""}`,
	].join("\n");
}

describe("stripVolatileNoise — PRB primitive (SCENARIO-014/018/019, AC-06/AC-08)", () => {
	it("strips ISO-8601 timestamps with timezone and fractional seconds", () => {
		expect(stripVolatileNoise("start 2026-08-18T10:11:42.496069+08:00 end")).toBe("start  end");
	});

	it("strips ISO-8601 timestamps in Z form", () => {
		expect(stripVolatileNoise("start 2026-08-18T10:11:42Z end")).toBe("start  end");
	});

	it("strips space-separated datetimes without timezone", () => {
		expect(stripVolatileNoise("start 2026-08-18 10:11:42 end")).toBe("start  end");
	});

	it("strips canonical UUIDs", () => {
		expect(stripVolatileNoise("id=76debd8a-9e7c-45f2-9d3a-da1f8dae56f8 ok")).toBe("id= ok");
		expect(stripVolatileNoise("bc3831c9-9705-43ad-ac26-04c70142f21a")).toBe("");
	});

	it("strips durations (seconds and milliseconds, whole and fractional)", () => {
		expect(stripVolatileNoise("a 14.439s b 3.695s c 0.000s d 423ms e")).toBe("a  b  c  d  e");
	});

	it("strips (cached) and [cached] markers", () => {
		expect(stripVolatileNoise("ok pkg (cached) [cached]")).toBe("ok pkg  ");
	});

	it("combined: two SCENARIO-016 replica lines differing ONLY in noise strip to identical output (SCENARIO-018)", () => {
		const a = snowReplica({ time: "2026-08-18T10:11:42.496069+08:00", uuid: "76debd8a-9e7c-45f2-9d3a-da1f8dae56f8", jsonDuration: "0.000s", failPkg: "snow", okSub: "odata", unit: "unittest", testLineDuration: "0.31s", memoHit: true });
		const b = snowReplica({ time: "2026-08-18T11:22:33.987654+08:00", uuid: "bc3831c9-9705-43ad-ac26-04c70142f21a", jsonDuration: "0.001s", failPkg: "snow", okSub: "odata", unit: "unittest", testLineDuration: "0.29s", memoHit: true });
		const sa = stripVolatileNoise(a);
		const sb = stripVolatileNoise(b);
		expect(sa).toBe(sb);
		// discriminating constants survive (never stripped — no over-normalization)
		for (const constant of ["internal/services/snow", "TestEnrichment_AreaCandidates_ClusterMatch_MatchType", "[baseline-verify] regression", "45b865ef"]) {
			expect(sa).toContain(constant);
		}
	});

	it("memo-hit stabilization: fresh vs ' [cached]'-suffixed evidence equalize through the consumer ordering strip → collapse → trim (baseline.ts:300 suffix)", () => {
		const fresh = snowReplica({ time: "2026-08-18T10:11:42Z", uuid: "76debd8a-9e7c-45f2-9d3a-da1f8dae56f8", jsonDuration: "0.000s", failPkg: "snow", okSub: "odata", unit: "unittest", testLineDuration: "0.31s", memoHit: false });
		const memoHit = snowReplica({ time: "2026-08-18T10:11:42Z", uuid: "76debd8a-9e7c-45f2-9d3a-da1f8dae56f8", jsonDuration: "0.000s", failPkg: "snow", okSub: "odata", unit: "unittest", testLineDuration: "0.31s", memoHit: true });
		const consume = (t: string) => stripVolatileNoise(t).replace(/\s+/g, " ").trim();
		expect(consume(fresh)).toBe(consume(memoHit));
	});

	it("equal outputs for noise-only differences — both directions of AC-08 (SCENARIO-018)", () => {
		const a = "2026-08-18T09:00:00Z go test FAIL internal/services/snow 14.439s (cached)";
		const b = "2026-08-19T11:30:15+02:00 go test FAIL internal/services/snow 3.695s [cached]";
		expect(stripVolatileNoise(a)).toBe(stripVolatileNoise(b));
	});

	it("different failing package ⇒ different outputs — no over-normalization (SCENARIO-019)", () => {
		const snow = "2026-08-18T09:00:00Z go test FAIL internal/services/snow 14.439s (cached)";
		const auth = "2026-08-18T09:00:00Z go test FAIL internal/services/auth 14.439s (cached)";
		expect(stripVolatileNoise(snow)).not.toBe(stripVolatileNoise(auth));
	});

	it("different error class ⇒ different outputs — no over-normalization (SCENARIO-019)", () => {
		const fail = "2026-08-18T09:00:00Z go test FAIL internal/services/snow 14.439s (cached)";
		const buildError = "2026-08-18T09:00:00Z build error: cannot find package internal/services/snow 14.439s (cached)";
		expect(stripVolatileNoise(fail)).not.toBe(stripVolatileNoise(buildError));
	});

	it("semver-ish and path tokens survive verbatim", () => {
		expect(stripVolatileNoise("v1.2.3 0.2.3src pkg/sub target/debug")).toBe("v1.2.3 0.2.3src pkg/sub target/debug");
	});
});

describe("isExcludedFromQuarantine — canonical OQ-2 predicate (SCENARIO-008/009, AC-03)", () => {
	it("excludes the spec-dir prefix derived worktree-relatively from an absolute specDirectory", () => {
		const o = { worktreePath: "/tmp/wt", specDirectory: "/tmp/wt/docs/specifications/30-track/" };
		expect(isExcludedFromQuarantine("docs/specifications/30-track/06-specification.md", o)).toBe(true);
		expect(isExcludedFromQuarantine("docs/specifications/30-track/sub/deep.md", o)).toBe(true);
		// a DIFFERENT spec dir is not excluded by the prefix rule
		expect(isExcludedFromQuarantine("docs/specifications/31-other/file.md", o)).toBe(false);
	});

	it("excludes .super-dev/ state prefix", () => {
		const o = { worktreePath: "/tmp/wt" };
		expect(isExcludedFromQuarantine(".super-dev", o)).toBe(true);
		expect(isExcludedFromQuarantine(".super-dev/runs/2026/run.log", o)).toBe(true);
		expect(isExcludedFromQuarantine("src/super-dev.ts", o)).toBe(false);
	});

	it("excludes copiedEnvFiles members (slash-normalized exact match)", () => {
		const o = { worktreePath: "/tmp/wt", copiedEnvFiles: [".env", "./apps/web/.env.local"] };
		expect(isExcludedFromQuarantine(".env", o)).toBe(true);
		expect(isExcludedFromQuarantine("apps/web/.env.local", o)).toBe(true);
		expect(isExcludedFromQuarantine("apps/web/.env.example", o)).toBe(false);
	});

	it("excludes extraExcluded members (in-loop claimed ∪ declaredScope ∪ testFiles)", () => {
		const o = { worktreePath: "/tmp/wt", extraExcluded: ["src/claimed.ts", "src/scope.ts", "tests/red.test.ts"] };
		expect(isExcludedFromQuarantine("src/claimed.ts", o)).toBe(true);
		expect(isExcludedFromQuarantine("src/unclaimed.ts", o)).toBe(false);
	});

	it("excludes harness bookkeeping inside the spec dir — same-named file elsewhere NOT exempt", () => {
		const o = { worktreePath: "/tmp/wt", specDirectory: "/tmp/wt/docs/specifications/30-track/" };
		for (const name of HARNESS_BOOKKEEPING_FILES) {
			expect(isExcludedFromQuarantine(`docs/specifications/30-track/${name}`, o)).toBe(true);
		}
		expect(isExcludedFromQuarantine("src/events.jsonl", o)).toBe(false);
	});

	it("foreign path ⇒ false", () => {
		expect(isExcludedFromQuarantine("internal/services/snow/enrichment.go", { worktreePath: "/tmp/wt" })).toBe(false);
		expect(isExcludedFromQuarantine("notes.md", { worktreePath: "/tmp/wt" })).toBe(false);
	});
});

describe("collectDirtPaths — canonical dirt inventory (SCENARIO-008/009, AC-03)", () => {
	it("foreign tracked mod + untracked root file survive every exclusion class ⇒ inventory EXACTLY [internal/services/snow/enrichment.go, notes.md] (SCENARIO-008)", () => {
		const repo = mkGitRepo("sd-t14-inv-");
		try {
			const specDirAbs = join(repo, "docs", "specifications", "30-test-track");
			// tracked base commit
			write(join(repo, "internal/services/snow/enrichment.go"), "package snow\n\nvar Enrich = 1\n");
			write(join(specDirAbs, "06-specification.md"), "# spec\n");
			write(join(repo, "src/claimed.ts"), "claimed base\n");
			write(join(repo, "src/in-scope.ts"), "scope base\n");
			write(join(repo, "tests/red.test.ts"), "test base\n");
			gitRun(repo, ["add", "-A"]);
			gitRun(repo, ["commit", "-q", "-m", "base"]);
			// foreign dirt (inventory members)
			write(join(repo, "internal/services/snow/enrichment.go"), "package snow\n\nvar Enrich = 2\n");
			write(join(repo, "notes.md"), "scratch\n");
			// excluded dirt: spec-dir prefix + bookkeeping + copied env + .super-dev/ + extraExcluded
			write(join(specDirAbs, "06-specification.md"), "# spec modified\n");
			for (const name of HARNESS_BOOKKEEPING_FILES) write(join(specDirAbs, name), "x\n");
			write(join(repo, ".env"), "SECRET=1\n");
			write(join(repo, ".super-dev/runs/2026/x.log"), "log\n");
			write(join(repo, "src/claimed.ts"), "claimed modified\n");
			write(join(repo, "src/in-scope.ts"), "scope modified\n");
			write(join(repo, "tests/red.test.ts"), "test modified\n");

			const inventory = collectDirtPaths({
				worktreePath: repo,
				specDirectory: `${specDirAbs}/`,
				copiedEnvFiles: [".env"],
				extraExcluded: ["src/claimed.ts", "src/in-scope.ts", "tests/red.test.ts"],
			});
			expect(inventory).toEqual(["internal/services/snow/enrichment.go", "notes.md"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("an undeclared current-attempt edit (RC12c class) IS in the inventory (SCENARIO-009)", () => {
		const repo = mkGitRepo("sd-t14-rc12c-");
		try {
			write(join(repo, "internal/services/auth/handler.go"), "package auth\n\nvar H = 1\n");
			write(join(repo, "src/in-scope.ts"), "scope base\n");
			gitRun(repo, ["add", "-A"]);
			gitRun(repo, ["commit", "-q", "-m", "base"]);
			write(join(repo, "internal/services/auth/handler.go"), "package auth\n\nvar H = 2\n");
			write(join(repo, "src/in-scope.ts"), "scope modified\n");
			const inventory = collectDirtPaths({
				worktreePath: repo,
				specDirectory: join(repo, "docs", "specifications", "30-x"),
				extraExcluded: ["src/in-scope.ts"], // claimed ∪ declared scope — handler.go NOT a member
			});
			expect(inventory).toEqual(["internal/services/auth/handler.go"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("rename entries resolve to the NEW path (porcelain scaffolding mirror)", () => {
		const repo = mkGitRepo("sd-t14-rename-");
		try {
			write(join(repo, "old_name.go"), "package x\n");
			write(join(repo, "internal/keep.go"), "package internal\n");
			gitRun(repo, ["add", "-A"]);
			gitRun(repo, ["commit", "-q", "-m", "base"]);
			gitRun(repo, ["mv", "old_name.go", "internal/new_name.go"]);
			const inventory = collectDirtPaths({ worktreePath: repo });
			expect(inventory).toEqual(["internal/new_name.go"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("git failure (non-repo dir) ⇒ [] and never throws", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-t14-nonrepo-"));
		try {
			expect(() => collectDirtPaths({ worktreePath: dir })).not.toThrow();
			expect(collectDirtPaths({ worktreePath: dir })).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("quarantineDirt — stash-based quarantine primitive + kill-switch (AC-13; primitive half of SCENARIO-028)", () => {
	/** A dirty repo carrying exactly the SCENARIO-020 dirt shape. */
	function mkDirtyRepo(): string {
		const repo = mkGitRepo("sd-t15-quar-");
		write(join(repo, "internal/services/snow/enrichment.go"), "package snow\n\nvar Enrich = 1\n");
		write(join(repo, "keep.txt"), "base\n");
		gitRun(repo, ["add", "-A"]);
		gitRun(repo, ["commit", "-q", "-m", "base"]);
		write(join(repo, "internal/services/snow/enrichment.go"), "package snow\n\nvar Enrich = 2\n"); // foreign tracked mod
		write(join(repo, "notes.md"), "scratch\n"); // untracked root file
		return repo;
	}

	const gitArgvCalls = () => cpRecorder.calls.filter((c) => c.cmd === "git");
	const mutatingSubcommands = ["checkout", "reset", "clean", "drop", "clear"];

	beforeEach(() => {
		cpRecorder.calls.length = 0;
	});

	it("happy path: exactly one stash entry containing tracked mod AND untracked file, recoverable via git stash show -u; stashRef matches git rev-parse refs/stash", () => {
		const repo = mkDirtyRepo();
		try {
			const q = quarantineDirt({
				worktreePath: repo,
				paths: ["internal/services/snow/enrichment.go", "notes.md"],
				reason: "stage9 environmental-blocker phase P1 (test)",
			});
			expect(q.ok).toBe(true);
			expect(q.skipped).toBeUndefined();
			expect(q.stashRef).toBeTruthy();
			expect(gitRun(repo, ["rev-parse", "refs/stash"]).trim()).toBe(q.stashRef);
			expect(gitRun(repo, ["stash", "list"]).trim().split("\n")).toHaveLength(1);
			// tracked mod AND untracked file both recoverable from the stash
			const stashed = gitRun(repo, ["stash", "show", "-u", "--name-only"]).trim().split("\n").sort();
			expect(stashed).toEqual(["internal/services/snow/enrichment.go", "notes.md"]);
			// worktree left clean of the quarantined paths
			expect(gitRun(repo, ["status", "--porcelain"]).trim()).toBe("");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("argv safety: the only mutating git argv ever issued is `stash push` — no checkout/reset/clean/drop/clear anywhere (SCENARIO-028 primitive half)", () => {
		const repo = mkDirtyRepo();
		try {
			quarantineDirt({ worktreePath: repo, paths: ["internal/services/snow/enrichment.go", "notes.md"], reason: "argv audit" });
			const calls = gitArgvCalls();
			expect(calls.length).toBeGreaterThan(0);
			const pushes = calls.filter((c) => c.args[0] === "stash" && c.args[1] === "push");
			expect(pushes).toHaveLength(1);
			expect(pushes[0]!.args).toContain("-u");
			expect(pushes[0]!.args).toContain("--");
			// dual-review F-1 remediation: every pathspec is `:(literal)`-prefixed so
			// glob metacharacters in paths can never widen the match.
			expect(pushes[0]!.args.slice(-2)).toEqual([":(literal)internal/services/snow/enrichment.go", ":(literal)notes.md"]);
			expect(pushes[0]!.cwd).toBe(repo);
			for (const c of calls) {
				for (const bad of mutatingSubcommands) {
					expect(c.args).not.toContain(bad);
				}
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("dual-review F-1: exit-0 pathspec-miss (no local changes to save) on a repo WITH a commit and a PRE-EXISTING stash ⇒ {ok:false} with the no-changes error, NO new stash entry, ledger/ref untouched (phantom-success guard)", () => {
		const repo = mkdtempSync(join(tmpdir(), "sd-phantom-"));
		try {
			gitRun(repo, ["init", "-q"]);
			gitRun(repo, ["config", "user.email", "t@t"]);
			gitRun(repo, ["config", "user.name", "t"]);
			writeFileSync(join(repo, "committed.txt"), "base\n");
			gitRun(repo, ["add", "committed.txt"]);
			gitRun(repo, ["commit", "-qm", "base"]);
			// Pre-existing stash: dirty a DIFFERENT file and stash it.
			writeFileSync(join(repo, "other.txt"), "other\n");
			gitRun(repo, ["add", "other.txt"]);
			gitRun(repo, ["stash", "push", "-qm", "preexisting"]);
			const refBefore = gitRun(repo, ["rev-parse", "refs/stash"]).trim();
			// Now quarantine a pathspec that matches NOTHING (file never dirtied):
			const q = quarantineDirt({ worktreePath: repo, paths: ["never/touched.go"], reason: "phantom probe" });
			expect(q.ok).toBe(false);
			expect(q.stashRef).toBeNull();
			expect(String(q.error ?? "")).toMatch(/changed nothing|no local changes/i);
			expect(gitRun(repo, ["rev-parse", "refs/stash"]).trim()).toBe(refBefore); // ref UNCHANGED
			expect(gitRun(repo, ["stash", "list"]).split("\n").filter(Boolean)).toHaveLength(1); // no new entry
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("kill-switch set ⇒ {ok:false, skipped:'kill-switch', stashRef:null}, worktree untouched, NO git call issued (D-10)", () => {
		const repo = mkDirtyRepo();
		const prev = process.env[DIRTY_QUARANTINE_KILL_SWITCH];
		process.env[DIRTY_QUARANTINE_KILL_SWITCH] = "1";
		try {
			const q = quarantineDirt({ worktreePath: repo, paths: ["internal/services/snow/enrichment.go", "notes.md"], reason: "ks" });
			expect(q).toEqual({ ok: false, skipped: "kill-switch", stashRef: null, paths: ["internal/services/snow/enrichment.go", "notes.md"] });
			expect(gitRun(repo, ["stash", "list"]).trim()).toBe("");
			expect(gitRun(repo, ["status", "--porcelain"]).trim()).not.toBe("");
			expect(gitArgvCalls()).toHaveLength(0);
		} finally {
			if (prev === undefined) delete process.env[DIRTY_QUARANTINE_KILL_SWITCH];
			else process.env[DIRTY_QUARANTINE_KILL_SWITCH] = prev;
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("empty or blank-only paths ⇒ {ok:false, skipped:'empty'} and no git call (the everything-stash footgun is unreachable, D-9)", () => {
		const repo = mkGitRepo("sd-t15-empty-");
		try {
			for (const paths of [[], ["", "   "]]) {
				cpRecorder.calls.length = 0;
			const q = quarantineDirt({ worktreePath: repo, paths, reason: "r" });
				expect(q.ok).toBe(false);
				expect(q.skipped).toBe("empty");
				expect(q.stashRef).toBeNull();
				expect(gitArgvCalls()).toHaveLength(0);
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("forced git failure (pathspec matching nothing) ⇒ {ok:false, error}, never throws, no stash entry (SCENARIO-029 primitive contract)", () => {
		const repo = mkGitRepo("sd-t15-fail-");
		try {
			const q = quarantineDirt({ worktreePath: repo, paths: ["no/such/path/anywhere"], reason: "r" });
			expect(q.ok).toBe(false);
			expect(q.stashRef).toBeNull();
			expect(typeof q.error).toBe("string");
			expect(q.error!.length).toBeGreaterThan(0);
			expect(gitRun(repo, ["stash", "list"]).trim()).toBe("");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("dirtyQuarantineEnabled: default true; '1' disables; other values keep it enabled (AC-11)", () => {
		const prev = process.env[DIRTY_QUARANTINE_KILL_SWITCH];
		try {
			delete process.env[DIRTY_QUARANTINE_KILL_SWITCH];
			expect(dirtyQuarantineEnabled()).toBe(true);
			process.env[DIRTY_QUARANTINE_KILL_SWITCH] = "1";
			expect(dirtyQuarantineEnabled()).toBe(false);
			process.env[DIRTY_QUARANTINE_KILL_SWITCH] = "0";
			expect(dirtyQuarantineEnabled()).toBe(true);
		} finally {
			if (prev === undefined) delete process.env[DIRTY_QUARANTINE_KILL_SWITCH];
			else process.env[DIRTY_QUARANTINE_KILL_SWITCH] = prev;
		}
	});
});

describe("environment-fault ledger primitives (SCENARIO-025, AC-12)", () => {
	it("environmentFaultLedgerPath joins the in-spec-dir JSONL name (the .resume-cache.jsonl precedent)", () => {
		expect(environmentFaultLedgerPath(join("a", "b"))).toBe(join("a", "b", ".environment-faults.jsonl"));
	});

	it("two appends ⇒ exactly 2 lines, each with key set EXACTLY [kind, paths, stashRef, reason], values preserved; readEnvironmentFaultCount ⇒ 2", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-t16-ledger-"));
		try {
			appendEnvironmentFault(dir, { kind: "quarantine", paths: ["internal/services/snow/enrichment.go", "notes.md"], stashRef: "abc123", reason: "environmental-blocker phase P1" });
			appendEnvironmentFault(dir, { kind: "judge-environmental", paths: null, stashRef: null, reason: "fix-environment: env is dirty" });
			const ledger = readFileSync(environmentFaultLedgerPath(dir), "utf8");
			const lines = ledger.split("\n");
			expect(lines).toHaveLength(3); // 2 records + trailing newline
			expect(lines[2]).toBe("");
			const first = JSON.parse(lines[0]!) as Record<string, unknown>;
			const second = JSON.parse(lines[1]!) as Record<string, unknown>;
			expect(Object.keys(first)).toEqual(["kind", "paths", "stashRef", "reason"]);
			expect(Object.keys(second)).toEqual(["kind", "paths", "stashRef", "reason"]);
			expect(first).toEqual({ kind: "quarantine", paths: ["internal/services/snow/enrichment.go", "notes.md"], stashRef: "abc123", reason: "environmental-blocker phase P1" });
			expect(second).toEqual({ kind: "judge-environmental", paths: null, stashRef: null, reason: "fix-environment: env is dirty" });
			expect(readEnvironmentFaultCount(dir)).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("absent file ⇒ readEnvironmentFaultCount null; undefined specDir ⇒ append never throws, count null", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-t16-absent-"));
		try {
			expect(readEnvironmentFaultCount(dir)).toBeNull();
			expect(readEnvironmentFaultCount(undefined)).toBeNull();
			expect(() => appendEnvironmentFault(undefined, { kind: "quarantine", paths: [], stashRef: null, reason: "r" })).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("unwritable target (read-only dir, chmod 0o555 — skipped as root) ⇒ no throw + warning through the log spy (SCENARIO-030 primitive half)", () => {
		if (process.getuid?.() === 0) return; // root ignores 0o555
		const dir = mkdtempSync(join(tmpdir(), "sd-t16-ro-"));
		const warnings: string[] = [];
		try {
			chmodSync(dir, 0o555);
			expect(() => appendEnvironmentFault(dir, { kind: "quarantine", paths: ["x"], stashRef: "s", reason: "r" }, (m) => warnings.push(m))).not.toThrow();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("environment-fault ledger append failed (continuing; never fatal): ");
			expect(readEnvironmentFaultCount(dir)).toBeNull();
		} finally {
			chmodSync(dir, 0o755);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// T6.3 file-mode twin (SCENARIO-030 end-to-end substrate): the setup e2e
	// cannot chmod its specDir read-only — that dir hosts the fail-closed AC-30
	// run lock — so it induces the SAME EACCES failure class at the ledger FILE
	// (0o444). This pin guards that the two modes degrade identically: one
	// warning through the sink, no throw, and the pre-existing ledger line is
	// left intact (no partial write).
	it("unwritable target via a read-only ledger FILE (chmod 0o444 — skipped as root) degrades identically to the read-only-dir mode (SCENARIO-030 file-mode half)", () => {
		if (process.getuid?.() === 0) return; // root ignores 0o444
		const dir = mkdtempSync(join(tmpdir(), "sd-t63-rofile-"));
		const warnings: string[] = [];
		try {
			const ledger = environmentFaultLedgerPath(dir);
			writeFileSync(ledger, `${JSON.stringify({ kind: "quarantine", paths: ["a"], stashRef: "s", reason: "seed" })}\n`);
			chmodSync(ledger, 0o444);
			expect(() => appendEnvironmentFault(dir, { kind: "judge-environmental", paths: null, stashRef: null, reason: "r" }, (m) => warnings.push(m))).not.toThrow();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("environment-fault ledger append failed (continuing; never fatal): ");
			// The seeded line is intact — the failed append added nothing.
			expect(readEnvironmentFaultCount(dir)).toBe(1);
		} finally {
			chmodSync(environmentFaultLedgerPath(dir), 0o644);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("isBaselineVerifySyntheticError (AC-01)", () => {
	it("true for a gate-built synthetic block (startsWith the exported prefix)", () => {
		expect(isBaselineVerifySyntheticError(syntheticBlock(BASELINE_EVIDENCE))).toBe(true);
	});

	it("false for an error that merely quotes the prefix words mid-string", () => {
		expect(isBaselineVerifySyntheticError(`note: saw [baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline mid-string`)).toBe(false);
	});

	it("false for ordinary gate errors", () => {
		expect(isBaselineVerifySyntheticError(OOS_BLOCK)).toBe(false);
		expect(isBaselineVerifySyntheticError("")).toBe(false);
	});
});
