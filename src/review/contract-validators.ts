/**
 * 059 R1A D-R-B — Layer R3 per-stage deterministic validators (control AST,
 * never rendered-markdown regex — grill R6 HIGH-2, P1/P6) + the Metadata
 * Strike-1 classifier/repair template (MED-3, P8). docs/requirements/
 * 059-reviewer-quality-architecture.md §3 R3 / §5 D-R-B.
 *
 * Every validator returns `{blocking, advisory}` message lists:
 *   - blocking findings feed the stage's convergence errors (replan-routable);
 *   - advisory findings are logged (and R1B will inject them into prompts).
 *
 * Pre-W re-entry (MED-1): when the control carries no `layerW` version stamp
 * (authored before Layer W — findReusableSpec re-entry / --resume), every
 * blocking finding DEGRADES to advisory plus a located P10 banner — never a
 * deterministic deadlock, never silent. Full W coverage via the normal
 * replan route remains operator-available.
 *
 * Metadata findings (malformed declaration SHAPE) are prefixed
 * `[contract-metadata]` so the Strike-1 classifier can distinguish a
 * formatting miss (one zero-attempt-cost inline retry) from a substantive
 * convergence failure (P4: mechanical, not heuristic).
 */

import { existsSync } from "node:fs";
import type { ContractInventory, ContractPin, ContractSlice, NormalizedAmendmentFamilyEntry } from "./contract-surface.ts";
import { buildContractSlice, contractSliceView, extractContractInventory, normalizeAmendmentFamily, readContractSliceStamp } from "./contract-surface.ts";

export const PRE_W_BANNER = "[layer-w: pre-W artifact — validation advisory; see 059 §3 R3]";

export interface ContractValidatorFinding {
	kind: "blocking" | "advisory";
	message: string;
}

const isPreW = (control: Record<string, unknown> | undefined, round?: number): boolean => {
	// Adversarial S7 (v0.3.98): degradation is a LEGACY-artifact accommodation,
	// never a fresh-run escape hatch — from round 2 on (any retry), validators
	// run at full strength regardless of the stamp.
	if (round !== undefined && round > 1) return false;
	return !(control && typeof control.layerW === "string" && control.layerW.trim() !== "");
};

/** Degrade every blocking finding to advisory + one located P10 banner
 *  (pre-W re-entry contract). */
function degradeForPreW(findings: ContractValidatorFinding[], stage: string): ContractValidatorFinding[] {
	if (!findings.some((f) => f.kind === "blocking")) return findings;
	return [
		{ kind: "advisory", message: `${PRE_W_BANNER} ${stage} artifact carries no layerW stamp — W validators run advisory-only this round` },
		...findings.map((f) => (f.kind === "blocking" ? { kind: "advisory" as const, message: `${f.message} (advisory: pre-W artifact)` } : f)),
	];
}

/** The set-inclusion core shared by the design (authoritative) and spec
 *  (Stage 6-skip fallback) family checks: family ⊇ inventory pins on every
 *  touched shared surface (059 §3 R3, blocking, ownerStage=design|spec). */
/** The DEMANDABLE pins for a stage's convergence check (059 R1A class fix;
 *  live specimen run 2026-09-14T00-59-16-373Z — bdd convergence aborted after
 *  8 rounds of whack-a-mole over dynamically-minted pin ids): (1) SLICE-
 *  BOUNDED — only pins the writer's injected slice actually carried (≤ the
 *  CONTRACT_SLICE_MAX_PINS cap). A demand for a pin the writer could never
 *  see is structurally unconvergeable — the W5 grounding advisory forbids
 *  citing ids outside the slice. (2) SELF-REFERENTIAL EXCLUSION — a pin
 *  minted from the stage's OWN artifact prose is not demandable: each
 *  ownership declaration re-mints further pins from the growing artifact
 *  (round 2 cited a pin whose locus was the BDD's own line 145), which the
 *  spec-26 judge correctly refused to arbitrate. */
