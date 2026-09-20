/**
 * WS6 (066 §2) — patch-mode on route-back. Research grounding: surgical
 * edits are what make delta verification possible at all (Amp's
 * old_string/new_string pattern; RepairAgent's iterative repair) — a writer
 * that regenerates the artifact changes every claim's hash and the WS5
 * verdict cache never hits. The route-back findings are precise; the writer
 * must CHANGE ONLY the implicated regions.
 *
 * The enforcement split (066 grill-2 M10): the diff-confinement check is a
 * SOFT check (diff-size expectation declared in the control;
 * renumbering/whitespace defeat mechanical diffing) — the real enforcement
 * is the reviewer scoped to the delta (WS5) plus this directive. Pure
 * module; never throws.
 */

/** The patch-mode directive block appended to the writer's feedback when the
 * walk is a route-back re-entry (a REVISION walk carrying precise findings). */
export function patchModeDirective(): string {
	return [
		"## Patch mode (route-back revision)",
		"THIS walk is a route-back revision carrying precise findings. Apply EXACTLY the implicated changes:",
		"- Preserve every previously-approved section byte-for-byte unless a finding names it — regeneration of untouched content is a defect (it invalidates verified claims).",
		"- Re-emit findingResolutions for the injected ids (unchanged findings may cite their existing verified loci).",
		"- Declare changedSections in the control: the section/file anchors you actually touched (advisory diff-scope expectation; the reviewer checks the delta).",
	].join("\n");
}

/** The soft check (grill-2 M10): what the control declared as its diff
 * scope. Advisory — logged, never blocking. */
export function changedSectionsSoftCheck(control: { changedSections?: unknown } | null | undefined): { declared: number; note: string } {
	const v = control?.changedSections;
	const declared = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").length : 0;
	return {
		declared,
		note: declared === 0
			? "patch-mode: changedSections absent — the writer did not declare a diff scope (advisory; reviewer scoping still applies)"
			: `patch-mode: ${declared} changed section(s) declared (advisory diff-scope expectation)`,
	};
}
