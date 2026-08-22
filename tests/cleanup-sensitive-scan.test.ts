/**
 * A-3 (repo-wide audit): the cleanup sensitive-data scan must operate on the
 * GIT-CARRIED view — only content that would actually reach the merge — and a
 * cleanup-blocked run must never be reported as `success`.
 *
 * Failure being fixed: setup copies `.env` files into created worktrees (so
 * integration tests can authenticate), cleanup then flagged the untracked copy
 * as sensitive, the merge was silently skipped, and runWorkflow still printed
 * "success". Four language-agnostic surfaces are pinned here:
 *   1. committed/staged/modified tracked sensitive files DO block;
 *   2. untracked copies (the pipeline-copied shape) NEVER block;
 *   3. non-git dirs fall back to the legacy root scan;
 *   4. workflow status honesty — blocked cleanup ⇒ partial, never success.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runHelper, blocksCleanupEnvBasename, ENV_VARIANT_BASENAME_RE } from "../src/helpers.ts";
import { isEnvFile } from "../src/setup.ts";
import { runWorkflow } from "../src/workflow.ts";
import type { Node, NodeResult, PipelineState } from "../src/types.ts";

const gitInit = (dir: string, branch = "main"): void => {
	execSync(`git init -b ${branch}`, { cwd: dir, stdio: "ignore" });
	execSync('git config user.email t@t && git config user.name t', { cwd: dir, shell: "/bin/bash", stdio: "ignore" });
};
const git = (dir: string, cmd: string): void => { execSync(cmd, { cwd: dir, stdio: "ignore" }); };

/** A repo on a feature branch with one committed production file. */
function featureRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "sd-a3-"));
	gitInit(root);
	writeFileSync(join(root, "src.txt"), "v1\n");
	git(root, "git add -A && git commit -m base");
	git(root, "git checkout -b feature/x");
	writeFileSync(join(root, "src.txt"), "v2\n");
	git(root, "git add -A && git commit -m work");
	return root;
}

const cleanupRun = (cwd: string, defaultBranch?: string) =>
	runHelper({ name: "cleanup", sources: {}, context: { cwd, worktreeCreated: true, ...(defaultBranch ? { defaultBranch } : {}) } });

