/**
 * `src/tracking.ts` — self-contained per-stage/per-phase git change tracker
 * (spec-11 Layer 1 / AC-01, AC-02, AC-03 → SCENARIO-001..007).
 *
 * A {@link ChangeTracker} brackets a `stage` or `phase` unit with a git
 * baseline at `begin()` and a git delta at `end()`, persisting an append-only
 * `<specDir>/change-tracker.jsonl` of start/end records. Each end record carries
 * a git-derived `gitActual` change set (created/modified/deleted), the agent's
 * claimed structured set, and a one-directional cross-check
 * (`claimedNotChanged` vs `changedNotClaimed`).
 *
 * INVARIANTS (the contract every caller relies on):
 *  - NEVER throws. The entire `begin`/`end` body and every git op is wrapped in
 *    one try/catch. Any git failure (ENOENT, non-zero exit, non-string stdout,
 *    spawn error, non-git dir) → the end record carries
 *    `{gitUnavailable:true, gitActual:null, crossCheck:null,
 *    verdict:"git-unavailable"}` and the method returns that record without
 *    throwing (no block — SCENARIO-005 / AC-02).
 *  - Conservative parse (SCENARIO-006 / AC-02): a claimed file is recorded as
 *    `claimedNotChanged` ONLY when `gitActual` was successfully computed AND the
 *    file is absent from `gitActual.{created ∪ modified}`. Ambiguous/unavailable
 *    parse leaves `claimedNotChanged` empty (no false failure / no false gate
 *    block).
 *  - Append-only: start + end records are appended (never overwritten) to
 *    `<specDir>/change-tracker.jsonl` (SCENARIO-007 / AC-03).
 *
 * Git primitives reuse the EXACT discrete-argv `spawnSync` shape from
 * `touchedFilePaths` (src/build-runner.ts) — `spawnSync("git", ["-C", wt, ...],
 * { encoding:"utf8", timeout: resolveTimeoutMs() })` — never `shell:true`, so
 * agent-supplied paths never reach a shell. The committed-diff UNION
 * untracked-files pattern mirrors `touchedFilePaths` but is keyed off the stored
 * `beginHead` instead of a base ref. `dedupePreservingOrder` is the single
 * source of truth for the UNION (imported from build-runner.ts — no duplication).
 *
 * Independently testable: a pure module + unit tests with a mocked
 * `node:child_process.spawnSync`, NO engine integration, NO dependency on later
 * phases.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { dedupePreservingOrder, resolveTimeoutMs } from "./build-runner.ts";

/** Bracketing granularity: a pipeline `stage` or an implementation `phase`. */
export type TrackerUnit = "stage" | "phase";

/**
 * The agent's claimed structured change set (spec-11 AC-06).
 * Replaces the legacy advisory flat `filesModified: string[]`.
 */
export interface StructuredChanges {
	filesCreated: string[];
	filesModified: string[];
	filesDeleted: string[];
}

/** The git-derived ground-truth change set for a unit's bracket. */
export interface GitActual {
	created: string[];
	modified: string[];
	deleted: string[];
}

/**
 * One-directional cross-check between the agent's claim and git's actual.
 *  - `claimedNotChanged`: files the agent claims to have created/modified that
 *    git does NOT show changed → the false-green killer (gated, AC-08).
 *  - `changedNotClaimed`: files git shows changed that the agent did NOT report
 *    → advisory-only under-reporting (logged, never gated, SCENARIO-014).
 */
export interface CrossCheck {
	claimedNotChanged: string[];
	changedNotClaimed: string[];
}

/**
 * A single start/end record persisted to `change-tracker.jsonl`.
 *
 * `verdict`:
 *  - `"ok"` — claim matches git (or no claim / no change).
 *  - `"claimed-miss"` — at least one claimed file is absent from git
 *    (`claimedNotChanged.length > 0`) → the gate can block on this (AC-08).
 *  - `"git-unavailable"` — git could not be queried; `gitUnavailable:true`;
 *    the gate must NOT block (degrade, SCENARIO-017).
 */
