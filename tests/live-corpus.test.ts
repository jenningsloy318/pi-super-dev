/**
 * v0.3.48 — live payload corpus (docs/testing-strategy.md L1).
 *
 * Every file under tests/fixtures/live-corpus/ is a REAL agent output
 * captured from a live run. Loading it here pins the engine's parse/render
 * boundary against the actual shapes models emit — the discipline born from
 * the v0.3.32–v0.3.39 drift wave and the v0.3.48 poisoned-replay incident.
 *
 * When a live run exposes a new failure class, extract the raw text BEFORE
 * the resume cache is consumed, drop it here with the run id in the name,
 * and pin the recovered contract.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractControl, repairUnescapedQuotes } from "../src/control.ts";

const corpus = (name: string) => readFileSync(join(__dirname, "fixtures/live-corpus", name), "utf8");

describe("live corpus — control extraction (L1)", () => {
	it("2026-08-31 cosmic-clock requirements review: unescaped HTML quotes in evidence no longer kill the control (the 22m52s + poisoned-replay-abort chain)", () => {
		const t = corpus("2026-08-31-cosmic-clock-requirements-review-unescaped-quotes.txt");
		// Strict JSON.parse fails on this payload (verified during the incident:
		// `Expected ',' or '}' after property value` at the `class="card "` quote).
		const body = t.match(/<control>\s*([\s\S]*?)\s*<\/control>/i)?.[1] ?? "";
		expect(body.length).toBeGreaterThan(1000);
		expect(() => JSON.parse(body.trim())).toThrow();
		// The repair boundary recovers the full review.
		const c = extractControl(t);
		expect(c).not.toBeNull();
		const ctrl = c as Record<string, unknown>;
		expect(ctrl.verdict).toBe("Changes Requested");
		expect((ctrl.findings as unknown[]).length).toBe(6);
		// the four blocking golden-value math findings the run died without:
		const titles = (ctrl.findings as Array<{ title: string; blocking: boolean }>).map((f) => f.title);
		expect(titles.some((x) => x.includes("doppler1pz"))).toBe(true);
		expect(titles.some((x) => x.includes("rvK"))).toBe(true);
		expect(titles.some((x) => x.includes("lambdaObs"))).toBe(true);
		// the optional round-1 key was correctly absent-then-empty:
		expect(ctrl.priorFindingResolutions).toEqual([]);
	});
});

describe("repairUnescapedQuotes (unit edges)", () => {
	it("escapes inner quotes so the payload parses to the INTENDED value", () => {
		const broken = `{"a": "he said <a class="x"> ok", "b": 1}`;
		const repaired = repairUnescapedQuotes(broken)!;
		const parsed = JSON.parse(repaired) as { a: string; b: number };
		expect(parsed.a).toBe('he said <a class="x"> ok');
		expect(parsed.b).toBe(1);
	});
	it("even the ambiguous inner-quote-before-comma case recovers the intended value (verified live-class behavior)", () => {
		const broken = `{"a": "he said class="card," loudly", "b": 1}`;
		const repaired = repairUnescapedQuotes(broken)!;
		const parsed = JSON.parse(repaired) as { a: string };
		expect(parsed.a).toBe('he said class="card," loudly'); // evidence text NEVER mutated
	});
	it("well-formed JSON passes through byte-identical", () => {
		const raw = `{"a": "clean", "list": [1, 2], "nested": {"k": "v"}}`;
		expect(repairUnescapedQuotes(raw)).toBe(raw);
	});
	it("trailing quote at end of input closes the string", () => {
		expect(repairUnescapedQuotes(`{"a": "v"}`)).toBe(`{"a": "v"}`);
	});
});