describe("cleanup sensitive-data scan (A-3 git-carried view)", () => {
	it("blocks a tracked .env COMMITTED on the feature branch (would be merged)", async () => {
		const root = featureRepo();
		try {
			writeFileSync(join(root, ".env"), "SECRET=1\n");
			git(root, "git add .env && git commit -m add-env");
			const r = await cleanupRun(root, "main");
			expect(r.value.blocked).toBe(true);
			expect(r.value.sensitiveDataFindings).toEqual(["Sensitive file in merge set: .env"]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("blocks a STAGED .env (the merge agent would commit it)", async () => {
		const root = featureRepo();
		try {
			writeFileSync(join(root, ".env"), "SECRET=1\n");
			git(root, "git add .env");
			const r = await cleanupRun(root, "main");
			expect(r.value.blocked).toBe(true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("does NOT block an UNTRACKED .env (the setup-copied worktree shape)", async () => {
		const root = featureRepo();
		try {
			writeFileSync(join(root, ".env"), "SECRET=1\n"); // untracked — never merged
			const r = await cleanupRun(root, "main");
			expect(r.value.blocked).toBe(false);
			expect(r.value.sensitiveDataFindings).toEqual([]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("does not block an untracked .env even when no default branch can be resolved (tracked-list fallback excludes untracked)", async () => {
		const root = featureRepo();
		try {
			writeFileSync(join(root, ".env"), "SECRET=1\n");
			const r = await cleanupRun(root, "no-such-branch");
			expect(r.value.blocked).toBe(false);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("blocks a tracked sensitive file MODIFIED in the working tree", async () => {
		const root = featureRepo();
		try {
			writeFileSync(join(root, "creds.pem"), "old\n");
			git(root, "git add creds.pem && git commit -m add-pem");
			writeFileSync(join(root, "creds.pem"), "new-secret\n"); // tracked, modified, unstaged
			const r = await cleanupRun(root, "main");
			expect(r.value.blocked).toBe(true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("falls back to the legacy ROOT scan when the directory is not a git repo", async () => {
		const root = mkdtempSync(join(tmpdir(), "sd-a3-nogit-"));
		try {
			writeFileSync(join(root, ".env"), "SECRET=1\n");
			const r = await cleanupRun(root, "main");
			expect(r.value.blocked).toBe(true);
			expect(r.value.sensitiveDataFindings).toEqual(["Sensitive file detected: .env"]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

// H6/AC-07: the blocklist predicate is DERIVED from the copier — the exported
// isEnvFile predicate (setup.ts, the copier's own gate) + the env-variant
// basename shape. Never a divergent hardcoded list.
describe("blocksCleanupEnvBasename / ENV_VARIANT_BASENAME_RE (AC-07 derived blocklist)", () => {
	it("isEnvFile is exported from setup.ts (the copier's own predicate)", () => {
		expect(isEnvFile(".env")).toBe(true);
		expect(isEnvFile(".env.development")).toBe(true);
		expect(isEnvFile(".env.example")).toBe(false);
	});

	it("ENV_VARIANT_BASENAME_RE matches the dotenv/Vite env-variant shape only", () => {
		for (const base of [".env", ".env.development", ".env.staging", ".env.prod", ".env.ci", ".env.local", ".env.production", ".env.qa.eu-west", ".env.example", ".env.template"]) {
			// shape-only: `.env.example` IS an env-variant basename shape — the
			// example/template/sample exclusion lives in isEnvFile (via
			// blocksCleanupEnvBasename), not in this regex
			expect(ENV_VARIANT_BASENAME_RE.test(base), base).toBe(true);
		}
		for (const base of [".envrc", ".environment", "env", "foo.env.txt"]) {
			expect(ENV_VARIANT_BASENAME_RE.test(base), base).toBe(false);
		}
	});

	it("blocksCleanupEnvBasename: every basename the copier would copy blocks; example/template/sample never do", () => {
		for (const base of [".env", ".env.development", ".env.staging", ".env.prod", ".env.ci", ".env.local", ".env.production"]) {
			expect(blocksCleanupEnvBasename(base), base).toBe(true);
		}
		for (const base of [".env.example", ".env.template", ".env.sample", ".env.production.sample", ".envrc", ".environment", "env", "creds.pem", "id_rsa"]) {
			expect(blocksCleanupEnvBasename(base), base).toBe(false);
		}
	});
});

// ── H6 (AC-07 / SCENARIO-015, SCENARIO-016): the env blocklist is DERIVED from
// the copier — every basename `copyEnvFilesToWorktree` would copy (any
// `.env`/`.env.<variant>`, minus example/template/sample) blocks cleanup when
// git-carried; example env templates never do.
describe("cleanup blocks every copied env variant (AC-07)", () => {
	it("blocks committed apps/web/.env.development, apps/web/.env.staging, .env.prod, and .env.ci (SCENARIO-015)", async () => {
		const root = featureRepo();
		try {
			mkdirSync(join(root, "apps", "web"), { recursive: true });
			writeFileSync(join(root, "apps", "web", ".env.development"), "DEV=1\n");
			writeFileSync(join(root, "apps", "web", ".env.staging"), "STG=1\n");
			writeFileSync(join(root, ".env.prod"), "PROD=1\n");
			writeFileSync(join(root, ".env.ci"), "CI=1\n");
			git(root, "git add -A && git commit -m add-envs");
			const r = await cleanupRun(root, "main");
			expect(r.value.blocked).toBe(true);
			expect(r.value.sensitiveDataFindings).toEqual([
				"Sensitive file in merge set: .env.ci",
				"Sensitive file in merge set: .env.prod",
				"Sensitive file in merge set: apps/web/.env.development",
				"Sensitive file in merge set: apps/web/.env.staging",
			]);
			expect(r.digest.startsWith("BLOCKED:")).toBe(true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("a committed .env.example does not block (SCENARIO-016)", async () => {
		const root = featureRepo();
		try {
			mkdirSync(join(root, "apps", "web"), { recursive: true });
			writeFileSync(join(root, "apps", "web", ".env.example"), "EXAMPLE=1\n");
			git(root, "git add -A && git commit -m add-example");
			const r = await cleanupRun(root, "main");
			expect(r.value.blocked).toBe(false);
			expect(r.value.sensitiveDataFindings).toEqual([]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("blocks committed .env.development in the legacy non-git root scan too (blocklist derived from the copier)", async () => {
		const root = mkdtempSync(join(tmpdir(), "sd-h6-nogit-"));
		try {
			writeFileSync(join(root, ".env.development"), "DEV=1\n");
			writeFileSync(join(root, ".env.example"), "EXAMPLE=1\n");
			const r = await cleanupRun(root);
			expect(r.value.blocked).toBe(true);
			expect(r.value.sensitiveDataFindings).toEqual(["Sensitive file detected: .env.development"]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

/** seed-node scaffolding mirroring tests/workflow.test.ts. */
function seed(patch: Partial<PipelineState>): Node {
	return {
		kind: "task",
		async run(state) {
			Object.assign(state, patch);
			return { status: "ok" } as NodeResult;
		},
	};
}
const wf = (root: Node) => ({ id: "test", root });

describe("runWorkflow status honesty for cleanup-blocked runs (A-3)", () => {
	const greenBase = {
		implementation: { totalPhases: 2, phasesCompleted: 2, allGreen: true },
		review: { verdict: "Approved" },
		preMergeBuild: { pass: true },
		buildGate: { pass: true }, // sweep-3 G9: success requires an affirmative build gate
	};
	it("a green run with a cleanup BLOCKED merge reports partial — never success", async () => {
		const s = await runWorkflow(
			wf(seed({ ...greenBase, cleanup: { blocked: true, sensitiveDataFindings: ["Sensitive file in merge set: .env"] } } as Partial<PipelineState>)),
			"t",
		);
		expect(s.status).toBe("partial");
	});
	it("a green run with an UNBLOCKED, merged cleanup still reports success (no regression)", async () => {
		const s = await runWorkflow(
			wf(seed({ ...greenBase, cleanup: { blocked: false }, merge: { merged: true } } as Partial<PipelineState>)),
			"t",
		);
		expect(s.status).toBe("success");
	});
});
