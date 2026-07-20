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
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- spawnSync stub (the ONLY side effect the checker performs) -------------
const mock = vi.hoisted(() => ({
	calls: [] as { args: string[] }[],
	stubber: null as null | ((args: string[]) => {
		status: number;
		stdout: string;
		stderr: string;
		signal: NodeJS.Signals | null;
		error?: Error;
	}),
}));

vi.mock("node:child_process", () => ({
	spawnSync: (cmd: string, argv?: readonly string[]) => {
		const full = [cmd, ...(Array.isArray(argv) ? argv.slice() : [])];
		mock.calls.push({ args: full });
		if (mock.stubber) return mock.stubber(full);
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
