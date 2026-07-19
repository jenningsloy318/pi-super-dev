/**
 * Phase 1 — Configurable build-gate timeout (RED phase).
 *
 * These tests define the contract for the timeout resolution BEFORE the
 * implementation exists. They target AC-01 (default raised to 10 min),
 * AC-02 (env-configurable via SUPER_DEV_BUILD_TIMEOUT_MS), AC-05 partial
 * (explicit opt overrides env+default), and AC-08 timeout subset.
 *
 * `DEFAULT_TIMEOUT_MS` and `resolveTimeoutMs` do NOT exist yet — importing
 * them fails the file until they are implemented (intentional RED state).
 *
 * Pure & hermetic: no process spawning. Each env-touching test saves and
 * restores `process.env` so tests stay independent (no shared state).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
// import resolves now that Phase 1 exports DEFAULT_TIMEOUT_MS + resolveTimeoutMs.
import { DEFAULT_TIMEOUT_MS, resolveTimeoutMs } from "../src/build-runner.ts";

const ENV_KEY = "SUPER_DEV_BUILD_TIMEOUT_MS";

describe("DEFAULT_TIMEOUT_MS export (AC-01)", () => {
	it("is exported as a number", () => {
		expect(typeof DEFAULT_TIMEOUT_MS).toBe("number");
	});

	it("is raised from the old 120_000 hardcoded value to the 10-minute default", () => {
		expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
	});

	it("is not the legacy 120_000 value (regression guard)", () => {
		expect(DEFAULT_TIMEOUT_MS).not.toBe(120_000);
	});
});

describe("resolveTimeoutMs — fallback matrix (AC-01/AC-02)", () => {
	// Per-test env save/restore keeps tests independent.
	let saved: string | undefined;

	beforeEach(() => {
		saved = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
	});

	afterEach(() => {
		if (saved === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = saved;
	});

	it("returns the 10-minute default when called with no args and no env", () => {
		expect(resolveTimeoutMs()).toBe(600_000);
	});

	it("treats an empty-string env as missing → default", () => {
		process.env[ENV_KEY] = "";
		expect(resolveTimeoutMs()).toBe(600_000);
	});

	it("treats a non-numeric env (NaN) → default", () => {
		process.env[ENV_KEY] = "abc";
		expect(resolveTimeoutMs()).toBe(600_000);
	});

	it("treats a zero env (<=0) → default", () => {
		process.env[ENV_KEY] = "0";
		expect(resolveTimeoutMs()).toBe(600_000);
	});

	it("treats a negative env (<=0) → default", () => {
		process.env[ENV_KEY] = "-5";
		expect(resolveTimeoutMs()).toBe(600_000);
	});

	it("parses a base-10 numeric env as milliseconds", () => {
		process.env[ENV_KEY] = "900000";
		expect(resolveTimeoutMs()).toBe(900_000);
	});

	it("honors a positive numeric env strictly greater than zero", () => {
		process.env[ENV_KEY] = "12345";
		expect(resolveTimeoutMs()).toBe(12_345);
	});

	it("ignores leading/trailing whitespace around a numeric env", () => {
		// parseInt(_, 10) trims leading whitespace and stops at the first
		// non-digit, so "  12345 " resolves to 12345.
		process.env[ENV_KEY] = "  12345 ";
		expect(resolveTimeoutMs()).toBe(12_345);
	});
});

describe("resolveTimeoutMs — explicit opt overrides env + default (AC-05 partial)", () => {
	let saved: string | undefined;

	beforeEach(() => {
		saved = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
	});

	afterEach(() => {
		if (saved === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = saved;
	});

	it("returns an explicit positive number with no env set (overrides default)", () => {
		expect(resolveTimeoutMs(1234)).toBe(1234);
	});

	it("returns an explicit positive number even when a valid env is set (opt wins over env)", () => {
		process.env[ENV_KEY] = "900000";
		expect(resolveTimeoutMs(1234)).toBe(1234);
	});

	it("returns an explicit positive number even when env is invalid", () => {
		process.env[ENV_KEY] = "abc";
		expect(resolveTimeoutMs(1234)).toBe(1234);
	});

	it("falls through to env/default when the explicit opt is not positive (0)", () => {
		// 0 is not a finite positive number → not an override; uses env/default.
		expect(resolveTimeoutMs(0)).toBe(600_000);
	});

	it("falls through to env/default when the explicit opt is negative", () => {
		expect(resolveTimeoutMs(-5)).toBe(600_000);
	});

	it("falls through to env/default when the explicit opt is NaN", () => {
		expect(resolveTimeoutMs(Number.NaN)).toBe(600_000);
	});

	it("falls through to env/default when the explicit opt is non-finite (Infinity)", () => {
		// Only finite positive numbers are honored as an explicit override.
		expect(resolveTimeoutMs(Number.POSITIVE_INFINITY)).toBe(600_000);
	});

	it("honors an explicit positive opt even when env would otherwise be 0", () => {
		process.env[ENV_KEY] = "0";
		expect(resolveTimeoutMs(1234)).toBe(1234);
	});
});
