/**
 * Deliverable Checker Primitive — runDeliverableCheck RED-phase tests
 * (Layer 1, AC-01/AC-02 → SCENARIO-001..010 + SCENARIO-014).
 *
 * These tests DEFINE the never-throwing `runDeliverableCheck(cwd, deliverables,
 * opts?)` primitive's contract BEFORE it is implemented in src/build-runner.ts.
 * They are RED until Phase 1 (Layer 1) lands. The function does not exist yet,
 * so every test fails with "runDeliverableCheck is not a function".
 *
 * Contract (spec §Layer 1 — sibling of runRedCheck/runBuildGate):
 *  - Reuses detectProjectCommands(cwd) for runner selection, resolveTimeoutMs
 *    for the spawn envelope, readMaybe for best-effort reads, and ONE cached
 *    `spawnSync` test-list subprocess per cwd per run.
 *  - Never throws: ENTIRE body wrapped in try/catch; any thrown error returns
 *    { pass:false, missing:['<reason>'], ran:[...] } instead of propagating
 *    (the load-bearing build-runner-nonregression invariant).
 *  - Sub-checks (every element evaluated, no short-circuit, so `missing` is
 *    exhaustive and `ran` is complete):
 *      (a) requireFiles       → existsSync(resolve(cwd,p)); miss ⇒ `missing file: <p>`
 *      (b) requireContains    → regex (substring fallback on invalid regex); miss ⇒ `missing pattern <pat> in <file>`
 *      (c) requireNotContains → regex hit ⇒ `forbidden pattern <pat> still present in <file>`
 *      (d) requireTests       → cached test-list spawn; tolerant substring-OR-regex
 *                               name match; miss ⇒ `missing test: <name>`
 *  - requireTests unavailable (no runner / spawn error / timeout / empty stdout)
 *    ⇒ records `test-list unavailable`, does NOT block (existence/grep enforced).
 *  - undefined/null/empty deliverables ⇒ early { pass:true, missing:[], ran:[] }.
 *
 * Hermetic: real temp cwds (mkdtempSync) drive detectProjectCommands so the
 * test-list runner is chosen exactly as runRedCheck chooses its runner;
 * node:child_process.spawnSync is mocked to feed a fixed test list and to count
 * spawns (the cache assertion). No real cargo/vitest/git runs in CI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- spawnSync stub (the ONLY side effect the checker performs) -------------
const mock = vi.hoisted(() => ({
	calls: [] as { args: string[]; cwd?: string }[],
	stubber: null as null | ((args: string[], cwd?: string) => {
		status: number;
		stdout: string;
		stderr: string;
		signal: NodeJS.Signals | null;
		error?: Error;
	}),
}));

vi.mock("node:child_process", () => ({
	spawnSync: (cmd: string, argv?: readonly string[], opts?: { cwd?: string }) => {
		const full = [cmd, ...(Array.isArray(argv) ? argv.slice() : [])];
		mock.calls.push({ args: full, cwd: opts?.cwd });
		if (mock.stubber) return mock.stubber(full, opts?.cwd);
		return { status: 0, stdout: "", stderr: "", signal: null };
	},
}));

import { runDeliverableCheck } from "../src/build-runner.ts";

// Root cannot be made to fail reads via chmod 000 (root bypasses file modes),
// so the chmod-based unreadable test would be flaky there → skip on root.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const maybeIt = isRoot ? it.skip : it;

// --- helpers ----------------------------------------------------------------

/** A temp cwd containing only a `Cargo.toml` so detectProjectCommands ⇒ rust. */
function rustTmp(prefix = "sd-dcheck-rust-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "ws"\nversion = "0.1.0"\n');
	return dir;
}

/** A temp cwd with a vitest `package.json` so detectProjectCommands ⇒ node+vitest. */
function vitestTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "sd-dcheck-vitest-"));
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "ws", scripts: { test: "vitest" } }),
	);
	return dir;
}

/** An EMPTY temp cwd (no manifest) → detectProjectCommands ⇒ no test runner. */
function greenfieldTmp(): string {
	return mkdtempSync(join(tmpdir(), "sd-dcheck-empty-"));
}

