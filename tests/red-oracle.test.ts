/**
 * Phase P2 — runRedCheck RED oracle — RED phase (TDD).
 *
 * These tests define the AC-01 contract for `runRedCheck(cwd, testTargets, opts)`
 * BEFORE the implementation exists. The function is the deterministic "red"
 * oracle for the Stage 9 TDD cycle: it runs the tdd-guide-authored test targets
 * and classifies the outcome into exactly one status:
 *
 *   export type RedStatus = "red" | "green" | "broken" | "unknown";
 *   export interface RedCheckOptions { timeoutMs?: number; signal?: AbortSignal; }
 *   export function runRedCheck(
 *     cwd: string,
 *     testTargets: string[],
 *     opts?: RedCheckOptions,
 *   ): RedStatus;
 *
 * Contract (spec §A.2, AC-01):
 *   - Modeled on the runBuildGate skeleton; reuses detectProjectCommands,
 *     resolveTimeoutMs, resolveIntegrationStems (no NEW primitives).
 *   - Per-language scoped invocation: cargo (per-stem `cargo test -p <pkg>
 *     --test <stem>`, NO --lib; fall back to `cargo test -p <pkg>` when no
 *     stems resolve), npm/vitest/jest/node:test (owning package cwd first;
 *     direct node:test/vitest/script plan; root fallback only when needed),
 *     pytest (`pytest <targets>`).
 *   - Classifies COMBINED stdout+stderr+exit into exactly one status:
 *       cargo    — broken: `error[E` / `could not compile` / `no tests to run`
 *                  (no run); red: exit≠0 + `test result: FAILED.`/`FAILED`/
 *                  `panicked` after successful compile; green: exit 0; unknown
 *                  on ambiguity.
 *       npm      — broken: `SyntaxError` / `failed to load` / `No test files
 *                  found`; red: exit≠0 + `❯` / `FAIL` / `Tests:\s+\d+ failed`;
 *                  green: exit 0; unknown on ambiguity.
 *       pytest   — broken: `ERROR collecting`; red: `failed`/`error` summary +
 *                  exit≠0; green: exit 0; unknown on ambiguity.
 *   - No test runner (greenfield/no-manifest/no package-local or root plan) OR
 *     `testTargets.length === 0` → "unknown" with NO spawn (greenfield cannot
 *     stall the pipeline).
 *   - The ENTIRE body is try/caught → any spawn error / thrown exception /
 *     parse ambiguity returns "unknown". NEVER throws.
 *
 * RED status: runRedCheck, RedStatus, RedCheckOptions do NOT exist yet in
 * src/build-runner.ts, so the import fails and every assertion is RED until
 * Phase P2 is implemented.
 *
 * Hermeticity: `node:child_process.spawnSync` is mocked for the whole file; a
 * module-level router routes the (possibly present) `git` self-detection spawn
 * to an empty success so the classification contract can be asserted on the
 * test-runner output alone without coupling to the exact cargo `-p <pkg>`
 * resolution argv (which the spec leaves to the implementer). The observable
 * behavior under test is the STATUS, the never-throw invariant, and the
 * no-spawn-on-unknown short-circuit — not the precise argv.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the ONLY side-effect runRedCheck performs: spawnSync. Real git/cargo/
// vitest/pytest must never run in CI.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import {
	runRedCheck,
	type RedStatus,
	type RedCheckOptions,
} from "../src/build-runner.ts";
import { spawnSync } from "node:child_process";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;

/** A minimal SpawnSyncReturns<string>-shaped object. */
function out(
	status: number | null,
	stdout = "",
	stderr = "",
	error?: Error,
): { status: number | null; stdout: string; stderr: string; error: Error | undefined; pid: number; signal: null } {
	return { status, stdout, stderr, error, pid: 1, signal: null };
}

function tmpProj(setup: (dir: string) => void): string {
	const dir = mkdtempSync(join(tmpdir(), "sd-red-"));
	setup(dir);
	return dir;
}

/** Route git → empty success, every other cmd → the given runner result. */
function mockRunner(result: ReturnType<typeof out>): void {
	spawn.mockImplementation((cmd: string) => {
		// Any git self-detection (cargo pkg resolution, etc.) yields no touched
		// set so the classification result is driven solely by `result`.
		if (cmd === "git") return out(0, "", "");
		return result;
	});
}

beforeEach(() => {
	spawn.mockReset();
});

