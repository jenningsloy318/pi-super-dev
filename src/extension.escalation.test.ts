/**
 * Phase 2 — `makeEscalate(ctx)` callback contract (spec-18 / AC-01).
 *
 * `makeEscalate` ALWAYS writes `escalation-report.md` (via `writeEscalationReport`),
 * then — ONLY when `ctx.hasUI === true` — prompts `ctx.ui.select` (300s timeout)
 * and, for a retry-with-guidance choice, `ctx.ui.input` to capture free-text
 * guidance. Dismissal / timeout / error all collapse to `undefined`. The
 * `accept-limitation` choice is OMITTED from the offered options when the
 * failure is `severity: "hard"`. NEVER throws.
 *
 * RED: every assertion fails until `makeEscalate` is implemented (the returned
 * closure throws). Tests use an injected fake `ctx` (no real ctx.ui / agents).
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStagnation, makeEscalate } from "./extension.ts";
import type { EscalationFailure, RunSummary } from "./types.ts";

const softFailure = (specDirectory: string): EscalationFailure => ({
	kind: "stagnation",
	stage: "review",
	message: "stuck",
	specDirectory,
	severity: "soft",
	findings: [{ file: "a.ts", severity: "high", title: "T" }],
});

describe("makeEscalate — always writes the report (SCENARIO-001)", () => {
	it("writes escalation-report.md even in headless mode (no decision)", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		try {
			const escalate = makeEscalate({ hasUI: false });
			const decision = await escalate(softFailure(d));
			expect(decision).toBeUndefined();
			expect(existsSync(join(d, "escalation-report.md"))).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("makeEscalate — headless no-prompt (AC-01)", () => {
	it("does not call ctx.ui.select when ctx.hasUI is false", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		const select = vi.fn();
		try {
			const escalate = makeEscalate({ hasUI: false, ui: { select } });
			await escalate(softFailure(d));
			expect(select).not.toHaveBeenCalled();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("returns undefined (and writes the report) when hasUI is false", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		try {
			const escalate = makeEscalate({ hasUI: false });
			const decision = await escalate(softFailure(d));
			expect(decision).toBeUndefined();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("makeEscalate — interactive path (AC-01)", () => {
	it("prompts select + input and maps retry-with-guidance to a decision", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		try {
			const select = vi.fn().mockResolvedValue("Retry with guidance");
			const input = vi.fn().mockResolvedValue("bump the cap");
			const escalate = makeEscalate({ hasUI: true, ui: { select, input } });
			const decision = await escalate(softFailure(d));
			expect(select).toHaveBeenCalledTimes(1);
			expect(input).toHaveBeenCalledTimes(1);
			expect(decision?.choice).toBe("retry-with-guidance");
			expect(decision?.guidance).toBe("bump the cap");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("passes a 300s (300_000ms) timeout to ctx.ui.select", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		try {
			const select = vi.fn().mockResolvedValue("Abandon");
			const escalate = makeEscalate({ hasUI: true, ui: { select, input: vi.fn() } });
			await escalate(softFailure(d));
			const opts = select.mock.calls[0]?.[2] as { timeout?: number } | undefined;
			expect(opts?.timeout).toBe(300_000);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("offers accept-limitation for a SOFT failure", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		try {
			const select = vi.fn().mockResolvedValue("Abandon");
			const escalate = makeEscalate({ hasUI: true, ui: { select, input: vi.fn() } });
			await escalate(softFailure(d));
			const options = (select.mock.calls[0]?.[1] as string[] | undefined) ?? [];
			expect(options.some((o) => /accept/i.test(o))).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("OMITS accept-limitation for a HARD failure", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		try {
			const select = vi.fn().mockResolvedValue("Abandon");
			const escalate = makeEscalate({ hasUI: true, ui: { select, input: vi.fn() } });
			await escalate({ ...softFailure(d), severity: "hard" });
			const options = (select.mock.calls[0]?.[1] as string[] | undefined) ?? [];
			expect(options.some((o) => /accept/i.test(o))).toBe(false);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("surfaces the FULL blocker (message + findings) in the prompt — not just 'a blocker'", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		try {
			const select = vi.fn().mockResolvedValue("Abandon");
			const escalate = makeEscalate({ hasUI: true, ui: { select, input: vi.fn() } });
			const failure: EscalationFailure = {
				kind: "gate-exhaustion",
				stage: "requirements",
				severity: "hard",
				message: "the requirements gate could not pass after 2 attempts: spec gap X",
				specDirectory: d,
				findings: [{ file: "docs/req.md", severity: "blocker", title: "missing acceptance criteria" }],
			};
			await escalate(failure);
			const prompt = String(select.mock.calls[0]?.[0] ?? "");
			// The prompt must carry the blocker context the user needs to decide…
			expect(prompt).toContain(failure.message);
			expect(prompt).toContain("missing acceptance criteria");
			expect(prompt).toContain("docs/req.md");
			expect(prompt).toContain("Stage: requirements");
			// …not just the generic "hit a blocker" headline.
			expect(prompt.length).toBeGreaterThan("Super-dev hit a blocker — how to proceed?".length);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("handleStagnation — delegates report-writing to writeEscalationReport (Phase 2)", () => {
	it("writes escalation-report.md via the shared writer with the stagnation record", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-stag-"));
		try {
			const summary = {
				specDirectory: d,
				state: {
					__stagnated: {
						rounds: 2,
						verdict: "fail",
						findings: [{ file: "src/x.ts", severity: "high", title: "broken invariant" }],
					},
				},
			} as unknown as RunSummary;
			// Headless ctx: only the report write happens (no interactive prompt).
			const choice = await handleStagnation(summary, { hasUI: false });
			expect(choice).toBeUndefined();
			expect(existsSync(join(d, "escalation-report.md"))).toBe(true);
			const body = readFileSync(join(d, "escalation-report.md"), "utf8");
			// Kind + the recurring finding title are delegated through the writer.
			expect(body).toMatch(/stagnation/i);
			expect(body).toMatch(/broken invariant/);
			// Stagnation prose is preserved in the message body.
			expect(body).toMatch(/review round/i);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("never throws when the spec dir is unwritable (delegated writer guards)", async () => {
		const summary = {
			specDirectory: "/nonexistent/sd-path/cannot/be/written/escalation-report.md",
			state: { __stagnated: { rounds: 1, verdict: "fail", findings: [] } },
		} as unknown as RunSummary;
		await expect(handleStagnation(summary, { hasUI: false })).resolves.toBeUndefined();
	});
});

describe("makeEscalate — never throws (AC-01 / SCENARIO-012)", () => {
	it("returns undefined (never throws) when ctx.ui.select throws", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		try {
			const select = vi.fn().mockRejectedValue(new Error("dismissed"));
			const escalate = makeEscalate({ hasUI: true, ui: { select, input: vi.fn() } });
			await expect(escalate(softFailure(d))).resolves.toBeUndefined();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("returns undefined when the prompt is dismissed (select resolves undefined)", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-mk-"));
		try {
			const select = vi.fn().mockResolvedValue(undefined);
			const escalate = makeEscalate({ hasUI: true, ui: { select, input: vi.fn() } });
			const decision = await escalate(softFailure(d));
			expect(decision).toBeUndefined();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