function demandablePins(slice: ContractSlice, inventory: ContractInventory, selfArtifactMatch?: (locusFile: string) => boolean): ContractPin[] {
	const byId = new Map<string, ContractPin>();
	for (const pins of inventory.protectedFiles.values()) for (const p of pins) byId.set(p.pinId, p);
	const out: ContractPin[] = [];
	for (const id of slice.pinIds) {
		const pin = byId.get(id);
		if (!pin) continue;
		if (selfArtifactMatch && selfArtifactMatch(pin.locus.split(":")[0] ?? "")) continue;
		out.push(pin);
	}
	return out;
}

/** Build the self-referential exclusion predicate for ONE stage: pins minted
 *  from THIS spec's own copy of the stage's artifact doc are not demandable
 *  (the writer's own remediation prose must not feed the demand set — see
 *  demandablePins). Sibling specs' docs are unaffected (their pins stay
 *  demandable — genuine cross-spec baselines). */
export function selfSpecArtifactMatcher(specDirectory: string | undefined, docSuffix: string): ((locusFile: string) => boolean) | undefined {
	if (!specDirectory) return undefined;
	let norm = specDirectory.replace(/\\/g, "/");
	// A1 (adversarial gate, run 2026-09-14T00-59-16-373Z follow-up): production
	// specDirectory is ABSOLUTE — join(worktreePath, "docs", "specifications",
	// specIdentifier) at src/setup.ts:755 — while pin loci are REPO-RELATIVE
	// (extractContractInventory walks with a "" prefix). Bridge via the
	// docs/specifications/ marker (fault-classification.ts path-normalization
	// precedent); fall back to the normalized dir when the marker is absent.
	const marker = "docs/specifications/";
	const idx = norm.indexOf(marker);
	if (idx !== -1) norm = norm.slice(idx);
	norm = norm.replace(/^\.\//, "");
	if (!norm.endsWith("/")) norm += "/"; // prefix-safety: "26-x" must not match sibling "26-x-other/"
	return (locusFile: string) => locusFile.startsWith(norm) && locusFile.endsWith(docSuffix);
}

function familySetInclusionFindings(
	stage: string,
	control: Record<string, unknown> | undefined,
	slice: ContractSlice,
	inventory: ContractInventory,
	selfArtifactMatch?: (locusFile: string) => boolean,
): ContractValidatorFinding[] {
	const findings: ContractValidatorFinding[] = [];
	const { entries, malformed } = normalizeAmendmentFamily(control?.amendmentFamily);
	for (const m of malformed) findings.push({ kind: "blocking", message: `[contract-metadata] ${stage} ${m}` });
	const familyDeclared = entries.length > 0 || malformed.length > 0;
	const sliceFiles = new Set(slice.files);
	const touchedWithPins = [...slice.files].filter((f) => (inventory.protectedFiles.get(f)?.length ?? 0) > 0);
	if (touchedWithPins.length === 0) {
		// No pins on the touched surfaces: nothing to cover. A declared family
		// that names UNTouched files is the writer's own declaration — advisory.
		for (const entry of entries) {
			if (!sliceFiles.has(entry.sharedFile)) findings.push({ kind: "advisory", message: `${stage} amendmentFamily names ${entry.sharedFile}, which is not in this stage's contract-surface slice — declare only touched shared surfaces` });
		}
		return findings;
	}
	if (!familyDeclared) {
		findings.push({ kind: "blocking", message: `${stage} touches shared surfaces carrying baseline pins (${touchedWithPins.join(", ")}) but declares no amendmentFamily — every touched shared surface must declare its amendment family (059 §3 R3; see the injected contract-surface slice)` });
		return findings;
	}
	// Class fix (run 2026-09-14T00-59-16-373Z): the demand set is the SLICE's
	// pins (what the writer saw), self-minted pins excluded — never the full
	// per-file inventory, which is unbounded and structurally unconvergeable.
	// A3 (adversarial gate): the shared surface is the INVENTORY's protected-
	// file key (e.g. src/schemas.ts), NOT the pin's locus file (the test or
	// spec doc that carries the assertion) — index pinId → protectedFile.
	const pinToFile = new Map<string, string>();
	for (const [file, pins] of inventory.protectedFiles.entries()) {
		for (const p of pins) pinToFile.set(p.pinId, file);
	}
	const demandable = demandablePins(slice, inventory, selfArtifactMatch);
	const uncovered = demandable.filter((pin) => {
		const protectedFile = pinToFile.get(pin.pinId);
		if (!protectedFile || !sliceFiles.has(protectedFile)) return false;
		let covered = false;
		for (const entry of entries) {
			if (entry.sharedFile !== protectedFile) continue;
			if (entry.pinsMoved.includes(pin.pinId) || entry.exemptions.some((ex) => ex.pinId === pin.pinId)) { covered = true; break; }
		}
		return !covered;
	});
	for (const pin of uncovered) {
		findings.push({
			kind: "blocking",
			message: `${stage} amendmentFamily does not cover pin ${pin.pinId} (${pin.idiomFamily}) on touched shared surface ${pinToFile.get(pin.pinId)} — pin declared @ ${pin.locus}: move it (pinsMoved), exempt it with a non-empty justification, or amend the plan (059 §3 R3 set-inclusion)`,
		});
	}
	// delta-4 DEFECT-3: exemptions are STRUCTURED with mandatory non-empty
	// justification — existence alone is not a legal basis.
	for (const entry of entries) {
		for (const ex of entry.exemptions) {
			if (!ex.pinId.trim()) findings.push({ kind: "blocking", message: `[contract-metadata] ${stage} amendmentFamily exemption on ${entry.sharedFile} is missing pinId` });
			else if (!ex.justification.trim()) findings.push({ kind: "blocking", message: `[contract-metadata] ${stage} amendmentFamily exemption ${ex.pinId} on ${entry.sharedFile} carries an EMPTY justification — every exemption needs the legal basis (owner decision or upstream declaration; 059 delta-4 DEFECT-3)` });
		}
	}
	return findings;
}

/** (a) The AUTHORITATIVE design check (blocking, ownerStage=design):
 *  DesignData.amendmentFamily ⊇ inventory pins on every touched shared
 *  surface. The LLM reviews tradeoff quality and audits exemption
 *  justifications; the inclusion itself is machine-checked. */
export function designAmendmentFamilyFindings(input: {
	control: Record<string, unknown> | undefined;
	slice: ContractSlice;
	inventory: ContractInventory;
	selfArtifactMatch?: (locusFile: string) => boolean;
}): ContractValidatorFinding[] {
	const findings = familySetInclusionFindings("design", input.control, input.slice, input.inventory, input.selfArtifactMatch);
	return isPreW(input.control) ? degradeForPreW(findings, "design") : findings;
}

/** The Stage 6-skip FALLBACK check (blocking, ownerStage=spec, 059 §3 R3
 *  DEFECT-1): when design did not declare a family, the specification's own
 *  SpecificationData.amendmentFamily must pass the same set-inclusion. */
export function specAmendmentFamilyFindings(input: {
	specControl: Record<string, unknown> | undefined;
	designControl: Record<string, unknown> | undefined;
	slice: ContractSlice;
	inventory: ContractInventory;
	/** Convergence round — from round 2 on, pre-W degradation is disabled
	 *  (adversarial S7: retries run validators at full strength). */
	round?: number;
	selfArtifactMatch?: (locusFile: string) => boolean;
}): ContractValidatorFinding[] {
	const designFamily = (input.designControl as { amendmentFamily?: unknown } | undefined)?.amendmentFamily;
	if (designFamily !== undefined && designFamily !== null) return []; // design owns the authoritative declaration
	const findings = familySetInclusionFindings("spec", input.specControl, input.slice, input.inventory, input.selfArtifactMatch);
	return isPreW(input.specControl, input.round) ? degradeForPreW(findings, "spec") : findings;
}

/** Normalize a bdd control's pinOwnership entries out of the scenario AST
 *  (features[].scenarios[].pinOwnership). */
export function bddPinOwnershipEntries(control: Record<string, unknown> | undefined): Array<{ pinId: string; state: string; justification: string; scenario: string; malformed: string | null }> {
	const out: Array<{ pinId: string; state: string; justification: string; scenario: string; malformed: string | null }> = [];
	const features = Array.isArray(control?.features) ? (control!.features as Array<Record<string, unknown>>) : [];
	for (const feature of features) {
		const scenarios = Array.isArray(feature.scenarios) ? (feature.scenarios as Array<Record<string, unknown>>) : [];
		for (const s of scenarios) {
			const scenario = typeof s.id === "string" ? `SCENARIO-${s.id}` : "scenario";
			const rows = Array.isArray(s.pinOwnership) ? (s.pinOwnership as Array<Record<string, unknown>>) : [];
			for (const row of rows) {
				const pinId = typeof row.pinId === "string" ? row.pinId.trim() : "";
				const state = typeof row.state === "string" ? row.state.trim() : "";
				const justification = typeof row.justification === "string" ? row.justification.trim() : "";
				let malformed: string | null = null;
				if (!pinId) malformed = "pinOwnership entry is missing pinId";
				else if (state !== "owned" && state !== "inherited-frozen") malformed = `pinOwnership ${pinId}: state must be 'owned' or 'inherited-frozen' (got '${state}')`;
				out.push({ pinId, state, justification, scenario, malformed });
			}
		}
	}
	return out;
}

/** (b) The bdd AST validator (blocking, ownerStage=bdd): unowned pins on
 *  touched surfaces are blocking; inherited-frozen requires a non-empty
 *  justification (DEFECT-3). Unknown pinIds (not in the inventory) are
 *  advisory — grounding guidance, not a loop-killer. */
export function bddPinOwnershipFindings(input: {
	control: Record<string, unknown> | undefined;
	slice: ContractSlice;
	inventory: ContractInventory;
	selfArtifactMatch?: (locusFile: string) => boolean;
}): ContractValidatorFinding[] {
	const findings: ContractValidatorFinding[] = [];
	const entries = bddPinOwnershipEntries(input.control);
	for (const e of entries) {
		if (e.malformed) findings.push({ kind: "blocking", message: `[contract-metadata] bdd ${e.scenario} ${e.malformed}` });
		if (e.state === "inherited-frozen" && !e.malformed && !e.justification) {
			findings.push({ kind: "blocking", message: `[contract-metadata] bdd ${e.scenario} pinOwnership ${e.pinId} is inherited-frozen with an EMPTY justification — state the legal basis (owner decision or upstream declaration; 059 delta-4 DEFECT-3)` });
		}
	}
	const owned = new Set(entries.filter((e) => !e.malformed).map((e) => e.pinId));
	const knownPinIds = new Set([...input.inventory.protectedFiles.values()].flat().map((p) => p.pinId));
	// Class fix (run 2026-09-14T00-59-16-373Z): the demand set is the WRITER'S
	// SLICE (what the writer actually saw, ≤ the 15-pin cap), self-minted pins
	// excluded — never the full per-file inventory. The full inventory is
	// unbounded (dozens of pins across the test suite + sibling spec docs) and
	// the W5 grounding advisory forbids citing ids beyond the slice, so
	// inventory-wide demands are structurally unconvergeable.
	const demandable = demandablePins(input.slice, input.inventory, input.selfArtifactMatch);
	// A3 (adversarial gate): the surface slot is the protected-file key, not the
	// pin's locus file (restores the pre-refactor message shape).
	const bddPinToFile = new Map<string, string>();
	for (const [file, pins] of input.inventory.protectedFiles.entries()) {
		for (const p of pins) bddPinToFile.set(p.pinId, file);
	}
	for (const pin of demandable) {
		if (owned.has(pin.pinId)) continue;
		findings.push({
			kind: "blocking",
			message: `bdd scenario set leaves pin ${pin.pinId} (${pin.idiomFamily}) on touched shared surface ${bddPinToFile.get(pin.pinId)} UNOWNED — every baseline-pinning behavior must declare prospective ownership in the typed pinOwnership field ({pinId, state: 'owned'|'inherited-frozen', justification}; 059 §3 R3 bdd duty; pin @ ${pin.locus})`,
		});
	}
	// P10 honesty: pins beyond the slice cap are invisible to the writer — one
	// advisory line (never blocking), the design/spec amendment-family
	// reconciliation owns the full inventory.
	const sliceIds = new Set(input.slice.pinIds);
	let beyondCap = 0;
	for (const file of input.slice.files) {
		for (const pin of input.inventory.protectedFiles.get(file) ?? []) {
			if (sliceIds.has(pin.pinId)) continue;
			if (input.selfArtifactMatch && input.selfArtifactMatch(pin.locus.split(":")[0] ?? "")) continue; // A4: self-minted pins are excluded, not "beyond cap"
			beyondCap++;
		}
	}
	// A4 (advisory honesty): design/spec slices are ALSO 15-pin-capped — no
	// stage blocking-checks the full inventory. The residual is disclosed as
	// advisory prose in the spec-review Contract Inventory Reconciliation.
	if (beyondCap > 0) findings.push({ kind: "advisory", message: `bdd: ${beyondCap} further pin(s) on the touched surfaces exceed the injected slice cap — not demandable at this stage (writer cannot see them); full-inventory reconciliation is documented advisory-only in the spec-review report` });
	for (const e of entries) {
		if (e.malformed || !e.pinId) continue;
		if (!knownPinIds.has(e.pinId)) findings.push({ kind: "advisory", message: `bdd ${e.scenario} pinOwnership cites unknown pinId ${e.pinId} — cite only pinIds present in the injected slice or upstream declarations (W5 grounding)` });
	}
	return isPreW(input.control) ? degradeForPreW(findings, "bdd") : findings;
}

/** (c) The requirements intent consistency check (ADVISORY at 2B — HIGH-1:
 *  requirements legitimately may not know; blocking moves down-stack to
 *  design-review). */
export function requirementsIntentFindings(input: {
	control: Record<string, unknown> | undefined;
	slice: ContractSlice;
}): ContractValidatorFinding[] {
	const declared = input.control?.affectsSharedSurfaces;
	const hasDeclaration = Array.isArray(declared) && declared.some((v) => typeof v === "string" && v.trim() !== "");
	if (input.slice.files.length > 0 && !hasDeclaration) {
		return [{
			kind: "advisory",
			message: `requirements touch shared surfaces (${input.slice.files.join(", ")}) but declare no affectsSharedSurfaces intent hints — declare concept/shared-file hints so downstream stages can reconcile pins (ADVISORY at 2B; 059 §3 R3)`,
		}];
	}
	return [];
}

// ─── Metadata Strike-1 (MED-3, P8) ───────────────────────────────────────────

/** A W-metadata rejection: EVERY error is either a located schema error whose
 *  location names a Layer-W field, or a `[contract-metadata]` validator
 *  finding. Deterministic (P4) — metadata formatting must never be mistaken
 *  for a substantive convergence failure, nor vice versa. */
const W_FIELD_NAME_RE = /(?:^|\.)(?:pinOwnership|amendmentFamily|affectsSharedSurfaces|tradeoffs|layerW|evidenceLoci)(?:\[|\.|$|:)/;

export function isWriterMetadataRejection(errors: string[]): boolean {
	if (errors.length === 0) return false;
	return errors.every((e) => {
		const line = String(e);
		if (line.includes("[contract-metadata]")) return true;
		// Located schema error shape: "<field path>: <message>" (render.ts
		// schemaLocationWithItems) — test the location BEFORE the first ": ".
		const location = line.includes(": ") ? line.slice(0, line.indexOf(": ")) : line;
		return W_FIELD_NAME_RE.test(location);
	});
}

/** The deterministic repair template for the Strike-1 inline retry
 *  (renderRetries precedent): the exact malformed fields + the shapes to
 *  return. Zero attempt cost — metadata formatting must never exhaust the
 *  substantive convergence budget. */
export function writerMetadataRepairFeedback(stage: string, errors: string[]): string {
	return [
		`## ${stage}: contract-declaration metadata repair (Strike-1 — retry does not consume a convergence round)`,
		"The control's contract declarations are MALFORMED (shape only — the content was not judged yet). Fix EXACTLY these fields and return the same control with everything else unchanged:",
		...errors.slice(0, 8).map((e) => `- ${e}`),
		"",
		"Shapes (strict):",
		"- affectsSharedSurfaces: string[] — intent-level shared-surface hints.",
		"- pinOwnership (per scenario): [{ pinId: string, state: 'owned' | 'inherited-frozen', justification: string }] — populate the FIELD, never prose tags.",
		"- amendmentFamily: [{ sharedFile: string, pinsMoved: string[], exemptions: [{ pinId: string, justification: string }], docUpdates: string[] }].",
		"- tradeoffs: [{ decision: string, favoredQuality: string, sacrificedQuality: string, rationale: string }].",
		"- layerW: the literal string \"1\".",
	].join("\n");
}

/** Split validator findings for gate wiring: blocking → errors; advisory → log. */
export function splitContractFindings(findings: ContractValidatorFinding[]): { blocking: string[]; advisory: string[] } {
	return {
		blocking: findings.filter((f) => f.kind === "blocking").map((f) => f.message),
		advisory: findings.filter((f) => f.kind === "advisory").map((f) => f.message),
	};
}

/** The per-stage Metadata Strike-1 state key (059 MED-3; DISJOINT from 058's
 *  planned phaseProtectionStrikes — different prefix, different lifetime). */
export function writerMetadataStrikeKey(stage: string): string {
	return `writerMetadataRetryUsed:${stage}`;
}

/** Assemble the validator context for a stage: the slice the writer's prompt
 *  saw (state stamp) + the inventory it derived from; when no stamp exists
 *  (direct validator call, pre-W replay) BOTH are recomputed fresh from the
 *  evaluated texts. Null when the worktree is absent/unwalkable — every
 *  validator no-ops (fail-open harmless, never a false blocking). */
export function contractValidationContext(state: Record<string, unknown>, stage: string, texts: Array<string | undefined | null>): { inventory: ContractInventory; slice: ContractSlice } | null {
	const worktreePath = (state.setup as { worktreePath?: string } | undefined)?.worktreePath;
	if (!worktreePath || !existsSync(worktreePath)) return null;
	try {
		const stamp = readContractSliceStamp(state, stage);
		const inventory = stamp?.inventory ?? extractContractInventory(worktreePath);
		const slice = stamp ? contractSliceView(stamp) : buildContractSlice({ inventory, texts });
		return { inventory, slice };
	} catch {
		return null;
	}
}

/** The mismatch lines the reconciliation section cites (set-inclusion result). */
export function familyInclusionMismatches(
	control: Record<string, unknown> | undefined,
	slice: ContractSlice,
	inventory: ContractInventory,
): string[] {
	const { entries } = normalizeAmendmentFamily(control?.amendmentFamily);
	const out: string[] = [];
	for (const file of slice.files) {
		const covered = new Set<string>();
		for (const entry of entries) {
			if (entry.sharedFile !== file) continue;
			for (const id of entry.pinsMoved) covered.add(id);
			for (const ex of entry.exemptions) covered.add(ex.pinId);
		}
		for (const pin of inventory.protectedFiles.get(file) ?? []) {
			if (!covered.has(pin.pinId)) out.push(`${pin.pinId} on ${file} (${pin.idiomFamily} @ ${pin.locus})`);
		}
	}
	return out;
}

export type { NormalizedAmendmentFamilyEntry };