describe("runRedCheck — AC-01 type contract", () => {
	it("exports a RedCheckOptions interface accepting { timeoutMs, signal }", () => {
		// Compile-time contract: the interface must exist and accept the
		// {timeoutMs?, signal?} shape shared with GateOptions. If the export is
		// missing this file fails to typecheck (RED).
		const opts: RedCheckOptions = { timeoutMs: 1, signal: undefined };
		expect(opts).toBeDefined();
	});

	it("returns one of the four declared RedStatus values", () => {
		// Create a cargo project so a runner exists; mock exit 0 (green).
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), "");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/green.rs"), "");
		});
		try {
			mockRunner(out(0, "test result: ok."));
			const status: RedStatus = runRedCheck(d, ["tests/green.rs"]);
			expect(["red", "green", "broken", "unknown"]).toContain(status);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — no-spawn short-circuit → unknown (AC-01)", () => {
	it("returns unknown for a greenfield dir (no manifest) without spawning", () => {
		const d = tmpProj(() => {});
		try {
			const status = runRedCheck(d, ["src/anything.test.ts"]);
			expect(status).toBe("unknown");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("returns unknown for an npm project WITHOUT a test script without spawning", () => {
		const d = tmpProj((dir) =>
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
			),
		);
		try {
			const status = runRedCheck(d, ["src/anything.test.ts"]);
			expect(status).toBe("unknown");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("returns unknown for empty testTargets without spawning (runner exists)", () => {
		const d = tmpProj((dir) =>
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } })),
		);
		try {
			const status = runRedCheck(d, []);
			expect(status).toBe("unknown");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — never-throw invariant (AC-01, NEVER-THROW)", () => {
	it("returns unknown (never throws) when spawnSync throws synchronously", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), "");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/x.rs"), "");
		});
		try {
			spawn.mockImplementation(() => {
				throw new Error("spawn blew up");
			});
			// Must NOT throw — entire body is try/caught.
			expect(() => runRedCheck(d, ["tests/x.rs"])).not.toThrow();
			expect(runRedCheck(d, ["tests/x.rs"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("returns unknown (never throws) when spawnSync returns r.error (ENOENT)", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), "");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/x.rs"), "");
		});
		try {
			mockRunner(out(127, "", "some stderr", new Error("spawn ENOENT")));
			expect(runRedCheck(d, ["tests/x.rs"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — cargo classification", () => {
	function cargoProj(): string {
		return tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), "");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/red_fail.rs"), "");
			writeFileSync(join(dir, "tests/green.rs"), "");
			writeFileSync(join(dir, "tests/compile_broke.rs"), "");
			writeFileSync(join(dir, "tests/ambiguous.rs"), "");
			writeFileSync(join(dir, "tests/notests.rs"), "");
		});
	}

	it("classifies exit 0 as green", () => {
		const d = cargoProj();
		try {
			mockRunner(out(0, "running 1 test\ntest result: ok. 1 passed; 0 failed"));
			expect(runRedCheck(d, ["tests/green.rs"])).toBe("green");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies `test result: FAILED.` + exit≠0 as red", () => {
		const d = cargoProj();
		try {
			mockRunner(out(101, "running 1 test\ntest red_fail ... FAILED\ntest result: FAILED. 0 passed; 1 failed"));
			expect(runRedCheck(d, ["tests/red_fail.rs"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies a panic with exit≠0 as red", () => {
		const d = cargoProj();
		try {
			mockRunner(out(101, "thread 'red_fail' panicked at src/lib.rs:3:5"));
			expect(runRedCheck(d, ["tests/red_fail.rs"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies `error[E...]` compile error + exit≠0 as broken (precedence over red)", () => {
		const d = cargoProj();
		try {
			// Both a compile error AND a FAILED marker: compile failed FIRST so
			// status is broken, not red.
			mockRunner(out(101, "error[E0308]: mismatched types\n --> src/lib.rs:1:1\ntest result: FAILED."));
			expect(runRedCheck(d, ["tests/compile_broke.rs"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies `could not compile` + exit≠0 as broken", () => {
		const d = cargoProj();
		try {
			mockRunner(out(101, "error: could not compile `mycrate` due to previous error"));
			expect(runRedCheck(d, ["tests/compile_broke.rs"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies `no tests to run` (no test execution) as broken", () => {
		const d = cargoProj();
		try {
			// `no tests to run` with no executed tests — the RED phase produced no
			// executable test, so it cannot have been RED. Spec: broken.
			mockRunner(out(0, "running 0 tests\nnote: no tests to run were matched"));
			expect(runRedCheck(d, ["tests/notests.rs"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies ambiguous nonzero output (no recognized marker) as unknown", () => {
		const d = cargoProj();
		try {
			mockRunner(out(1, "totally unstructured cargo noise with no marker"));
			expect(runRedCheck(d, ["tests/ambiguous.rs"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — npm / vitest / jest classification", () => {
	function vitestProj(): string {
		return tmpProj((dir) =>
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({
					name: "x",
					scripts: { test: "vitest run" },
					devDependencies: { vitest: "1", react: "19" },
				}),
			),
		);
	}

	it("classifies exit 0 as green", () => {
		const d = vitestProj();
		try {
			mockRunner(out(0, "Test Files  1 passed (1)\nTests  2 passed (2)"));
			expect(runRedCheck(d, ["src/green.test.ts"])).toBe("green");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies vitest `❯ <path>` failing marker + exit≠0 as red", () => {
		const d = vitestProj();
		try {
			mockRunner(out(1, "FAIL  src/fail.test.ts [ src/fail.test.ts ]\n ❯ src/fail.test.ts:4:5\nTests  1 failed (1)"));
			expect(runRedCheck(d, ["src/fail.test.ts"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies jest `FAIL <path>` + `Tests: N failed` + exit≠0 as red", () => {
		const d = tmpProj((dir) =>
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({
					name: "x",
					scripts: { test: "jest" },
					devDependencies: { jest: "29" },
				}),
			),
		);
		try {
			mockRunner(out(1, "FAIL src/fail.test.js\nTests: 2 failed, 3 passed"));
			expect(runRedCheck(d, ["src/fail.test.js"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies a `Tests: N failed` summary + exit≠0 as red", () => {
		const d = vitestProj();
		try {
			mockRunner(out(1, "Tests  3 failed | 1 passed (4)"));
			expect(runRedCheck(d, ["src/fail.test.ts"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies a SyntaxError collection failure as broken", () => {
		const d = vitestProj();
		try {
			mockRunner(out(1, "SyntaxError: Unexpected token '}' at src/fail.test.ts:5"));
			expect(runRedCheck(d, ["src/fail.test.ts"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("emits per-command RED diagnostics with cwd, argv, status, exit, and output tail", () => {
		const d = vitestProj();
		try {
			mockRunner(out(1, "SyntaxError: Unexpected token '}' at src/fail.test.ts:5\nstack tail marker"));
			const diagnostics: Array<{ plan: { cwd: string; argv: string[] }; status: string; exitCode: number | null; signal: string | null; outputTail: string }> = [];
			expect(runRedCheck(d, ["src/fail.test.ts"], { onResult: (diagnostic) => diagnostics.push(diagnostic) })).toBe("broken");
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]!.plan.cwd).toBe(d);
			expect(diagnostics[0]!.plan.argv.length).toBeGreaterThan(0);
			expect(diagnostics[0]!.status).toBe("broken");
			expect(diagnostics[0]!.exitCode).toBe(1);
			expect(diagnostics[0]!.signal).toBeNull();
			expect(diagnostics[0]!.outputTail).toContain("SyntaxError");
			expect(diagnostics[0]!.outputTail).toContain("stack tail marker");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies a `failed to load` collection failure as broken", () => {
		const d = vitestProj();
		try {
			mockRunner(out(1, "failed to load config from /x/vitest.config.ts"));
			expect(runRedCheck(d, ["src/fail.test.ts"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("GREENFIELD RED: a test importing a not-yet-created relative module is red (AC alignment with buildTddPrompt)", () => {
		// The textbook greenfield RED: the module under test does not exist yet, so
		// vitest fails to LOAD it at collection time. buildTddPrompt states this is a
		// valid RED; the oracle must agree. (Real vitest 3.2.6 wording, reproduced.)
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }));
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "persistence.test.ts"), "// imports ./persistence");
			// NOTE: src/persistence.ts deliberately NOT created.
		});
		try {
			mockRunner(out(1, "FAIL  src/persistence.test.ts [ src/persistence.test.ts ]\nError: Cannot find module './persistence' imported from '/d/src/persistence.test.ts'\n ❯ src/persistence.test.ts:2:1\nCaused by: Error: Failed to load url ./persistence (resolved id: ./persistence) in /d/src/persistence.test.ts. Does the file exist?\nTest Files  1 failed (1)\n      Tests  no tests"));
			expect(runRedCheck(d, ["src/persistence.test.ts"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("GREENFIELD guard: the same load-failure output with the module file PRESENT stays broken (no false greenfield)", () => {
		// If the imported relative module DOES exist on disk, the load failure is a
		// genuine collection/load error, not a greenfield missing module → broken.
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }));
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "persistence.test.ts"), "// imports ./persistence");
			writeFileSync(join(dir, "src", "persistence.ts"), "export const readEntry = () => 0;"); // module EXISTS
		});
		try {
			mockRunner(out(1, "FAIL  src/persistence.test.ts [ src/persistence.test.ts ]\nError: Cannot find module './persistence' imported from '/d/src/persistence.test.ts'\nCaused by: Error: Failed to load url ./persistence (resolved id: ./persistence) in /d/src/persistence.test.ts. Does the file exist?"));
			expect(runRedCheck(d, ["src/persistence.test.ts"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies `No test files found` (no run) as broken", () => {
		const d = vitestProj();
		try {
			mockRunner(out(1, "No test files found, exiting with code 1"));
			expect(runRedCheck(d, ["src/missing.test.ts"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies ambiguous nonzero npm output (no recognized marker) as unknown", () => {
		const d = vitestProj();
		try {
			mockRunner(out(1, "random unrelated npm chatter"));
			expect(runRedCheck(d, ["src/x.test.ts"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("RC-1: a package with NO test script under a RECURSIVE root script never gets the monorepo-wide `-r … -- <file>` plan", () => {
		// The 15h livelock: auth-service had no `test` script, so the resolver fell
		// back to root `pnpm -r run test -- <file>` — which forwards the file to every
		// workspace, runs their whole suite, and reads green (red-not-confirmed
		// forever). With no scoped runner detectable, the resolver must emit NO
		// recursive-fanout plan.
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "pnpm -r run test" } }));
			writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
			mkdirSync(join(dir, "auth-service", "src"), { recursive: true });
			writeFileSync(join(dir, "auth-service", "package.json"), JSON.stringify({ name: "auth-service" }));
			writeFileSync(join(dir, "auth-service", "src", "session.test.ts"), "it('x', () => { expect(1).toBe(2); })\n");
		});
		try {
			const plans: Array<{ cwd: string; argv: string[] }> = [];
			mockRunner(out(0, "whatever"));
			runRedCheck(d, ["auth-service/src/session.test.ts"], { onPlan: (pp) => plans.push(...pp) });
			for (const pl of plans) {
				const joined = pl.argv.join(" ");
				expect(joined).not.toMatch(/-r\b/);
				expect(joined).not.toMatch(/run test -- /);
			}
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("RC-1: a package WITH vitest runs a direct scoped `vitest run <file>`, not the recursive root script", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "pnpm -r run test" } }));
			mkdirSync(join(dir, "auth-service", "src"), { recursive: true });
			writeFileSync(join(dir, "auth-service", "package.json"), JSON.stringify({ name: "auth-service", scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }));
			writeFileSync(join(dir, "auth-service", "src", "session.test.ts"), "it('x', () => { expect(1).toBe(2); })\n");
		});
		try {
			const plans: Array<{ cwd: string; argv: string[] }> = [];
			mockRunner(out(1, "❯ src/session.test.ts:1:1\nTests  1 failed (1)"));
			expect(runRedCheck(d, ["auth-service/src/session.test.ts"], { onPlan: (pp) => plans.push(...pp) })).toBe("red");
			expect(plans.some((pl) => pl.cwd === join(d, "auth-service") && pl.argv.join(" ").includes("vitest run src/session.test.ts"))).toBe(true);
			expect(plans.every((pl) => !/-r\b/.test(pl.argv.join(" ")))).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});


	it("runs a node:test target from the owning package directory before classifying RED", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "pnpm -r run test" } }));
			writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
			const pkgDir = join(dir, "auth-service");
			mkdirSync(join(pkgDir, "src", "api", "v1", "auth"), { recursive: true });
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "auth-service", devDependencies: { tsx: "4" } }));
			writeFileSync(
				join(pkgDir, "src", "api", "v1", "auth", "auth.authority-boundary-red.test.ts"),
				"import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red', () => assert.equal(1, 2));\n",
			);
		});
		try {
			const plans: Array<{ cwd: string; argv: string[] }> = [];
			spawn.mockImplementation((cmd: string, args: string[], opts: { cwd?: string }) => {
				expect(plans).toEqual([{ cwd: join(d, "auth-service"), argv: ["node", "--import", "tsx", "--test", "src/api/v1/auth/auth.authority-boundary-red.test.ts"] }]);
				expect(cmd).toBe("node");
				expect(args).toEqual(["--import", "tsx", "--test", "src/api/v1/auth/auth.authority-boundary-red.test.ts"]);
				expect(opts.cwd).toBe(join(d, "auth-service"));
				return out(1, "✖ red\n# failing tests:\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal");
			});

			expect(runRedCheck(d, ["auth-service/src/api/v1/auth/auth.authority-boundary-red.test.ts"], { onPlan: (p) => plans.push(...p) })).toBe("red");
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(plans).toEqual([{ cwd: join(d, "auth-service"), argv: ["node", "--import", "tsx", "--test", "src/api/v1/auth/auth.authority-boundary-red.test.ts"] }]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — pytest classification", () => {
	function pytestProj(): string {
		return tmpProj((dir) =>
			writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n"),
		);
	}

	it("classifies exit 0 as green", () => {
		const d = pytestProj();
		try {
			mockRunner(out(0, "===== 2 passed in 0.01s ====="));
			expect(runRedCheck(d, ["tests/test_green.py"])).toBe("green");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies a `failed` summary + exit≠0 as red", () => {
		const d = pytestProj();
		try {
			mockRunner(out(1, "===== 1 failed, 1 passed in 0.02s ====="));
			expect(runRedCheck(d, ["tests/test_fail.py"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies an `error` summary + exit≠0 as red", () => {
		const d = pytestProj();
		try {
			mockRunner(out(1, "===== 1 error in 0.02s ====="));
			expect(runRedCheck(d, ["tests/test_err.py"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("classifies `ERROR collecting` as broken", () => {
		const d = pytestProj();
		try {
			mockRunner(out(2, "ERROR collecting tests/test_broke.py"));
			expect(runRedCheck(d, ["tests/test_broke.py"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — nested module owner derivation", () => {
	it("runs a Go *_test.go target from its owning go.mod directory", () => {
		const d = tmpProj((dir) => {
			const mod = join(dir, "backend-service");
			mkdirSync(join(mod, "internal", "handlers", "performance"), { recursive: true });
			writeFileSync(join(mod, "go.mod"), "module example.com/backend-service\n\ngo 1.22\n");
			writeFileSync(join(mod, "internal", "handlers", "performance", "jmx_resource_manifest_test.go"), "package performance\n");
		});
		try {
			const moduleDir = join(d, "backend-service");
			const plans: Array<{ cwd: string; argv: string[] }> = [];
			spawn.mockImplementation((cmd: string, args: string[], opts: { cwd?: string }) => {
				expect(plans).toEqual([{ cwd: moduleDir, argv: ["go", "test", "./internal/handlers/performance"] }]);
				expect(cmd).toBe("go");
				expect(args).toEqual(["test", "./internal/handlers/performance"]);
				expect(opts.cwd).toBe(moduleDir);
				return out(1, "--- FAIL: TestJMXManifestRed (0.00s)\nFAIL\n");
			});

			expect(runRedCheck(d, ["backend-service/internal/handlers/performance/jmx_resource_manifest_test.go"], { onPlan: (p) => plans.push(...p) })).toBe("red");
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(plans).toEqual([{ cwd: moduleDir, argv: ["go", "test", "./internal/handlers/performance"] }]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — reuses shared timeout envelope (AC-01)", () => {
	it("honors opts.timeoutMs by passing it as the spawnSync timeout (resolveTimeoutMs reuse)", () => {
		const d = tmpProj((dir) =>
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } })),
		);
		try {
			mockRunner(out(0, "Tests  1 passed (1)"));
			runRedCheck(d, ["src/green.test.ts"], { timeoutMs: 4242 });
			expect(spawn).toHaveBeenCalled();
			// Every spawn invocation must carry the resolved timeout in its
			// options (the runBuildGate-style envelope via resolveTimeoutMs).
			for (const call of spawn.mock.calls) {
				const opts = call[2] as { timeout?: number } | undefined;
				expect(opts?.timeout).toBe(4242);
			}
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — cross-language GREENFIELD RED parity (Fix 6)", () => {
	// All fixtures below are byte-level captures from empirical probes against
	// the REAL toolchains available in this environment: pytest 8.3.5,
	// go 1.26.3, cargo 1.95.0 (same methodology as the vitest 3.2.6 probe).

	function pyProj(setup: (dir: string) => void): string {
		return tmpProj((dir) => {
			writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "p"\nversion = "0.1.0"\n');
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests", "test_thing.py"), "from mypkg.persistence import save\n\ndef test_save():\n    assert save(1) == 2\n");
			setup(dir);
		});
	}

	const PY_GREENFIELD_OUT = `
==================================== ERRORS ====================================
_____________________ ERROR collecting tests/test_thing.py _____________________
ImportError while importing test module '/tmp/x/tests/test_thing.py'.
Hint: make sure your test modules/packages have valid Python names.
Traceback:
tests/test_thing.py:1: in <module>
    from mypkg.persistence import save
E   ModuleNotFoundError: No module named 'mypkg'
=========================== short test summary info ============================
ERROR tests/test_thing.py
!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
1 error in 0.09s`;

	it("python: collection ModuleNotFoundError for an ABSENT module → greenfield RED", () => {
		const d = pyProj(() => {}); // no mypkg anywhere
		try {
			mockRunner(out(2, PY_GREENFIELD_OUT, ""));
			expect(runRedCheck(d, ["tests/test_thing.py"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("python: missing SUBMODULE under an existing package → greenfield RED", () => {
		const d = pyProj((dir) => {
			mkdirSync(join(dir, "mypkg"));
			writeFileSync(join(dir, "mypkg", "__init__.py"), "");
			// mypkg/persistence.py deliberately absent
		});
		try {
			mockRunner(out(2, PY_GREENFIELD_OUT.replace("No module named 'mypkg'", "No module named 'mypkg.persistence'"), ""));
			expect(runRedCheck(d, ["tests/test_thing.py"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("python: module EXISTS on disk but import fails (RuntimeError) → broken, NOT greenfield", () => {
		const d = pyProj((dir) => {
			mkdirSync(join(dir, "mypkg"));
			writeFileSync(join(dir, "mypkg", "__init__.py"), "");
		});
		try {
			// mypkg exists → even a ModuleNotFoundError naming it must NOT be greenfield
			mockRunner(out(2, PY_GREENFIELD_OUT, ""));
			expect(runRedCheck(d, ["tests/test_thing.py"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("python: collection error WITHOUT ModuleNotFoundError (RuntimeError at import) → broken", () => {
		const d = pyProj(() => {});
		try {
			const runtimeOut = PY_GREENFIELD_OUT.replace(
				"E   ModuleNotFoundError: No module named 'mypkg'",
				"mypkg/persistence.py:1: in <module>\nE   RuntimeError: boom at import",
			);
			mockRunner(out(2, runtimeOut, ""));
			expect(runRedCheck(d, ["tests/test_thing.py"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	function goProj(setup: (dir: string) => void): string {
		return tmpProj((dir) => {
			writeFileSync(join(dir, "go.mod"), "module example.com/p\n\ngo 1.26\n");
			mkdirSync(join(dir, "api"), { recursive: true });
			writeFileSync(join(dir, "api", "handler_test.go"), "package api\n\nimport \"testing\"\n\nfunc TestFoo(t *testing.T) {\n\tif Foo() != 2 {\n\t\tt.Fatal(\"expected 2\")\n\t}\n}\n");
			setup(dir);
		});
	}

	const GO_UNDEFINED_OUT = "# example.com/p/api [example.com/p/api.test]\napi/handler_test.go:6:5: undefined: Foo\nFAIL\texample.com/p/api [build failed]\nFAIL";

	it("go: undefined ident in a test-ONLY package dir → greenfield RED", () => {
		const d = goProj(() => {}); // api/ has only handler_test.go
		try {
			mockRunner(out(1, GO_UNDEFINED_OUT, ""));
			expect(runRedCheck(d, ["api/handler_test.go"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("go: undefined ident but PRODUCTION .go present in the dir → broken, NOT greenfield", () => {
		const d = goProj((dir) => {
			writeFileSync(join(dir, "api", "handler.go"), "package api\n\nfunc Foo() int { return 0 }\n");
		});
		try {
			mockRunner(out(1, GO_UNDEFINED_OUT, ""));
			expect(runRedCheck(d, ["api/handler_test.go"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("go: same-module package directory ABSENT → greenfield RED", () => {
		const d = goProj(() => {}); // example.com/p/missing dir does not exist
		try {
			const missingPkgOut = "# example.com/p/api\napi/handler_test.go:6:2: no required module provides package example.com/p/missing; to add it:\n\tgo get example.com/p/missing\nFAIL\texample.com/p/api [setup failed]\nFAIL";
			mockRunner(out(1, missingPkgOut, ""));
			expect(runRedCheck(d, ["api/handler_test.go"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("go: EXTERNAL module missing (different module path) → broken", () => {
		const d = goProj(() => {});
		try {
			const externalOut = "# example.com/p/api\napi/handler_test.go:6:2: no required module provides package github.com/external/dep; to add it:\n\tgo get github.com/external/dep\nFAIL\texample.com/p/api [setup failed]\nFAIL";
			mockRunner(out(1, externalOut, ""));
			expect(runRedCheck(d, ["api/handler_test.go"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	function rsProj(setup: (dir: string) => void): string {
		return tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "p"\nversion = "0.1.0"\nedition = "2021"\n');
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests", "it.rs"), "use p::thing::save;\n\n#[test]\nfn save_doubles() {\n    assert_eq!(save(1), 2);\n}\n");
			setup(dir);
		});
	}

	it("rust: greenfield crate (no src/lib.rs) E0433 naming THIS crate → greenfield RED", () => {
		const d = rsProj(() => {}); // no src/ at all
		try {
			const out_text = "error[E0433]: cannot find module or crate `p` in this scope\n --> tests/it.rs:1:5\n  |\n1 | use p::thing::save;\n  |     ^ use of unresolved module or unlinked crate `p`\n  |\n  = help: if you wanted to use a crate named `p`, use `cargo add p` to add it to your Cargo.toml\n\nFor more information about this error, see `rustc --explain E0433`.\nerror: could not compile `p` (test \"it\") due to 1 previous error";
			mockRunner(out(101, out_text, ""));
			expect(runRedCheck(d, ["tests/it.rs"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("rust: E0432 unresolved import of THIS crate's undeclared module → greenfield RED", () => {
		const d = rsProj((dir) => {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "lib.rs"), "pub fn placeholder() {}\n"); // lib exists, mod thing undeclared
		});
		try {
			const out_text = "error[E0432]: unresolved import `p::thing`\n --> tests/it.rs:1:8\n  |\n1 | use p::thing::save;\n  |        ^^^^^ could not find `thing` in `p`\n\nFor more information about this error, see `rustc --explain E0432`.\nerror: could not compile `p` (test \"it\") due to 1 previous error";
			mockRunner(out(101, out_text, ""));
			expect(runRedCheck(d, ["tests/it.rs"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("rust: E0432 naming an EXTERNAL crate (serde_json) → broken, NOT greenfield", () => {
		const d = rsProj((dir) => {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "lib.rs"), "pub fn placeholder() {}\n");
		});
		try {
			const out_text = "error[E0432]: unresolved import `serde_json`\n --> tests/it.rs:1:5\n  |\n1 | use serde_json::Value;\n  |     ^^^^^^^^^^ use of unresolved module or unlinked crate `serde_json`\n\nerror[E0433]: cannot find module or crate `serde_json` in this scope\n --> tests/it.rs:5:21\n\nFor more information about this error, see `rustc --explain E0432`.\nerror: could not compile `p` (test \"it\") due to 2 previous errors";
			mockRunner(out(101, out_text, ""));
			expect(runRedCheck(d, ["tests/it.rs"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("rust: E0583 file-not-found for a declared module → greenfield RED", () => {
		const d = rsProj((dir) => {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "lib.rs"), "pub mod thing;\n"); // declared, file absent
		});
		try {
			const out_text = "error[E0583]: file not found for module `thing`\n --> src/lib.rs:1:1\n  |\n1 | pub mod thing;\n  | ^^^^^^^^^^^^^^\n  |\n  = help: to create the module `thing`, create file \"src/thing.rs\" or \"src/thing/mod.rs\"\n\nFor more information about this error, see `rustc --explain E0583`.\nerror: could not compile `p` (lib) due to 1 previous error";
			mockRunner(out(101, out_text, ""));
			expect(runRedCheck(d, ["tests/it.rs"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("rust: ordinary compile error in EXISTING code (E0308) → broken (greenfield check must not over-match)", () => {
		const d = rsProj((dir) => {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "lib.rs"), "pub fn placeholder() {}\n");
		});
		try {
			const out_text = "error[E0308]: mismatched types\n --> src/thing.rs:2:12\n\nFor more information about this error, see `rustc --explain E0308`.\nerror: could not compile `p` (lib) due to 1 previous error";
			mockRunner(out(101, out_text, ""));
			expect(runRedCheck(d, ["tests/it.rs"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

// ─── Failure-statement-only greenfield extraction (run 2026-08-15T13-45-02-387Z postmortem) ──
// Production evidence: RED try 1 of phase 1 imported the EXISTING
// ../src/schemas.ts (spec 01) AND the missing ../src/persistence.ts; vitest's
// printed source frame textually contains BOTH, and the old whole-output scan
// required EVERY mentioned specifier to be absent — the existing sibling vetoed
// the greenfield classification (broken), costing an 11-minute re-author. The
// detector must key ONLY on the runner's failure statements.
describe("runRedCheck — failure-statement greenfield extraction (sibling-import veto fix)", () => {
	// EXACT production tail from the run log (paths trimmed to /wt/…).
	const PROD_TAIL =
		" FAIL tests/persistence.test.ts [ tests/persistence.test.ts ] " +
		"Error: Cannot find module '../src/persistence.ts' imported from '/wt/.worktree/02-data-persistence/tests/persistence.test.ts' " +
		"❯ tests/persistence.test.ts:77:1 75| import * as S from \"../src/schemas.ts\"; 76| import type { DimensionResult, Evidence } from \"../src/schemas.ts\"; " +
		"77| import * as P from \"../src/persistence.ts\"; | ^ 78| 79| const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), \"..\")… " +
		"Caused by: Error: Failed to load url ../src/persistence.ts (resolved id: ../src/persistence.ts) in /wt/.worktree/02-data-persistence/tests/persistence.test.ts. Does the file exist?";

	it("PRODUCTION BYTES: an existing sibling import in the source frame no longer vetoes greenfield RED", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "schemas.ts"), "export {};"); // spec-01 sibling EXISTS
			// src/persistence.ts deliberately absent — the module under test.
			writeFileSync(join(dir, "tests", "persistence.test.ts"), "// imports ../src/schemas.ts and ../src/persistence.ts");
		});
		try {
			mockRunner(out(1, PROD_TAIL));
			expect(runRedCheck(d, ["tests/persistence.test.ts"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("if the FAILURE STATEMENT names an EXISTING module, it stays broken (conservative guard intact)", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "schemas.ts"), "export {};");
			writeFileSync(join(dir, "tests", "t.test.ts"), "// t");
		});
		try {
			// The runner says the EXISTING module failed to load — a real load
			// failure (corrupt module, bad export), not greenfield.
			mockRunner(out(1, "Error: Cannot find module '../src/schemas.ts' imported from '/d/tests/t.test.ts'"));
			expect(runRedCheck(d, ["tests/t.test.ts"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("jest format: Cannot find module '<spec>' from '<importer>' is greenfield when the module is absent", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" } }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests", "t.test.js"), "// t");
		});
		try {
			mockRunner(out(1, "FAIL tests/t.test.js\n  ● Test suite failed to run\n\n    Cannot find module '../src/persistence' from 'tests/t.test.js'\n\n      1 | import P from \"../src/persistence\""));
			expect(runRedCheck(d, ["tests/t.test.js"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("node ESM absolute-path form: absent resolved path is greenfield", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests", "t.test.mjs"), "// t");
		});
		try {
			const abs = join(d, "src", "persistence.ts");
			mockRunner(out(1, `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${abs}' imported from ${join(d, "tests", "t.test.mjs")}`));
			expect(runRedCheck(d, ["tests/t.test.mjs"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("a BARE specifier failure (dependency miss) stays broken, not greenfield", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest run" } }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests", "t.test.ts"), "// t");
		});
		try {
			mockRunner(out(1, "Error: Cannot find module 'left-pad-deluxe' imported from '/d/tests/t.test.ts'"));
			expect(runRedCheck(d, ["tests/t.test.ts"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
