/**
 * Compact, reusable retry-feedback blocks for bounded agent loops.
 *
 * A retrying agent should not receive only "failed" or a growing transcript. The
 * harness should encode the current rejection as location / observed / expected
 * / missing items / next action, then feed that compact repair record into the
 * next same-role attempt.
 */

import { fenceUntrusted } from "./fence.ts";


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

export type RetryFeedbackMap = Record<string, RetryFeedbackInput[]>;

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
	// AC-31 (SCENARIO-063): the item bodies carry LLM-authored observed/missing
	// text — fence the rendered list (the heading and the harness instruction
	// line stay outside).
	return [
		`## ${heading}`,
		"The harness rejected the prior attempt using external evidence. Address every item before calling structured_output.",
		fenceUntrusted(filtered.map(renderRetryFeedbackItem).join("\n"), "prior-attempt feedback"),
	].join("\n");
}

function feedbackMap(state: Record<string, unknown>): RetryFeedbackMap {
	const existing = state.__feedback;
	if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as RetryFeedbackMap;
	const created: RetryFeedbackMap = {};
	state.__feedback = created;
	return created;
}

export function getRetryFeedback(state: Record<string, unknown>, key: string): RetryFeedbackInput[] | undefined {
	const existing = state.__feedback;
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) return undefined;
	const value = (existing as RetryFeedbackMap)[key];
	return Array.isArray(value) ? value : undefined;
}

export function setRetryFeedback(state: Record<string, unknown>, key: string, items: RetryFeedbackInput | RetryFeedbackInput[]) {
	feedbackMap(state)[key] = Array.isArray(items) ? items : [items];
}

export function clearRetryFeedback(state: Record<string, unknown>, ...keys: string[]) {
	const existing = state.__feedback;
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) return;
	const map = existing as RetryFeedbackMap;
	for (const key of keys) delete map[key];
}
