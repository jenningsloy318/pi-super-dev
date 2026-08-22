/**
 * v0.3.12 — F1/F2: spec-track reuse absorption guard + merge close-out.
 * Incident: the 06 task was absorbed into the merged 05 track at Jaccard 0.64
 * (no numeral guard on the anchor branch), and merged tracks never wrote
 * .complete, so 05 stayed a live reuse candidate.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReusableSpec, SPEC_TASK_ANCHOR } from "../src/setup.ts";

// the REAL incident texts (05 track anchor vs the 06 task that was absorbed):
// measured Jaccard 0.643 >= 0.6 on unpatched main.
const TEMPLATE = (n: string, slug: string) =>
	`by referencing design docs/research/pi-omisis-master-design.md, implement docs/requirements/${n}-${slug}.md`;

function seedTrack(root: string, id: string, anchorTask: string): string {
	const dir = join(root, ".worktree", id, "docs", "specifications", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, SPEC_TASK_ANCHOR), anchorTask);
	// non-empty resume cache → isResumable true (no .complete)
	writeFileSync(join(dir, ".resume-cache.jsonl"), "row1\n");
	return dir;
}

describe("F1 — spec-reference numeral guard on the anchor-Jaccard branch", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "numguard-")); });
	afterEach(() => { rmSync(root, { recursive: true, force: true }); });

	it("T1: the 06 task must NOT reuse the 05 track (the incident texts — Jaccard 0.643 pre-fix)", () => {
		seedTrack(root, "05-independent-verification-gate", TEMPLATE("05", "verification"));
		const hit = findReusableSpec(root, TEMPLATE("06", "ai-policy"), { worktree: true });
		expect(hit).toBeNull();
	});

	it("T2 (control): the identical 05 task still reuses the 05 track", () => {
		seedTrack(root, "05-independent-verification-gate", TEMPLATE("05", "verification"));
		expect(findReusableSpec(root, TEMPLATE("05", "verification"), { worktree: true })).toBe("05-independent-verification-gate");
	});

	it("T3: a re-phrased task KEEPING the 05 spec reference still matches", () => {
		seedTrack(root, "05-independent-verification-gate", TEMPLATE("05", "verification"));
		const rephrased = `Implement docs/requirements/05-verification.md using the master design doc at docs/research/pi-omisis-master-design.md`;
		expect(findReusableSpec(root, rephrased, { worktree: true })).toBe("05-independent-verification-gate");
	});

	it("T4: free-text numerals WITHOUT a spec-reference shape do not trip the guard", () => {
		seedTrack(root, "07-staged-execution", `fix the retry ladder: 3 attempts, port 8080, ticket 1234 — implement docs/requirements/07-staged-execution.md`);
		// same numerals present, re-phrased, same spec ref 07 → still a match
		const task = `implement docs/requirements/07-staged-execution.md (retry 3 attempts on port 8080, ticket 1234)`;
		expect(findReusableSpec(root, task, { worktree: true })).toBe("07-staged-execution");
	});
});

describe("F2 — merge-verify pass writes .complete + clears the cache", () => {
	it("T5: a git-confirmed merge closes the track immediately", async () => {
		const root = mkdtempSync(join(tmpdir(), "mergeclose-"));
		try {
			const { execFileSync } = await import("node:child_process");
			const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			git(["init", "-q", "-b", "main"]);
			git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
			writeFileSync(join(root, "f.txt"), "x");
			git(["add", "-A"]); git(["commit", "-q", "-m", "init"]);
			const specDir = join(root, "docs", "specifications", "05-track");
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, ".resume-cache.jsonl"), "row1\n");
			const { mergeVerifyTask } = await import("../src/stages/writers.ts");
			const state = {
				merge: { merged: true, commitSha: "" },
				setup: { worktreePath: root, specDirectory: specDir, defaultBranch: "main" },
			} as never;
			const logs: string[] = [];
			const ctx = { log: (m: string) => logs.push(m) } as never;
			const r = await mergeVerifyTask.run(state, ctx);
			expect((r as { status?: string }).status).toBe("ok");
			expect(existsSync(join(specDir, ".complete"))).toBe(true);
			expect(readFileSync(join(specDir, ".resume-cache.jsonl"), "utf8")).toBe("");
			expect(logs.some((m) => m.includes("track closed"))).toBe(true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

describe("round-2 — CR-1/CR-2/CR-3/CR-4 regressions", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "numguard2-")); });
	afterEach(() => { rmSync(root, { recursive: true, force: true }); });

	it("CR-1: the containment branch also refuses a different-spec anchor (numeric-stripped slug)", () => {
		seedTrack(root, "09-verification-hardening-suite", TEMPLATE("09", "verification-hardening-suite"));
		const task = "add the verification hardening suite behavior described in docs/requirements/05-verification.md";
		expect(findReusableSpec(root, task, { worktree: true })).toBeNull();
	});

	it("CR-2: a source-path numeral (src/254-e2e/…) does NOT fabricate a spec ref — same-spec reuse survives", () => {
		seedTrack(root, "05-verification", TEMPLATE("05", "verification"));
		const task = "by referencing design docs/research/pi-omisis-master-design.md and the harness at src/254-e2e/loader.ts, implement docs/requirements/05-verification.md";
		expect(findReusableSpec(root, task, { worktree: true })).toBe("05-verification");
	});

	it("CR-3: a numeral refusal is LOGGED (not silent)", () => {
		seedTrack(root, "05-verification", TEMPLATE("05", "verification"));
		const logs: string[] = [];
		findReusableSpec(root, TEMPLATE("06", "ai-policy"), { worktree: true, log: (m) => logs.push(m) });
		expect(logs.some((m) => m.includes("refusing track") && m.includes("numeral 5"))).toBe(true);
	});

	it("CR-4: 4-digit spec numbers and zero-padding normalize (0042 == 42)", () => {
		seedTrack(root, "0042-large-refactor", "implement docs/requirements/0042-large-refactor.md");
		expect(findReusableSpec(root, "implement docs/requirements/42-large-refactor.md", { worktree: true })).toBe("0042-large-refactor");
	});
});
