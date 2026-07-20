/**
 * Phase 4 — Regression Suite, Backward-Compat & Gate Verification.
 *
 * Scope: AC-06 / AC-08 / AC-09 / AC-10 and SCENARIO-012/013/014/015/016/023/024.
 *
 * Phases 1–3 (metadata resolver, wiring, prompt discipline) are implemented and
 * green. This file adds the FOURTH layer of defence: regression tests that
 * lock in the BACKWARD-COMPAT invariants and GATE-VERIFICATION guarantees that
 * the prior phases left intentionally uncovered, so a future change cannot
 * silently regress them. It deliberately does NOT duplicate the forward-path
 * tests in build-runner-package-resolution / -package-wiring /
 * -inscope-classification (which use dir-style names `data`/`compute`); instead
 * it asserts the REAL prefixed-name end-to-end behaviour and the static
 * contract on the source itself.
 *
 *   (A) classifyOutOfScopeErrors partitions against REAL prefixed names
 *       (SCENARIO-016 / SCENARIO-023).
 *   (B) dir==name workspaces are an identity no-op (AC-08 / SCENARIO-012).
 *   (C) Static gate spawn-inventory guardrail (AC-10 / SCENARIO-014): the only
 *       new spawned process is cached `cargo metadata --no-deps`, no shell:true.
 *   (D) No new runtime dependencies (AC-10 / SCENARIO-014).
 *   (E) Theme/render guardrail (AC-09 / SCENARIO-015/024): the changed module
 *       introduces no render/theme coupling; method-binding stays intact.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `spawnSync` is mocked at the module boundary so the dir==name identity test
// (B) never spawns a real `cargo`/`git`. Every other test in this file is a
// PURE function call or a STATIC source-text assertion and needs no spawn.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

// Imported AFTER vi.mock (hoisted): build-runner.ts and this file share the
// SAME mocked spawnSync instance. The `.ts` extension is required under
// NodeNext + allowImportingTsExtensions (matches the sibling test files).
import { spawnSync } from "node:child_process";
import { classifyOutOfScopeErrors, resolveCargoPackageNames } from "../src/build-runner.ts";

// Loose mock handle: cast away the real `SpawnSyncReturns<string>` return type
// so `mockReturnValue` accepts a partial shape (status/stdout/stderr only),
// mirroring the sibling test files' `as unknown as SpawnFn` pattern.
const spawn = spawnSync as unknown as ReturnType<typeof vi.fn>;

const REPO_ROOT = process.cwd();
const SRC = readFileSync(join(REPO_ROOT, "src", "build-runner.ts"), "utf8");
// Code-only view of the source: JSDoc/line comments stripped, so the static
// guardrails assert against REAL code, not against prose that *describes* the
// invariant (e.g. comments saying "no shell:true").
const SRC_CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<
	string,
	unknown
>;

beforeEach(() => {
	vi.clearAllMocks();
});

/**
 * Build a realistic cargo failure block in the EXACT shape `runBuildGate`
 * emits: `<label> FAILED (<reason>):\n<tail>`. The tail carries cargo's own
 * rerun marker `-p <pkg>` (the REAL package name), which is what
 * `classifyOutOfScopeErrors` scans (the label's own `-p` is excluded by the
 * FAILED-region split). This is the form a real prefixed-crate failure takes.
 */
function cargoFailBlock(realPkg: string, reason = "exit 101"): string {
	const label = `cargo test -p ${realPkg} --quiet`;
	const tail = `error: test failed, to rerun: \`cargo test -p ${realPkg}\`\n  --> crates/${realPkg}/src/lib.rs:10:3`;
	return `${label} FAILED (${reason}):\n${tail}`;
}

