/**
 * Static-site integration honesty (run 2026-08-27T12-33-43-088Z).
 *
 * A static HTML tree (index.html, no package.json — the Caddyfile/Makefile
 * nuclear-fission project) has no dev-server machinery. When its ui service
 * cannot start, that is a property of the project, not failed verification:
 * `integrationOutcome` must classify it `skipped-static` (with the bringup
 * staticSite flag) instead of the hard-gating `skipped-service-unavailable`
 * that misreported 10h of green deterministic work as PARTIAL.
 */
import { describe, it, expect } from "vitest";
import { integrationOutcome } from "../src/stages/verify.ts";
import type { PipelineState } from "../src/types.ts";

const uiUnavailable = { pass: false, skipped: true, failures: [{ reason: "service(s) not ready: ui" }], summary: "service(s) not ready: ui" };

describe("integrationOutcome — skipped-static", () => {
	it("classifies a service-unavailable ui role on a STATIC tree as skipped-static", () => {
		const s = {
			integrationExpectedTests: ["ui"],
			uiTest: uiUnavailable,
			bringup: { staticSite: true },
		} as unknown as PipelineState;
		expect(integrationOutcome(s)).toMatchObject({ status: "skipped-static", pass: false });
	});

	it("keeps skipped-service-unavailable (hard) for NON-static projects", () => {
		const s = {
			integrationExpectedTests: ["ui"],
			uiTest: uiUnavailable,
			bringup: { staticSite: false },
		} as unknown as PipelineState;
		expect(integrationOutcome(s)).toMatchObject({ status: "skipped-service-unavailable", pass: false });
	});

	it("a REAL test failure outranks the static skip", () => {
		const s = {
			integrationExpectedTests: ["ui"],
			uiTest: { pass: false, failures: [{ reason: "assertion failed: card count" }] },
			bringup: { staticSite: true },
		} as unknown as PipelineState;
		expect(integrationOutcome(s)).toMatchObject({ status: "failed", pass: false });
	});

	it("a started-and-passed static server still reports passed", () => {
		const s = {
			integrationExpectedTests: ["ui"],
			uiTest: { pass: true },
			bringup: { staticSite: true },
		} as unknown as PipelineState;
		expect(integrationOutcome(s)).toMatchObject({ status: "passed", pass: true });
	});
});
