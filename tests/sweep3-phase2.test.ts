/**
 * Codebase sweep-3 remediation, Phase 2 — RED oracle & build-gate correctness.
 * Fix groups (docs/requirements/sweep3-findings-dossier.md):
 *   G1   (blocker) go RED oracle maps FILE targets to PACKAGE dirs.
 *   G5   gate-side spawns carry maxBuffer 64MB.
 *   G11  audit B-items: B-1 stem restriction, B-2 rust -p resolution,
 *        B-7 pm-exec vitest fallback.
 *   G12  tolerantMatch alias relaxation anchored.
 *   G13  stripCommentsAndBlanks strips `#` only for #comment languages.
 *   G44  RED boundary 'spec' token narrowed to test-layout shapes.
 *
 * RED-first: FIX tests fail on pre-fix main; CONTROL tests pass on both trees.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const cpMock = vi.hoisted(() => ({
	stubber: null as null | ((args: string[], cwd?: string, opts?: Record<string, unknown>) => { status: number; stdout: string; stderr: string; signal: NodeJS.Signals | null; error?: Error }),
	spawned: [] as { args: string[]; opts?: Record<string, unknown> }[],
}));

vi.mock("node:child_process", async (importOriginal) => {
	const orig = await importOriginal<typeof import("node:child_process")>();
	return {
		...orig,
		spawnSync: ((cmd: string, argv: string[], opts?: Record<string, unknown>) => {
			cpMock.spawned.push({ args: [cmd, ...(Array.isArray(argv) ? argv : [])], opts });
			if (cpMock.stubber) return cpMock.stubber([cmd, ...(Array.isArray(argv) ? argv : [])], opts?.cwd as string | undefined, opts);
			return (orig.spawnSync as unknown as (c: string, a: string[], o?: unknown) => unknown)(cmd, argv, opts) as never;
		}) as typeof spawnSync,
	};
});

import { runRedCheck } from "../src/build-runner/gates.ts";
import { resolveIntegrationStems } from "../src/build-runner/detect.ts";
import { classifyObviousRedPath } from "../src/test-artifacts.ts";
import { tolerantMatch, stripCommentsAndBlanks } from "../src/build-runner/gates.ts";

function gitInit(dir: string): void {
	for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
	}
}

// ─── G1: go RED oracle package targets ─────────────────────────────────────

describe("G1 — go RED oracle maps file targets to package dirs", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sweep3-g1-"));
		cpMock.stubber = (args) => {
			if (args[0] === "go") return { status: 1, stdout: "", stderr: "--- FAIL: TestX (0.00s)\nFAIL\texample.com/app/pkg\t0.001s\n", signal: null };
			if (args[0] === "git") return { status: 128, stdout: "", stderr: "fatal: not a git repository", signal: null };
			return { status: 0, stdout: "", stderr: "", signal: null };
		};
		cpMock.spawned.length = 0;
	});
	afterEach(() => { cpMock.stubber = null; rmSync(dir, { recursive: true, force: true }); });

	it("FIX (RED pre-fix): pkg/prod_test.go target spawns `go test ./pkg` — NEVER the raw file path", () => {
		writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.26\n");
		mkdirSync(join(dir, "pkg"), { recursive: true });
		writeFileSync(join(dir, "pkg", "prod.go"), "package pkg\n");
		writeFileSync(join(dir, "pkg", "prod_test.go"), "package pkg\n");
		const plans: string[][] = [];
		runRedCheck(dir, ["pkg/prod_test.go"], { onPlan: (ps) => ps.forEach((p) => plans.push(p.argv)) });
		expect(plans.length).toBeGreaterThan(0);
		const goPlan = plans.find((a) => a[0] === "go" && a[1] === "test");
		expect(goPlan).toBeDefined();
		expect(goPlan).toEqual(["go", "test", "-json", "./pkg"]);
		expect(JSON.stringify(goPlan)).not.toContain("prod_test.go");
	});

	it("FIX (RED pre-fix): root-level test file maps to `.`", () => {
		writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.26\n");
		writeFileSync(join(dir, "main_test.go"), "package main\n");
		const plans: string[][] = [];
		runRedCheck(dir, ["main_test.go"], { onPlan: (ps) => ps.forEach((p) => plans.push(p.argv)) });
		const goPlan = plans.find((a) => a[0] === "go" && a[1] === "test");
		expect(goPlan).toEqual(["go", "test", "-json", "."]);
	});

	it("CONTROL: multiple files in one package dedupe to ONE package target", () => {
		writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.26\n");
		mkdirSync(join(dir, "pkg"), { recursive: true });
		writeFileSync(join(dir, "pkg", "a_test.go"), "package pkg\n");
		writeFileSync(join(dir, "pkg", "b_test.go"), "package pkg\n");
		const plans: string[][] = [];
		runRedCheck(dir, ["pkg/a_test.go", "pkg/b_test.go"], { onPlan: (ps) => ps.forEach((p) => plans.push(p.argv)) });
		const goPlans = plans.filter((a) => a[0] === "go" && a[1] === "test");
		expect(goPlans).toEqual([["go", "test", "-json", "./pkg"]]);
	});
});

// ─── G5: maxBuffer on gate spawns ──────────────────────────────────────────

describe("G5 — RED oracle spawns carry 64MB maxBuffer", () => {
	it("FIX (RED pre-fix): runRedCheck's spawnSync opts include maxBuffer ≥ 64MB", () => {
		const dir = mkdtempSync(join(tmpdir(), "sweep3-g5-"));
		try {
			cpMock.stubber = () => ({ status: 1, stdout: "", stderr: "AssertionError: red\n", signal: null });
			cpMock.spawned.length = 0;
			writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.26\n");
			mkdirSync(join(dir, "pkg"), { recursive: true });
			writeFileSync(join(dir, "pkg", "prod_test.go"), "package pkg\n");
			runRedCheck(dir, ["pkg/prod_test.go"]);
			const spawned = cpMock.spawned.find((s) => s.args[0] === "go" && s.args.includes("test"));
			expect(spawned).toBeDefined();
			expect(Number(spawned?.opts?.maxBuffer ?? 0)).toBeGreaterThanOrEqual(64 * 1024 * 1024);
		} finally {
			cpMock.stubber = null;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─── G11-B1: integration stems restricted to tests/ dirs ───────────────────

describe("G11-B1 — resolveIntegrationStems restricted to tests/ layouts", () => {
	it("FIX (RED pre-fix): src/foo.rs is NOT an integration stem; tests/real.rs is", () => {
		const dir = mkdtempSync(join(tmpdir(), "sweep3-b1-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, "tests"), { recursive: true });
			writeFileSync(join(dir, "src", "foo.rs"), "fn foo() {}\n");
			writeFileSync(join(dir, "tests", "real.rs"), "#[test]\nfn t() {}\n");
			const stems = resolveIntegrationStems(dir, ["src/foo.rs", "tests/real.rs"]);
			expect(stems).toEqual(["real"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─── G11-B2: rust fallback resolves -p package NAMES ───────────────────────

describe("G11-B2 — rust RED fallback resolves package names", () => {
	it("FIX (RED pre-fix): -p carries the Cargo.toml NAME (renamed-pkg), not the raw dir segment (foo)", () => {
		const dir = mkdtempSync(join(tmpdir(), "sweep3-b2-"));
		try {
			gitInit(dir);
			writeFileSync(join(dir, "Cargo.toml"), "[workspace]\nmembers = [\"crates/foo\"]\nresolver = \"2\"\n");
			mkdirSync(join(dir, "crates", "foo", "src"), { recursive: true });
			writeFileSync(join(dir, "crates", "foo", "Cargo.toml"), "[package]\nname = \"renamed-pkg\"\nversion = \"0.1.0\"\n");
			writeFileSync(join(dir, "crates", "foo", "src", "lib.rs"), "pub fn x() {}\n");
			cpMock.stubber = (args, cwd) => {
				if (args[0] === "cargo" && args.includes("metadata")) {
					const manifest = (cwd ?? dir) + "/crates/foo/Cargo.toml";
					return { status: 0, stdout: JSON.stringify({ packages: [{ name: "renamed-pkg", manifest_path: manifest }], workspace_members: [], resolve: null, target_directory: dir, version: 1 }), stderr: "", signal: null };
				}
				if (args[0] === "cargo") return { status: 101, stdout: "", stderr: "error: test failed\n", signal: null };
				if (args[0] === "git" && (args.includes("diff") || args.includes("ls-files"))) return { status: 0, stdout: "crates/foo/src/lib.rs\n", stderr: "", signal: null };
				if (args[0] === "git") return { status: 0, stdout: "", stderr: "", signal: null };
				return { status: 0, stdout: "", stderr: "", signal: null };
			};
			cpMock.spawned.length = 0;
			const plans: Array<{ cwd: string; argv: string[] }> = [];
			runRedCheck(dir, ["crates/foo/src/does_not_exist_test.rs"], { onPlan: (ps) => ps.forEach((p) => plans.push(p)) });
			// v0.3.31: the cargo convention scopes by running AT the nearest
			// crate (crates/foo) instead of resolving workspace -p names from
			// the root — same single-crate scope, no metadata spawn needed.
			const cargoPlan = plans.find((p) => p.argv[0] === "cargo");
			expect(cargoPlan).toBeDefined();
			expect(cargoPlan?.cwd.replace(/\\/g, "/")).toContain("crates/foo");
			expect(cargoPlan).not.toContain("foo");
		} finally {
			cpMock.stubber = null;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─── G12: tolerantMatch alias relaxation anchored ──────────────────────────

describe("G12 — tolerantMatch one-letter alias anchored", () => {
	it("CONTROL: a genuine alias pattern still matches", () => {
		expect(tolerantMatch("h\\.POST\\s*\\(", "  h.POST (y)")).toBe(true);
	});
	it("FIX (RED pre-fix): a pattern merely CONTAINING 'h.' is not silently widened", () => {
		// e.g. an agent pattern intending `path.` — contains the substring 'h.'
		// Pre-fix the relaxation matches far more than the documented h.POST case.
		expect(tolerantMatch("auth\\.something", "authXsomething")).toBe(false);
	});
});

// ─── G13: # stripping is language-aware ────────────────────────────────────

describe("G13 — stripCommentsAndBlanks keeps # lines for #syntax languages", () => {
	it("CONTROL: python/ruby/sh # comment lines are stripped", () => {
		expect(stripCommentsAndBlanks("# a comment\nx = 1\n", "script.py")).not.toContain("# a comment");
	});
	it("FIX (RED pre-fix): Rust #[derive] attribute lines survive", () => {
		expect(stripCommentsAndBlanks("#[derive(Debug)]\nstruct S;\n", "rs")).toContain("#[derive(Debug)]");
	});
	it("FIX (RED pre-fix): C #include survives", () => {
		expect(stripCommentsAndBlanks("#include <stdio.h>\nint main(){}\n", "c")).toContain("#include");
	});
	it("FIX (RED pre-fix): JS #private field survives", () => {
		expect(stripCommentsAndBlanks("class A { #x = 1; }\n", "ts")).toContain("#x");
	});
});

// ─── G44: RED boundary spec token narrowed ─────────────────────────────────

describe("G44 — RED boundary 'spec' token narrowed to test-layout shapes", () => {
	it("CONTROL: rspec-style _spec.rb and __specs__ dirs stay allowed", () => {
		expect(classifyObviousRedPath("spec/models/user_spec.rb").category).toBe("test");
		expect(classifyObviousRedPath("app/__specs__/thing_spec.ts").category).toBe("test");
	});
	it("FIX (RED pre-fix): src/specRegistry.ts is NOT deterministically allowed — ambiguous for the evaluator", () => {
		const c = classifyObviousRedPath("src/specRegistry.ts");
		expect(c.category).toBe("ambiguous");
		expect(c.allowed).toBe(false);
	});
	it("FIX (RED pre-fix): internal/spec/loader.go is ambiguous", () => {
		expect(classifyObviousRedPath("internal/spec/loader.go").category).toBe("ambiguous");
	});
	it("CONTROL: src/authService.ts (no test token) stays ambiguous", () => {
		expect(classifyObviousRedPath("src/authService.ts").category).toBe("ambiguous");
	});
});

describe("v0.3.62 — stripCommentsAndBlanks is string-aware (run 2026-09-02T10-18-31-007Z)", () => {
	const GLOB = "tests/" + "**" + "/*.test.ts";

	it("a slash-star pair inside a // line comment no longer swallows following code", () => {
		const src = [
			`// collected by the vitest include glob ${GLOB}) above`,
			'export const TARGET = "gate-properties.test.ts";',
		].join("\n");
		const stripped = stripCommentsAndBlanks(src, "x.test.ts");
		expect(stripped).toContain("TARGET");
		expect(stripped).toContain("gate-properties.test.ts");
		expect(stripped).not.toContain("collected by");
	});

	it("comment markers inside single/double-quoted strings are inert", () => {
		const src = `const a = "not // comment";\nconst b = 'not /* either';\nexport const TARGET = 1;`;
		const stripped = stripCommentsAndBlanks(src, "x.ts");
		expect(stripped).toContain('"not // comment"');
		expect(stripped).toContain("'not /* either'");
		expect(stripped).toContain("TARGET");
	});

	it("template literals are strings; dollar-brace interpolation is scanned as code", () => {
		const src = "const t = `x ${/* inner */ 1} y`;\nexport const TARGET = 2;";
		const stripped = stripCommentsAndBlanks(src, "x.ts");
		expect(stripped).toContain("TARGET");
		expect(stripped).not.toContain("inner");
		expect(stripped).toContain("`x ");
		expect(stripped).toContain("1} y`");
	});

	it("inline // and # comments are removed (stricter; matches the documented contract)", () => {
		expect(stripCommentsAndBlanks("const a = 1; // tag: X", "a.ts")).not.toContain("tag: X");
		expect(stripCommentsAndBlanks("x = 1  # tag: Y\n", "a.py")).not.toContain("tag: Y");
		expect(stripCommentsAndBlanks("x = 1  # tag: Y\n", "a.py")).toContain("x = 1");
	});

	it("non-hash languages keep # and non-comment slashes (rust attribute, division)", () => {
		expect(stripCommentsAndBlanks("#[derive(Debug)]\nstruct S;\nlet a = b / c;\n", "rs")).toContain("#[derive(Debug)]");
		expect(stripCommentsAndBlanks("#[derive(Debug)]\nstruct S;\nlet a = b / c;\n", "rs")).toContain("b / c");
	});

	it("unterminated string consumes to EOF without throwing; empty source stays empty", () => {
		// String content is kept verbatim (it is not comment text); no crash, no hang.
		expect(stripCommentsAndBlanks('const a = "unterminated /* x', "a.ts")).toContain('const a = "unterminated /* x');
		expect(stripCommentsAndBlanks("", "a.ts")).toBe("");
	});
});
