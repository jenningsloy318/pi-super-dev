/**
 * Phase 5 (Track 30) — PRC wiring: reused/resumed-track quarantine in runSetup
 * (tests/setup-dirty-quarantine.test.ts — RED-first per SCENARIO-031/AC-14).
 *
 * T5.1 (SCENARIO-020 · AC-09): on RE-ENTRY — a reused track (referenced-spec
 *   entry, `reusedTrack === true`) OR a resumed one
 *   (`options.resumeSpecIdentifier` set) — foreign uncommitted state in the
 *   worktree is detected via the canonical collectDirtPaths inventory
 *   (spec-dir / harness-bookkeeping / copiedEnvFiles exclusions; NO
 *   extraExcluded — the declared scope is unknown at setup time) and
 *   quarantined recoverably: ONE scoped `git stash push -u` + ONE PRD ledger
 *   record. After setup the worktree contains no foreign tracked
 *   modifications (`git status --porcelain`).
 * T5.2 (SCENARIO-021 · AC-09): exclusions preserved; a fresh track performs
 *   NO detection at all; the user's main checkout (skipWorktree) is never
 *   quarantined. These boundary cases are born-green guards by construction
 *   (nothing quarantines when detection is correctly scoped) — they pin the
 *   boundary against over-quarantining once T5.1 lands.
 * T5.3 (SCENARIO-022 · AC-10): ONE prominent recovery log line naming the
 *   quarantined paths, the EXACT stashRef, `git stash pop`, and
 *   SUPER_DEV_NO_DIRTY_QUARANTINE=1 (the SUPER_DEV_NO_SPEC_REUSE /
 *   SUPER_DEV_NO_BOOTSTRAP logging style, src/stages/setup.ts:35 convention).
 * T5.4 (SCENARIO-023 · AC-11): the kill-switch at setup — detection observes
 *   (warning log), mutation never runs; worktree untouched.
 * T5.5 (SCENARIO-028 · AC-13): end-to-end pathspec safety — the stash lists
 *   ONLY the foreign paths (excluded classes stay in the worktree,
 *   unmodified); a child_process argv recorder spanning the whole setup run
 *   shows the ONLY mutating git argv is ONE `stash push` (no
 *   checkout/reset/clean), and NO quarantine argv at all when the kill-switch
 *   is set.
 *
 * Phase 6 (Track 30) — PRD wiring: ledger consumers at setup.
 *
 * T6.1 (SCENARIO-027 · AC-12): the prior-fault count is surfaced IFF the
 *   ledger `<specDir>/.environment-faults.jsonl` EXISTS — one options.log
 *   line naming the count (absent file ⇒ NO line at all, never a ": 0"); a
 *   quarantining re-entry's line reflects the just-appended record (the
 *   count is read AFTER the quarantine arm).
 * T6.3 (SCENARIO-030 · AC-13/AC-12): an unwritable ledger at setup degrades
 *   to the /ledger append failed/ warning — runSetup completes normally, the
 *   quarantine itself still succeeded, never fatal, no throw.
 *
 * Harness: real-git temp repos per tests/setup.test.ts (git() helper via
 * execFileSync, try/finally rmSync); two-step re-entry fixtures — first
 * runSetup creates the track + worktree (task referencing
 * `@docs/specifications/<id>/` so `reusedTrack === true`), the worktree is
 * dirtied with the SCENARIO-020 foreign shape, then runSetup re-enters the
 * same track.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSetup, releaseHeldRunLock } from "../src/setup.ts";
import { HARNESS_BOOKKEEPING_FILES } from "../src/helpers.ts";
import { DIRTY_QUARANTINE_KILL_SWITCH } from "../src/fault-classification.ts";

/** Pass-through child_process argv recorder (T1.5 / rc8-rc12 cpMock pattern):
 *  every spawnSync AND execFileSync call is recorded, then delegated to the
 *  REAL implementation — so the real-git fixtures keep working while the argv
 *  stream stays auditable (T5.5: only `stash push` may ever mutate the
 *  worktree during a setup run; setup.ts's git helpers use execFileSync, the
 *  shared dirt primitives use spawnSync — both shapes must be captured). */