export interface ChangeRecord {
	unit: TrackerUnit;
	id: string;
	event: "start" | "end";
	ts: string;
	beginHead: string | null;
	endHead: string | null;
	gitActual: GitActual | null;
	claimed: StructuredChanges | null;
	crossCheck: CrossCheck | null;
	verdict: "ok" | "claimed-miss" | "git-unavailable";
	/** Set `true` only when git was unavailable for this record. */
	gitUnavailable?: boolean;
}

/** Internal begin baseline keyed by `${unit}:${id}`. */
interface Baseline {
	beginHead: string | null;
}

const TRACKER_FILENAME = "change-tracker.jsonl";

/**
 * Classify a porcelain v1 `XY` status code into a change kind.
 *
 * Explicit map (no ambiguity — SCENARIO-002/003 / AC-01):
 *  - `??` (untracked) → `created`
 *  - any `D` (`D*` / `*D`, staged or worktree deletion) → `deleted`
 *  - everything else (`M `, ` M`, `MM`, `A `, `R `, …) → `modified`
 */
function classifyPorcelain(xy: string): "created" | "modified" | "deleted" {
	if (xy === "??") return "created";
	if (xy[0] === "D" || xy[1] === "D") return "deleted";
	return "modified";
}

/**
 * Per-run `ChangeTracker`. Brackets `stage`/`phase` units with git snapshots
 * and persists an append-only jsonl trace. See module doc for the full
 * never-throw / conservative-parse / append-only contract.
 */
export class ChangeTracker {
	private readonly specDir: string;
	private readonly worktreePath: string;
	private readonly baselines = new Map<string, Baseline>();
	private readonly endRecords = new Map<string, ChangeRecord>();

	constructor(specDir: string, worktreePath: string) {
		this.specDir = specDir;
		this.worktreePath = worktreePath;
	}

	/**
	 * Begin a bracket for `unit`:`id`. Snapshots the committed-ref baseline
	 * (`git rev-parse HEAD`) and emits one `{event:"start"}` jsonl line.
	 * Never throws — git failure leaves `beginHead:null` (SCENARIO-004/005).
	 */
	begin(unit: TrackerUnit, id: string): void {
		let beginHead: string | null = null;
		try {
			const head = this.gitSpawn(["rev-parse", "HEAD"]);
			beginHead = head.trim() || null;
		} catch {
			// git unavailable / non-git dir → null baseline; end() records the miss.
			beginHead = null;
		}
		this.baselines.set(`${unit}:${id}`, { beginHead });
		this.appendRecord({
			unit,
			id,
			event: "start",
			ts: this.nowIso(),
			beginHead,
			endHead: null,
			gitActual: null,
			claimed: null,
			crossCheck: null,
			verdict: "ok",
		});
	}

