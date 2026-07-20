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
 *     stems resolve), npm/vitest/jest (`vitest run <targets>` or
 *     `<pm> test -- <targets>`), pytest (`pytest <targets>`).
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
 *   - No test runner (greenfield/no-manifest, or npm without a test script) OR
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

	it("classifies a `failed to load` collection failure as broken", () => {
		const d = vitestProj();
		try {
			mockRunner(out(1, "failed to load config from /x/vitest.config.ts"));
			expect(runRedCheck(d, ["src/fail.test.ts"])).toBe("broken");
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
