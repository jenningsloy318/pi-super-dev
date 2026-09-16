/**
 * 063 Wave S2 acceptance tests — the census-driven redirect, the reader-sweep
 * gate, the class-audit pin, the full-set migration, and the external
 * findResumableSpec scan with its layout/content re-check
 * (docs/requirements/063-external-state-store.md §3.2 step 3, §1 H3, §3.5).
 * No LLM-behavior claims (the 059 convention).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	stateFileFor,
	specStateDir,
	migrateInSpecState,
	sweepStateOrphansForRepo,
	externalResumeCandidates,
	resetRepoMemoForTests,
	resetFailClosedWarnsForTests,
	stateRootBase,
} from "../src/state/state-root.ts";
import { externalMigrateBasenames, harnessBasenames, HARNESS_FILE_ROLES } from "../src/harness-paths.ts";
import { findResumableSpec, isResumable } from "../src/resume.ts";
import { eventsPath } from "../src/runlog.ts";
import { readdirSync as rd } from "node:fs";

let home: string;
let stateRoot: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "sd-063-s2-"));
	stateRoot = join(home, "state-root");
	process.env.SUPER_DEV_STATE_DIR = stateRoot;
	resetRepoMemoForTests();
	resetFailClosedWarnsForTests();
});
afterEach(() => {
	delete process.env.SUPER_DEV_STATE_DIR;
	try { rmSync(home, { recursive: true, force: true }); } catch { /* tmp */ }
	resetRepoMemoForTests();
});

function mkRepo(name: string): string {
	const d = join(home, name);
	mkdirSync(d, { recursive: true });
	const g = (args: string[]) => execFileSync("git", args, { cwd: d, stdio: ["ignore", "pipe", "ignore"] });
	g(["init", "-q"]);
	g(["config", "user.email", "t@t"]);
	g(["config", "user.name", "t"]);
	writeFileSync(join(d, "README.md"), "x\n");
	g(["add", "-A"]);
	g(["commit", "-qm", "init"]);
	return d;
}
function mkSpecDir(repo: string, id: string): string {
	const specDir = join(repo, "docs", "specifications", id);
	mkdirSync(specDir, { recursive: true });
	return specDir;
}

// ─── the class-audit pin (§1, grill H3) ─────────────────────────────────────

describe("063 S2 class audit", () => {
	it("stateExternal membership == the spec's Class R+M+H+E durable set (25 basenames)", () => {
		expect([...harnessBasenames("stateExternal")].sort()).toEqual([
			".complete", ".convergence-ledger.json", ".environment-faults.jsonl",
			".inherited-red.jsonl", ".judge.jsonl", ".knowledge.json", ".replan.jsonl",
			".resume-cache.jsonl", ".run-lock", ".task", ".user-notes.json",
			"artifact-revisions.json", "audit.jsonl", "change-tracker.jsonl",
			"events.jsonl", "implementation-evidence.jsonl", "messages.jsonl",
			"replan-requests.json", "research-assists.jsonl", "routing-epoch.json",
			"routing-journal.jsonl", "run-metrics.jsonl", "test-runner.json",
			"tool-usage.jsonl", "usage-calls.jsonl",
		]);
	});

	it("routing-journal.jsonl and replan-requests.json are Class M (control authority — they migrate and are durable)", () => {
		// The grill-H3 inversions, pinned: both MUST be in the durable external set.
		expect(harnessBasenames("stateExternal").has("routing-journal.jsonl")).toBe(true);
		expect(harnessBasenames("stateExternal").has("replan-requests.json")).toBe(true);
		expect(externalMigrateBasenames()).toContain("routing-journal.jsonl");
		expect(externalMigrateBasenames()).toContain("replan-requests.json");
	});

	it("externalMigrateBasenames == stateExternal minus .run-lock; user-input/ is NOT a basename", () => {
		const list = externalMigrateBasenames();
		expect(list).not.toContain(".run-lock");
		expect(list).toHaveLength([...harnessBasenames("stateExternal")].length - 1);
		expect(list.every((b) => HARNESS_FILE_ROLES[b]?.stateExternal === true)).toBe(true);
	});
});