	/**
	 * End a bracket for `unit`:`id`. Re-snapshots, computes the delta =
	 * `git diff --name-status <beginHead>` UNION `git status --porcelain`,
	 * classifies into created/modified/deleted, cross-checks against the
	 * optional `claimed` set, and emits one `{event:"end"}` jsonl line.
	 * Returns the {@link ChangeRecord} (never null, never throws).
	 *
	 * On any git failure the record is `{gitUnavailable:true, gitActual:null,
	 * crossCheck:null, verdict:"git-unavailable"}` and the method returns it
	 * WITHOUT throwing (no block — SCENARIO-005 / AC-02). Conservative parse
	 * leaves `claimedNotChanged` empty on ambiguity/unavailability
	 * (SCENARIO-006 / AC-02).
	 */
	end(unit: TrackerUnit, id: string, claimed?: StructuredChanges): ChangeRecord | null {
		const key = `${unit}:${id}`;
		const baseline = this.baselines.get(key) ?? { beginHead: null };
		const beginHead = baseline.beginHead;
		const claimedOrNull = claimed ?? null;
		let record: ChangeRecord;
		try {
			const endHeadRaw = this.gitSpawn(["rev-parse", "HEAD"]);
			const endHead = endHeadRaw.trim() || null;
			// Committed changes since the begin ref (skipped when no baseline ref).
			const diffRaw = beginHead ? this.gitSpawn(["diff", "--name-status", beginHead]) : "";
			// Working-tree (uncommitted/untracked) state at end.
			const statusRaw = this.gitSpawn(["status", "--porcelain"]);
			const gitActual = this.buildGitActual(diffRaw, statusRaw);
			const crossCheck = claimedOrNull ? this.computeCrossCheck(claimedOrNull, gitActual) : null;
			const verdict: ChangeRecord["verdict"] =
				crossCheck && crossCheck.claimedNotChanged.length > 0 ? "claimed-miss" : "ok";
			record = {
				unit,
				id,
				event: "end",
				ts: this.nowIso(),
				beginHead,
				endHead,
				gitActual,
				claimed: claimedOrNull,
				crossCheck,
				verdict,
			};
		} catch {
			// git unavailable: degrade, never throw, never block (AC-02).
			record = {
				unit,
				id,
				event: "end",
				ts: this.nowIso(),
				beginHead,
				endHead: null,
				gitActual: null,
				claimed: claimedOrNull,
				crossCheck: null,
				verdict: "git-unavailable",
				gitUnavailable: true,
			};
		}
		this.appendRecord(record);
		// Last end-record wins so the gate reads the freshest crossCheck.
		this.endRecords.set(key, record);
		return record;
	}

