import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveRedBoundary } from "../src/stages/implementation.ts";
import { runHelper } from "../src/helpers.ts";
import type { AgentCall, AgentResult, Budget, HelperCall, PipelineState, StageContext } from "../src/types.ts";

// ─── v0.3.24 S4-3 (revised) ───────────────────────────────────────────────────
// The greenfield compiled-language RED trap (run 12-51-40) is fixed by
// SUFFIX-TOLERANT matching (S4-1): the evaluator's verdict on a
// declaration-only scaffold must LAND even when it echoes absolute worktree
// paths. A deliberately omitted verdict still DENIES — "new file + failing
// RED" alone does not prove declaration-only content (a RED agent can write
// partial real implementation), so there is no deterministic scaffold repair;
// the escape hatches are the evaluator itself, the widened late judge floor
// (fix-environment + allow-scaffold), and noise-free signature cycle
// detection (S4-2). These pins hold resolveRedBoundary to that contract.

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sd-scaffold-proof-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@test.test"]);
	git(dir, ["config", "user.name", "test"]);
	writeFileSync(join(dir, "README.md"), "baseline\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-q", "-m", "baseline"]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function verdictCtx(agentCalls: { count: number }, classifications: Array<Record<string, unknown>>): StageContext {
	return {
		task: "implement feature",
		options: {},
		state: { setup: undefined } as unknown as PipelineState,
		budget: { count: 0, check: () => true, spent() { this.count++; return true; } } satisfies Budget,
		log() {},
		phase() {},
		events: new EventEmitter(),
		results: [],
		async agent(_call: AgentCall): Promise<AgentResult> {
			agentCalls.count++;
			return { text: "", control: { classifications, allAllowed: true } };
		},
		async helper(call: HelperCall) { return runHelper(call); },
		async parallel(calls) { return Promise.all(calls.map((call) => call())); },
	};
}

function args(cwd: string, changedFiles: string[], redStatus: "red" | "broken", ctx: StageContext) {
	return {
		ctx,
		phaseId: "phase-01",
		phaseName: "phase-01",
		phase: {},
		redStatus,
		testFiles: ["app/src/test/java/dev/FooTest.kt"],
		changedFiles,
		cwd,
	};
}

const NEW_KT = "app/src/main/java/dev/Foo.kt";

describe("S4-3 resolveRedBoundary scaffold/pollution contract", () => {
	it("a scaffold verdict with an ABSOLUTE path echo lands: new untracked declaration-only file + failing RED is ALLOWED (run 12-51-40 fix, end-to-end)", async () => {
		mkdirSync(join(dir, "app/src/main/java/dev"), { recursive: true });
		writeFileSync(join(dir, NEW_KT), "class Foo { fun bar(): Int = error(\"not implemented\") }\n");
		const agentCalls = { count: 0 };
		const ctx = verdictCtx(agentCalls, [{ path: join(dir, NEW_KT), category: "scaffold", confidence: 0.9, reason: "declaration-only; error() stubs" }]);

		const result = await resolveRedBoundary(args(dir, [NEW_KT], "red", ctx));

		const row = result.classifications.find((c) => c.path === NEW_KT);
		expect(row?.allowed).toBe(true);
		expect(row?.category).toBe("scaffold");
		expect(row?.source).toBe("agent");
		expect(result.forbiddenFiles).toEqual([]);
		expect(agentCalls.count).toBe(1);
	});

	it("an omitted verdict still DENIES a new untracked production file (no deterministic repair — pollution contract preserved)", async () => {
		mkdirSync(join(dir, "app/src/main/java/dev"), { recursive: true });
		writeFileSync(join(dir, NEW_KT), "class Foo { fun bar(): Int = error(\"not implemented\") }\n");
		const agentCalls = { count: 0 };
		const ctx = verdictCtx(agentCalls, []); // evaluator said nothing about this path

		const result = await resolveRedBoundary(args(dir, [NEW_KT], "red", ctx));

		const row = result.classifications.find((c) => c.path === NEW_KT);
		expect(row?.allowed).toBe(false);
		expect(row?.source).toBe("fallback");
	});

	it("an explicit production verdict on a new file is forbidden even with failing tests (a RED agent writing real implementation stays pollution)", async () => {
		mkdirSync(join(dir, "app/src/main/java/dev"), { recursive: true });
		writeFileSync(join(dir, NEW_KT), "class Foo { fun bar(): Int = 42 }\n");
		const agentCalls = { count: 0 };
		const ctx = verdictCtx(agentCalls, [{ path: NEW_KT, category: "production", confidence: 0.95, reason: "real behavior" }]);

		const result = await resolveRedBoundary(args(dir, [NEW_KT], "red", ctx));

		const row = result.classifications.find((c) => c.path === NEW_KT);
		expect(row?.allowed).toBe(false);
		expect(row?.source).toBe("agent");
		expect(result.forbiddenFiles).toContain(NEW_KT);
	});
});
