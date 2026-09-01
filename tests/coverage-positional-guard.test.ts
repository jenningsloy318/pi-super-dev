/**
 * v0.3.56 F3 — insertBeforeFirstPositional treated option VALUES as positionals,
 * so `node --import tsx --test …` got coverage flags inserted BETWEEN --import
 * and its value (the value became a bare positional and the coverage flag
 * became the value of --import — the command was corrupted).
 *
 * Escape class F (environment realism — node CLI value semantics); defense
 * layer L2 (real toolchain spawns, docs/testing-strategy.md).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { insertBeforeFirstPositional } from "../src/build-runner/coverage-gate.ts";

describe("insertBeforeFirstPositional — value-taking flags are skipped (F3)", () => {
	it("never splits --import from its value", () => {
		const out = insertBeforeFirstPositional(["node", "--import", "tsx", "--test", "tests/a.test.mjs"], "--experimental-test-coverage");
		expect(out).toEqual(["node", "--import", "tsx", "--test", "--experimental-test-coverage", "tests/a.test.mjs"]);
	});
	it("handles --require / -r / --loader / --config the same way", () => {
		expect(insertBeforeFirstPositional(["node", "--require", "dot-env.ts", "--test"], "--experimental-test-coverage"))
			.toEqual(["node", "--require", "dot-env.ts", "--test", "--experimental-test-coverage"]);
		expect(insertBeforeFirstPositional(["node", "-r", "tsconfig.ts", "--test", "a.test.mjs"], "--experimental-test-coverage"))
			.toEqual(["node", "-r", "tsconfig.ts", "--test", "--experimental-test-coverage", "a.test.mjs"]);
		expect(insertBeforeFirstPositional(["node", "--loader", "x.mjs", "--test"], "--experimental-test-coverage"))
			.toEqual(["node", "--loader", "x.mjs", "--test", "--experimental-test-coverage"]);
	});
	it("a bare -- ends the scan: flags land right before it", () => {
		expect(insertBeforeFirstPositional(["node", "--test", "--", "a.test.mjs"], "--experimental-test-coverage"))
			.toEqual(["node", "--test", "--experimental-test-coverage", "--", "a.test.mjs"]);
	});
	it("no positional → append (bare node --test shape unchanged)", () => {
		expect(insertBeforeFirstPositional(["node", "--test"], "--experimental-test-coverage"))
			.toEqual(["node", "--test", "--experimental-test-coverage"]);
	});
});

describe("F3 L2 — real node --import spawn with inserted coverage flag runs", () => {
	it("the corrupted shape is gone: node executes the test file", { timeout: 60_000 }, () => {
		const root = mkdtempSync(join(tmpdir(), "sd-f3-nodeimport-"));
		try {
			mkdirSync(join(root, "tests"));
			// A plain .mjs fixture avoids needing tsx: --import takes any specifier.
			writeFileSync(join(root, "side-effect.mjs"), "globalThis.imported = true;\n");
			writeFileSync(join(root, "tests", "ok.test.mjs"), "import test from 'node:test';\ntest('passes', () => {});\n");
			// The exact shape the old scanner corrupted, with TAP for a stable assertion.
			const argv = insertBeforeFirstPositional(
				["node", "--import", join(root, "side-effect.mjs"), "--test", "--test-reporter=tap", join(root, "tests", "ok.test.mjs")],
				"--experimental-test-coverage",
			);
			// Coverage flag must NOT sit between --import and its value.
			expect(argv.indexOf("--experimental-test-coverage")).toBeGreaterThan(argv.indexOf("--import") + 1);
			const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 30_000 });
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("# pass 1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