	/**
	 * Return the LAST end-record for `unit`:`id`, or `null` if the unit was
	 * never ended. The cross-check gate reads `crossCheck` off this record.
	 */
	getRecord(unit: TrackerUnit, id: string): ChangeRecord | null {
		return this.endRecords.get(`${unit}:${id}`) ?? null;
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	/**
	 * Centralized git spawn. Reuses the EXACT discrete-argv `spawnSync` shape
	 * from `touchedFilePaths` (no `shell:true`) under the shared
	 * {@link resolveTimeoutMs} envelope. Throws on ANY git failure
	 * (spawn error, non-zero exit, non-string stdout) so the caller's
	 * try/catch maps it to a `gitUnavailable` record.
	 */
	private gitSpawn(argv: string[]): string {
		const r = spawnSync("git", ["-C", this.worktreePath, ...argv], {
			encoding: "utf8",
			timeout: resolveTimeoutMs(),
		});
		if (r.error) throw r.error;
		if (typeof r.status !== "number" || r.status !== 0) {
			throw new Error(`git ${argv.join(" ")} exited with status ${String(r.status)}`);
		}
		if (typeof r.stdout !== "string") {
			throw new Error(`git ${argv.join(" ")} returned non-string stdout`);
		}
		return r.stdout;
	}

	/**
	 * Build {@link GitActual} from `diff --name-status` (committed) UNION
	 * `status --porcelain` (uncommitted/untracked). Classification (AC-01):
	 *  - diff status letters: `A`→created, `D`→deleted, else (`M`/`T`/…)→modified
	 *  - porcelain XY via {@link classifyPorcelain}: `??`→created, `D*`/`*D`
	 *    →deleted, else→modified
	 * UNION via {@link dedupePreservingOrder} (first-seen order): a path in BOTH
	 * the committed diff and porcelain collapses to ONE entry at its
	 * committed-diff position, classified by its first source
	 * (SCENARIO-001/002/003/004).
	 */
	private buildGitActual(diffRaw: string, statusRaw: string): GitActual {
		type Kind = "created" | "modified" | "deleted";
		const entries: { path: string; kind: Kind }[] = [];

		// Committed diff first → first-seen classification precedence.
		for (const line of diffRaw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			const parts = trimmed.split("\t");
			const status = parts[0]?.[0] ?? "";
			// For renames/copies the destination is the last tab field.
			const path = (parts.length >= 2 ? parts[parts.length - 1] : "").trim();
			if (path === "") continue;
			let kind: Kind = "modified";
			if (status === "A") kind = "created";
			else if (status === "D") kind = "deleted";
			entries.push({ path, kind });
		}

		// Porcelain uncommitted/untracked second.
		for (const line of statusRaw.split("\n")) {
			// Preserve the leading XY columns — only trim trailing whitespace.
			const trimmed = line.replace(/\s+$/u, "");
			if (trimmed === "" || trimmed.length < 3) continue;
			const xy = trimmed.slice(0, 2);
			let path = trimmed.slice(3).trim();
			if (path === "") continue;
			// Renames: "old -> new" — take the destination.
			if (path.includes(" -> ")) path = path.split(" -> ").pop()!.trim();
			entries.push({ path, kind: classifyPorcelain(xy) });
		}

		// Single source of truth: dedupe by path, first-seen kind wins.
		const orderedPaths = dedupePreservingOrder(entries.map((e) => e.path));
		const kindByPath = new Map<string, Kind>();
		for (const e of entries) {
			if (!kindByPath.has(e.path)) kindByPath.set(e.path, e.kind);
		}
		const created: string[] = [];
		const modified: string[] = [];
		const deleted: string[] = [];
		for (const p of orderedPaths) {
			const kind = kindByPath.get(p) ?? "modified";
			if (kind === "created") created.push(p);
			else if (kind === "deleted") deleted.push(p);
			else modified.push(p);
		}
		return { created, modified, deleted };
	}

	/**
	 * One-directional cross-check (AC-01 / AC-08 precursor):
	 *  - `claimedNotChanged` = (claimed.created ∪ claimed.modified) \
	 *      gitActual.(created ∪ modified)  — gated (false-green killer).
	 *  - `changedNotClaimed` = gitActual.(created ∪ modified ∪ deleted) \
	 *      claimed.(all three)  — advisory only.
	 */
	private computeCrossCheck(claimed: StructuredChanges, git: GitActual): CrossCheck {
		const claimedCreatedOrModified = dedupePreservingOrder([
			...claimed.filesCreated,
			...claimed.filesModified,
		]);
		const gitAllChanged = dedupePreservingOrder([...git.created, ...git.modified, ...git.deleted]);
		const gitCreatedOrModified = new Set<string>([...git.created, ...git.modified]);
		const claimedAll = new Set<string>([
			...claimed.filesCreated,
			...claimed.filesModified,
			...claimed.filesDeleted,
		]);
		const claimedNotChanged = claimedCreatedOrModified.filter((p) => !gitCreatedOrModified.has(p));
		const changedNotClaimed = gitAllChanged.filter((p) => !claimedAll.has(p));
		return { claimedNotChanged, changedNotClaimed };
	}

	/** Append one record as a JSON line to `<specDir>/change-tracker.jsonl`. */
	private appendRecord(record: ChangeRecord): void {
		try {
			mkdirSync(this.specDir, { recursive: true });
			appendFileSync(join(this.specDir, TRACKER_FILENAME), `${JSON.stringify(record)}\n`, "utf8");
		} catch {
			// Append-only persistence is best-effort: NEVER throw from the
			// tracker (the in-memory record returned to the caller is still
			// authoritative for the gate).
		}
	}

	private nowIso(): string {
		return new Date().toISOString();
	}
}

// -------------------------------------------------------------------------
// Per-run singleton (mirrors `activeRun` in src/extension.ts — AC-05, Phase 2).
// Provided here so Phase 1 ships the lifecycle primitives the engine will wire
// in later phases. Stages/phases read it via {@link getActiveTracker} and
// no-op when null (idle / non-git) — never throw, never block.
// -------------------------------------------------------------------------

let activeTracker: ChangeTracker | null = null;

/** Set the per-run singleton tracker (pass `null` to clear in a `finally`). */
export function setActiveTracker(tracker: ChangeTracker | null): void {
	activeTracker = tracker;
}

/** Get the per-run singleton tracker, or `null` when none is active. */
export function getActiveTracker(): ChangeTracker | null {
	return activeTracker;
}
