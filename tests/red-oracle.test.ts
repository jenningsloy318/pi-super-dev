/**
 * v0.3.31 — the universal RED oracle contract (REWRITE of the v0.3.20-era
 * per-language pins).
 *
 * What changed and why (deep research 2026-08-29 — Bazel test encyclopedia,
 * SWE-Factory, gotestsum, nextest/pytest/vitest docs):
 *   - The ENGINE is language-blind. Scoped invocation comes from CONVENTIONS
 *     DATA (src/build-runner/conventions.ts); classification comes ONLY from
 *     structured evidence + exit code.
 *   - Console prose NEVER classifies (Bazel: "writing any of the strings PASS
 *     or FAIL to stdout has no significance"). Old fixtures that pinned
 *     rust/npm/pytest/go regex classification now pin `unknown`.
 *   - RED/GREEN are confirmed from the runner's own structured channel:
 *     vitest/jest count lines (declared pattern), node:test TAP, go-test
 *     json events, cargo libtest summaries, pytest junit (tmp redirect).
 *
 * Hermeticity: spawnSync is mocked for the whole file; classification is
 * asserted on runner output alone.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
		if (cmd === "git") return out(0, "", "");
		return result;
	});
}

/** Capture argv of the LAST non-git spawn (for scoped-invocation pins). */
function lastRunnerArgv(): string[] | null {
	const calls = spawn.mock.calls as unknown as Array<[string, string[]]>;
	for (let i = calls.length - 1; i >= 0; i--) {
		if (calls[i][0] !== "git") return [calls[i][0], ...calls[i][1]];
	}
	return null;
}

beforeEach(() => {
	spawn.mockReset();
});

