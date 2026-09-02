import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	verifyUntouchedFailuresAgainstBaseline,
	clearBaselineCache,
	type BaselineRunner,
} from "../src/build-runner/baseline.ts";
import { resolveInScopePassWithBaseline } from "../src/build-runner/gates.ts";
import * as gatesNs from "../src/build-runner/gates.ts";

/** Real throwaway git repo helper (B-6 fixtures). */
function mkGitRepo(): string {
	const dir = mkdtmp();
	run(dir, "git", ["init", "-q", "-b", "main"]);
	run(dir, "git", ["config", "user.email", "t@t"]);
	run(dir, "git", ["config", "user.name", "t"]);
	return dir;
}

function mkdtmp(): string {
	const d = join(tmpdir(), `sd-b6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(d, { recursive: true });
	return d;
}

function run(cwd: string, cmd: string, args: string[]): void {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
}

function commitAll(cwd: string, msg: string): void {
	run(cwd, "git", ["add", "-A"]);
	run(cwd, "git", ["commit", "-q", "-m", msg]);
}

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length) {
		const d = cleanups.pop()!;
		try { run(d, "git", ["worktree", "list", "--porcelain"]); } catch { /* not a repo */ }
		try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
	}
	clearBaselineCache();
});
beforeEach(() => clearBaselineCache());

describe("B-6 baseline verification (npm family, injected runner)", () => {
	it("subjects pass at baseline ⇒ regression", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { test: "vitest run" } }));
		commitAll(repo, "init");
		cleanups.push(repo);
		const runner: BaselineRunner = () => ({ status: 0, stdout: "Test Files 1 passed", stderr: "" });
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "main", language: "backend", subjects: ["tests/old.test.ts"], runner,
		});
		expect(r.status).toBe("regression");
		expect(r.evidence).toContain("PASS");
	});

	it("all subjects fail at baseline ⇒ preexisting (jest FAIL markers)", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { test: "vitest run" } }));
		commitAll(repo, "init");
		cleanups.push(repo);
		const runner: BaselineRunner = () => ({
			status: 1,
			stdout: "FAIL tests/old.test.ts\nFAIL tests/older.test.ts\nTests: 2 failed",
			stderr: "",
		});
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "main", language: "frontend", subjects: ["tests/old.test.ts", "tests/older.test.ts"], runner,
		});
		expect(r.status).toBe("preexisting");
		expect(r.evidence).toContain("all 2 subject(s)");
	});

	it("partial subject match ⇒ regression naming the passing subject", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { test: "vitest run" } }));
		commitAll(repo, "init");
		cleanups.push(repo);
		const runner: BaselineRunner = () => ({ status: 1, stdout: "❯ tests/old.test.ts:4:5", stderr: "" });
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "main", language: "backend", subjects: ["tests/old.test.ts", "tests/new.test.ts"], runner,
		});
		expect(r.status).toBe("regression");
		expect(r.evidence).toContain("tests/new.test.ts");
	});

	it("nonzero baseline with unparseable output ⇒ unknown (lenient fallback)", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { test: "vitest run" } }));
		commitAll(repo, "init");
		cleanups.push(repo);
		const runner: BaselineRunner = () => ({ status: 1, stdout: "Error: failed to load config from vitest.config.ts", stderr: "" });
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "main", language: "frontend", subjects: ["tests/old.test.ts"], runner,
		});
		expect(r.status).toBe("unknown");
	});

	it("baseline timeout ⇒ unknown", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { test: "vitest run" } }));
		commitAll(repo, "init");
		cleanups.push(repo);
		const runner: BaselineRunner = () => ({ status: null, stdout: "", stderr: "", timedOut: true });
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "main", language: "backend", subjects: ["tests/old.test.ts"], runner,
		});
		expect(r.status).toBe("unknown");
	});
});

describe("B-6 fallbacks and cache", () => {
	it("no defaultBranch ⇒ unknown without spawning the runner", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
		commitAll(repo, "init");
		cleanups.push(repo);
		let calls = 0;
		const runner: BaselineRunner = () => { calls++; return { status: 0, stdout: "", stderr: "" }; };
		const r = verifyUntouchedFailuresAgainstBaseline({ cwd: repo, language: "backend", subjects: ["a.test.ts"], runner });
		expect(r.status).toBe("unknown");
		expect(calls).toBe(0);
	});

	it("unresolvable default branch ⇒ unknown without spawning the runner", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { test: "vitest run" } }));
		commitAll(repo, "init");
		cleanups.push(repo);
		let calls = 0;
		const runner: BaselineRunner = () => { calls++; return { status: 0, stdout: "", stderr: "" }; };
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "no-such-branch", language: "backend", subjects: ["a.test.ts"], runner,
		});
		expect(r.status).toBe("unknown");
		expect(calls).toBe(0);
	});

	it("memoizes per signature — second identical call does not re-run", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { test: "vitest run" } }));
		commitAll(repo, "init");
		cleanups.push(repo);
		let calls = 0;
		const runner: BaselineRunner = () => { calls++; return { status: 0, stdout: "", stderr: "" }; };
		const input = { cwd: repo, defaultBranch: "main", language: "backend" as const, subjects: ["a.test.ts"], runner };
		const r1 = verifyUntouchedFailuresAgainstBaseline(input);
		const r2 = verifyUntouchedFailuresAgainstBaseline(input);
		expect(calls).toBe(1);
		expect(r1.status).toBe("regression");
		expect(r2.evidence).toContain("[cached]");
		expect(r2.status).toBe(r1.status);
	});

	// Track 30 T3.2 memo pin (D-1a — SCENARIO-006 · AC-03): the in-loop
	// post-quarantine gate re-run calls clearBaselineCache() immediately before
	// the single re-run so it cannot inherit a verdict memoized against the
	// pre-quarantine worktree. This pins the mechanism itself: after
	// clearBaselineCache() an identical call is a cache MISS (the injectable
	// verifier is re-invoked) where a second call without clearing hits the memo.
	it("clearBaselineCache() forces a cache miss on the next identical call (Track 30 D-1a pin)", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { test: "vitest run" } }));
		commitAll(repo, "init");
		cleanups.push(repo);
		let calls = 0;
		const runner: BaselineRunner = () => { calls++; return { status: 0, stdout: "", stderr: "" }; };
		const input = { cwd: repo, defaultBranch: "main", language: "backend" as const, subjects: ["a.test.ts"], runner };
		verifyUntouchedFailuresAgainstBaseline(input); // runner 1×, memo populated
		expect(calls).toBe(1);
		verifyUntouchedFailuresAgainstBaseline(input); // memo hit — runner still 1×
		expect(calls).toBe(1);
		clearBaselineCache();
		verifyUntouchedFailuresAgainstBaseline(input); // MISS — runner re-invoked (2×)
		expect(calls).toBe(2);
	});

	it("SUPER_DEV_DISABLE_BASELINE_CHECK=1 ⇒ unknown without spawning", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { test: "vitest run" } }));
		commitAll(repo, "init");
		cleanups.push(repo);
		const prev = process.env.SUPER_DEV_DISABLE_BASELINE_CHECK;
		process.env.SUPER_DEV_DISABLE_BASELINE_CHECK = "1";
		try {
			let calls = 0;
			const runner: BaselineRunner = () => { calls++; return { status: 0, stdout: "", stderr: "" }; };
			const r = verifyUntouchedFailuresAgainstBaseline({ cwd: repo, defaultBranch: "main", language: "backend", subjects: ["a.test.ts"], runner });
			expect(r.status).toBe("unknown");
			expect(calls).toBe(0);
		} finally {
			if (prev === undefined) delete process.env.SUPER_DEV_DISABLE_BASELINE_CHECK;
			else process.env.SUPER_DEV_DISABLE_BASELINE_CHECK = prev;
		}
	});
});

describe("B-6 rust crate subjects (injected runner)", () => {
	it("cargo baseline fails to compile ⇒ preexisting", () => {
		const repo = mkGitRepo();
		mkdirSync(join(repo, "crates/data/src"), { recursive: true });
		writeFileSync(join(repo, "Cargo.toml"), "[workspace]\nmembers = [\"crates/data\"]\nresolver = \"2\"\n");
		writeFileSync(join(repo, "crates/data/Cargo.toml"), '[package]\nname = "data"\nversion = "0.1.0"\nedition = "2021"\n');
		writeFileSync(join(repo, "crates/data/src/lib.rs"), "pub fn f() {}\n");
		commitAll(repo, "init");
		cleanups.push(repo);
		const runner: BaselineRunner = () => ({ status: 101, stdout: "", stderr: "error: could not compile `data` (test \"it\")" });
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "main", language: "rust", subjects: ["data"], runner,
		});
		expect(r.status).toBe("preexisting");
	});

	it("cargo -p resolution mismatch ⇒ unknown (our argv, not their failure)", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "Cargo.toml"), "[workspace]\nmembers = []\nresolver = \"2\"\n");
		commitAll(repo, "init");
		cleanups.push(repo);
		const runner: BaselineRunner = () => ({ status: 101, stdout: "", stderr: "error: package ID specification `data` did not match any packages" });
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "main", language: "rust", subjects: ["data"], runner,
		});
		expect(r.status).toBe("unknown");
	});
});

describe("B-6 go integration (real go test at merge-base)", () => {
	it("real: untouched failing package pre-exists at baseline", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "go.mod"), "module example.com/p\n\ngo 1.26\n");
		mkdirSync(join(repo, "api"), { recursive: true });
		writeFileSync(join(repo, "api/handler.go"), "package api\n\nvar Foo = 1\n");
		writeFileSync(join(repo, "api/handler_test.go"), "package api\n\nimport \"testing\"\n\nfunc TestFoo(t *testing.T) {\n\tif Foo != 99 {\n\t\tt.Fatalf(\"Foo=%d want 99\", Foo)\n\t}\n}\n");
		commitAll(repo, "baseline failing");
		run(repo, "git", ["checkout", "-q", "-b", "feature/x"]);
		writeFileSync(join(repo, "README.md"), "# feature\n");
		commitAll(repo, "feature change elsewhere");
		cleanups.push(repo);
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "main", language: "go", subjects: ["api/handler_test.go"],
		});
		expect(r.status).toBe("preexisting");
	}, 120_000);

	it("real: untouched package green at baseline ⇒ regression", () => {
		const repo = mkGitRepo();
		writeFileSync(join(repo, "go.mod"), "module example.com/p\n\ngo 1.26\n");
		mkdirSync(join(repo, "api"), { recursive: true });
		writeFileSync(join(repo, "api/handler.go"), "package api\n\nvar Foo = 1\n");
		writeFileSync(join(repo, "api/handler_test.go"), "package api\n\nimport \"testing\"\n\nfunc TestFoo(t *testing.T) {\n\tif Foo != 1 {\n\t\tt.Fatalf(\"Foo=%d want 1\", Foo)\n\t}\n}\n");
		commitAll(repo, "baseline green");
		run(repo, "git", ["checkout", "-q", "-b", "feature/x"]);
		// simulate the feature branch breaking the untouched test via a touched prod file
		writeFileSync(join(repo, "api/handler.go"), "package api\n\nvar Foo = 2\n");
		commitAll(repo, "feature change");
		cleanups.push(repo);
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo, defaultBranch: "main", language: "go", subjects: ["api/handler_test.go"],
		});
		expect(r.status).toBe("regression");
	}, 120_000);
});

describe("B-6 gate wiring (resolveInScopePassWithBaseline)", () => {
	const base = {
		language: "backend",
		cwd: "/tmp/x",
		errors: ["FAIL tests/old.test.ts\nexpected 1 to be 2"],
		outOfScopeErrors: ["FAIL tests/old.test.ts\nexpected 1 to be 2"],
	};

	it("preexisting keeps the lenient pass", () => {
		const r = resolveInScopePassWithBaseline({
			...base, pass: false, defaultBranch: "main",
			baselineVerify: () => ({ status: "preexisting", evidence: "also fails at baseline" }),
		});
		expect(r.inScopePass).toBe(true);
		expect(r.errors).toHaveLength(1);
		expect(r.baselineCheck?.status).toBe("preexisting");
	});

	it("regression strips the lenient pass and appends a visible error block", () => {
		const r = resolveInScopePassWithBaseline({
			...base, pass: false, defaultBranch: "main",
			baselineVerify: () => ({ status: "regression", evidence: "passes at baseline abc" }),
		});
		expect(r.inScopePass).toBe(false);
		expect(r.errors).toHaveLength(2);
		expect(r.errors[1]).toContain("[baseline-verify] regression");
		expect(r.baselineCheck?.status).toBe("regression");
	});

	it("regression appends the single-sourced exported BASELINE_VERIFY_ERROR_PREFIX (byte-identical hoist, T1.2/AC-01)", () => {
		// Namespace read so this file's PRE-EXISTING cases stay green on the
		// pre-fix tree while this new case is RED (export absent → undefined).
		const prefix = (gatesNs as { BASELINE_VERIFY_ERROR_PREFIX?: string }).BASELINE_VERIFY_ERROR_PREFIX;
		expect(typeof prefix).toBe("string");
		const evidence = "passes at baseline abc";
		const r = resolveInScopePassWithBaseline({
			...base, pass: false, defaultBranch: "main",
			baselineVerify: () => ({ status: "regression", evidence }),
		});
		// (a) the appended error starts with the exported prefix — classifier and
		// gate read ONE constant, never two literals (D-11).
		expect(r.errors[1]!.startsWith(prefix!)).toBe(true);
		expect(r.errors[1]).toBe(`${prefix} ${evidence}`);
		// (b) backward-compat guard: byte-for-byte the pre-hoist inline literal.
		expect(r.errors[1]).toBe("[baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch: passes at baseline abc");
	});

	it("unknown degrades to the historical lenient pass", () => {
		const r = resolveInScopePassWithBaseline({
			...base, pass: false, defaultBranch: "main",
			baselineVerify: () => ({ status: "unknown", evidence: "timeout" }),
		});
		expect(r.inScopePass).toBe(true);
		expect(r.errors).toHaveLength(1);
	});

	it("green gate never consults the baseline", () => {
		let calls = 0;
		const r = resolveInScopePassWithBaseline({
			...base, pass: true, defaultBranch: "main",
			baselineVerify: () => { calls++; return { status: "regression", evidence: "x" }; },
		});
		expect(r.inScopePass).toBe(true);
		expect(calls).toBe(0);
	});

	it("partial out-of-scope never consults the baseline (conservative in-scope)", () => {
		let calls = 0;
		const r = resolveInScopePassWithBaseline({
			...base, pass: false, defaultBranch: "main",
			outOfScopeErrors: [],
			baselineVerify: () => { calls++; return { status: "regression", evidence: "x" }; },
		});
		expect(r.inScopePass).toBe(false);
		expect(calls).toBe(0);
	});

	it("no defaultBranch keeps the historical formula untouched", () => {
		let calls = 0;
		const r = resolveInScopePassWithBaseline({
			...base, pass: false,
			baselineVerify: () => { calls++; return { status: "regression", evidence: "x" }; },
		});
		expect(r.inScopePass).toBe(true); // historical lenient pass
		expect(calls).toBe(0);
		expect(r.baselineCheck).toBeUndefined();
	});

	it("rust crate subjects are extracted from blocks and verified", () => {
		const blocks = ["error: could not compile `data` (test \"it\")\n --> crates/data/src/lib.rs:1:1"];
		let got: string[] | undefined;
		const r = resolveInScopePassWithBaseline({
			pass: false, errors: blocks, outOfScopeErrors: blocks, language: "rust", cwd: "/tmp/x", defaultBranch: "main",
			baselineVerify: (input) => { got = input.subjects; return { status: "regression", evidence: "passes at baseline" }; },
		});
		expect(got).toContain("data");
		expect(r.inScopePass).toBe(false);
	});
});

/* v0.3.62 — python subject anchoring (run 2026-09-02T10-18-31-007Z): the     */
/* failing command ran `cd python && pytest -q`, so subjects are module-      */
/* relative ("tests/test_x.py") while the file lives at python/tests/ in the  */
/* baseline checkout. The anchor re-writes subjects so the baseline pytest    */
/* actually collects them (previously: collection failure ⇒ unproven).        */
describe("B-6 python subject anchoring", () => {
	it("module-relative subjects are re-anchored under their common top-level dir and PROVEN preexisting", () => {
		const repo = mkGitRepo();
		mkdirSync(join(repo, "python", "tests"), { recursive: true });
		writeFileSync(
			join(repo, "python", "tests", "test_preexisting.py"),
			"def test_census_exists():\n    assert False\n",
		);
		commitAll(repo, "init with pre-existing failing python test");
		cleanups.push(repo);
		let seenArgv: string[] | null = null;
		let seenCwd = "";
		const runner: BaselineRunner = (cwd, argv) => {
			seenArgv = argv;
			seenCwd = cwd;
			return {
				status: 1,
				stdout: "FAILED python/tests/test_preexisting.py::test_census_exists - assert False\n1 failed in 0.1s",
				stderr: "",
			};
		};
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo,
			defaultBranch: "main",
			language: "python",
			subjects: ["tests/test_preexisting.py"],
			runner,
		});
		expect(seenArgv).toContain("python/tests/test_preexisting.py");
		expect(seenArgv).not.toContain("tests/test_preexisting.py");
		expect(r.status).toBe("preexisting");
		expect(seenCwd).toBeTruthy();
	});

	it("subjects that exist at the checkout root are passed through unchanged", () => {
		const repo = mkGitRepo();
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests", "test_root.py"), "def test_a():\n    assert False\n");
		commitAll(repo, "init");
		cleanups.push(repo);
		let seenArgv: string[] | null = null;
		const runner: BaselineRunner = (_cwd, argv) => {
			seenArgv = argv;
			return { status: 1, stdout: "FAILED tests/test_root.py::test_a - assert False\n1 failed", stderr: "" };
		};
		const r = verifyUntouchedFailuresAgainstBaseline({
			cwd: repo,
			defaultBranch: "main",
			language: "python",
			subjects: ["tests/test_root.py"],
			runner,
		});
		expect(seenArgv).toContain("tests/test_root.py");
		expect(r.status).toBe("preexisting");
	});
});
