/**
 * Phase P1 — resolver validation (RED phase).
 *
 * Defense-in-depth (Layer C) tests for the hardened `resolveCargoPackageNames`
 * + new `validatePackageNames` helper + its wiring inside `runBuildGate`.
 *
 * These tests define the NEW hardened behavior BEFORE P1 is implemented:
 *   - SCENARIO-004 (AC-02): a dir resolving to a known member emits the REAL name.
 *   - SCENARIO-005 (AC-02, critical): an unresolved dir is DROPPED, never emitted
 *     as its raw name (removes the per-element identity fallback).
 *   - SCENARIO-006 (AC-02, critical): metadata failure → resolver returns []
 *     (removes the whole-list identity fallback) so the gate widens safely;
 *     never throws.
 *   - SCENARIO-007 (AC-03, critical): every candidate name is validated against
 *     known members before any `-p` flag is built; unknowns dropped.
 *   - SCENARIO-008 (AC-03): an empty surviving set after validation widens to
 *     workspace-wide (no invalid `-p`).
 *   - SCENARIO-034 (AC-02, critical): no gate component ever raises an error.
 *   - SCENARIO-035 (AC-02): spawned commands never reach a shell (discrete argv).
 *   - SCENARIO-036 (AC-02): metadata is only spawned when there is something to
 *     resolve.
 *
 * Hermetic: `node:child_process.spawnSync` is mocked. We feed synthetic
 * `cargo metadata` JSON and capture argvs. Each test uses a unique temp cwd so
 * the module-level `cargoMetadataCache` never leaks across tests (cache key is
 * the absolute cwd).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the ONLY side effects these functions perform: spawnSync. Real git and
// cargo must never run in CI. Routed per-call below to return metadata fixtures
// or capture cargo build/test/clippy argvs.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import {
	resolveCargoPackageNames,
	validatePackageNames, // NEW — does not exist yet (RED by import)
	runBuildGate,
} from "../src/build-runner.ts";

const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;
const PKG_ENV = "SUPER_DEV_BUILD_TEST_PACKAGES";

/** A real rust temp worktree (Cargo.toml present) so detectProjectCommands ⇒ rust. */
function rustTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "sd-p1-rust-"));
	writeFileSync(join(dir, "Cargo.toml"), "");
	return dir;
}

/** A plain temp dir (no manifest needed for pure resolver/validator unit tests). */
function tmp(): string {
	return mkdtempSync(join(tmpdir(), "sd-p1-"));
}

type Member = { dir: string; name: string };

/** Build a `cargo metadata` JSON fixture for a set of workspace members. */
function cargoMetadataJson(cwd: string, members: Member[]): string {
	return JSON.stringify({
		packages: members.map((m) => ({
			name: m.name,
			manifest_path: join(cwd, m.dir, "Cargo.toml"),
		})),
	});
}

/** The default stockfan-shape member set used across tests. */
function stockfanMembers(cwd: string): Member[] {
	return [
		{ dir: "crates/data", name: "stockfan-data" },
		{ dir: "crates/tools", name: "stockfan-tools" },
	];
}

/** Save/restore SUPER_DEV_BUILD_TEST_PACKAGES around a test block. */
function withEnv() {
	let savedPkg: string | undefined;
	return {
		before() {
			savedPkg = process.env[PKG_ENV];
			delete process.env[PKG_ENV];
		},
		after() {
			if (savedPkg === undefined) delete process.env[PKG_ENV];
			else process.env[PKG_ENV] = savedPkg;
		},
	};
}

/**
 * Route spawnSync so `cargo metadata` returns a JSON fixture for `cwd`,
 * `git` returns `gitDiff`, and any other cargo call is captured + succeeds.
 * `cargoCalls` receives the full argv `[cmd, ...args]` for build/test/clippy.
 */
function routeWithMetadata(
	cwd: string,
	members: Member[],
	gitDiff: string,
	cargoCalls: string[][],
): void {
	spawn.mockImplementation((cmd: string, args: string[]) => {
		const a = args ?? [];
		if (cmd === "cargo" && a[0] === "metadata") {
			return { status: 0, stdout: cargoMetadataJson(cwd, members), stderr: "" };
		}
		if (cmd === "git") {
			return { status: 0, stdout: gitDiff, stderr: "" };
		}
		cargoCalls.push([cmd, ...a]);
		return { status: 0, stdout: "", stderr: "" };
	});
}

