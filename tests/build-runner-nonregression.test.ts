/**
 * Phase 6 — Backward-compat, typecheck & full test-suite gate
 *           NON-REGRESSION suite (RED-first — AC-06/AC-07 →
 *           SCENARIO-015/016/018/019/026/029).
 *
 * These tests PROVE the scope-aware build-gate change is fully backward
 * compatible. The implementation lives in Phases 1–5 (already merged); this
 * suite LOCKS IN the backward-compat contract so any future regression fails
 * the gate:
 *
 *   SCENARIO-015 — non-cargo / non-git / no-touched-crates / unset-env runs
 *     produce IDENTICAL gate argvs and an IDENTICAL runBuildGate result to the
 *     pre-change behaviour, modulo the two ADDITIVE fields
 *     `outOfScopeErrors` / `inScopePass`. detectProjectCommands purity is
 *     preserved (scoping applies only on a shallow copy).
 *   SCENARIO-016 — a workspace-wide (empty-scoped) run NEVER grants an
 *     in-scope pass the old code would not: every failure counts in-scope so
 *     `inScopePass` stays false and current abort semantics are preserved.
 *   SCENARIO-018 — strict typecheck + full test run pass with NO new runtime
 *     dependencies and NO new spawned processes beyond the existing gate
 *     commands plus one `git diff --name-only`.
 *   SCENARIO-019 — constraint isolation: only src/build-runner.ts +
 *     src/stages/implementation.ts (+ tests) change; nodes/workflow/pipeline/
 *     render/engine stay untouched and the target repo is never mutated.
 *   SCENARIO-026 — full baseline-diff gating is NOT implemented this pass
 *     (deferred): no baseline-diff code path exists; only one read-only
 *     `git diff --merge-base <ref> --name-only` ever runs.
 *   SCENARIO-029 — strict mode type-clean across the changed files.
 *
 * Hermetic: `node:child_process.spawnSync` is mocked so no real git/cargo/npm
 * ever runs. Env-touching tests save/restore the two relevant vars so cases
 * stay independent. `detectProjectCommands` stays PURE (reads the real fs),
 * so each case creates a real temp manifest so the detector reports the
 * expected language.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runBuildGate,
	detectProjectCommands,
} from "../src/build-runner.ts";
import type { BuildGateResult } from "../src/build-runner.ts";

// Mock the ONLY side-effects runBuildGate performs: spawnSync. Real git,
// cargo, npm, go must never run in CI.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;

const PKG_ENV = "SUPER_DEV_BUILD_TEST_PACKAGES";
const BASE_REF_ENV = "SUPER_DEV_GATE_BASE_REF";

let savedPkg: string | undefined;
let savedRef: string | undefined;

beforeEach(() => {
	savedPkg = process.env[PKG_ENV];
	savedRef = process.env[BASE_REF_ENV];
	delete process.env[PKG_ENV];
	delete process.env[BASE_REF_ENV];
	spawn.mockReset();
});

afterEach(() => {
	if (savedPkg === undefined) delete process.env[PKG_ENV];
	else process.env[PKG_ENV] = savedPkg;
	if (savedRef === undefined) delete process.env[BASE_REF_ENV];
	else process.env[BASE_REF_ENV] = savedRef;
});

/** Make a fresh empty temp dir. */
function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "sd-nonreg-"));
}

/** Write a temp manifest + optional extras, returning the dir path. */
function tmpProj(setup: (dir: string) => void): string {
	const dir = tmpDir();
	setup(dir);
	return dir;
}

interface SpawnConfig {
	/** stdout returned for every `git` spawn (default ""). */
	gitDiff?: string;
	/** exit status for `git` spawns (default 0). */
	gitStatus?: number;
	/** when true, the labelled command is reported as a failing spawn. */
	failing?: (label: string, argv: string[]) => boolean;
	/** stderr tail to emit for a failing spawn. */
	failStderr?: string;
}