// ---------------------------------------------------------------------------
// (A) classifyOutOfScopeErrors partitions against REAL prefixed names
//     AC-08 / SCENARIO-016 / SCENARIO-023
// ---------------------------------------------------------------------------
describe("classifyOutOfScopeErrors — REAL prefixed-name partitioning (AC-08 / SCENARIO-016/023)", () => {
	it("a `stockfan-data` rerun failure is IN-SCOPE when `stockfan-data` is scoped", () => {
		// Previously the gate scoped by the DIRECTORY name `data`; cargo's rerun
		// marker `-p stockfan-data` (REAL name) never matched `data`, so this
		// failure would have been falsely classified OUT-OF-SCOPE (false green).
		// Now the scope carries the REAL name and the partition is correct.
		const block = cargoFailBlock("stockfan-data");
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors([block], [
			"stockfan-data",
			"stockfan-tools",
		]);
		expect(inScopeErrors).toHaveLength(1);
		expect(inScopeErrors[0]).toBe(block);
		expect(outOfScopeErrors).toHaveLength(0);
	});

	it("a `stockfan-data` rerun failure is OUT-OF-SCOPE when only `stockfan-tools` is scoped", () => {
		const block = cargoFailBlock("stockfan-data");
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors([block], [
			"stockfan-tools",
		]);
		expect(outOfScopeErrors).toHaveLength(1);
		expect(outOfScopeErrors[0]).toBe(block);
		expect(inScopeErrors).toHaveLength(0);
	});

	it("partitions a mixed REAL-name batch: in-scope kept, out-of-scope separated", () => {
		const inScope = cargoFailBlock("stockfan-data");
		const outScope = cargoFailBlock("stockfan-tools");
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors(
			[inScope, outScope],
			["stockfan-data"],
		);
		expect(inScopeErrors).toEqual([inScope]);
		expect(outOfScopeErrors).toEqual([outScope]);
	});

	it("the full prefixed workspace scope keeps every touched crate in-scope", () => {
		const blocks = [
			cargoFailBlock("stockfan-data"),
			cargoFailBlock("stockfan-tools"),
			cargoFailBlock("stockfan-workflows"),
		];
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors(blocks, [
			"stockfan-data",
			"stockfan-tools",
			"stockfan-workflows",
		]);
		expect(inScopeErrors).toEqual(blocks);
		expect(outOfScopeErrors).toEqual([]);
	});

	it("a failure referencing an UNSCOPED real name alongside a scoped one stays IN-SCOPE (conservative)", () => {
		// anyInScope ⇒ in-scope. This is the contract that prevents a false green.
		const block =
			cargoFailBlock("stockfan-data") + "\n" + cargoFailBlock("stockfan-tools");
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors([block], [
			"stockfan-data",
		]);
		expect(inScopeErrors).toHaveLength(1);
		expect(outOfScopeErrors).toHaveLength(0);
	});

	it("empty REAL-name scope ⇒ every error conservatively in-scope (never a false green)", () => {
		const block = cargoFailBlock("stockfan-data");
		const { inScopeErrors, outOfScopeErrors } = classifyOutOfScopeErrors([block], []);
		expect(inScopeErrors).toHaveLength(1);
		expect(outOfScopeErrors).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// (B) dir==name workspaces are an identity no-op (AC-08 / SCENARIO-012)
//     When package name == directory segment, the resolver is a verbatim
//     identity mapping — backward-compat with the pre-change behaviour.
// ---------------------------------------------------------------------------
describe("dir==name workspace is an identity no-op (AC-08 / SCENARIO-012)", () => {
	it("maps each dir to itself when package name == directory segment", () => {
		// A unique cwd so the module-level cache is cold for this test.
		const cwd = "/phase4-dir-eq-name-ws";
		const metadata = {
			packages: [
				{ name: "data", manifest_path: `${cwd}/crates/data/Cargo.toml` },
				{ name: "tools", manifest_path: `${cwd}/crates/tools/Cargo.toml` },
			],
		};
		spawn.mockReturnValue({
			status: 0,
			stdout: JSON.stringify(metadata),
			stderr: "",
		});

		const resolved = resolveCargoPackageNames(cwd, ["data", "tools"]);
		// Assert the mock actually drove resolution (metadata was consulted once).
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(resolved).toEqual(["data", "tools"]); // identity — names unchanged
	});

	it("dir==name resolution still dedupes + preserves first-seen order", () => {
		const cwd = "/phase4-dir-eq-name-order";
		const metadata = {
			packages: [
				{ name: "alpha", manifest_path: `${cwd}/crates/alpha/Cargo.toml` },
				{ name: "beta", manifest_path: `${cwd}/crates/beta/Cargo.toml` },
			],
		};
		spawn.mockReturnValue({
			status: 0,
			stdout: JSON.stringify(metadata),
			stderr: "",
		});

		// tools-before-data order + a duplicate must survive verbatim.
		const resolved = resolveCargoPackageNames(cwd, ["beta", "alpha", "beta"]);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(resolved).toEqual(["beta", "alpha"]);
	});
});

// ---------------------------------------------------------------------------
// (C) Static gate spawn-inventory guardrail (AC-10 / SCENARIO-014)
//     Asserts ON THE SOURCE TEXT that the only new spawned process is the
//     cached `cargo metadata --no-deps`, that it uses discrete argv, and that
//     no shell:true ever appears (no shell-injection surface).
// ---------------------------------------------------------------------------
describe("gate spawn-inventory — static source contract (AC-10 / SCENARIO-014)", () => {
	it("the cargo metadata spawn carries `--no-deps` and `--manifest-path`", () => {
		expect(SRC).toContain("--no-deps");
		expect(SRC).toContain("--manifest-path");
	});

	it("`cargo metadata` is invoked with `--format-version 1` via discrete argv", () => {
		expect(SRC).toMatch(/spawnSync\(\s*"cargo"\s*,\s*\[\s*"metadata"/);
		expect(SRC).toContain('"--format-version"');
		expect(SRC).toContain('"1"');
	});

	it("NO `shell: true` option exists in the module's CODE (no shell-injection surface)", () => {
		// AC-10 / security: package/path data must never reach a shell. Asserted
		// against CODE only (comments stripped) so the JSDoc prose that *states*
		// "no shell:true" does not mask — or be masked by — a real option.
		expect(SRC_CODE).not.toMatch(/shell:\s*true/);
	});

	it("the only `cargo metadata` occurrence is the single cached resolver spawn", () => {
		// Count distinct `cargo metadata` argv constructions — there must be
		// exactly ONE (the resolver), not duplicated elsewhere.
		const matches = SRC.match(/"metadata"/g) ?? [];
		expect(matches.length).toBe(1);
	});

	it("the module exports the resolver + keeps the legacy surface intact", () => {
		// Backward-compat: the public symbols Phases 1–2 added/kept are present.
		expect(SRC).toMatch(/export function resolveCargoPackageNames/);
		expect(SRC).toMatch(/export function detectTouchedCargoPackages/);
		expect(SRC).toMatch(/export function classifyOutOfScopeErrors/);
		expect(SRC).toMatch(/export function runBuildGate/);
	});
});

// ---------------------------------------------------------------------------
// (D) No new runtime dependencies (AC-10 / SCENARIO-014)
//     The change is pure TS; package.json gains no runtime dependency.
// ---------------------------------------------------------------------------
describe("no new runtime dependencies (AC-10 / SCENARIO-014)", () => {
	it("package.json declares NO `dependencies` (runtime deps) field", () => {
		// A pi-extension ships runtime deps only via peerDependencies; the
		// resolver adds nothing — it uses only node:child_process + node:path.
		expect(PKG.dependencies).toBeUndefined();
	});

	it("the resolver's only runtime need is the Node stdlib (no third-party import added)", () => {
		// The changed module must not introduce a new third-party runtime import.
		// Allowed stdlib + relative imports only.
		const importLines = SRC.split("\n").filter((l) => /^\s*import /.test(l));
		for (const line of importLines) {
			// node: stdlib, or a relative in-repo path are the only acceptable
			// runtime imports. Bare specifiers (e.g. a new npm pkg) are rejected.
			expect(line).toMatch(/from\s+["'](?:node:|\.\/)/);
		}
	});
});

// ---------------------------------------------------------------------------
// (E) Theme/render guardrail (AC-09 / SCENARIO-015/024)
//     The changed module introduces NO render/theme coupling, so the theme
//     method-binding contract (tests/stream-theme-class-theme.test.ts) is
//     preserved: no `const fg = theme.fg` destructuring can detach `this`.
// ---------------------------------------------------------------------------
describe("theme/render guardrail — no new rendering in the changed module (AC-09 / SCENARIO-015/024)", () => {
	it("build-runner.ts imports nothing from the render layer", () => {
		expect(SRC).not.toMatch(/from\s+["']\.\/render/);
	});

	it("build-runner.ts contains no destructured theme binding (`= theme.fg` / fgColors)", () => {
		// AC-09 regression: a destructured `const fg = theme.fg` detaches `this`
		// and throws "reading 'fgColors'". The changed module must not add one.
		expect(SRC).not.toMatch(/=\s*theme\.fg\b/);
		expect(SRC).not.toMatch(/fgColors/);
	});
});
