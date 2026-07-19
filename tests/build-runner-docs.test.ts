/**
 * Phase 3 — Documentation, contracts, and full quality gate (RED phase).
 *
 * These tests define the CONTRACTS and DOCUMENTATION deliverables for Phase 3
 * BEFORE the documentation is written. They are deterministic and hermetic:
 * they read source/README/package files as plain text — they never spawn cargo.
 *
 * Coverage:
 *   - AC-10 / SCENARIO-017: a README "Configuration" section exists and
 *     documents BOTH env vars (SUPER_DEV_BUILD_TIMEOUT_MS,
 *     SUPER_DEV_BUILD_TEST_PACKAGES) with Rust-workspace examples.
 *   - AC-09 / SCENARIO-013: non-mutation contract — the DEFAULT_TIMEOUT_MS /
 *     resolution-site JSDoc documents both env vars + fallback semantics, the
 *     three stage call sites are unchanged, no `shell:true`, and the pure
 *     detector's rust test argv is byte-identical to today.
 *   - SCENARIO-012: the three stage call sites still pass only `{ signal }`.
 *   - SCENARIO-014: the test argv stays a `string[]` with no shell.
 *   - SCENARIO-016: package.json exposes the `typecheck` + `test` scripts and
 *     adds no new runtime dependencies.
 *
 * Documentation deliverables do NOT exist yet (no README "Configuration"
 * section; the DEFAULT_TIMEOUT_MS JSDoc does not yet mention the env vars) —
 * so the doc-targeted tests are intentionally RED until Phase 3 is implemented.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProjectCommands } from "../src/build-runner.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = readFileSync(join(ROOT, "src", "build-runner.ts"), "utf8");
// Comments-stripped view for assertions that must target real code, not docs.
const SRC_CODE = SRC
	.replace(/\/\*[\s\S]*?\*\//g, "") // block comments
	.replace(/(^|\n)\s*\/\/[^\n]*/g, "$1"); // line comments
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<
	string,
	unknown
>;

// ---- Helpers ---------------------------------------------------------------

/** Extract the JSDoc block (a `/** ... *\/`) immediately preceding `anchor`. */
function jsdocPreceding(source: string, anchor: string): string {
	const idx = source.indexOf(anchor);
	expect(idx, `anchor ${JSON.stringify(anchor)} should exist in source`).toBeGreaterThan(-1);
	const close = source.lastIndexOf("*/", idx); // end of the preceding JSDoc
	expect(close, "a JSDoc block should close before the anchor").toBeGreaterThan(-1);
	const open = source.lastIndexOf("/**", close); // start of that JSDoc
	expect(open, "a JSDoc block should open before its close").toBeGreaterThan(-1);
	return source.slice(open, close + 2);
}

/** The section body following a `## Heading` until the next `##`/`#` heading. */
function sectionBody(md: string, heading: string): string {
	const start = md.search(new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "m"));
	if (start === -1) return "";
	const afterHeading = md.indexOf("\n", start) + 1;
	const nextHeading = md.slice(afterHeading).search(/^#{1,6}\s+/m);
	const end = nextHeading === -1 ? md.length : afterHeading + nextHeading;
	return md.slice(afterHeading, end);
}

// ---- AC-10 / SCENARIO-017: README "Configuration" section ------------------