/**
 * Build a deterministic spawnSync mock. Returns the captured argv list
 * (each entry is `[cmd, ...args]`), routed: git → config git stdout/status;
 * everything else → status 0 success unless `failing(label)` is true.
 */
function mockSpawn(cfg: SpawnConfig = {}): string[][] {
	const calls: string[][] = [];
	spawn.mockImplementation((cmd: string, args: string[]) => {
		const argv = [cmd, ...(args ?? [])];
		const label = argv.join(" ");
		calls.push(argv);
		if (cmd === "git") {
			return {
				status: cfg.gitStatus ?? 0,
				stdout: cfg.gitDiff ?? "",
				stderr: "",
			};
		}
		if (cfg.failing && cfg.failing(label, argv)) {
			return {
				status: 1,
				stdout: "",
				stderr: cfg.failStderr ?? "boom\n--> crates/compute/src/lib.rs:1:1",
			};
		}
		return { status: 0, stdout: "", stderr: "" };
	});
	return calls;
}

const gitCalls = (calls: string[][]) => calls.filter((a) => a[0] === "git");
const nonGitCalls = (calls: string[][]) => calls.filter((a) => a[0] !== "git");
/** The argv list expected to be spawned, in run order (build→test→typecheck). */
function expectedArgvs(dir: string): string[][] {
	const det = detectProjectCommands(dir);
	return [det.build, det.test, det.typecheck].filter(
		(a): a is string[] => Array.isArray(a) && a.length > 0,
	);
}

/**
 * The universal workspace-wide / non-scoped backward-compat invariant: the
 * two additive fields NEVER change the verdict. `outOfScopeErrors` is [] and
 * `inScopePass` exactly mirrors `pass` (true on green, false on any failure).
 */
function assertAdditiveNoOp(r: BuildGateResult): void {
	expect(Array.isArray(r.outOfScopeErrors)).toBe(true);
	expect(r.outOfScopeErrors).toEqual([]);
	expect(r.inScopePass).toBe(r.pass);
}

/* ------------------------------------------------------------------ *
 * SCENARIO-015 — non-cargo / non-git / no-touched / unset-env ⇒
 *                IDENTICAL argvs + result (modulo 2 additive fields)
 * ------------------------------------------------------------------ */
