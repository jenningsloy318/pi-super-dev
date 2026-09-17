/**
 * contract-surface — the D-R-E reconciliation section + tolerant amendmentFamily normalization. Layer doctrine: ./types.ts.
 */
import { claimPathUsable } from "../../stages/plan-feasibility.ts";
import type { ContractInventory } from "./types.ts";

// ─── reconciliation (D-R-E: the engine-written spec-review section) ──────────

export interface NormalizedAmendmentFamilyEntry {
	sharedFile: string;
	pinsMoved: string[];
	exemptions: Array<{ pinId: string; justification: string }>;
	docUpdates: string[];
}

/** Tolerant control-shape reader for amendmentFamily (unknown LLM JSON in). */
export function normalizeAmendmentFamily(raw: unknown): { entries: NormalizedAmendmentFamilyEntry[]; malformed: string[] } {
	const entries: NormalizedAmendmentFamilyEntry[] = [];
	const malformed: string[] = [];
	if (raw === undefined || raw === null) return { entries, malformed };
	if (!Array.isArray(raw)) {
		malformed.push("amendmentFamily must be a JSON array of {sharedFile, pinsMoved, exemptions, docUpdates}");
		return { entries, malformed };
	}
	raw.forEach((entry, i) => {
		const e = entry as { sharedFile?: unknown; pinsMoved?: unknown; exemptions?: unknown; docUpdates?: unknown } | null;
		if (!e || typeof e !== "object") {
			malformed.push(`amendmentFamily[${i}]: not an object`);
			return;
		}
		const sharedFile = typeof e.sharedFile === "string" ? claimPathUsable(e.sharedFile) : null;
		if (!sharedFile) {
			malformed.push(`amendmentFamily[${i}]: sharedFile must be a non-empty repo-relative path`);
			return;
		}
		const strArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
		const exemptions = Array.isArray(e.exemptions)
			? e.exemptions.map((x) => x as { pinId?: unknown; justification?: unknown })
				.filter((x) => x && typeof x === "object")
				.map((x) => ({ pinId: typeof x.pinId === "string" ? x.pinId : "", justification: typeof x.justification === "string" ? x.justification : "" }))
			: [];
		entries.push({ sharedFile, pinsMoved: strArr(e.pinsMoved), exemptions, docUpdates: strArr(e.docUpdates) });
	});
	return { entries, malformed };
}

/** The deterministic cross-check result rendered into the spec-review doc
 *  (059 §3 R3 spec-reviewer duty): inventory summary + the family set-
 *  inclusion verdict D2's pass/fail must cite. Pure; never throws. */
export function contractInventoryReconciliationSection(
	inventory: ContractInventory,
	declaredFamily: NormalizedAmendmentFamilyEntry[] | undefined,
	mismatches: string[],
): string {
	const pinTotal = [...inventory.protectedFiles.values()].reduce((n, arr) => n + arr.length, 0);
	if (pinTotal === 0 && !declaredFamily?.length) return "";
	const lines = [
		"## Contract Inventory Reconciliation (engine-written — deterministic cross-check; D2 must cite this)",
		`- scanned sources: ${inventory.counts.specArtifacts} spec artifact(s), ${inventory.counts.testFiles} test file(s)`,
		`- inventory pins: ${pinTotal} across ${inventory.protectedFiles.size} protected file(s); unanchored: ${inventory.unanchored.length}`,
	];
	if (inventory.unanchored.length > 0) {
		for (const pin of inventory.unanchored.slice(0, 6)) lines.push(`  - unanchored: ${pin.pinId} @ ${pin.locus} — ${pin.unanchoredReason ?? "unresolved"}`);
		if (inventory.unanchored.length > 6) lines.push(`  - …(+${inventory.unanchored.length - 6} more unanchored pin(s) — see repo-invariants.json)`);
	}
	appendDeclaredFamilyRows(declaredFamily, lines);
	if (mismatches.length === 0) {
		lines.push(declaredFamily?.length ? "- set-inclusion: OK — declared amendmentFamily covers every inventory pin on the touched shared surfaces" : "- set-inclusion: (no family declared; no touched-surface pins to cover)");
	} else {
		lines.push("- set-inclusion: MISMATCH — declared amendmentFamily does NOT cover every inventory pin on the touched shared surfaces:");
		for (const m of mismatches.slice(0, 10)) lines.push(`  - ${m}`);
		if (mismatches.length > 10) lines.push(`  - …(+${mismatches.length - 10} more — see the convergence findings)`);
	}
	return lines.join("\n");
}

function appendDeclaredFamilyRows(declaredFamily: NormalizedAmendmentFamilyEntry[] | undefined, lines: string[]): void {
	if (!declaredFamily || declaredFamily.length === 0) {
		lines.push("- declared amendment family: (none declared)");
		return;
	}
	lines.push(`- declared amendment family: ${declaredFamily.length} entr${declaredFamily.length === 1 ? "y" : "ies"}`);
	for (const f of declaredFamily.slice(0, 8)) {
		lines.push(`  - ${f.sharedFile}: pinsMoved=[${f.pinsMoved.join(", ")}] exemptions=[${f.exemptions.map((e) => `${e.pinId}${e.justification ? "" : " (EMPTY justification)"}`).join(", ")}] docUpdates=[${f.docUpdates.join(", ")}]`);
	}
	if (declaredFamily.length > 8) lines.push(`  - …(+${declaredFamily.length - 8} more entr${declaredFamily.length - 8 === 1 ? "y" : "ies"})`);
}