/** The cargo call whose full argv contains `subcommand` as argv[1]. */
function cargoArgvFor(cargoCalls: string[][], subcommand: string): string[] {
	const found = cargoCalls.find((a) => a[1] === subcommand);
	if (!found) throw new Error(`no captured cargo ${subcommand} argv`);
	return found;
}

beforeEach(() => {
	spawn.mockReset();
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-004 — a dir resolving to a known member emits the REAL name        */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-004 — dir resolving to a known member emits the real name", () => {
	it("crates/data → stockfan-data when metadata has that member", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			expect(resolveCargoPackageNames(cwd, ["data"])).toEqual(["stockfan-data"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("multiple dirs each resolve to their real member name, order preserved", () => {
		// anti-hardcode: compute BEFORE data forces input-order preservation,
		// defeating any literal or sorted-lookup shortcut.
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			expect(resolveCargoPackageNames(cwd, ["tools", "data"])).toEqual([
				"stockfan-tools",
				"stockfan-data",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-005 — an unresolved dir is DROPPED, never emitted as its raw name   */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-005 — unresolved dir is dropped, never its raw name", () => {
	it("a dir with no matching member is dropped (returns [], NOT ['data'])", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			// 'ghost' matches no member → DROPPED. Old behavior returned ['ghost'].
			expect(resolveCargoPackageNames(cwd, ["ghost"])).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("known + unknown mix keeps only the known, dropping the raw unknown", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			expect(resolveCargoPackageNames(cwd, ["data", "ghost", "tools"])).toEqual([
				"stockfan-data",
				"stockfan-tools",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-006 — metadata failure widens to [] (no identity fallback)         */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-006 — metadata failure returns [] instead of guessing names", () => {
	it("non-zero cargo exit → [] (NOT the touched dir names)", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 1, stdout: "", stderr: "error" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			expect(resolveCargoPackageNames(cwd, ["data", "tools"])).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("spawn error (missing cargo) → [] (NOT ['data','tools'])", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { error: new Error("spawn cargo ENOENT") };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			expect(resolveCargoPackageNames(cwd, ["data", "tools"])).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("empty stdout → [] (no usable metadata to fall back from)", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: "", stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			expect(resolveCargoPackageNames(cwd, ["data"])).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("malformed JSON → [] (parse failure degrades, no throw, no guess)", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: "{not valid json", stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			expect(() => resolveCargoPackageNames(cwd, ["data"])).not.toThrow();
			expect(resolveCargoPackageNames(cwd, ["data"])).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-034 — no gate component ever raises an error                       */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-034 — resolver and validator never throw", () => {
	it("resolveCargoPackageNames never throws even when the spawn handler throws", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation(() => {
				throw new Error("boom inside spawn");
			});
			expect(() => resolveCargoPackageNames(cwd, ["data"])).not.toThrow();
			expect(resolveCargoPackageNames(cwd, ["data"])).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("resolveCargoPackageNames never throws on non-array input", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
			// @ts-expect-error — exercising defensive path with a bad input shape.
			expect(() => resolveCargoPackageNames(cwd, null)).not.toThrow();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("validatePackageNames never throws when the spawn handler throws", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation(() => {
				throw new Error("boom inside spawn");
			});
			expect(() => validatePackageNames(cwd, ["stockfan-data"])).not.toThrow();
			expect(validatePackageNames(cwd, ["stockfan-data"])).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-035 — spawned commands never reach a shell                         */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-035 — metadata spawn uses discrete argv, no shell", () => {
	it("the metadata call argv is a discrete array with no shell:true and utf8 encoding", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			resolveCargoPackageNames(cwd, ["data"]);
			const metaCall = spawn.mock.calls.find(
				(c) => c[0] === "cargo" && (c[1] as string[])[0] === "metadata",
			);
			expect(metaCall, "a cargo metadata spawn must have occurred").toBeTruthy();
			const [cmd, argv, opts] = metaCall as [
				string,
				string[],
				{ shell?: boolean; encoding?: string },
			];
			expect(cmd).toBe("cargo");
			expect(Array.isArray(argv)).toBe(true); // discrete argv, not a shell string
			expect(argv).toContain("--no-deps");
			expect(argv).toContain(join(cwd, "Cargo.toml"));
			expect(opts?.shell).toBeFalsy(); // never reaches a shell
			expect(opts?.encoding).toBe("utf8");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-036 — metadata is only spawned when there is something to resolve  */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-036 — empty input never spawns metadata", () => {
	it("empty touched-dir input short-circuits with NO cargo metadata spawn", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
			expect(resolveCargoPackageNames(cwd, [])).toEqual([]);
			expect(spawn.mock.calls).toHaveLength(0); // never spawned
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-007 — validatePackageNames drops unknown candidates (AC-03)         */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-007 — validatePackageNames keeps known, drops unknown", () => {
	it("returns only candidates that are known workspace members, order preserved", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			// 'ghost' is unknown → dropped; the two known survive in input order.
			expect(
				validatePackageNames(cwd, ["stockfan-tools", "ghost", "stockfan-data"]),
			).toEqual(["stockfan-tools", "stockfan-data"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("dedupes while preserving first-seen order", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			expect(
				validatePackageNames(cwd, ["stockfan-data", "stockfan-data", "stockfan-tools"]),
			).toEqual(["stockfan-data", "stockfan-tools"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("metadata unavailable → validator returns [] (cannot confirm anything)", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 1, stdout: "", stderr: "error" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			// With no metadata, NOTHING is a known member → all dropped.
			expect(validatePackageNames(cwd, ["stockfan-data", "stockfan-tools"])).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-007b — validatePackageNames reuses the CACHED metadata (no extra   */
/* spawn): the spec mandates the helper reuses loadCargoMetadata's per-cwd     */
/* cache, so a resolver call followed by a validator call on the SAME cwd must */
/* spawn `cargo metadata` exactly ONCE total.                                  */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-007b — validatePackageNames reuses cached metadata (single spawn)", () => {
	it("resolver + validator on the same cwd spawn `cargo metadata` exactly once", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			// Resolver call: spawns metadata once, caches the result per-cwd.
			expect(resolveCargoPackageNames(cwd, ["data", "tools"])).toEqual([
				"stockfan-data",
				"stockfan-tools",
			]);
			// Validator call: MUST reuse the cache, NOT spawn metadata again.
			expect(
				validatePackageNames(cwd, ["stockfan-data", "stockfan-tools", "ghost"]),
			).toEqual(["stockfan-data", "stockfan-tools"]);
			const metadataCalls = spawn.mock.calls.filter(
				(c) => c[0] === "cargo" && (c[1] as string[])[0] === "metadata",
			);
			expect(metadataCalls, "exactly one cargo metadata spawn across both calls").toHaveLength(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("repeated validatePackageNames calls on the same cwd spawn metadata at most once", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			validatePackageNames(cwd, ["stockfan-data"]);
			validatePackageNames(cwd, ["stockfan-tools"]);
			validatePackageNames(cwd, ["stockfan-data", "stockfan-tools"]);
			const metadataCalls = spawn.mock.calls.filter(
				(c) => c[0] === "cargo" && (c[1] as string[])[0] === "metadata",
			);
			expect(metadataCalls).toHaveLength(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-008 — empty surviving set after validation widens to workspace-wide */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-008 — all-unknown validation collapses to []", () => {
	it("every candidate unknown → validatePackageNames returns []", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === "cargo" && args?.[0] === "metadata") {
					return { status: 0, stdout: cargoMetadataJson(cwd, stockfanMembers(cwd)), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			});
			expect(validatePackageNames(cwd, ["foo", "bar"])).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* runBuildGate validator wiring — every candidate re-checked before any -p     */
/* (AC-03 integration: applies to env + auto-detect sources alike)             */
/* -------------------------------------------------------------------------- */

describe("runBuildGate validator wiring (AC-03 integration)", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("an env override is TRUSTED as-is — names kept verbatim, not validated (CR-007)", () => {
		const cargoCalls: string[][] = [];
		const cwd = rustTmp();
		try {
			// env declares stockfan-data + a ghost; env is an EXPLICIT operator
			// override, TRUSTED as-is (not re-validated against metadata members).
			process.env[PKG_ENV] = "stockfan-data,ghost";
			routeWithMetadata(cwd, stockfanMembers(cwd), "crates/tools/src/lib.rs\n", cargoCalls);
			runBuildGate(cwd);
			// No git detection spawn when an env override exists.
			expect(spawn.mock.calls.filter((c) => c[0] === "git")).toHaveLength(0);
			// BOTH names are kept (env is trusted, not validated).
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"stockfan-data",
				"-p",
				"ghost",
				"--quiet",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("an all-unknown env override is still TRUSTED (operator's explicit intent honored — CR-007)", () => {
		const cargoCalls: string[][] = [];
		const cwd = rustTmp();
		try {
			process.env[PKG_ENV] = "foo,bar"; // both unknown to metadata
			routeWithMetadata(cwd, stockfanMembers(cwd), "crates/data/src/lib.rs\n", cargoCalls);
			runBuildGate(cwd);
			expect(spawn.mock.calls.filter((c) => c[0] === "git")).toHaveLength(0);
			// Env is TRUSTED — both unknown names are emitted (cargo will surface
			// the error itself, which is the operator's explicit intent).
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"foo",
				"-p",
				"bar",
				"--quiet",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("auto-detected dir resolves to a real name that the validator confirms", () => {
		const cargoCalls: string[][] = [];
		const cwd = rustTmp();
		try {
			// No env, no opts → auto-detect via git diff (crates/data) → resolver
			// yields stockfan-data → validator confirms → scoped argvs.
			routeWithMetadata(cwd, stockfanMembers(cwd), "crates/data/src/lib.rs\n", cargoCalls);
			const r = runBuildGate(cwd);
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"stockfan-data",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual([
				"cargo",
				"test",
				"-p",
				"stockfan-data",
				"--quiet",
			]);
			expect(r.pass).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("explicit opts are TRUSTED as-is — not validated against members (CR-007)", () => {
		const cargoCalls: string[][] = [];
		const cwd = rustTmp();
		try {
			routeWithMetadata(cwd, stockfanMembers(cwd), "", cargoCalls);
			runBuildGate(cwd, { testPackages: ["ghost", "stockfan-tools"] });
			expect(spawn.mock.calls.filter((c) => c[0] === "git")).toHaveLength(0);
			// BOTH kept (opt is trusted, not validated).
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo",
				"build",
				"-p",
				"ghost",
				"-p",
				"stockfan-tools",
				"--quiet",
			]);
			expect(cargoArgvFor(cargoCalls, "clippy")).toEqual([
				"cargo",
				"clippy",
				"-p",
				"ghost",
				"-p",
				"stockfan-tools",
				"--all-targets",
				"--quiet",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("never throws from runBuildGate even when the metadata spawn throws (widens safely)", () => {
		const cwd = rustTmp();
		try {
			process.env[PKG_ENV] = "stockfan-data";
			spawn.mockImplementation(() => {
				throw new Error("metadata boom");
			});
			expect(() => runBuildGate(cwd)).not.toThrow();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* -------------------------------------------------------------------------- */
/* SCENARIO-034/036 PARITY — validatePackageNames defensive contract mirrors    */
/* the resolver: empty input never spawns metadata, and a bad input shape never */
/* throws. Closes the P1 defense-in-depth contract for the validator helper.    */
/* -------------------------------------------------------------------------- */

describe("SCENARIO-036 parity — validatePackageNames empty input never spawns metadata", () => {
	it("an empty names list short-circuits to [] with NO cargo metadata spawn", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
			expect(validatePackageNames(cwd, [])).toEqual([]);
			expect(spawn.mock.calls).toHaveLength(0); // never spawned — AC-10 invariant
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("a names list of only non-strings is treated as empty (no spawn, returns [])", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
			// filter to strings first → empty surviving set → no spawn.
			expect(
				// @ts-expect-error — exercising defensive path with a bad element shape.
				validatePackageNames(cwd, [null, undefined, 0, false]),
			).toEqual([]);
			expect(spawn.mock.calls).toHaveLength(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("SCENARIO-034 parity — validatePackageNames never throws on bad input", () => {
	it("a non-array names argument returns [] without throwing", () => {
		const cwd = tmp();
		try {
			spawn.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
			// @ts-expect-error — exercising defensive path with a bad input shape.
			expect(() => validatePackageNames(cwd, null)).not.toThrow();
			// @ts-expect-error
			expect(validatePackageNames(cwd, null)).toEqual([]);
			expect(spawn.mock.calls).toHaveLength(0); // never reached the spawn
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/* ========================================================================== */
/* CR-006 — gate-contract runBuildGate integration tests (Layer D)            */
/* ========================================================================== */

describe("CR-006 — spec-declared gate contract (runBuildGate integration)", () => {
	const env = withEnv();
	beforeEach(env.before);
	afterEach(env.after);

	it("gate.packages drives scope (validated against metadata members)", () => {
		const cargoCalls: string[][] = [];
		const cwd = rustTmp();
		try {
			routeWithMetadata(cwd, stockfanMembers(cwd), "", cargoCalls);
			runBuildGate(cwd, { gate: { packages: ["stockfan-data", "ghost"] } });
			// ghost is NOT a known member → dropped; stockfan-data kept.
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo", "build", "-p", "stockfan-data", "--quiet",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("gate.workspace===true short-circuits to workspace-wide (no -p)", () => {
		const cargoCalls: string[][] = [];
		const cwd = rustTmp();
		try {
			routeWithMetadata(cwd, stockfanMembers(cwd), "crates/data/src/lib.rs\n", cargoCalls);
			runBuildGate(cwd, { gate: { workspace: true } });
			expect(cargoArgvFor(cargoCalls, "build")).toEqual(["cargo", "build", "--quiet"]);
			expect(cargoArgvFor(cargoCalls, "test")).toEqual(["cargo", "test", "--quiet"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("gate.integration emits cargo test --test <stem> (stat-validated, NOT -p)", () => {
		const cargoCalls: string[][] = [];
		const cwd = rustTmp();
		try {
			routeWithMetadata(cwd, stockfanMembers(cwd), "", cargoCalls);
			// Create the integration test file so existsSync passes.
			const testPath = "crates/data/tests/e2e_screen.rs";
			mkdirSync(join(cwd, "crates/data/tests"), { recursive: true });
			writeFileSync(join(cwd, testPath), "#[test] fn e2e() {}");
			runBuildGate(cwd, {
				gate: { packages: ["stockfan-data"], integration: [testPath] },
			});
			// The gate has: build -p stockfan-data, test -p stockfan-data,
			// clippy -p stockfan-data, PLUS cargo test --test e2e_screen --quiet.
			const integrationCalls = cargoCalls.filter(
				(a) => a[1] === "test" && a.includes("--test"),
			);
			expect(integrationCalls).toHaveLength(1);
			expect(integrationCalls[0]).toEqual([
				"cargo", "test", "--test", "e2e_screen", "--quiet",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("gate.integration with a MISSING file is dropped (never emits invalid --test)", () => {
		const cargoCalls: string[][] = [];
		const cwd = rustTmp();
		try {
			routeWithMetadata(cwd, stockfanMembers(cwd), "", cargoCalls);
			runBuildGate(cwd, {
				gate: { packages: ["stockfan-data"], integration: ["crates/data/tests/nope.rs"] },
			});
			// No --test invocation for the missing file.
			expect(cargoCalls.filter((a) => a.includes("--test"))).toHaveLength(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("precedence: gate.packages > SUPER_DEV_BUILD_TEST_PACKAGES env", () => {
		const cargoCalls: string[][] = [];
		const cwd = rustTmp();
		try {
			process.env[PKG_ENV] = "stockfan-tools";
			routeWithMetadata(cwd, stockfanMembers(cwd), "crates/tools/src/lib.rs\n", cargoCalls);
			runBuildGate(cwd, { gate: { packages: ["stockfan-data"] } });
			// Gate wins over env: build uses stockfan-data, not stockfan-tools.
			expect(cargoArgvFor(cargoCalls, "build")).toEqual([
				"cargo", "build", "-p", "stockfan-data", "--quiet",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
