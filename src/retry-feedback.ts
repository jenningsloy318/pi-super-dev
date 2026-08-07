/**
 * Compact, reusable retry-feedback blocks for bounded agent loops.
 *
 * A retrying agent should not receive only "failed" or a growing transcript. The
 * harness should encode the current rejection as location / observed / expected
 * / missing items / next action, then feed that compact repair record into the
 * next same-role attempt.
 */

export interface RetryFeedback {
	stage: string;
	phase?: string;
	attempt?: number;
	gate: string;
	location?: string;
	observed?: string;
	expected?: string;
	missing?: string[];
	diagnostics?: string[];
	nextAction: string;
}

export type RetryFeedbackInput = RetryFeedback | string;

function isRetryFeedback(value: RetryFeedbackInput): value is RetryFeedback {
	return typeof value === "object" && value !== null && "gate" in value && "nextAction" in value;
}

function compactList(values: string[] | undefined, max = 8): string {
	if (!values?.length) return "none";
	const shown = values.slice(0, max);
	const suffix = values.length > shown.length ? `; +${values.length - shown.length} more` : "";
	return `${shown.join("; ")}${suffix}`;
}

export function renderRetryFeedbackItem(item: RetryFeedbackInput): string {
	if (!isRetryFeedback(item)) return `- ${item}`;
	const prefix = [`stage=${item.stage}`, item.phase ? `phase=${item.phase}` : "", item.attempt ? `attempt=${item.attempt}` : "", `gate=${item.gate}`]
		.filter(Boolean)
		.join(" ");
	const lines = [`- ${prefix}`];
	if (item.location) lines.push(`  location: ${item.location}`);
	if (item.observed) lines.push(`  observed: ${item.observed}`);
	if (item.expected) lines.push(`  expected: ${item.expected}`);
	if (item.missing?.length) lines.push(`  missing: ${compactList(item.missing)}`);
	if (item.diagnostics?.length) lines.push(`  diagnostics: ${compactList(item.diagnostics, 4)}`);
	lines.push(`  next action: ${item.nextAction}`);
	return lines.join("\n");
}

export function renderRetryFeedbackBlock(items: RetryFeedbackInput[], heading = "Previous attempt rejected — fix these"): string {
	const filtered = items.filter((item) => typeof item === "string" ? item.trim().length > 0 : true);
	if (filtered.length === 0) return "";
	return [
		`## ${heading}`,
		"The harness rejected the prior attempt using external evidence. Address every item before calling structured_output.",
		filtered.map(renderRetryFeedbackItem).join("\n"),
	].join("\n");
}