describe("README 'Configuration' section (AC-10 / SCENARIO-017)", () => {
	it("contains a Configuration heading", () => {
		expect(/#{1,6}\s+Configuration\s*$/m.test(README)).toBe(true);
	});

	it("documents SUPER_DEV_BUILD_TIMEOUT_MS", () => {
		expect(sectionBody(README, "Configuration")).toContain("SUPER_DEV_BUILD_TIMEOUT_MS");
	});

	it("documents SUPER_DEV_BUILD_TEST_PACKAGES", () => {
		expect(sectionBody(README, "Configuration")).toContain("SUPER_DEV_BUILD_TEST_PACKAGES");
	});

	it("includes a Rust-workspace timeout-override example", () => {
		const body = sectionBody(README, "Configuration");
		// Env-var export form + a numeric millisecond value + rust signal.
		expect(/SUPER_DEV_BUILD_TIMEOUT_MS\s*=\s*\d+/.test(body)).toBe(true);
		expect(body.toLowerCase()).toContain("cargo");
	});

	it("includes a per-package scoping example with -p flags", () => {
		const body = sectionBody(README, "Configuration");
		expect(body).toContain("SUPER_DEV_BUILD_TEST_PACKAGES");
		expect(body).toContain("-p");
	});
});

// ---- AC-09 / SCENARIO-013: resolution-site JSDoc documents both env vars ---

describe("DEFAULT_TIMEOUT_MS resolution-site JSDoc (AC-09 / SCENARIO-013)", () => {
	const jsdoc = jsdocPreceding(SRC, "export const DEFAULT_TIMEOUT_MS");

	it("documents SUPER_DEV_BUILD_TIMEOUT_MS at the resolution site", () => {
		expect(jsdoc).toContain("SUPER_DEV_BUILD_TIMEOUT_MS");
	});

	it("documents SUPER_DEV_BUILD_TEST_PACKAGES at the resolution site", () => {
		expect(jsdoc).toContain("SUPER_DEV_BUILD_TEST_PACKAGES");
	});

	it("documents the fallback/default semantics", () => {
		expect(jsdoc.toLowerCase()).toMatch(/default|fallback/);
	});
});

// ---- SCENARIO-012: the three stage call sites are unchanged ----------------

describe("Stage call sites unchanged (SCENARIO-012)", () => {
	const stageFiles = [
		"src/stages/verify.ts",
		"src/stages/implementation.ts",
		"src/stages/index.ts",
	];

	it.each(stageFiles)("calls runBuildGate with only { signal } in %s", (rel) => {
		const text = readFileSync(join(ROOT, rel), "utf8");
		// Every call site must pass ONLY the signal option — no timeoutMs / no
		// testPackages. Matches the spec invariant that zero stage edits are
		// required because the helper resolves env vars internally.
		expect(text, `${rel} must call runBuildGate`).toContain("runBuildGate(");
		expect(text, `${rel} must pass only { signal: ctx.signal }`).toContain(
			"{ signal: ctx.signal }",
		);
		// Robust against nested parens (e.g. setupOf(s).worktreePath): assert no
		// new options ever leak into a stage call site.
		expect(text, `${rel} must not thread the new opts`).not.toMatch(
			/timeoutMs|testPackages/,
		);
	});
});

// ---- SCENARIO-014: test argv stays a string[] with no shell ----------------

describe("No shell interpolation in build-runner (SCENARIO-014)", () => {
	it("never enables shell:true on spawnSync", () => {
		// Assert against real code only (the env-var names legitimately appear in
		// JSDoc comments, so the comment-stripped view is the correct target).
		expect(SRC_CODE).not.toMatch(/shell\s*:\s*true/);
	});
});

// ---- AC-09 / SCENARIO-013: pure detector's rust argv is byte-identical -----

describe("detectProjectCommands purity — no -p baked into the detector (AC-09)", () => {
	it("produces the unchanged workspace-wide rust test argv", async () => {
		const tmp = join(
			(import.meta.dirname as string) ?? ".",
			`.tmp-rust-proj-${process.pid}-${Date.now()}`,
		);
		const fs = await import("node:fs");
		fs.mkdirSync(tmp, { recursive: true });
		fs.writeFileSync(
			join(tmp, "Cargo.toml"),
			"[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
		);
		fs.mkdirSync(join(tmp, "src"), { recursive: true });
		fs.writeFileSync(join(tmp, "src", "main.rs"), "fn main() {}\n");
		try {
			const cmds = detectProjectCommands(tmp);
			expect(cmds.language).toBe("rust");
			expect(cmds.test).toEqual(["cargo", "test", "--quiet"]);
			// Scoping must be applied ONLY inside runBuildGate, never the detector.
			expect(cmds.test).not.toContain("-p");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---- SCENARIO-016: package.json exposes scripts + no new runtime deps ------

describe("package.json contracts (SCENARIO-016)", () => {
	it("exposes a typecheck script (tsc --noEmit)", () => {
		const scripts = PKG.scripts as Record<string, string> | undefined;
		expect(scripts?.typecheck).toMatch(/tsc/);
	});

	it("exposes a test script (vitest)", () => {
		const scripts = PKG.scripts as Record<string, string> | undefined;
		expect(scripts?.test).toMatch(/vitest/);
	});

	it("introduces no new runtime dependencies", () => {
		// This fix is explicitly dependency-free (Node built-ins only). A
		// hard-fail here means a stray dep leaked in during implementation.
		const deps = Object.keys((PKG.dependencies ?? {}) as Record<string, unknown>);
		expect(deps.length, "dependencies must not grow during this fix").toBeLessThanOrEqual(1);
		// The only permitted runtime dep is the harness's own agent entry point.
		// Asserting `name` to anchor the package identity (no bundled SDK creep).
		expect(typeof PKG.name).toBe("string");
	});
});