/** Returns a stubber that answers the test-LISTER spawn with `list` stdout. */
function listStubber(listStdout: string): NonNullable<typeof mock.stubber> {
	return (args) => {
		if (/\blist\b|listTests|collect-only/i.test(args.join(" "))) {
			return { status: 0, stdout: listStdout, stderr: "", signal: null };
		}
		return { status: 0, stdout: "", stderr: "", signal: null };
	};
}

/** Count spawns that look like the project test-LISTER. */
function listSpawns(): number {
	return mock.calls.filter((c) => /\blist\b|listTests|collect-only/i.test(c.args.join(" "))).length;
}

function nestedVitestTmp(): { cwd: string; moduleDir: string } {
	const cwd = mkdtempSync(join(tmpdir(), "sd-dcheck-nested-vitest-"));
	const moduleDir = join(cwd, "auth-service");
	mkdirSync(join(moduleDir, "src"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root", scripts: { build: "echo root" } }));
	writeFileSync(join(moduleDir, "package.json"), JSON.stringify({ name: "auth-service", scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }));
	writeFileSync(join(moduleDir, "src", "auth.test.ts"), "test('nested auth expires session', () => {})\n");
	return { cwd, moduleDir };
}

beforeEach(() => {
	mock.calls = [];
	mock.stubber = null;
});

afterEach(() => {
	mock.calls = [];
	mock.stubber = null;
});

// === SCENARIO-014 / backward compat: empty/undefined deliverables ============

describe("runDeliverableCheck — backward-compat (SCENARIO-014)", () => {
	it("returns {pass:true, missing:[], ran:[]} for undefined deliverables", () => {
		const cwd = rustTmp();
		try {
			expect(runDeliverableCheck(cwd, undefined)).toEqual({ pass: true, missing: [], ran: [] });
			expect(listSpawns()).toBe(0); // early-return ⇒ no list spawn
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns {pass:true, missing:[], ran:[]} for null deliverables", () => {
		const cwd = rustTmp();
		try {
			expect(runDeliverableCheck(cwd, null)).toEqual({ pass: true, missing: [], ran: [] });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns {pass:true, missing:[], ran:[]} for an empty deliverables object", () => {
		const cwd = rustTmp();
		try {
			expect(runDeliverableCheck(cwd, {})).toEqual({ pass: true, missing: [], ran: [] });
			expect(listSpawns()).toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("runDeliverableCheck — requireScenarios (anti-brittle stable-tag grading)", () => {
	it("PASSES when the SCENARIO-NNN tag is present in a test file, even if the it() title is reworded", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sd-dcheck-scenario-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app" }));
		// A completely different English title — only the stable tag matters.
		writeFileSync(join(cwd, "src", "expiry.test.ts"), "it('rejects a totally reworded description SCENARIO-024', () => {})\n");
		try {
			const res = runDeliverableCheck(cwd, { requireScenarios: ["SCENARIO-024"] });
			expect(res.pass).toBe(true);
			expect(res.missing).toEqual([]);
			expect(listSpawns()).toBe(0); // scenario grep never spawns a runner
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("FAILS with `missing scenario:` when no test file carries the tag", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sd-dcheck-scenario-miss-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app" }));
		writeFileSync(join(cwd, "src", "expiry.test.ts"), "it('covers SCENARIO-001 only', () => {})\n");
		try {
			const res = runDeliverableCheck(cwd, { requireScenarios: ["SCENARIO-024", "SCENARIO-001"] });
			expect(res.pass).toBe(false);
			expect(res.missing).toContain("missing scenario: SCENARIO-024");
			expect(res.missing).not.toContain("missing scenario: SCENARIO-001");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not confuse SCENARIO-024 with SCENARIO-0240 (word boundary)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sd-dcheck-scenario-boundary-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app" }));
		writeFileSync(join(cwd, "src", "x.test.ts"), "it('SCENARIO-0240 unrelated', () => {})\n");
		try {
			const res = runDeliverableCheck(cwd, { requireScenarios: ["SCENARIO-024"] });
			expect(res.pass).toBe(false);
			expect(res.missing).toContain("missing scenario: SCENARIO-024");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("finds the tag even when >200 unrelated test files precede it in a root-only repo (scan-order fix)", () => {
		// Root-only manifest: projectDirsFromEvidence collapses everything to cwd, so
		// the fix must prioritize the touched FILE's own directory, not just roots.
		const cwd = mkdtempSync(join(tmpdir(), "sd-dcheck-scenario-bigrepo-"));
		mkdirSync(join(cwd, "aaa"), { recursive: true });
		mkdirSync(join(cwd, "zzz"), { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root" }));
		for (let i = 0; i < 201; i++) writeFileSync(join(cwd, "aaa", `u${i}.test.ts`), "it('unrelated', () => { expect(1).toBe(1); })\n");
		writeFileSync(join(cwd, "zzz", "target.test.ts"), "it('covers SCENARIO-999', () => { expect(f()).toBe(1); })\n");
		try {
			// The touched file is the target; its dir must be scanned before the 201 aaa files.
			const res = runDeliverableCheck(cwd, {
				requireScenarios: ["SCENARIO-999"],
				requireContains: [{ file: "zzz/target.test.ts", pattern: "SCENARIO-999" }],
			});
			expect(res.missing).not.toContain("missing scenario: SCENARIO-999");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reads the exact evidence test file directly (tier 1) so 200+ unrelated siblings can't exhaust the cap first", () => {
		// The target is declared as deliverable evidence (requireContains points at
		// it). tier-1 reads that file DIRECTLY before any dir walk, so the tagged
		// file is seen regardless of how many unrelated siblings exist. This is the
		// mechanism that fixes the real (git-touched) standalone case.
		const cwd = mkdtempSync(join(tmpdir(), "sd-dcheck-scenario-tier1-"));
		mkdirSync(join(cwd, "aaa"), { recursive: true });
		mkdirSync(join(cwd, "zzz"), { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root" }));
		for (let i = 0; i < 250; i++) writeFileSync(join(cwd, "aaa", `u${i}.test.ts`), "it('unrelated', () => { expect(1).toBe(1); })\n");
		writeFileSync(join(cwd, "zzz", "target.test.ts"), "it('covers SCENARIO-999', () => { expect(f()).toBe(1); })\n");
		try {
			const res = runDeliverableCheck(cwd, {
				requireScenarios: ["SCENARIO-999"],
				requireContains: [{ file: "zzz/target.test.ts", pattern: "SCENARIO-999" }],
			});
			expect(res.missing).not.toContain("missing scenario: SCENARIO-999");
			expect(res.pass).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does NOT match a scenario tag in a file OUTSIDE the worktree (evidence-path escape guard)", () => {
		// A model-authored deliverable path like ../sibling/tests/x.test.ts must not
		// let scenario matching read outside cwd and falsely pass.
		const base = mkdtempSync(join(tmpdir(), "sd-dcheck-escape-"));
		const cwd = join(base, "wt");
		const sibling = join(base, "sibling", "tests");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app" }));
		writeFileSync(join(sibling, "outside.test.ts"), "it('covers SCENARIO-777', () => { expect(f()).toBe(1); })\n");
		try {
			const res = runDeliverableCheck(cwd, {
				requireScenarios: ["SCENARIO-777"],
				requireContains: [{ file: "../sibling/tests/outside.test.ts", pattern: "x" }],
			});
			// The tag exists only outside the worktree → must be reported missing.
			expect(res.missing).toContain("missing scenario: SCENARIO-777");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

// === SCENARIO-001: all-present → pass:true, ran complete ====================

describe("runDeliverableCheck — every deliverable satisfied (SCENARIO-001)", () => {
	it("passes when all files/contains/not-contains/tests are present", () => {
		const cwd = rustTmp();
		writeFileSync(
			join(cwd, "screen.rs"),
			"fn fetch_us_data() {}\nfn real() { fetch_us_data() }\n",
		);
		mock.stubber = listStubber("ws::screen::fetch_us_data\nws::screen::loads\n");
		try {
			const r = runDeliverableCheck(cwd, {
				requireFiles: ["screen.rs"],
				requireContains: [{ file: "screen.rs", pattern: "fetch_us_data" }],
				requireNotContains: [{ file: "screen.rs", pattern: "unreachable_marker_xyz" }],
				requireTests: ["fetch_us_data"],
			});
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
			expect(Array.isArray(r.ran)).toBe(true);
			expect(r.ran.length).toBeGreaterThan(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// === SCENARIO-002: requireFiles ============================================

describe("runDeliverableCheck — requireFiles (SCENARIO-002)", () => {
	it("reports `missing file: <path>` for each absent declared file", () => {
		const cwd = rustTmp();
		try {
			const r = runDeliverableCheck(cwd, {
				requireFiles: ["does/not/exist.rs", "also_missing.rs"],
			});
			expect(r.pass).toBe(false);
			expect(r.missing).toContain("missing file: does/not/exist.rs");
			expect(r.missing).toContain("missing file: also_missing.rs");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("passes when every declared file exists", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "present.rs"), "");
		try {
			const r = runDeliverableCheck(cwd, { requireFiles: ["present.rs"] });
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// === SCENARIO-003 / 006: requireContains ===================================

describe("runDeliverableCheck — requireContains (SCENARIO-003/006)", () => {
	it("reports `missing pattern <pattern> in <file>` when the pattern is absent", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "screen.rs"), "fn other() {}\n");
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "screen.rs", pattern: "fetch_us_data" }],
			});
			expect(r.pass).toBe(false);
			expect(r.missing).toContain("missing pattern fetch_us_data in screen.rs");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reports `missing pattern ... in <file>` when the file does not exist", () => {
		const cwd = rustTmp();
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "ghost.rs", pattern: "fetch_us_data" }],
			});
			expect(r.pass).toBe(false);
			expect(r.missing).toContain("missing pattern fetch_us_data in ghost.rs");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("matches a valid regex pattern that a plain substring lookup would miss (SCENARIO-006)", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "screen.rs"), "fetch_us_data_v2();\n");
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "screen.rs", pattern: "fetch_us_data_v\\d" }],
			});
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("falls back to a substring match when the pattern is an invalid regex", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "screen.rs"), "config[host]\n"); // literal '[' sequence
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "screen.rs", pattern: "config[host" }], // invalid regex
			});
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not satisfy code requireContains from comments only", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "route.ts"), "// must use createRootHandlers('/x', 'API')\nexport async function POST() {}\n");
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "route.ts", pattern: "createRootHandlers\\([\"']/x[\"'],\\s*[\"']API[\"']\\)" }],
			});
			expect(r.pass).toBe(false);
			// RC9: the comment-only case now carries the honest suffix (cause + fix);
			// pin the prefix + the new marker instead of the bare legacy string.
			const msg = r.missing.find((m) => typeof m === "string" && m.startsWith("missing pattern createRootHandlers\\([\"']/x[\"'],\\s*[\"']API[\"']\\) in route.ts"));
			expect(msg).toBeDefined();
			expect(msg).toMatch(/matched only inside comments/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("relaxes generated one-letter alias examples for member export patterns", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "route.ts"), "const handlers = createRootHandlers('/x', 'API')\nexport const POST = handlers.POST\n");
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "route.ts", pattern: "export\\s+const\\s+POST\\s*=\\s*h\\.POST" }],
			});
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("supports (?i) case-insensitive regex prefixes emitted by specs/agents", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "screen.rs"), "Permission denied\nLoading usage analytics\n");
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [
					{ file: "screen.rs", pattern: "(?i)permission" },
					{ file: "screen.rs", pattern: "(?i)empty|error|loading" },
				],
			});
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// === SCENARIO-004: requireNotContains ======================================

describe("runDeliverableCheck — requireNotContains (SCENARIO-004)", () => {
	it("reports `forbidden pattern <pattern> still present in <file>` on a hit", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "screen.rs"), "with_retry(() => fetch_fmp());\n");
		try {
			const r = runDeliverableCheck(cwd, {
				requireNotContains: [{ file: "screen.rs", pattern: "with_retry" }],
			});
			expect(r.pass).toBe(false);
			expect(r.missing).toContain("forbidden pattern with_retry still present in screen.rs");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("passes when the forbidden pattern is absent", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "screen.rs"), "fetch_us_data();\n");
		try {
			const r = runDeliverableCheck(cwd, {
				requireNotContains: [{ file: "screen.rs", pattern: "with_retry" }],
			});
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("passes when a pure negative assertion names a missing optional file", () => {
		const cwd = rustTmp();
		try {
			const r = runDeliverableCheck(cwd, {
				requireNotContains: [{ file: "proxy.ts", pattern: "analytics" }],
			});
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
			expect(r.ran).toContain("not-contains:proxy.ts:analytics");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still fails a missing not-contains target when requireFiles also declares it", () => {
		const cwd = rustTmp();
		try {
			const r = runDeliverableCheck(cwd, {
				requireFiles: ["proxy.ts"],
				requireNotContains: [{ file: "proxy.ts", pattern: "analytics" }],
			});
			expect(r.pass).toBe(false);
			expect(r.missing).toContain("missing file: proxy.ts");
			expect(r.missing.some((m) => m.includes("forbidden pattern"))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// === SCENARIO-005 / 006: requireTests ======================================

describe("runDeliverableCheck — requireTests (SCENARIO-005/006)", () => {
	it("reports `missing test: <name>` when a declared test is absent from the list (SCENARIO-005)", () => {
		const cwd = rustTmp();
		mock.stubber = listStubber("ws::existing_test\n");
		try {
			const r = runDeliverableCheck(cwd, { requireTests: ["declared_but_absent"] });
			expect(r.pass).toBe(false);
			expect(r.missing).toContain("missing test: declared_but_absent");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("passes via tolerant substring match against the list (SCENARIO-006)", () => {
		const cwd = rustTmp();
		mock.stubber = listStubber("ws::screen::loads_us_data\n");
		try {
			const r = runDeliverableCheck(cwd, { requireTests: ["loads_us_data"] });
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("passes via tolerant regex match against the list", () => {
		const cwd = rustTmp();
		mock.stubber = listStubber("ws::screen::loads_v3\n");
		try {
			const r = runDeliverableCheck(cwd, { requireTests: ["loads_v\\d"] });
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("evaluates EVERY declared name (no short-circuit) so `missing` is exhaustive", () => {
		const cwd = rustTmp();
		mock.stubber = listStubber("ws::present\n");
		try {
			const r = runDeliverableCheck(cwd, {
				requireTests: ["present", "absent_a", "absent_b"],
			});
			expect(r.pass).toBe(false);
			expect(r.missing).toContain("missing test: absent_a");
			expect(r.missing).toContain("missing test: absent_b");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("uses the vitest lister on a node+vitest project and tolerantly matches", () => {
		const cwd = vitestTmp();
		// `vitest list --json` emits a JSON-ish stream; tolerant substring match works.
		mock.stubber = listStubber('[{"name":"screen loads us data"}]');
		try {
			const r = runDeliverableCheck(cwd, { requireTests: ["loads"] });
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("derives the owning nested package cwd for requireTests instead of treating the root as unavailable", () => {
		const { cwd, moduleDir } = nestedVitestTmp();
		mock.stubber = (args, spawnCwd) => {
			if (/\blist\b|listTests|collect-only/i.test(args.join(" "))) {
				expect(spawnCwd).toBe(moduleDir);
				return { status: 0, stdout: '[{"name":"nested auth expires session"}]', stderr: "", signal: null };
			}
			return { status: 0, stdout: "", stderr: "", signal: null };
		};
		try {
			const r = runDeliverableCheck(cwd, {
				requireFiles: ["auth-service/src/auth.test.ts"],
				requireTests: ["nested auth expires session"],
			});
			expect(r.pass).toBe(true);
			expect(r.ran).toContain("tests:list:auth-service");
			expect(mock.calls.some((c) => c.cwd === moduleDir && /vitest\s+(--\s+)?list/.test(c.args.join(" ")))).toBe(true); // v0.3.56 F1: argv form may carry the `--` guard between tool and args
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fails a missing requireTests name when the relevant test list is in a nested package", () => {
		const { cwd, moduleDir } = nestedVitestTmp();
		mock.stubber = (args, spawnCwd) => {
			if (/\blist\b|listTests|collect-only/i.test(args.join(" "))) {
				expect(spawnCwd).toBe(moduleDir);
				return { status: 0, stdout: '[{"name":"some other nested test"}]', stderr: "", signal: null };
			}
			return { status: 0, stdout: "", stderr: "", signal: null };
		};
		try {
			const r = runDeliverableCheck(cwd, {
				requireFiles: ["auth-service/src/auth.test.ts"],
				requireTests: ["nested auth expires session"],
			});
			expect(r.pass).toBe(false);
			expect(r.missing).toContain("missing test: nested auth expires session");
			expect(r.ran).toContain("tests:list:auth-service");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("derives a nested Go module cwd for requireTests before listing tests", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sd-dcheck-nested-go-"));
		const moduleDir = join(cwd, "backend-service");
		mkdirSync(join(moduleDir, "internal", "handlers", "performance"), { recursive: true });
		writeFileSync(join(moduleDir, "go.mod"), "module example.com/backend-service\n\ngo 1.22\n");
		writeFileSync(join(moduleDir, "internal", "handlers", "performance", "jmx_resource_manifest_test.go"), "package performance\n");
		mock.stubber = (args, spawnCwd) => {
			if (args[0] === "git") return { status: 128, stdout: "", stderr: "fatal: not a git repository", signal: null };
			if (args[0] === "go" && args.includes("-list")) {
				expect(spawnCwd).toBe(moduleDir);
				expect(args).toEqual(["go", "test", "./...", "-list", "."]);
				return { status: 0, stdout: "TestJMXResourceManifest\n", stderr: "", signal: null };
			}
			return { status: 0, stdout: "", stderr: "", signal: null };
		};

		try {
			const r = runDeliverableCheck(cwd, {
				requireFiles: ["backend-service/internal/handlers/performance/jmx_resource_manifest_test.go"],
				requireTests: ["TestJMXResourceManifest"],
			});
			expect(r.pass).toBe(true);
			expect(r.ran).toContain("tests:list:backend-service");
			expect(mock.calls.some((c) => c.cwd === moduleDir && c.args.join(" ") === "go test ./... -list .")).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// === SCENARIO-007: requireTests test-list unavailable (does NOT block) ======

describe("runDeliverableCheck — requireTests unavailable (SCENARIO-007)", () => {
	it("does NOT block when the project has no test runner (greenfield cwd)", () => {
		const cwd = greenfieldTmp();
		writeFileSync(join(cwd, "present.txt"), "");
		try {
			const r = runDeliverableCheck(cwd, {
				requireFiles: ["present.txt"],
				requireTests: ["any_test"],
			});
			expect(r.pass).toBe(true); // unavailable does not block
			expect(r.missing).not.toContain("missing test: any_test");
			expect(listSpawns()).toBe(0); // no runner ⇒ no list spawn attempted
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still enforces existence/grep while requireTests is unavailable", () => {
		const cwd = greenfieldTmp();
		writeFileSync(join(cwd, "present.txt"), "");
		try {
			const r = runDeliverableCheck(cwd, {
				requireFiles: ["present.txt", "missing.txt"],
				requireTests: ["any_test"],
			});
			// a genuinely missing file still blocks despite requireTests being unavailable.
			expect(r.pass).toBe(false);
			expect(r.missing).toContain("missing file: missing.txt");
			expect(r.missing).not.toContain("missing test: any_test");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does NOT block when the test-list spawn errors (ENOENT)", () => {
		const cwd = rustTmp();
		mock.stubber = (args) => {
			if (/\blist\b|listTests|collect-only/i.test(args.join(" "))) {
				return { status: 1, stdout: "", stderr: "enoent", signal: null, error: new Error("enoent") };
			}
			return { status: 0, stdout: "", stderr: "", signal: null };
		};
		try {
			const r = runDeliverableCheck(cwd, { requireTests: ["any_test"] });
			expect(r.pass).toBe(true); // spawn error does not block
			expect(r.missing).not.toContain("missing test: any_test");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does NOT block when the test-list spawn returns empty stdout", () => {
		const cwd = rustTmp();
		mock.stubber = (args) => {
			if (/\blist\b|listTests|collect-only/i.test(args.join(" "))) {
				return { status: 0, stdout: "   \n", stderr: "", signal: null };
			}
			return { status: 0, stdout: "", stderr: "", signal: null };
		};
		try {
			const r = runDeliverableCheck(cwd, { requireTests: ["any_test"] });
			expect(r.pass).toBe(true); // empty list does not block
			expect(r.missing).not.toContain("missing test: any_test");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// === SCENARIO-008 / 010: unreadable file + never-throw =====================

describe("runDeliverableCheck — unreadable file & never-throw (SCENARIO-008/010)", () => {
	maybeIt("reports `unreadable: <path>` (no throw) for an unreadable requireContains file", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "secret.rs"), "fetch_us_data();\n");
		chmodSync(join(cwd, "secret.rs"), 0o000);
		writeFileSync(join(cwd, "present.rs"), "");
		try {
			const r = runDeliverableCheck(cwd, {
				requireFiles: ["present.rs"],
				requireContains: [{ file: "secret.rs", pattern: "fetch_us_data" }],
			});
			expect(r).toBeTruthy();
			expect(r.pass).toBe(false);
			expect(
				r.missing.some((m) => m.startsWith("unreadable:") && m.includes("secret.rs")),
			).toBe(true);
			// remaining checks still ran (the present file is verified, not swallowed).
			expect(r.missing).not.toContain("missing file: present.rs");
		} finally {
			chmodSync(join(cwd, "secret.rs"), 0o600);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("never throws when iterating deliverables throws — returns {pass:false} (SCENARIO-010)", () => {
		const cwd = rustTmp();
		const boom = {
			get requireFiles(): string[] {
				throw new Error("iteration boom");
			},
		};
		try {
			const r = runDeliverableCheck(
				cwd,
				boom as unknown as Parameters<typeof runDeliverableCheck>[1],
			);
			expect(r).toBeTruthy();
			expect(r.pass).toBe(false);
			expect(Array.isArray(r.missing)).toBe(true);
			expect(r.missing.length).toBeGreaterThan(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// === SCENARIO-009: single cached test-list spawn per cwd ===================

describe("runDeliverableCheck — single cached test-list per cwd (SCENARIO-009)", () => {
	it("spawns the test-lister at most once across two requireTests calls sharing a cwd", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "present.rs"), "");
		mock.stubber = listStubber("ws::a\nws::b\n");
		try {
			runDeliverableCheck(cwd, { requireTests: ["a"] });
			expect(listSpawns()).toBe(1); // first call spawns the lister
			runDeliverableCheck(cwd, { requireTests: ["b"] });
			// cache: still only ONE list spawn for this cwd across both calls.
			expect(listSpawns()).toBe(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// === opts plumbing =========================================================

describe("runDeliverableCheck — options", () => {
	it("accepts an opts bag with timeoutMs without throwing", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "present.rs"), "");
		try {
			const r = runDeliverableCheck(cwd, { requireFiles: ["present.rs"] }, { timeoutMs: 5000 });
			expect(r.pass).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("accepts an AbortSignal option without throwing", () => {
		const cwd = rustTmp();
		writeFileSync(join(cwd, "present.rs"), "");
		const ac = new AbortController();
		try {
			const r = runDeliverableCheck(cwd, { requireFiles: ["present.rs"] }, { signal: ac.signal });
			expect(r.pass).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// === v0.3.62 — string-aware comment stripping (run 2026-09-02T10-18-31-007Z) =
// The REAL incident: prosperity-contract.test.ts carried `//` line comments
// mentioning the vitest include glob and `python/tests/*`; the old stripper's
// block-comment regex ran FIRST and treated the glob's slash-star sequences as
// comment openers, swallowing the REAL string literals below. The deliverable
// gate then rejected an honest file with "matched only inside comments" and
// two attempts (~25 min each) burned re-fixing an already-correct file.
describe("runDeliverableCheck — string-aware comment stripping (v0.3.62 live-incident regression)", () => {
	// Assembled so this comment can't contain a literal comment-terminator.
	const GLOB = "tests/" + "**" + "/*.test.ts";

	/** The incident shape: glob mentions in line comments ABOVE the real literals. */
	function incidentFile(): string {
		return [
			"// xmur3+splitmix32 harness; not collected by the vitest include glob",
			`// ${GLOB}) and tests/gate-properties.test.ts (one property test`,
			"// per gate G0-G21 over the real exported oracles, per phase",
			"// spec23-seeded-property-layer. The phase's python/tests/* property",
			"// files sit outside this suite's walked pathspec.",
			"export const TOLERATED_PATHS = [",
			'\t"tests/support/",',
			'\t"tests/support/property-harness.ts",',
			'\t"tests/gate-properties.test.ts",',
			"];",
			"",
		].join("\n");
	}

	it("PASSES an honest file whose line comments mention the vitest include glob (live incident)", () => {
		const cwd = vitestTmp();
		mkdirSync(join(cwd, "tests"), { recursive: true });
		writeFileSync(join(cwd, "tests", "prosperity-contract.test.ts"), incidentFile());
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "tests/prosperity-contract.test.ts", pattern: "tests/gate-properties\\.test\\.ts" }],
			});
			expect(r.pass).toBe(true);
			expect(r.missing).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("STILL FAILS when the pattern lives only in a real block comment", () => {
		const cwd = vitestTmp();
		mkdirSync(join(cwd, "tests"), { recursive: true });
		// Pattern inside a plain block comment (no comment-terminator inside it).
		const body = "export const A = 1;\n/* documented target: gate-properties.test.ts (see spec) */\n";
		writeFileSync(join(cwd, "tests", "x.test.ts"), body);
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "tests/x.test.ts", pattern: "gate-properties\\.test\\.ts" }],
			});
			expect(r.pass).toBe(false);
			expect(r.missing[0]).toContain("matched only inside comments");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("a pattern only in an INLINE comment no longer matches (stricter, matches the documented contract)", () => {
		const cwd = vitestTmp();
		mkdirSync(join(cwd, "tests"), { recursive: true });
		writeFileSync(join(cwd, "tests", "x.test.ts"), 'export const A = "real code"; // tags: tests/gate-properties.test.ts\n');
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "tests/x.test.ts", pattern: "gate-properties\\.test\\.ts" }],
			});
			expect(r.pass).toBe(false);
			expect(r.missing[0]).toContain("matched only inside comments");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("comment markers INSIDE string literals are inert (the exact swallow shape)", () => {
		const cwd = vitestTmp();
		mkdirSync(join(cwd, "tests"), { recursive: true });
		// The string contains a slash-star pair; the old stripper ate from it to EOF.
		writeFileSync(join(cwd, "tests", "x.test.ts"), 'const glob = "tests/" + "**" + "/*.test.ts";\nexport const TARGET = "gate-properties.test.ts";\n');
		try {
			const r = runDeliverableCheck(cwd, {
				requireContains: [{ file: "tests/x.test.ts", pattern: "TARGET" }],
			});
			expect(r.pass).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("a real-code file with a glob-in-comment is NOT symbol-hollow (computeSymbolGate shares the stripper)", async () => {
		const { computeSymbolGate } = await import("../src/build-runner.ts");
		const cwd = mkdtempSync(join(tmpdir(), "sd-dcheck-symbol-"));
		mkdirSync(join(cwd, "tests"), { recursive: true });
		writeFileSync(join(cwd, "tests", "x.test.ts"), incidentFile());
		try {
			const r = computeSymbolGate(cwd, ["tests/x.test.ts"], "frontend");
			expect(r.pass).toBe(true);
			expect(r.hollowFiles).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
