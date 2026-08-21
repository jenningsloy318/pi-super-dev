/**
 * M4 (v0.3.8) escalation-surface pins: the route-back choice (G6) —
 * option offering, mapping, report persistence, and the artifact-convergence
 * intercept (choice → RouteBackSignal; planner-null → emulation; both-null →
 * honest fatal).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalateOptionsFor, mapEscalateChoice } from "../src/extension.ts";
import { writeEscalationReport } from "../src/render/escalation-report.ts";
import type { EscalationFailure } from "../src/types.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-m4-esc-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("M4 escalation route-back choice (G6)", () => {
	it("routeBackOwner adds the recommended option FIRST (soft + hard)", () => {
		const soft = escalateOptionsFor({ severity: "soft", routeBackOwner: "requirements" });
		expect(soft[0]).toBe("Route back to requirements (recommended)");
		expect(soft).toHaveLength(5);
		const hard = escalateOptionsFor({ severity: "hard", routeBackOwner: "spec" });
		expect(hard[0]).toBe("Route back to spec (recommended)");
		expect(hard).toHaveLength(4);
		// no owner → unchanged lists
		expect(escalateOptionsFor({ severity: "soft" })).toHaveLength(4);
		expect(escalateOptionsFor({ severity: "soft" })[0]).toBe("Retry with guidance");
	});

	it("mapEscalateChoice maps the route-back option (and nothing else mis-maps)", () => {
		expect(mapEscalateChoice("Route back to requirements (recommended)")).toEqual({ choice: "route-back" });
		expect(mapEscalateChoice("Retry with guidance")).toEqual({ choice: "retry-with-guidance" });
		expect(mapEscalateChoice("Revise manually")).toEqual({ choice: "revise-manually" });
		expect(mapEscalateChoice("Accept limitation")).toEqual({ choice: "accept-limitation" });
		expect(mapEscalateChoice("Abandon")).toEqual({ choice: "abandon" });
		expect(mapEscalateChoice(undefined)).toBeUndefined();
	});

	it("MP5: the report persists the route-back owner and offered choices", () => {
		const specDir = join(dir, "spec");
		mkdirSync(specDir, { recursive: true });
		const failure: EscalationFailure = {
			kind: "stagnation",
			stage: "bdd",
			message: "upstream-owned blocker",
			severity: "soft",
			routeBackOwner: "requirements",
			offeredChoices: escalateOptionsFor({ severity: "soft", routeBackOwner: "requirements" }),
		};
		writeEscalationReport(failure, undefined, specDir);
		const report = readFileSync(join(specDir, "escalation-report.md"), "utf8");
		expect(report).toContain("**Route-back owner:** requirements");
		expect(report).toContain("**Offered choices:** Route back to requirements (recommended) | Retry with guidance");
	});
});

describe("M4 round-1 remediation pins", () => {
	it("applyRetryDecision is a NO-OP for a route-back choice (no rollback, no guidance)", async () => {
		const { applyRetryDecision } = await import("../src/escalation.ts");
		const before = JSON.stringify(state0);
		// guidance present + a rollback-eligible worktree: BOTH must be ignored.
		applyRetryDecision(state0, { choice: "route-back", guidance: "should never be consumed" }, { worktreePath: dir, specDirectory: dir });
		expect(JSON.stringify(state0)).toBe(before); // untouched
		// and the guidance landed nowhere on disk (no user-notes write).
		expect(existsSync(join(dir, ".user-notes.json"))).toBe(false);
	});
});

// minimal shared state for the no-op pin
const state0: Record<string, unknown> = { review: { verdict: "x" } };
