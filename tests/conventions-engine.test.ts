/**
 * v0.3.31 — conventions engine (TDD RED).
 *
 * Contract: per-language/toolchain knowledge lives ONLY in the conventions
 * DATA table (src/build-runner/conventions.ts). The oracle engine
 * (gates.ts runRedCheck) contains ZERO language branches: it interprets
 * convention rows through a generic vocabulary (anchors, wrapper, package
 * manager, target transforms, structured result channels).
 *
 * Research grounding (2026-08-29 deep-dive):
 *   - Bazel test encyclopedia: exit code is the ONLY authoritative gate;
 *     console prose never classifies.
 *   - SWE-Factory: scoped targets + runner knowledge are data/agent-authored,
 *     not harness code.
 *   - gotestsum/pytest/vitest/nextest: structured output is a runner FLAG —
 *     expressible as convention data.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conventionPlansFor, RUNNER_CONVENTIONS, type ConventionPlan } from "../src/build-runner/conventions.ts";

/** Direct conventionPlansFor callers own the tmp junit dirs plans carry
 *  (runRedCheck cleans them in its finally; tests must mirror that). */
function cleanupPlans(plans: ConventionPlan[]): void {
	for (const dir of plans.flatMap((p) => p.cleanupDirs ?? [])) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "conv-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const p = join(root, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
}

describe("conventions table — structural invariants (no code-side language knowledge)", () => {
	it("ships rows for the previously-hardcoded stacks via DATA only", () => {
		const ids = RUNNER_CONVENTIONS.map((c) => c.id).sort();
		for (const id of ["npm-family", "python-pytest", "go-test", "cargo-test", "gradle", "maven"]) {
			expect(ids, `convention ${id} must exist as data`).toContain(id);
		}
	});

	it("every row declares a STRUCTURED result channel (Bazel principle: prose never classifies)", () => {
		for (const c of RUNNER_CONVENTIONS) {
			expect(c.results, `${c.id} must declare results`).toBeTruthy();
			expect(c.results.format, `${c.id} channel format`).toMatch(/^(junit-xml|tap|gojson|counts|auto)$/);
		}
	});

	it("every row declares manifest anchors (no stack matches without a file anchor)", () => {
		for (const c of RUNNER_CONVENTIONS) {
			expect(c.anchors.length, `${c.id} anchors`).toBeGreaterThan(0);
		}
	});
});

describe("npm-vitest — scoped plan at the owning package dir", () => {
	it("builds pm-exec vitest run --reporter=tap with positional targets (structured tap channel)", () => {
		write("package.json", JSON.stringify({ name: "x", devDependencies: { vitest: "^3.0.0" } }));
		write("tests/a.test.ts", "x");
		const plans = conventionPlansFor(root, ["tests/a.test.ts"]);
		expect(plans).toHaveLength(1);
		expect(plans[0].conventionId).toBe("npm-vitest");
		expect(plans[0].argv.slice(0, 3)).toEqual(["npm", "exec", "vitest"]);
		// v0.3.56 F1 (class B): the `--` guard after the tool token keeps child
		// flags out of npm's config parser (unguarded control empirically leaks
		// npm's own `--version` — see defect-ledger 2026-09-01).
		expect(plans[0].argv[3]).toBe("--");
		expect(plans[0].argv).toContain("--reporter=tap");
		expect(plans[0].argv.at(-1)).toBe("tests/a.test.ts");
		expect(plans[0].cwd).toBe(root);
		expect(plans[0].channel.format).toBe("tap");
	});

	it("resolves the NEAREST package dir for workspace targets", () => {
		write("package.json", JSON.stringify({ name: "ws", workspaces: ["packages/*"] }));
		write("packages/lib/package.json", JSON.stringify({ name: "lib", devDependencies: { vitest: "*"} }));
		write("packages/lib/src/t.test.ts", "x");
		const plans = conventionPlansFor(root, ["packages/lib/src/t.test.ts"]);
		expect(plans[0].cwd).toBe(join(root, "packages/lib"));
		expect(plans[0].argv.at(-1)).toBe("src/t.test.ts");
	});

	it("honors packageManager field (pnpm) over npm", () => {
		write("package.json", JSON.stringify({ name: "x", packageManager: "pnpm@9", devDependencies: { vitest: "*" } }));
		const plans = conventionPlansFor(root, ["tests/a.test.ts"]);
		expect(plans[0].argv[0]).toBe("pnpm");
	});
});