describe("runRedCheck — AC-01 type contract", () => {
	it("exports a RedCheckOptions interface accepting { timeoutMs, signal }", () => {
		const opts: RedCheckOptions = { timeoutMs: 1, signal: undefined };
		expect(opts).toBeDefined();
	});

	it("returns one of the four declared RedStatus values", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), "");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/green.rs"), "");
		});
		try {
			mockRunner(out(0, "test result: ok. 3 passed; 0 failed; 0 ignored"));
			const status: RedStatus = runRedCheck(d, ["tests/green.rs"]);
			expect(["red", "green", "broken", "unknown"]).toContain(status);
			expect(status).toBe("green");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — no-spawn short-circuit → unknown (AC-01)", () => {
	it("returns unknown for a greenfield dir (no manifest) without spawning", () => {
		const d = tmpProj(() => {});
		try {
			expect(runRedCheck(d, ["src/anything.test.ts"])).toBe("unknown");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("returns unknown for an npm project WITHOUT any test script/tool without spawning", () => {
		const d = tmpProj((dir) =>
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { build: "tsc" } })),
		);
		try {
			expect(runRedCheck(d, ["src/anything.test.ts"])).toBe("unknown");
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
			expect(runRedCheck(d, [])).toBe("unknown");
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
			expect(() => runRedCheck(d, ["tests/x.rs"])).not.toThrow();
			expect(runRedCheck(d, ["tests/x.rs"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("returns unknown when spawnSync reports an error object (ENOENT)", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), "");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/y.rs"), "");
		});
		try {
			mockRunner(out(null, "", "", new Error("spawn ENOENT")));
			expect(runRedCheck(d, ["tests/y.rs"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — scoped invocation from CONVENTIONS DATA", () => {
	it("cargo: integration stem → `cargo test --test <stem> --quiet`", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), "");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/stem_a.rs"), "");
		});
		try {
			mockRunner(out(1, "test result: FAILED. 0 passed; 2 failed; 0 ignored"));
			expect(runRedCheck(d, ["tests/stem_a.rs"])).toBe("red");
			const call = lastRunnerArgv();
			expect(call?.[0]).toBe("cargo");
			expect(call?.[1]).toBe("test");
			expect(call).toContain("--test");
			expect(call).toContain("stem_a");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("go: file target → `go test -json ./pkg` (package dir, json channel)", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "go.mod"), "module x\n");
			mkdirSync(join(dir, "pkg"), { recursive: true });
			writeFileSync(join(dir, "pkg/a_test.go"), "");
		});
		try {
			mockRunner(out(1, '{"Action":"fail","Package":"x/pkg","Test":"TestA"}\n{"Action":"fail","Package":"x/pkg","Test":""}'));
			expect(runRedCheck(d, ["pkg/a_test.go"])).toBe("red");
			const call = lastRunnerArgv();
			expect(call?.slice(0, 3)).toEqual(["go", "test", "-json"]);
			expect(call?.at(-1)).toBe("./pkg");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("pytest: positional targets + tmp junit redirect outside the worktree", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/test_x.py"), "");
		});
		try {
			// realistic mock: write the junit XML the command promises
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "git") return out(0, "", "");
				const junitArg = args.find((a) => a.startsWith("--junitxml="));
				if (junitArg) {
					writeFileSync(junitArg.slice("--junitxml=".length),
						`<?xml version='1.0'?><testsuite name="t" tests="3" failures="3" errors="0" skipped="0"></testsuite>`);
				}
				return out(1, "3 failed");
			});
			expect(runRedCheck(d, ["tests/test_x.py"])).toBe("red");
			const call = lastRunnerArgv();
			expect(call?.[0]).toBe("pytest");
			expect(call?.at(-1)).toBe("tests/test_x.py");
			const junitArg = call?.find((a: string) => a.startsWith("--junitxml="));
			expect(junitArg?.slice("--junitxml=".length).startsWith(tmpdir())).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("npm vitest: owning package cwd + `pm exec vitest run --reporter=tap <rel>` + tap channel", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/a.test.ts"), "");
		});
		try {
			mockRunner(out(1, "1..2\nnot ok 1 - tests/a.test.ts\nok 2 - other\n"));
			expect(runRedCheck(d, ["tests/a.test.ts"])).toBe("red");
			const call = lastRunnerArgv();
			expect(call?.slice(0, 3)).toEqual(["npm", "exec", "vitest"]);
			expect(call?.[3]).toBe("--"); // v0.3.56 F1: child flags guarded from npm config
			expect(call).toContain("--reporter=tap");
			expect(call?.at(-1)).toBe("tests/a.test.ts");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("node:test file: `node --test --test-reporter=tap <rel>` + tap channel", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/a.test.mjs"), "import { test } from 'node:test';\n");
		});
		try {
			mockRunner(out(1, "not ok 1 - behaves\nok 2 - other\n"));
			expect(runRedCheck(d, ["tests/a.test.mjs"])).toBe("red");
			const call = lastRunnerArgv();
			expect(call?.[0]).toBe("node");
			expect(call).toContain("--test");
			expect(call).toContain("--test-reporter=tap");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — structured classification per channel (v0.3.31 truth table)", () => {
	function cargoProj() {
		return tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), "");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/x.rs"), "");
		});
	}

	it("rust: libtest summary counts → red / green", () => {
		const d = cargoProj();
		try {
			mockRunner(out(1, "test result: FAILED. 5 passed; 12 failed; 0 ignored"));
			expect(runRedCheck(d, ["tests/x.rs"])).toBe("red");
			mockRunner(out(0, "test result: ok. 17 passed; 0 failed; 0 ignored"));
			expect(runRedCheck(d, ["tests/x.rs"])).toBe("green");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("rust: COMPILE FAILURE prose (greenfield or syntax) → unknown — no structured evidence, judge routes own the escape", () => {
		const d = cargoProj();
		try {
			mockRunner(out(101, "error[E0432]: unresolved import `crate::missing`\nerror: could not compile `x`"));
			expect(runRedCheck(d, ["tests/x.rs"])).toBe("unknown");
			mockRunner(out(1, "error: expected `,` or `;`\nerror: could not compile `x`"));
			expect(runRedCheck(d, ["tests/x.rs"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("vitest: TAP channel → red (incl. all-fail + greenfield load-failure) / green / filter-miss unknown", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/a.test.ts"), "");
		});
		try {
			// review-2 F1: the ALL-FAILING summary shape (`Tests  2 failed (2)` —
			// no " | " separator) motivated the TAP channel; per-test `not ok`
			// lines cover every shape.
			mockRunner(out(1, "1..2\nnot ok 1 - a\nnot ok 2 - b\n"));
			expect(runRedCheck(d, ["tests/a.test.ts"])).toBe("red");
			// greenfield suite load failure emits a per-FILE `not ok` (verified
			// live against vitest 3.2.6 --reporter=tap) — structured RED.
			mockRunner(out(1, "1..1\nnot ok 1 - tests/a.test.ts\n"));
			expect(runRedCheck(d, ["tests/a.test.ts"])).toBe("red");
			mockRunner(out(0, "1..10\nok 1 - a\nok 2 - b\n"));
			expect(runRedCheck(d, ["tests/a.test.ts"])).toBe("green");
			// filter miss: exit 1, no tap lines → unknown (never a false green)
			mockRunner(out(1, "No test files found, exiting with code 1"));
			expect(runRedCheck(d, ["tests/a.test.ts"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("npm: SyntaxError / load-failure prose → unknown (prose never classifies)", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/a.test.ts"), "");
		});
		try {
			mockRunner(out(1, "SyntaxError: Unexpected token"));
			expect(runRedCheck(d, ["tests/a.test.ts"])).toBe("unknown");
			mockRunner(out(1, "Error: Cannot find module './missing'\nfailed to load config"));
			expect(runRedCheck(d, ["tests/a.test.ts"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("go: json events → red / green / package-fail-no-tests broken", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "go.mod"), "module x\n");
			mkdirSync(join(dir, "pkg"), { recursive: true });
			writeFileSync(join(dir, "pkg/a_test.go"), "");
		});
		try {
			mockRunner(out(1, '{"Action":"fail","Package":"x/pkg","Test":"TestA"}\n{"Action":"fail","Package":"x/pkg","Test":""}'));
			expect(runRedCheck(d, ["pkg/a_test.go"])).toBe("red");
			mockRunner(out(0, '{"Action":"pass","Package":"x/pkg","Test":"TestA"}\n{"Action":"pass","Package":"x/pkg","Test":""}'));
			expect(runRedCheck(d, ["pkg/a_test.go"])).toBe("green");
			// build failure: package-level fail, ZERO test events → tests=0 + exit≠0 → broken
			mockRunner(out(1, '{"Action":"output","Package":"x/pkg","Output":"# x/pkg\\n"}\n{"Action":"fail","Package":"x/pkg","Test":""}'));
			expect(runRedCheck(d, ["pkg/a_test.go"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("go: build-failure PROSE (no -json events) → unknown", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "go.mod"), "module x\n");
			mkdirSync(join(dir, "pkg"), { recursive: true });
			writeFileSync(join(dir, "pkg/a_test.go"), "");
		});
		try {
			mockRunner(out(1, "# x/pkg\npkg/a_test.go:5:2: undefined: NewThing\nFAIL x/pkg [build failed]"));
			expect(runRedCheck(d, ["pkg/a_test.go"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("pytest: collection-error exit 2 → broken (declared exit semantics); junit errors>0 at exit 1 → red", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/test_x.py"), "");
		});
		try {
			// review-2 F4: exit 2 is the collection-error exit — broken BEFORE
			// counts (a collection error must never confirm a RED).
			mockRunner(out(2, "ERROR collecting tests/test_x.py"));
			expect(runRedCheck(d, ["tests/test_x.py"])).toBe("broken");
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "git") return out(0, "", "");
				const junitArg = args.find((a) => a.startsWith("--junitxml="));
				if (junitArg) {
					writeFileSync(junitArg.slice("--junitxml=".length),
						`<?xml version='1.0'?><testsuite name="t" tests="3" failures="0" errors="3" skipped="0"></testsuite>`);
				}
				return out(1, "3 errors");
			});
			expect(runRedCheck(d, ["tests/test_x.py"])).toBe("red");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — polyglot repos never starve the correct runner (review-2 F2)", () => {
	it("a .go target in an npm monorepo with a nested go module runs `go test -json`, never vitest", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mono", devDependencies: { vitest: "^3" } }));
			mkdirSync(join(dir, "services", "api", "pkg"), { recursive: true });
			writeFileSync(join(dir, "services", "api", "go.mod"), "module svc\n");
			writeFileSync(join(dir, "services", "api", "pkg", "h_test.go"), "package pkg\n");
		});
		try {
			mockRunner(out(0, '{"Action":"pass","Package":"svc/pkg","Test":"TestH"}\n{"Action":"pass","Package":"svc/pkg","Test":""}'));
			expect(runRedCheck(d, ["services/api/pkg/h_test.go"])).toBe("green");
			const call = lastRunnerArgv();
			expect(call?.[0]).toBe("go");
			expect(call).not.toContain("vitest");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("a .py target with BOTH root pyproject.toml and package.json runs pytest, never vitest", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tooling", devDependencies: { vitest: "^3" } }));
			writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests", "test_x.py"), "");
		});
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "git") return out(0, "", "");
				const junitArg = args.find((a) => a.startsWith("--junitxml="));
				if (junitArg) {
					writeFileSync(junitArg.slice("--junitxml=".length),
						`<?xml version='1.0'?><testsuite name="t" tests="2" failures="0" errors="0" skipped="0"></testsuite>`);
				}
				return out(0, "2 passed");
			});
			expect(runRedCheck(d, ["tests/test_x.py"])).toBe("green");
			const call = lastRunnerArgv();
			expect(call?.[0]).toBe("pytest");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — jest count-line channel (review-2 F1: all-fail shapes)", () => {
	it("jest `Tests: 2 failed, 2 total` (passes omitted) → red; all-pass → green", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" }, devDependencies: { jest: "^29" } }));
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests", "a.test.js"), "");
		});
		try {
			mockRunner(out(1, "\nTests:  2 failed, 2 total\n"));
			expect(runRedCheck(d, ["tests/a.test.js"])).toBe("red");
			mockRunner(out(0, "\nTests:  2 passed, 2 total\n"));
			expect(runRedCheck(d, ["tests/a.test.js"])).toBe("green");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — pytest exit-code semantics (review-2 F4)", () => {
	it("exit 2 collection error with junit errors>0 → BROKEN, never a confirmed RED", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests", "test_x.py"), "");
		});
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "git") return out(0, "", "");
				const junitArg = args.find((a) => a.startsWith("--junitxml="));
				if (junitArg) {
					writeFileSync(junitArg.slice("--junitxml=".length),
						`<?xml version='1.0'?><testsuite name="t" tests="1" failures="0" errors="1" skipped="0"></testsuite>`);
				}
				return out(2, "ERROR collecting tests/test_x.py");
			});
			expect(runRedCheck(d, ["tests/test_x.py"])).toBe("broken");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("runRedCheck — scope-miss false-green guard (exit 0 without evidence)", () => {
	it("exit 0 with NO count line (cargo filter miss `0 passed; 0 failed`) → unknown, never green", () => {
		const d = tmpProj((dir) => {
			writeFileSync(join(dir, "Cargo.toml"), "");
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "tests/x.rs"), "");
		});
		try {
			mockRunner(out(0, "running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored"));
			expect(runRedCheck(d, ["tests/x.rs"])).toBe("unknown");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