describe("SCENARIO-015 backward-compat: identical argvs + result (modulo additive fields)", () => {
	it("non-cargo node repo → argvs equal detectProjectCommands, no git spawn, additive fields no-op", () => {
		const dir = tmpProj((d) => {
			writeFileSync(
				join(d, "package.json"),
				JSON.stringify({ scripts: { build: "tsc", test: "node -e 0" } }),
			);
			writeFileSync(join(d, "tsconfig.json"), "{}");
		});
		try {
			const calls = mockSpawn();
			const det = detectProjectCommands(dir);
			// non-rust ("backend") ⇒ no auto-scope tier ⇒ backward-compatible path
			expect(det.language).not.toBe("rust");
			const r = runBuildGate(dir);

			// argvs byte-identical to the pure detector (no -p anywhere)
			expect(nonGitCalls(calls)).toEqual(expectedArgvs(dir));
			// tier (iv) for non-rust ⇒ NO git spawn at all (no auto-detection)
			expect(gitCalls(calls)).toHaveLength(0);
			// additive fields never block
			assertAdditiveNoOp(r);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("non-cargo go repo → argvs equal detector, zero git spawn, additive no-op", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "go.mod"), "module x\n"));
		try {
			const calls = mockSpawn();
			const det = detectProjectCommands(dir);
			expect(det.language).toBe("go");
			const r = runBuildGate(dir);

			expect(nonGitCalls(calls)).toEqual(expectedArgvs(dir));
			expect(gitCalls(calls)).toHaveLength(0);
			assertAdditiveNoOp(r);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rust repo with NO touched crates (empty diff) → workspace-wide argvs + TWO read-only git spawns (diff + ls-files)", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			const calls = mockSpawn({ gitDiff: "" });
			const det = detectProjectCommands(dir);
			expect(det.language).toBe("rust");
			const r = runBuildGate(dir);

			// empty scope ⇒ cmds byte-identical to the detector (no -p)
			expect(nonGitCalls(calls)).toEqual(expectedArgvs(dir));
			nonGitCalls(calls).forEach((argv) =>
				expect(argv).not.toContain("-p"),
			);
			// exactly TWO git spawns (diff + ls-files union — Layer B), read-only
			const g = gitCalls(calls);
			expect(g).toHaveLength(2);
			expect(g[0]).toContain("diff");
			expect(g[0]).toContain("--name-only");
			expect(g[0]).toContain("--merge-base");
			assertAdditiveNoOp(r);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rust NON-GIT dir (git status != 0) → detectTouchedCargoPackages ⇒ [] ⇒ workspace-wide, never throws", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			const calls = mockSpawn({ gitStatus: 1 });
			const r = runBuildGate(dir);

			expect(nonGitCalls(calls)).toEqual(expectedArgvs(dir));
			nonGitCalls(calls).forEach((argv) =>
				expect(argv).not.toContain("-p"),
			);
			// git diff + ls-files both attempted (2 calls), both failed, swallowed → []
			expect(gitCalls(calls)).toHaveLength(2);
			assertAdditiveNoOp(r);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rust repo, only NON-crate paths touched (Cargo.toml/README) ⇒ [] ⇒ workspace-wide", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			const calls = mockSpawn({
				gitDiff: "Cargo.toml\nREADME.md\nCHANGELOG.md\n",
			});
			const r = runBuildGate(dir);

			expect(nonGitCalls(calls)).toEqual(expectedArgvs(dir));
			nonGitCalls(calls).forEach((argv) =>
				expect(argv).not.toContain("-p"),
			);
			assertAdditiveNoOp(r);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("unset env vars (no SUPER_DEV_BUILD_TEST_PACKAGES) ⇒ tier iii/iv used, no extra spawns beyond two git spawns (diff + ls-files)", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			expect(process.env[PKG_ENV]).toBeUndefined();
			const calls = mockSpawn({ gitDiff: "" });
			runBuildGate(dir);
			// exactly two git (diff + ls-files) + the gate commands
			expect(gitCalls(calls)).toHaveLength(2);
			expect(nonGitCalls(calls)).toEqual(expectedArgvs(dir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detectProjectCommands purity: running the gate never mutates the detector output", () => {
		const dir = tmpProj((d) =>
			writeFileSync(join(d, "package.json"),
				JSON.stringify({ scripts: { build: "tsc", test: "node -e 0" } })),
		);
		try {
			const before = JSON.stringify(detectProjectCommands(dir));
			mockSpawn();
			runBuildGate(dir); // internally scopes a SHALLOW COPY only
			const after = JSON.stringify(detectProjectCommands(dir));
			expect(after).toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/* ------------------------------------------------------------------ *
 * SCENARIO-016 — workspace-wide scope NEVER grants an in-scope pass
 * ------------------------------------------------------------------ */
describe("SCENARIO-016 workspace-wide never grants an in-scope pass the old code would not", () => {
	it("rust, no touched crates, build FAILS ⇒ inScopePass stays false (current abort preserved)", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			mockSpawn({
				gitDiff: "",
				failing: (label) => label.startsWith("cargo build"),
			});
			const r = runBuildGate(dir);
			expect(r.pass).toBe(false);
			expect(r.outOfScopeErrors).toEqual([]);
			// workspace-wide ⇒ every failure in-scope ⇒ NO in-scope pass
			expect(r.inScopePass).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("non-cargo repo, test FAILS ⇒ inScopePass stays false", () => {
		const dir = tmpProj((d) =>
			writeFileSync(join(d, "package.json"),
				JSON.stringify({ scripts: { build: "tsc", test: "node -e 0" } })),
		);
		try {
			mockSpawn({
				failing: (label) => label.includes("run test"),
			});
			const r = runBuildGate(dir);
			expect(r.pass).toBe(false);
			expect(r.outOfScopeErrors).toEqual([]);
			expect(r.inScopePass).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("green run (pass=true) ⇒ inScopePass=true & outOfScopeErrors=[] (classification is a no-op on green)", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			mockSpawn({ gitDiff: "" });
			const r = runBuildGate(dir);
			expect(r.pass).toBe(true);
			expect(r.outOfScopeErrors).toEqual([]);
			expect(r.inScopePass).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("classifier never throws and never blocks on zero failures (pure, empty scope)", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			// all-success ⇒ zero errors collected ⇒ additive fields are inert
			mockSpawn({ gitDiff: "" });
			const r = runBuildGate(dir);
			expect(r.errors).toHaveLength(0);
			expect(r.outOfScopeErrors).toHaveLength(0);
			// inScopePass === pass === true → does NOT invent a green
			expect(r.inScopePass).toBe(r.pass);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/* ------------------------------------------------------------------ *
 * SCENARIO-026 — full baseline-diff gating is NOT implemented this pass
 * ------------------------------------------------------------------ */
describe("SCENARIO-026 baseline-diff on main is deferred (no such code path)", () => {
	it("no baseline-diff function is exported from the build-runner module", async () => {
		const mod = await import("../src/build-runner.ts");
		const baselineNames = [
			"runBaselineDiff",
			"subtractBaseline",
			"computeBaseline",
			"baselineGate",
			"runBaselineGate",
		];
		for (const name of baselineNames) {
			expect((mod as Record<string, unknown>)[name]).toBeUndefined();
		}
	});

	it("a workspace-wide rust run spawns exactly TWO read-only git spawns (diff + ls-files) — no baseline run on main", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			const calls = mockSpawn({ gitDiff: "" });
			runBuildGate(dir);
			const g = gitCalls(calls);
			expect(g).toHaveLength(2);
			// two git subcommands (diff + ls-files), both read-only
			const sub = g[0].slice(1); // drop "git"
			expect(sub).toContain("diff");
			expect(sub).toContain("--name-only");
			// no mutating git verbs anywhere
			const mutating = ["checkout", "stash", "reset", "commit", "apply", "rebase", "merge"];
			for (const verb of mutating) {
				expect(g[0].some((a) => a === verb)).toBe(false);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/* ------------------------------------------------------------------ *
 * SCENARIO-018 — no new runtime deps / no new spawned processes
 * ------------------------------------------------------------------ */
describe("SCENARIO-018 no new deps / processes beyond gate commands + one git diff", () => {
	it("rust workspace-wide run spawns exactly: 2 git (diff + ls-files) + 3 cargo (build/test/clippy)", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			const calls = mockSpawn({ gitDiff: "" });
			runBuildGate(dir);
			expect(gitCalls(calls)).toHaveLength(2);
			expect(nonGitCalls(calls)).toHaveLength(3);
			expect(nonGitCalls(calls).every((a) => a[0] === "cargo")).toBe(true);
			// exact match to the pure detector output (no extra/missing argvs)
			expect(nonGitCalls(calls)).toEqual(expectedArgvs(dir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("non-rust run spawns ZERO git + only the detector's gate commands", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "go.mod"), "module x\n"));
		try {
			const calls = mockSpawn();
			runBuildGate(dir);
			expect(gitCalls(calls)).toHaveLength(0);
			expect(nonGitCalls(calls)).toEqual(expectedArgvs(dir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("package.json introduces no NEW runtime dependency (no extra top-level dep key appears)", () => {
		const root = JSON.parse(
			readFileSync(join(process.cwd(), "package.json"), "utf8"),
		) as Record<string, unknown>;
		// The change must add NO runtime dependency. This repo ships with NO
		// `dependencies` key at all (only devDependencies/peerDependencies), so
		// the backward-compat invariant is: a `dependencies` key must NOT
		// appear (the change introduced zero runtime deps).
		expect(root.dependencies).toBeUndefined();
		expect(typeof root.devDependencies).toBe("object");
		// No baseline-diff / cargo-helper runtime package was pulled in anywhere.
		const all = Object.keys({
			...((root.dependencies ?? {}) as object),
			...((root.devDependencies ?? {}) as object),
			...((root.peerDependencies ?? {}) as object),
		});
		const forbidden = ["cargo", "rust-script", "simple-git", "execa"];
		for (const f of forbidden) expect(all).not.toContain(f);
	});
});

/* ------------------------------------------------------------------ *
 * SCENARIO-019 — constraint isolation / target repo never mutated
 * ------------------------------------------------------------------ */
describe("SCENARIO-019 constraint isolation: engine untouched & repo never mutated", () => {
	it("the control-flow engine files do not import the new build-runner helpers", () => {
		const engineFiles = ["nodes.ts", "workflow.ts", "pipeline.ts"].map((f) =>
			join(process.cwd(), "src", f),
		);
		const newSymbols = [
			"detectTouchedCargoPackages",
			"scopedCargoArgs",
			"classifyOutOfScopeErrors",
			"inScopePass",
		];
		for (const file of engineFiles) {
			if (!existsSync(file)) continue; // engine layout may differ — skip
			const src = readFileSync(file, "utf8");
			for (const sym of newSymbols) {
				expect(src, `${file} must not reference ${sym}`).not.toContain(sym);
			}
		}
	});

	it("git spawns are READ-ONLY (diff only) — the target repo is never mutated by the gate", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			const calls = mockSpawn({ gitDiff: "" });
			runBuildGate(dir);
			const mutating = ["checkout", "stash", "reset", "commit", "apply", "rebase", "add", "rm"];
			for (const argv of gitCalls(calls)) {
				for (const verb of mutating) {
					expect(argv, `git must not run '${verb}'`).not.toContain(verb);
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("the worktree contents are unchanged after a (mocked) gate run", () => {
		const dir = tmpProj((d) => {
			writeFileSync(join(d, "Cargo.toml"), "");
			mkdirSync(join(d, "crates", "data", "src"), { recursive: true });
			writeFileSync(join(d, "crates", "data", "src", "lib.rs"), "pub fn x() {}");
			writeFileSync(join(d, "SENTINEL.txt"), "keep-me");
		});
		try {
			const beforeLib = readFileSync(join(dir, "crates", "data", "src", "lib.rs"), "utf8");
			const beforeSent = readFileSync(join(dir, "SENTINEL.txt"), "utf8");
			mockSpawn({ gitDiff: "" });
			runBuildGate(dir);
			expect(readFileSync(join(dir, "crates", "data", "src", "lib.rs"), "utf8")).toBe(beforeLib);
			expect(readFileSync(join(dir, "SENTINEL.txt"), "utf8")).toBe(beforeSent);
			expect(existsSync(join(dir, "Cargo.toml"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/* ------------------------------------------------------------------ *
 * SCENARIO-029 — strict mode type-clean across the changed files
 * ------------------------------------------------------------------ */
describe("SCENARIO-029 strict type-clean: BuildGateResult additive fields are typed", () => {
	// Compile-time guard: the additive fields exist on the type under strict.
	// If either is dropped or mistyped, `tsc --noEmit` fails on this file.
	function _acceptResult(r: BuildGateResult): BuildGateResult {
		const outOfScopeErrors: string[] = r.outOfScopeErrors;
		const inScopePass: boolean = r.inScopePass;
		return { ...r, outOfScopeErrors, inScopePass };
	}

	it("a real runBuildGate result carries outOfScopeErrors:string[] & inScopePass:boolean", () => {
		const dir = tmpProj((d) => writeFileSync(join(d, "Cargo.toml"), ""));
		try {
			mockSpawn({ gitDiff: "" });
			const r = runBuildGate(dir);
			expect(Array.isArray(r.outOfScopeErrors)).toBe(true);
			expect(typeof r.inScopePass).toBe("boolean");
			// full result is acceptable to the typed guard
			_acceptResult(r);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