const cpRecorder = vi.hoisted(() => ({
	calls: [] as Array<{ cmd: string; args: string[]; cwd?: string }>,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const record = (cmd: string, argv?: readonly string[] | null, opts?: { cwd?: string }) => {
		cpRecorder.calls.push({ cmd, args: Array.isArray(argv) ? [...argv] : [], cwd: opts?.cwd });
	};
	return {
		...actual,
		spawnSync: (cmd: string, argv?: readonly string[], opts?: { cwd?: string }) => {
			record(cmd, argv, opts);
			return (actual.spawnSync as typeof import("node:child_process").spawnSync)(cmd, argv, opts as never);
		},
		execFileSync: (cmd: string, argv?: readonly string[], opts?: { cwd?: string }) => {
			record(cmd, argv, opts);
			return (actual.execFileSync as typeof import("node:child_process").execFileSync)(cmd, argv, opts as never);
		},
	};
});

// ─── Real-git helpers (tests/setup.test.ts pattern — local IO only) ─────────

const gitRun = (cwd: string, args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** git argv issued inside a recorder window (spawnSync + execFileSync). */
function gitArgvInWindow(): Array<{ cmd: string; args: string[]; cwd?: string }> {
	return cpRecorder.calls.filter((c) => c.cmd === "git");
}

/** The first non-global-option git token — handles BOTH argv shapes:
 *  `["status", …]` (setup.ts's git helper, cwd via opts) and
 *  `["-c", "k=v", "-C", "path", "status", …]` (collectDirtPaths/quarantine). */
function gitSubcommand(args: readonly string[]): string | null {
	let i = 0;
	if (args[i] === "-c") i += 2;
	if (args[i] === "-C") i += 2;
	const sub = args[i];
	return typeof sub === "string" ? sub : null;
}

/** Porcelain lines whose path is NOT under this track's spec dir — the
 *  "foreign residue" SCENARIO-020 Then-clause check (harness state inside the
 *  spec dir — .run-lock, ledger — is never foreign). */
function foreignPorcelain(wt: string, specId: string): string[] {
	const prefix = `docs/specifications/${specId}/`;
	return gitRun(wt, ["status", "--porcelain", "--untracked-files=all"])
		.split("\n")
		.filter((l) => l.trim() !== "" && !l.slice(3).trim().startsWith(prefix));
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SPEC_ID = "24-auth-flow";
const SPEC_DIR_REL = `docs/specifications/${SPEC_ID}`;
const REFERENCED_TASK = `implement @docs/specifications/${SPEC_ID}/ the token refresh changes`;
const SNOW = "internal/services/snow/enrichment.go";

/** Main checkout whose `docs/specifications/<id>` exists (committed) so the
 *  referenced-spec branch of runSetup re-enters it (`reusedTrack === true`). */
function seededReferencedTrackRepo(): string {
	const d = mkdtempSync(join(tmpdir(), "sd-t5-seed-"));
	gitRun(d, ["init", "-q", "-b", "main"]);
	gitRun(d, ["config", "user.email", "t@t"]);
	gitRun(d, ["config", "user.name", "t"]);
	gitRun(d, ["commit", "-q", "--allow-empty", "-m", "base"]);
	write(join(d, SPEC_DIR_REL, "06-specification.md"), "# Spec\n");
	gitRun(d, ["add", "."]);
	gitRun(d, ["commit", "-q", "-m", "seed spec"]);
	return d;
}

/** First entry: create the track + worktree, commit the (would-be foreign)
 *  tracked file on the track branch, then optionally dirty it with the
 *  SCENARIO-020 foreign shape — a tracked modification to
 *  internal/services/snow/enrichment.go plus an untracked scratch.txt. */
function enteredTrack(opts: { dirt?: boolean; extraDirt?: (wt: string, main: string) => void } = {}): { d: string; wt: string } {
	const d = seededReferencedTrackRepo();
	const first = runSetup(REFERENCED_TASK, { cwd: d });
	write(join(first.worktreePath, SNOW), "package snow\n\nvar Enrich = 1\n");
	gitRun(first.worktreePath, ["add", "-A"]);
	gitRun(first.worktreePath, ["commit", "-q", "-m", "seed snow"]);
	if (opts.dirt !== false) {
		write(join(first.worktreePath, SNOW), "package snow\n\nvar Enrich = 2\n"); // foreign tracked mod
		write(join(first.worktreePath, "scratch.txt"), "scratch\n"); // foreign untracked
	}
	opts.extraDirt?.(first.worktreePath, d);
	return { d, wt: first.worktreePath };
}

/** Re-enter the SAME track — referenced-spec (reusedTrack) or resume — with a
 *  captured options.log sink. */
function reenter(d: string, opts: { resume?: boolean } = {}): { setup: ReturnType<typeof runSetup>; logs: string[] } {
	const logs: string[] = [];
	const setup = opts.resume
		? runSetup("continue the auth work", { cwd: d, resumeSpecIdentifier: SPEC_ID, log: (m) => logs.push(m) })
		: runSetup(REFERENCED_TASK, { cwd: d, log: (m) => logs.push(m) });
	return { setup, logs };
}

function readLedger(wt: string): Array<Record<string, unknown>> {
	const text = readFileSync(join(wt, SPEC_DIR_REL, ".environment-faults.jsonl"), "utf8");
	return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ─── Suite lifecycle: kill-switch env hygiene + run-lock release ─────────────

const ORIG_KS = process.env[DIRTY_QUARANTINE_KILL_SWITCH];
const ORIG_REUSE = process.env.SUPER_DEV_NO_SPEC_REUSE;

beforeEach(() => {
	delete process.env[DIRTY_QUARANTINE_KILL_SWITCH];
	delete process.env.SUPER_DEV_NO_SPEC_REUSE;
	cpRecorder.calls.length = 0;
});

afterEach(() => {
	releaseHeldRunLock();
	if (ORIG_KS === undefined) delete process.env[DIRTY_QUARANTINE_KILL_SWITCH];
	else process.env[DIRTY_QUARANTINE_KILL_SWITCH] = ORIG_KS;
	if (ORIG_REUSE === undefined) delete process.env.SUPER_DEV_NO_SPEC_REUSE;
	else process.env.SUPER_DEV_NO_SPEC_REUSE = ORIG_REUSE;
});

// ─── T5.1 — detect + quarantine foreign state on re-entry ────────────────────

describe("T5.1 — detect + quarantine foreign state on re-entry; worktree left clean (SCENARIO-020 · AC-09)", () => {
	it("FIX (RED pre-fix): reused track (referenced-spec re-entry) — foreign tracked mod + untracked scratch quarantined; porcelain reports NO foreign tracked modifications; ONE stash; ledger line with exactly the two foreign paths", () => {
		const { d, wt } = enteredTrack({ dirt: true });
		try {
			const { setup } = reenter(d);
			expect(setup.reusedTrack).toBe(true);
			expect(setup.worktreePath).toBe(wt);
			// SCENARIO-020 Then/And: the foreign state was quarantined and the
			// porcelain reports no foreign tracked modifications.
			expect(foreignPorcelain(wt, SPEC_ID)).toEqual([]);
			// ONE recoverable stash entry carrying BOTH foreign paths (-u).
			expect(gitRun(wt, ["stash", "list"]).trim().split("\n").filter(Boolean)).toHaveLength(1);
			const stashed = gitRun(wt, ["stash", "show", "-u", "--name-only"]).trim().split("\n").sort();
			expect(stashed).toEqual([SNOW, "scratch.txt"]);
			// PRD ledger (SCENARIO-025): one kind:"quarantine" line, exact key
			// set, paths EXACTLY the two foreign paths, stashRef === refs/stash.
			const ledger = readLedger(wt);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]!["kind"]).toBe("quarantine");
			expect(Object.keys(ledger[0]!)).toEqual(["kind", "paths", "stashRef", "reason"]);
			expect(ledger[0]!["paths"]).toEqual([SNOW, "scratch.txt"]);
			expect(ledger[0]!["stashRef"]).toBe(gitRun(wt, ["rev-parse", "refs/stash"]).trim());
			expect(String(ledger[0]!["reason"])).toContain(`setup re-entry track ${SPEC_ID}`);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);

	it("FIX (RED pre-fix): the resumed-track parameterization (options.resumeSpecIdentifier) quarantines identically", () => {
		const { d, wt } = enteredTrack({ dirt: true });
		try {
			const { setup } = reenter(d, { resume: true });
			expect(setup.worktreePath).toBe(wt);
			expect(foreignPorcelain(wt, SPEC_ID)).toEqual([]);
			expect(gitRun(wt, ["stash", "list"]).trim().split("\n").filter(Boolean)).toHaveLength(1);
			const stashed = gitRun(wt, ["stash", "show", "-u", "--name-only"]).trim().split("\n").sort();
			expect(stashed).toEqual([SNOW, "scratch.txt"]);
			const ledger = readLedger(wt);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]!["kind"]).toBe("quarantine");
			expect(ledger[0]!["paths"]).toEqual([SNOW, "scratch.txt"]);
			expect(ledger[0]!["stashRef"]).toBe(gitRun(wt, ["rev-parse", "refs/stash"]).trim());
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);
});

// ─── T5.2 — exclusions preserved; fresh tracks / main checkout untouched ─────

describe("T5.2 — exclusions preserved; fresh tracks and the main checkout untouched (SCENARIO-021 · AC-09)", () => {
	it("GUARD (born-green boundary pin): only-excluded uncommitted state (spec-dir mod + every HARNESS_BOOKKEEPING_FILES member + a copiedEnvFiles entry) ⇒ NO stash, every path still present/modified as-is", () => {
		const { d, wt } = enteredTrack({
			dirt: false,
			extraDirt: (wt2) => {
				write(join(wt2, SPEC_DIR_REL, "06-specification.md"), "# Spec (modified in spec dir)\n");
				for (const name of HARNESS_BOOKKEEPING_FILES) write(join(wt2, SPEC_DIR_REL, name), "x\n");
			},
		});
		// a NEW env file in the MAIN checkout ⇒ re-entry copies it (a
		// copiedEnvFiles member — excluded from the dirt inventory)
		write(join(d, ".env"), "SECRET=1\n");
		try {
			const { setup, logs } = reenter(d);
			expect(setup.copiedEnvFiles).toContain(".env");
			expect(gitRun(wt, ["stash", "list"]).trim()).toBe("");
			expect(logs.some((l) => /Setup quarantined foreign uncommitted state/.test(l))).toBe(false);
			// every excluded path preserved as-is (state preserved, not quarantined)
			expect(readFileSync(join(wt, SPEC_DIR_REL, "06-specification.md"), "utf8")).toContain("# Spec (modified in spec dir)");
			for (const name of HARNESS_BOOKKEEPING_FILES) expect(existsSync(join(wt, SPEC_DIR_REL, name))).toBe(true);
			expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
			// the spec-dir mod still shows as a modification (not stashed)
			expect(gitRun(wt, ["status", "--porcelain"])).toContain(`${SPEC_DIR_REL}/06-specification.md`);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);

	it("GUARD (born-green boundary pin): SUPER_DEV_NO_SPEC_REUSE=1 fresh track ⇒ NO detection at all — no stash, no quarantine log line, foreign dirt in the allocated worktree untouched", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-t5-fresh-"));
		try {
			gitRun(d, ["init", "-q", "-b", "main"]);
			gitRun(d, ["config", "user.email", "t@t"]);
			gitRun(d, ["config", "user.name", "t"]);
			gitRun(d, ["commit", "-q", "--allow-empty", "-m", "base"]);
			// Pre-create the worktree the fresh allocation will land in
			// (01-fresh-track — no other specs ⇒ nextSpecNumber 1) carrying
			// FOREIGN dirt: if detection were wrongly scoped to fresh tracks,
			// this stash would appear.
			gitRun(d, ["worktree", "add", "-q", "-b", "01-fresh-track", join(d, ".worktree", "01-fresh-track")]);
			const wt = join(d, ".worktree", "01-fresh-track");
			write(join(wt, SNOW), "package snow\n\nvar Enrich = 1\n");
			gitRun(wt, ["add", "-A"]);
			gitRun(wt, ["commit", "-q", "-m", "seed"]);
			write(join(wt, SNOW), "package snow\n\nvar Enrich = 2\n");
			write(join(wt, "scratch.txt"), "scratch\n");

			const logs: string[] = [];
			process.env.SUPER_DEV_NO_SPEC_REUSE = "1";
			const setup = runSetup("build a car theory html animation page", { cwd: d, slug: "fresh-track", log: (m) => logs.push(m) });
			expect(setup.specIdentifier).toBe("01-fresh-track");
			expect(setup.reusedTrack ?? false).toBe(false);
			expect(setup.worktreePath).toBe(wt);
			// no stash, dirt untouched, no detection/quarantine log at all
			expect(gitRun(wt, ["stash", "list"]).trim()).toBe("");
			expect(gitRun(wt, ["status", "--porcelain"])).toContain(SNOW);
			expect(existsSync(join(wt, "scratch.txt"))).toBe(true);
			expect(logs.some((l) => /Setup (quarantined|detected) foreign uncommitted state/.test(l))).toBe(false);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);

	it("GUARD (born-green boundary pin): skipWorktree with a DIRTY main checkout (cwd) ⇒ cwd dirt untouched, no stash anywhere (never quarantine the user's checkout)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-t5-inplace-"));
		try {
			gitRun(d, ["init", "-q", "-b", "main"]);
			gitRun(d, ["config", "user.email", "t@t"]);
			gitRun(d, ["config", "user.name", "t"]);
			write(join(d, "notes.md"), "base\n");
			gitRun(d, ["add", "-A"]);
			gitRun(d, ["commit", "-q", "-m", "base"]);
			write(join(d, "notes.md"), "modified\n"); // dirty main checkout
			write(join(d, "untracked.txt"), "u\n");

			const logs: string[] = [];
			const setup = runSetup("continue the auth work", { cwd: d, skipWorktree: true, resumeSpecIdentifier: "01-x", log: (m) => logs.push(m) });
			expect(setup.worktreePath).toBe(d);
			expect(readFileSync(join(d, "notes.md"), "utf8")).toBe("modified\n");
			expect(existsSync(join(d, "untracked.txt"))).toBe(true);
			expect(gitRun(d, ["stash", "list"]).trim()).toBe("");
			expect(logs.some((l) => /Setup (quarantined|detected) foreign uncommitted state/.test(l))).toBe(false);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);
});

// ─── T5.3 — prominent recovery log ───────────────────────────────────────────

describe("T5.3 — prominent recovery log (SCENARIO-022 · AC-10)", () => {
	it("FIX (RED pre-fix): ONE log line naming a quarantined path, the EXACT stashRef, `git stash pop`, and SUPER_DEV_NO_DIRTY_QUARANTINE=1", () => {
		const { d, wt } = enteredTrack({ dirt: true });
		try {
			const { logs } = reenter(d);
			const line = logs.find((l) => l.includes("Setup quarantined foreign uncommitted state"));
			expect(line).toBeDefined();
			expect(line).toContain(`on re-entered track ${SPEC_ID}`);
			expect(line).toContain(SNOW);
			expect(line).toContain("scratch.txt");
			expect(line).toContain("git stash pop");
			expect(line).toContain("SUPER_DEV_NO_DIRTY_QUARANTINE=1");
			expect(line).toContain(gitRun(wt, ["rev-parse", "refs/stash"]).trim());
			// ONE quarantine line (prominent, not repeated)
			expect(logs.filter((l) => l.includes("Setup quarantined foreign uncommitted state"))).toHaveLength(1);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);
});

// ─── T5.4 — kill-switch at setup: detection warning, worktree untouched ──────

describe("T5.4 — kill-switch at setup: detection warning, worktree untouched (SCENARIO-023 · AC-11)", () => {
	it("FIX (RED pre-fix): SUPER_DEV_NO_DIRTY_QUARANTINE=1 + dirty re-entry ⇒ no stash, foreign modification still present, the detection-warning literal logged", () => {
		const { d, wt } = enteredTrack({ dirt: true });
		process.env[DIRTY_QUARANTINE_KILL_SWITCH] = "1";
		try {
			const { logs } = reenter(d);
			expect(gitRun(wt, ["stash", "list"]).trim()).toBe("");
			expect(readFileSync(join(wt, SNOW), "utf8")).toContain("var Enrich = 2"); // still modified
			expect(gitRun(wt, ["status", "--porcelain"])).toContain(SNOW);
			expect(existsSync(join(wt, "scratch.txt"))).toBe(true);
			const warn = logs.find((l) => l.includes("Setup detected foreign uncommitted state"));
			expect(warn).toBeDefined();
			expect(warn).toContain(`on re-entered track ${SPEC_ID}`);
			expect(warn).toContain("SUPER_DEV_NO_DIRTY_QUARANTINE=1 is set — worktree untouched");
			expect(warn).toContain(SNOW);
			expect(warn).toContain("scratch.txt");
			expect(logs.some((l) => l.includes("Setup quarantined foreign uncommitted state"))).toBe(false);
			// detection only — no ledger record was minted
			expect(existsSync(join(wt, SPEC_DIR_REL, ".environment-faults.jsonl"))).toBe(false);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);
});

// ─── T5.5 — end-to-end pathspec safety (stash-only, never touches excluded files) ──

describe("T5.5 — end-to-end pathspec safety (SCENARIO-028 · AC-13)", () => {
	it("FIX (RED pre-fix): the stash lists ONLY the foreign paths — spec-dir file, bookkeeping files, copied env file all still in the worktree, unmodified", () => {
		const { d, wt } = enteredTrack({
			dirt: true,
			extraDirt: (wt2) => {
				write(join(wt2, SPEC_DIR_REL, "06-specification.md"), "# Spec (modified in spec dir)\n");
				for (const name of HARNESS_BOOKKEEPING_FILES) write(join(wt2, SPEC_DIR_REL, name), "x\n");
			},
		});
		write(join(d, ".env"), "SECRET=1\n"); // copied on re-entry ⇒ excluded
		try {
			const { setup } = reenter(d);
			expect(setup.copiedEnvFiles).toContain(".env");
			const stashed = gitRun(wt, ["stash", "show", "-u", "--name-only"]).trim().split("\n").sort();
			expect(stashed).toEqual([SNOW, "scratch.txt"]);
			// every excluded class survives the quarantine untouched
			expect(readFileSync(join(wt, SPEC_DIR_REL, "06-specification.md"), "utf8")).toContain("# Spec (modified in spec dir)");
			for (const name of HARNESS_BOOKKEEPING_FILES) expect(existsSync(join(wt, SPEC_DIR_REL, name))).toBe(true);
			expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
			expect(existsSync(join(wt, SPEC_DIR_REL, ".task"))).toBe(true);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);

	it("FIX (RED pre-fix): argv recorder spanning the whole re-entry runSetup — the ONLY mutating git argv is ONE `stash push` (with -u, --, exactly the foreign pathspec); no checkout/reset/clean/drop/clear anywhere", () => {
		const { d, wt } = enteredTrack({ dirt: true });
		try {
			cpRecorder.calls.length = 0; // scope the window to the setup run
			reenter(d);
			const calls = gitArgvInWindow();
			expect(calls.length).toBeGreaterThan(0);
			const pushes = calls.filter((c) => gitSubcommand(c.args) === "stash" && c.args.includes("push"));
			expect(pushes).toHaveLength(1);
			expect(pushes[0]!.args).toContain("-u");
			const dd = pushes[0]!.args.indexOf("--");
			expect(dd).toBeGreaterThan(-1);
			// dual-review F-1 remediation: pathspecs are `:(literal)`-prefixed.
			expect(pushes[0]!.args.slice(dd + 1).sort()).toEqual([`:(literal)${SNOW}`, ":(literal)scratch.txt"]);
			expect(pushes[0]!.cwd).toBe(wt);
			for (const c of calls) {
				expect(["checkout", "reset", "clean", "drop", "clear"]).not.toContain(gitSubcommand(c.args));
			}
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);

	it("GUARD (kill-switch twin): with the kill-switch set, NO quarantine argv is issued at all during the whole setup run (no `stash` argv)", () => {
		const { d } = enteredTrack({ dirt: true });
		process.env[DIRTY_QUARANTINE_KILL_SWITCH] = "1";
		try {
			cpRecorder.calls.length = 0;
			reenter(d);
			const stashArgv = gitArgvInWindow().filter((c) => gitSubcommand(c.args) === "stash");
			expect(stashArgv).toHaveLength(0);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);
});

// ─── T6.1 — setup prior-fault count iff the ledger exists ──────────────────

describe("T6.1 — setup surfaces the prior-fault count iff the ledger exists (SCENARIO-027 · AC-12)", () => {
	it("FIX (RED pre-fix): re-entry with a pre-seeded 3-line ledger ⇒ the informational count line with the correct N", () => {
		// Clean re-entry (no dirt ⇒ no quarantine) isolates the count line.
		const { d, wt } = enteredTrack({ dirt: false });
		const ledgerPath = join(wt, SPEC_DIR_REL, ".environment-faults.jsonl");
		writeFileSync(ledgerPath, `${JSON.stringify({ kind: "quarantine", paths: ["a"], stashRef: "s", reason: "r" })}\n`.repeat(3));
		try {
			const { setup, logs } = reenter(d);
			expect(setup.reusedTrack).toBe(true);
			// The spec's exact literal (SCENARIO-027 Then): count + ledger name +
			// class + next=none (informational only — no actuation follows).
			expect(logs).toContain(`Setup prior environmental faults on track ${SPEC_ID}: 3 (ledger: .environment-faults.jsonl — class=environment; next=none, informational)`);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);

	it("FIX (RED pre-fix): a quarantining re-entry ⇒ the count line reflects the just-appended record, logged AFTER the recovery line (count read after the quarantine arm)", () => {
		const { d } = enteredTrack({ dirt: true });
		try {
			const { logs } = reenter(d);
			const countIdx = logs.findIndex((l) => l.startsWith("Setup prior environmental faults on track"));
			expect(countIdx).toBeGreaterThanOrEqual(0);
			// The quarantine arm appended exactly ONE record before the count read.
			expect(logs[countIdx]!).toContain(`on track ${SPEC_ID}: 1 (ledger: .environment-faults.jsonl`);
			// Ordering: the informational count follows the prominent recovery line.
			const recoveryIdx = logs.findIndex((l) => l.includes("Setup quarantined foreign uncommitted state"));
			expect(recoveryIdx).toBeGreaterThanOrEqual(0);
			expect(countIdx).toBeGreaterThan(recoveryIdx);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);

	it("GUARD (born-green boundary pin): re-entry with NO ledger ⇒ no line matching /prior environmental faults/ at all (absent file ⇒ NO line, never a \": 0\")", () => {
		const { d } = enteredTrack({ dirt: false });
		try {
			const { logs } = reenter(d);
			expect(logs.some((l) => /prior environmental faults/.test(l))).toBe(false);
		} finally {
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);
});

// ─── T6.3 — unwritable ledger at setup: never fatal, plain proceed ──────────

describe("T6.3 — unwritable ledger at setup: the run proceeds plainly, never fatal (SCENARIO-030 · AC-13/AC-12)", () => {
	// DEVIATION NOTE (documented in the Phase 6 report): the spec's literal
	// "chmod 0o555 the ledger's directory" is structurally incompatible with the
	// AC-30 run lock living in the SAME spec dir — acquireRunLock is deliberately
	// fail-closed on real IO failures, and in a 0o555 dir BOTH the stale-steal
	// `rmSync(lockPath)` and the re-create `openSync(lockPath, "wx")` throw EACCES
	// (verified empirically), so runSetup could never "complete normally". The
	// SAME EACCES failure class is therefore induced at the ledger FILE (0o444):
	// every Then-clause — normal completion, quarantine still succeeded (stash
	// exists), the /ledger append failed/ warning — is preserved bit-for-bit.
	// (The read-only-DIR variant stays pinned at the primitive level in
	// tests/fault-classification.test.ts.)
	it("PIN: re-entry with dirt where the ledger is unwritable (chmod 0o444, skipped as root) ⇒ runSetup completes normally, the quarantine still succeeded (stash exists), the /ledger append failed/ warning is logged, and the ledger is left uncorrupted", () => {
		if (process.getuid?.() === 0) return; // root ignores 0o444
		const { d, wt } = enteredTrack({ dirt: true });
		const ledgerPath = join(wt, SPEC_DIR_REL, ".environment-faults.jsonl");
		writeFileSync(ledgerPath, `${JSON.stringify({ kind: "quarantine", paths: ["seed"], stashRef: "seed", reason: "seed" })}\n`);
		chmodSync(ledgerPath, 0o444);
		try {
			const { setup, logs } = reenter(d);
			// Never fatal: setup completed normally (no throw, plain proceed).
			expect(setup.reusedTrack).toBe(true);
			expect(setup.worktreePath).toBe(wt);
			// The quarantine itself still succeeded — the ledger failure NEVER blocks
			// the state change (SCENARIO-030's “the flow proceeds”).
			expect(gitRun(wt, ["stash", "list"]).trim().split("\n").filter(Boolean)).toHaveLength(1);
			// The degrade warning through the log sink (the primitive's exact literal).
			expect(logs.some((l) => /ledger append failed/.test(l))).toBe(true);
			expect(logs.some((l) => l.startsWith("environment-fault ledger append failed (continuing; never fatal):"))).toBe(true);
			// The seeded line is intact — the failed append added NOTHING (no partial
		// write corrupted the ledger) — and T6.1's informational count still
		// surfaced (reads work on a read-only file; the flow ran past the degrade).
			expect(readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim() !== "")).toHaveLength(1);
			expect(logs.some((l) => l.includes(`Setup prior environmental faults on track ${SPEC_ID}: 1`))).toBe(true);
		} finally {
			chmodSync(ledgerPath, 0o644); // restore for the cleanup
			releaseHeldRunLock();
			rmSync(d, { recursive: true, force: true });
		}
	}, 20_000);
});