describe("npm-node-test — tap channel from the runner itself", () => {
	it("uses --test --test-reporter=tap when only node:test is in use", () => {
		write("package.json", JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
		write("tests/a.test.mjs", "import { test } from 'node:test';\n");
		const plans = conventionPlansFor(root, ["tests/a.test.mjs"]);
		expect(plans[0].conventionId).toBe("npm-node-test");
		expect(plans[0].argv).toContain("--test-reporter=tap");
		expect(plans[0].argv.at(-1)).toBe("tests/a.test.mjs");
		expect(plans[0].channel.format).toBe("tap");
	});
});

describe("python-pytest — junit redirected OUTSIDE the worktree", () => {
	it("emits --junitxml to a per-run temp path and declares the xml channel", () => {
		write("pyproject.toml", "[tool.pytest.ini_options]\n");
		const plans = conventionPlansFor(root, ["tests/test_x.py"]);
		cleanupPlans(plans);
		const i = plans[0].argv.findIndex((a) => a.startsWith("--junitxml="));
		expect(i).toBeGreaterThan(0);
		const path = plans[0].argv[i].slice("--junitxml=".length);
		expect(path.startsWith(tmpdir()), "junit must not pollute the worktree").toBe(true);
		expect(plans[0].argv.at(-1)).toBe("tests/test_x.py");
		expect(plans[0].channel.format).toBe("junit-xml");
		expect(plans[0].channel).toMatchObject({ format: "junit-xml" });
	});
});

describe("go-test — json events + package-dir scoping", () => {
	it("runs go test -json with the target's package dir", () => {
		write("go.mod", "module x\n");
		write("pkg/a_test.go", "x");
		const plans = conventionPlansFor(root, ["pkg/a_test.go"]);
		expect(plans[0].argv).toEqual(["go", "test", "-json", "./pkg"]);
		expect(plans[0].channel).toMatchObject({ format: "gojson" });
	});
});

describe("gradle — wrapper discovery, FQN scoping, android task", () => {
	it("scopes via --tests <FQN> using src/test/java roots and the gradlew wrapper", () => {
		write("settings.gradle", "rootProject.name = 'x'\n");
		write("gradlew", "#!/bin/sh\n");
		write("src/test/java/com/example/WidgetTest.java", "x");
		const plans = conventionPlansFor(root, ["src/test/java/com/example/WidgetTest.java"]);
		expect(plans[0].argv[0]).toBe(join(root, "gradlew"));
		expect(plans[0].argv).toContain("--tests");
		expect(plans[0].argv).toContain("com.example.WidgetTest");
		expect(plans[0].channel).toMatchObject({ format: "junit-xml" });
	});

	it("selects testDebugUnitTest when the manifest declares the android plugin", () => {
		write("settings.gradle.kts", "rootProject.name = \"x\"\n");
		write("build.gradle.kts", "plugins { id(\"com.android.application\") }\n");
		write("gradlew", "#!/bin/sh\n");
		write("app/src/test/java/com/example/YTest.kt", "x");
		const plans = conventionPlansFor(root, ["app/src/test/java/com/example/YTest.kt"]);
		expect(plans[0].argv).toContain("testDebugUnitTest");
		const testsIdx = plans[0].argv.indexOf("--tests");
		expect(plans[0].argv[testsIdx + 1]).toBe("com.example.YTest");
	});
});

describe("maven — -Dtest=<FQN> scoping with surefire channel", () => {
	it("builds mvn test -Dtest=<FQN>", () => {
		write("pom.xml", "<project></project>\n");
		write("src/test/java/com/z/WidgetTest.java", "x");
		const plans = conventionPlansFor(root, ["src/test/java/com/z/WidgetTest.java"]);
		expect(plans[0].argv[0]).toBe("mvn");
		expect(plans[0].argv).toContain("-Dtest=com.z.WidgetTest");
	});
});

describe("matching discipline", () => {
	it("returns NO plans when no anchor matches (unknown stack stays unknown)", () => {
		write("README.md", "nothing here\n");
		expect(conventionPlansFor(root, ["whatever.ts"])).toHaveLength(0);
	});

	it("requires the tool to be present for tool-gated rows (vitest row skips a bare npm repo)", () => {
		write("package.json", JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
		write("tests/a.test.mjs", "import { test } from 'node:test';\n");
		const plans = conventionPlansFor(root, ["tests/a.test.mjs"]);
		expect(plans[0].conventionId).toBe("npm-node-test");
		expect(plans[0].argv).toContain("--test-reporter=tap");
	});
});
