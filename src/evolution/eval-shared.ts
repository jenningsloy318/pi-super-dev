/**
 * EVAL SHARED SUBSTRATE (P3) — the eval-surface values every module shares,
 * in a deliberately LEAF module (imports: node builtins + super-dev-dir
 * only).
 *
 * Why this module exists (the P6 cycle break): the learned-index injection
 * seam (src/render/learned.ts) must participate in the §8.1 contamination
 * firewall, but importing eval-layer.ts from learned.ts closes the cycle
 * learned.ts → eval-layer.ts → register-agents.ts → agents.ts → learned.ts
 * (eval-layer evaluates the DEC-6 closure at module scope, so the cycle is
 * not merely theoretical). makeCanary and the ~/.super-dev/evals/ layout
 * therefore live HERE — one spelling, imported by eval-layer (re-exported
 * for compat), eval-stage, the flywheel, and the firewall — and learned.ts
 * gets a leaf-safe path to the same values.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSuperDevDir } from "../render/super-dev-dir.ts";

// ─── §8.1 canary (single source — re-exported by eval-layer) ────────────────

/**
 * The literal canary GUID embedded in every golden-case scenario (§8.1):
 * deterministic in the case id (sha256-derived, GUID-shaped) so validation
 * RECOMPUTES it instead of trusting a stored copy — a scenario that lost its
 * canary fails validation loudly. Quoting this string anywhere (learned
 * index, prompt, trajectory) is proof of golden-case contamination.
 */
export function makeCanary(caseId: string): string {
	const hex = createHash("sha256").update(`super-dev-eval-canary:${caseId}`).digest("hex");
	const guid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
	return `canary-guid:${guid}`;
}

// ─── the ~/.super-dev/evals/ layout (DEC-5 user-local; one spelling) ────────

/** The evals neighborhood root: ~/.super-dev/evals/ (user-local, NEVER
 *  in-repo — the same doctrine as learned-index/config). */
export function evalsDir(): string {
	return join(getSuperDevDir(), "evals");
}

/** Golden cases: one *.json per case (DEC-5/DEC-6). */
export function casesDir(): string {
	return join(evalsDir(), "cases");
}

/** Rubric artifacts: one file per rubricId (DEC-7). */
export function rubricsDir(): string {
	return join(evalsDir(), "rubrics");
}

/** Maintainer hand labels (D7 / L3). */
export function labelsDir(): string {
	return join(evalsDir(), "labels");
}

/** Dataset rows: <runs>/rows.jsonl (DEC-2 — the flywheel's input ledger). */
export function runsDir(): string {
	return join(evalsDir(), "runs");
}

/** Flywheel PROPOSAL DRAFTS (DEC-11③ propose/apply split — drafts only;
 *  nothing here is a golden case until the maintainer moves it to cases/
 *  by hand). */
export function proposalsDir(): string {
	return join(evalsDir(), "proposals");
}

/** The flywheel's persisted state (saturation streaks, refresh version,
 *  proposalApplied stamps). */
export function flywheelStatePath(): string {
	return join(evalsDir(), "state.json");
}

/** The evolution-refresh marker (DEC-13④): present = golden-case re-review
 *  pending; the maintainer CLEARS it (rm) after re-review. */
export function refreshMarkerPath(): string {
	return join(evalsDir(), "refresh-pending");
}

/** The contamination quarantine ledger (§8.1): one row per first detection. */
export function contaminationLedgerPath(): string {
	return join(evalsDir(), "contamination.jsonl");
}

// ─── the quarantine ledger (read face — leaf-safe for learned.ts) ───────────

/** One quarantine record: a learned-index entry caught by the §8.1 scan.
 *  Written by the full scan (flywheel runs); read at the injection seam. */
export interface ContaminationLedgerRow {
	ts: number;
	entryId: string;
	/** "canary" (literal canary GUID found) | "ngram-overlap" (7-gram
	 *  overlap above threshold). */
	trigger: string;
	/** The golden case whose text was matched. */
	caseId?: string;
	detail?: string;
}

/** Best-effort ledger read (missing/unreadable/malformed → []; malformed
 *  lines are skipped — the ledger is observability, never a gate). */
export function readContaminationLedger(path: string = contaminationLedgerPath()): ContaminationLedgerRow[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const out: ContaminationLedgerRow[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as ContaminationLedgerRow;
			if (typeof parsed?.entryId === "string" && typeof parsed?.trigger === "string") out.push(parsed);
		} catch { /* skip malformed ledger lines — never throw from the firewall */ }
	}
	return out;
}

/** The set of entry ids already quarantined (the durable record the
 *  injection seam can filter on without running the scan). */
export function quarantinedEntryIds(path: string = contaminationLedgerPath()): Set<string> {
	return new Set(readContaminationLedger(path).map((r) => r.entryId));
}