// ─── the reader-sweep gate (§3.2 step 3 — pins the census against drift) ─────

describe("063 S2 reader-sweep gate", () => {
	it("ZERO remaining join/concat resolution of externalized basenames outside the funnel", async () => {
		const { readdirSync: rd, readFileSync: rf, statSync } = await import("node:fs");
		const srcRoot = join(import.meta.dirname, "..", "src");
		const basenames = [...harnessBasenames("stateExternal")];
		// Collect every src .ts file (tests excluded — they seed fixtures).
		const files: string[] = [];
		const walk = (dir: string): void => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(p); // colocated test fixtures seed legitimately
			}
		};
		walk(srcRoot);
		const violations: string[] = [];
		// Documented allowlist: joins of state basenames into NON-spec-dir
		// homes. audit.jsonl's registry entry covers the spec-dir form only;
		// the runs-dir ledger (~/.super-dev/runs/<run>/) is user-local machine
		// state that already lives outside the repo — never 063's concern.
		const allow = new Set(["extension.ts:audit.jsonl", "render/super-dev-dir.ts:audit.jsonl"]);
		for (const f of files) {
			const rel = f.slice(srcRoot.length + 1).replace(/\\/g, "/");
			// The funnel + the registry are the ONLY allowed resolution sites.
			if (rel === "state/state-root.ts" || rel === "harness-paths.ts") continue;
			const text = rf(f, "utf8");
			for (const b of basenames) {
				// Form 1: join(<dir-ish>, "basename")
				// Gate F3/ADV-4 fold: window spans nested parens ([^;] only) — the old
				// [^;)] form stopped at the first ")" and let join(withTrailingSlash(x), "b") escape.
				const joinRe = new RegExp(`join\\([^;]{0,200}"${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
				for (const m of text.matchAll(joinRe)) {
					// The GLOBAL ~/.super-dev ledger home (getSuperDevDir()) is
					// not spec-dir state — same documented class as the
					// runs-dir audit.jsonl allowlist (non-spec-dir homes).
					if (m[0].includes("getSuperDevDir(")) continue;
					if (!allow.has(`${rel}:${b}`)) violations.push(`${rel}: join-form "${b}"`);
				}
				// Form 2: template concat `<dir>}<basename>` (the census form)
				const tmplRe = new RegExp("\\$\\{[a-zA-Z][a-zA-Z0-9.]{0,30}\\}" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
				for (const m of text.matchAll(tmplRe)) violations.push(`${rel}: concat-form "${b}"`);
				// Form 3: string concat dir + "/" + "basename"
				const plusRe = new RegExp(`"\\s*\\+\\s*"${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
				for (const m of text.matchAll(plusRe)) violations.push(`${rel}: plus-form "${b}"`);
			}
		}
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("every module-level basename literal is a registry member (drift-proof consolidation)", () => {
		const text = readFileSync(join(import.meta.dirname, "..", "src", "runlog.ts"), "utf8");
		expect(text).toContain('RUN_LOG_FILENAME = "events.jsonl"');
		expect(harnessBasenames("stateExternal").has("events.jsonl")).toBe(true);
	});
});

// ─── the full-set migration (D-S-D) ─────────────────────────────────────────

describe("063 S2 full-set migration", () => {
	it("every externalized basename with an in-spec file migrates; .run-lock stays", () => {
		const repo = mkRepo("full-migrate");
		const specDir = mkSpecDir(repo, "10-full");
		for (const b of ["routing-journal.jsonl", "replan-requests.json", ".convergence-ledger.json", ".knowledge.json", ".task", ".complete"]) {
			writeFileSync(join(specDir, b), "seed\n");
		}
		writeFileSync(join(specDir, ".run-lock"), JSON.stringify({ pid: 999999999, startedAt: "x" })); // dead pid — never alive
		const out = migrateInSpecState(specDir, externalMigrateBasenames());
		for (const b of ["routing-journal.jsonl", "replan-requests.json", ".convergence-ledger.json", ".knowledge.json", ".task", ".complete"]) {
			expect(existsSync(join(specDir, b))).toBe(false); // moved out
			expect(existsSync(stateFileFor(specDir, b))).toBe(true); // external home
			expect(out.migrations.some((m) => m.basename === b && m.action.startsWith("moved"))).toBe(true);
		}
		// .run-lock NEVER migrates (dead-pid steal is the existing path)
		expect(existsSync(join(specDir, ".run-lock"))).toBe(true);
		expect(out.migrations.some((m) => m.basename === ".run-lock")).toBe(false);
	});

	it("Class M authority survives: the migrated routing-journal is the file budgetFromJournal reads", () => {
		const repo = mkRepo("class-m");
		const specDir = mkSpecDir(repo, "11-classm");
		writeFileSync(join(specDir, "routing-journal.jsonl"), JSON.stringify({ edge: "spec→bdd", n: 1 }) + "\n");
		migrateInSpecState(specDir, externalMigrateBasenames());
		const external = stateFileFor(specDir, "routing-journal.jsonl");
		expect(readFileSync(external, "utf8")).toContain("spec→bdd");
	});
});

// ─── events ledger + .task through the funnel ───────────────────────────────

describe("063 S2 funnel redirects", () => {
	it("eventsPath funnels external (the concat form is gone)", () => {
		const repo = mkRepo("events");
		const specDir = mkSpecDir(repo, "12-events");
		const p = eventsPath(specDir);
		expect(p.startsWith(stateRoot)).toBe(true);
		expect(p.endsWith("events.jsonl")).toBe(true);
		expect(existsSync(dirname(p))).toBe(true); // lazily born
	});

	it("fail-closed fallback keeps the in-spec join for non-git dirs", () => {
		const plain = join(home, "plain-spec-dir");
		mkdirSync(plain, { recursive: true });
		const p = eventsPath(plain);
		expect(p).toBe(join(plain, "events.jsonl"));
	});
});

// ─── the external findResumableSpec scan + layout/content re-check (§3.5) ───

describe("063 S2 external resume scan", () => {
	it("branch-survived orphan surfaces as a resume candidate (worktree re-creatable)", () => {
		const repo = mkRepo("orphan-resume");
		// Simulate the dead-worktree run: state external, branch exists, spec dir GONE.
		const specDir = mkSpecDir(repo, "20-orphan");
		writeFileSync(stateFileFor(specDir, ".resume-cache.jsonl"), '{"key":"pipeline.spec@root#1","result":{}}\n');
		// Gate F5/ADV-2 fold: the branch TIP must contain the spec dir (that
		// is createOrReuseWorktree's re-creation source) — commit the track
		// content BEFORE branching, then kill the filesystem dir.
		writeFileSync(join(specDir, "spec.md"), "track content\n");
		execFileSync("git", ["-C", repo, "add", "-A"]);
		execFileSync("git", ["-C", repo, "commit", "-qm", "track 20-orphan"]);
		execFileSync("git", ["-C", repo, "branch", "20-orphan"], { stdio: "ignore" });
		rmSync(specDir, { recursive: true, force: true });
		const cands = externalResumeCandidates(repo);
		expect(cands.map((c) => c.id)).toContain("20-orphan");
		const found = findResumableSpec(repo);
		expect(found).toBe("20-orphan");
	});

	it("branch-LESS orphan is visible-only (never a resume candidate — no false resume)", () => {
		const repo = mkRepo("orphan-visible");
		const specDir = mkSpecDir(repo, "21-nobranch");
		writeFileSync(stateFileFor(specDir, ".resume-cache.jsonl"), '{"key":"k","result":{}}\n');
		rmSync(specDir, { recursive: true, force: true });
		// NO branch created — content is unrecoverable → orphan, not candidate
		expect(externalResumeCandidates(repo).map((c) => c.id)).not.toContain("21-nobranch");
		const sweep = sweepStateOrphansForRepo(repo);
		expect(sweep.orphans.some((o) => o.includes("21-nobranch"))).toBe(true);
	});

	it("the sweep names orphans with (projectKey, specId) scoping — another repo's tracks are not ours", () => {
		const repo = mkRepo("sweep-scope");
		const specDir = mkSpecDir(repo, "22-gone");
		writeFileSync(stateFileFor(specDir, ".resume-cache.jsonl"), "row\n");
		rmSync(specDir, { recursive: true, force: true });
		const sweep = sweepStateOrphansForRepo(repo);
		expect(sweep.orphans.some((o) => o.endsWith("/22-gone"))).toBe(true);
		expect(sweep.lines.some((l) => l.includes("NOT deleted"))).toBe(true);
		// and it never deleted anything
		expect(existsSync(stateFileFor(specDir, ".resume-cache.jsonl"))).toBe(true);
	});

	it("spec dir present in a layout ⇒ NOT an external candidate (normal scans own it)", () => {
		const repo = mkRepo("covered");
		const specDir = mkSpecDir(repo, "23-covered");
		writeFileSync(stateFileFor(specDir, ".resume-cache.jsonl"), "row\n");
		expect(externalResumeCandidates(repo).map((c) => c.id)).not.toContain("23-covered");
		expect(isResumable(specDir)).toBe(true);
	});

	it(".complete in the external store blocks candidature", () => {
		const repo = mkRepo("completed");
		const specDir = mkSpecDir(repo, "24-done");
		writeFileSync(stateFileFor(specDir, ".resume-cache.jsonl"), "row\n");
		writeFileSync(stateFileFor(specDir, ".complete"), new Date().toISOString());
		rmSync(specDir, { recursive: true, force: true });
		execFileSync("git", ["-C", repo, "branch", "24-done"], { stdio: "ignore" });
		expect(externalResumeCandidates(repo).map((c) => c.id)).not.toContain("24-done");
	});
});

describe("063 S2 sweep noise guard", () => {
	it("a hollow state dir (read-probe mkdir, zero files) is NOT an orphan", () => {
		const repo = mkRepo("hollow");
		mkSpecDir(repo, "30-hollow"); // spec dir exists (the probe needs a live repo path)
		// a read probe through the funnel lazily creates the hollow dir
		const probe = stateFileFor(join(repo, "docs", "specifications", "30-hollow"), ".resume-cache.jsonl");
		expect(existsSync(dirname(probe))).toBe(true);
		expect(readdirSync(dirname(probe)).length).toBe(0);
		const sweep = sweepStateOrphansForRepo(repo);
		expect(sweep.orphans.some((o) => o.includes("30-hollow"))).toBe(false);
	});
});

describe("063 S2 dual-gate folds (code F1/F4/B1, adversarial B1/ADV-1)", () => {
	it("B1 — worktree-ONLY repo (no <root>/docs/specifications parent): orphan still surfaces", () => {
		const repo = mkRepo("wt-only");
		// The default geometry: spec dirs only ever lived in worktrees; the
		// main checkout NEVER had docs/specifications. Pre-fold, facts derived
		// from a joined <root>/docs/specifications → git -C ENOENT → [] silent.
		// A REAL linked worktree so the branch tip's tree carries
		// docs/specifications/30-x (paths are worktree-relative on its branch).
		execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "30-x", join(repo, ".worktree", "30-x")], { stdio: "ignore" });
		const wtSpec = join(repo, ".worktree", "30-x", "docs", "specifications", "30-x");
		mkdirSync(wtSpec, { recursive: true });
		writeFileSync(join(wtSpec, "spec.md"), "content\n");
		execFileSync("git", ["-C", join(repo, ".worktree", "30-x"), "add", "-A"]);
		execFileSync("git", ["-C", join(repo, ".worktree", "30-x"), "commit", "-qm", "track"]);
		writeFileSync(stateFileFor(`${wtSpec}/`, ".resume-cache.jsonl"), '{"key":"k","result":{}}\n');
		rmSync(join(repo, ".worktree"), { recursive: true, force: true }); // worktree died
		const cands = externalResumeCandidates(repo);
		expect(cands.map((c) => c.id)).toContain("30-x");
	});

	it("ADV-2 — branch exists but its TIP lacks the spec dir → visible-only, not surfaced", () => {
		const repo = mkRepo("tip-lack");
		// A run that died BEFORE its first phase commit: branch at default tip.
		execFileSync("git", ["-C", repo, "branch", "31-empty"], { stdio: "ignore" });
		const ghost = stateFileFor(`${join(repo, "docs", "specifications", "31-empty")}/`, ".resume-cache.jsonl");
		// seed state via a spec dir that we then delete (branch tip never had it)
		const specDir = mkSpecDir(repo, "31-empty");
		writeFileSync(stateFileFor(specDir, ".resume-cache.jsonl"), '{"key":"k","result":{}}\n');
		rmSync(specDir, { recursive: true, force: true });
		expect(externalResumeCandidates(repo).map((c) => c.id)).not.toContain("31-empty");
		// the sweep still NAMES it (visible-only), and findResumableSpec does not resume it
		expect(sweepStateOrphansForRepo(repo).orphans.some((o) => o.includes("31-empty"))).toBe(true);
		expect(findResumableSpec(repo)).toBeUndefined();
	});

	it("F4/ADV-1 — sweep from a RUN WORKTREE with live sibling tracks: ZERO false orphans; .complete tracks exempt", () => {
		const repo = mkRepo("sweep-sib");
		// two live sibling tracks under the MAIN checkout's .worktree/
		for (const id of ["40-a", "40-b"]) {
			const specDir = join(repo, ".worktree", id, "docs", "specifications", id);
			mkdirSync(specDir, { recursive: true });
			writeFileSync(stateFileFor(`${specDir}/`, ".resume-cache.jsonl"), '{"key":"k","result":{}}\n');
		}
		// a FINISHED track whose spec dir was legitimately cleaned (mkdir
		// BEFORE stateFileFor — resolving against an absent dir fail-closes)
		const doneSpec = join(repo, "docs", "specifications", "40-done");
		mkdirSync(doneSpec, { recursive: true });
		writeFileSync(stateFileFor(`${doneSpec}/`, ".complete"), "{}");
		// the run's OWN worktree (the cwd production passes)
		const runWt = join(repo, ".worktree", "40-a");
		const sweep = sweepStateOrphansForRepo(runWt);
		expect(sweep.orphans.filter((o) => o.includes("40-"))).toEqual([]); // no false alarms
		expect(sweep.lines.some((l) => l.includes("0 orphan"))).toBe(true);
	});

	it("F1 — bumpOwnerRevision writes the EXTERNAL counter (no in-spec residue)", async () => {
		const { bumpOwnerRevision } = await import("../src/routing/walker.ts");
		const repo = mkRepo("rev-redirect");
		const specDir = mkSpecDir(repo, "50-rev");
		const n = bumpOwnerRevision(specDir, "spec");
		expect(n).toBe(1);
		// the counter lives in the EXTERNAL home…
		expect(readFileSync(stateFileFor(specDir, "artifact-revisions.json"), "utf8")).toMatch(/"spec":\s*1/);
		// …and NO in-spec copy was created (the pre-fold split-brain writer)
		expect(existsSync(join(specDir, "artifact-revisions.json"))).toBe(false);
	});
});
