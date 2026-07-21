/**
 * Phase 5 — Quality-gate non-regression audit (RED phase).
 * spec-11 AC-11 → SCENARIO-020 (Layer 6).
 *
 * Phase 5's gate is `npm run typecheck && npm test` both exit 0 with NO
 * regression to: runRedCheck, runDeliverableCheck + cache reset, npm in-scope
 * classification, scope-aware cargo gate, themed live stream, mid-run input
 * injection (activeRun coexists with activeTracker), the dashboard widget, and
 * real-theme parity. This file codifies the SUBSET of that contract that can be
 * asserted statically/behaviourally (the rest is exercised by the existing
 * suite staying green):
 *
 *   (A) Deliverable contract — the four Phase 1-4 test files exist on disk
 *       (guards against an accidental delete that would silently drop coverage).
 *   (B) Theme audit — NO new code destructured a pi `Theme` method call
 *       (`const { fg } = theme`); pi `Theme` must be called method-style
 *       (`theme.fg(...)`). This is the grep audit the spec asks Phase 5d to run,
 *       codified as a regression guard. Real-theme parity tests guard render.
 *   (C) Singleton coexistence — `activeTracker` (tracking.ts) and `activeRun`
 *       (extension.ts) are independent module-scoped singletons; mid-run input
 *       injection reads activeRun while phases bracket via activeTracker.
 *   (D) computeChangeGate contract — never throws on null/unknown/garbage,
 *       returns `{ pass, claimedNotChanged }`, blocks ONLY on a real
 *       claimed-miss (SCENARIO-013/016/017).
 *   (E) Tracking types exported — the strict-mode types Phase 5 cleans up
 *       (ChangeRecord, StructuredChanges, CrossCheck, ChangeTracker, TrackerUnit)
 *       are all part of the public module surface.
 *
 * Most assertions are GREEN guards (correct initial state = no regression).
 * The genuinely failing tests for this cut live in `tracker-bracketing.test.ts`
 * (Phase 3a wiring). This file is the durable no-regression fence.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	ChangeTracker,
	setActiveTracker,
	getActiveTracker,
	type ChangeRecord,
	type StructuredChanges,
	type CrossCheck,
	type TrackerUnit,
} from "../src/tracking.ts";
import { computeChangeGate } from "../src/build-runner.ts";
import { setActiveRun, getActiveRun } from "../src/extension.ts";

const repoRoot = process.cwd();

function readSrc(rel: string): string {
	return readFileSync(join(repoRoot, rel), "utf8");
}

/** Recursively collect every `.ts`/`.tsx` file under a src subtree. */
function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listSourceFiles(full));
		else if (entry.isFile() && /\.(ts|tsx)$/i.test(entry.name)) out.push(full);
	}
	return out;
}

// ---------------------------------------------------------------------------
// (A) Deliverable contract — Phase 1-4 test files exist
// ---------------------------------------------------------------------------

describe("AC-11 deliverable contract (Phase 1-4 test files exist)", () => {
	const expected = [
		"tests/tracking.test.ts",
		"tests/structured-changes.test.ts",
		"tests/tracker-bracketing.test.ts",
		"tests/implementation-crosscheck-gate.test.ts",
	];
	for (const rel of expected) {
		it(`ships ${rel}`, () => {
			expect(existsSync(join(repoRoot, rel)), `expected ${rel} to exist`).toBe(true);
		});
	}
});

// ---------------------------------------------------------------------------
// (B) Theme audit — no destructured pi Theme method call (Phase 5d grep)
// ---------------------------------------------------------------------------

describe("AC-11 theme audit (no destructured Theme method call)", () => {
	const srcFiles = listSourceFiles(join(repoRoot, "src"));
	// Match the spec's anti-pattern: `const { fg } = theme`, `const { fg, bg } = theme`,
	// or any `} = <someThemeVar>` object-destructure that pulls Theme methods off.
	// Method-style calls (`theme.fg(...)`) are the required form.
	const destructuredThemePattern = /\{\s*[a-zA-Z0-9_,\s]+\s*\}\s*=\s*[A-Za-z_][A-Za-z0-9_]*\s*[,;)\n]/;

	it("no src file destructures a Theme into local method bindings", () => {
		const offenders: string[] = [];
		for (const f of srcFiles) {
			const text = readFileSync(f, "utf8");
			// Only flag lines that ALSO reference a known pi Theme method, to avoid
			// matching unrelated generic destructures.
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					destructuredThemePattern.test(line) &&
					/\b(fg|bg|dim|bold|underline|red|green|yellow|blue|magenta|cyan|gray|grey)\b/.test(line)
				) {
					offenders.push(`${f}:${i + 1}: ${line.trim()}`);
				}
			}
		}
		expect(
			offenders,
			`destructured Theme methods must be converted to theme.method(...) style:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (C) Singleton coexistence — activeTracker + activeRun (mid-run input injection)
// ---------------------------------------------------------------------------

describe("AC-11 singleton coexistence (activeTracker + activeRun)", () => {
	it("activeTracker and activeRun are independent get/set singletons", () => {
		// activeTracker
		setActiveTracker(null);
		expect(getActiveTracker()).toBeNull();
		const tracker = new ChangeTracker(join(repoRoot, ".tmp-test-spec"), repoRoot);
		setActiveTracker(tracker);
		expect(getActiveTracker()).toBe(tracker);

		// activeRun is a SEPARATE singleton; setting one must not clobber the other.
		setActiveRun(null);
		expect(getActiveRun()).toBeNull();
		expect(getActiveTracker(), "activeTracker must survive activeRun reset").toBe(tracker);

		// Teardown — never leak across tests.
		setActiveTracker(null);
		setActiveRun(null);
		expect(getActiveTracker()).toBeNull();
		expect(getActiveRun()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// (D) computeChangeGate contract — never throws, blocks only on a real miss
// ---------------------------------------------------------------------------

describe("AC-11 computeChangeGate never-throws / blocks-on-miss contract", () => {
	it("returns trivial pass on null / undefined / unknown shapes", () => {
		for (const rec of [null, undefined, {}, { foo: "bar" }, 42, "string"]) {
			const g = computeChangeGate(rec);
			expect(g.pass, `rec=${JSON.stringify(rec)}`).toBe(true);
			expect(g.claimedNotChanged).toEqual([]);
		}
	});

	it("passes when git was unavailable (no block on infrastructure)", () => {
		const g = computeChangeGate({ gitUnavailable: true, crossCheck: { claimedNotChanged: ["x"] } });
		expect(g.pass).toBe(true);
		expect(g.claimedNotChanged).toEqual([]);
	});

	it("passes when there is no crossCheck (trivial pass)", () => {
		const g = computeChangeGate({ crossCheck: null });
		expect(g.pass).toBe(true);
	});

	it("blocks (pass=false) ONLY when claimedNotChanged is non-empty AND git was available", () => {
		const g = computeChangeGate({
			crossCheck: { claimedNotChanged: ["src/a.ts", "src/b.ts"], changedNotClaimed: ["src/c.ts"] },
		});
		expect(g.pass).toBe(false);
		expect(g.claimedNotChanged).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("changedNotClaimed (under-reporting) is advisory and never blocks", () => {
		const g = computeChangeGate({
			crossCheck: { claimedNotChanged: [], changedNotClaimed: ["src/extra.ts"] },
		});
		expect(g.pass).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (E) Tracking type exports — strict-mode types are public module surface
// ---------------------------------------------------------------------------

describe("AC-11 tracking types are exported (strict-mode surface intact)", () => {
	it("ChangeTracker class is exported", () => {
		expect(typeof ChangeTracker).toBe("function");
	});

	it("ChangeRecord / StructuredChanges / CrossCheck / TrackerUnit types are exported", () => {
		// Type-only imports compile only when the symbols are part of the module
		// surface; this assertion guarantees the export survives any strict-mode
		// refactor Phase 5 performs. The runtime check binds the types to locals.
		const _a: ChangeRecord | null = null;
		const _b: StructuredChanges = { filesCreated: [], filesModified: [], filesDeleted: [] };
		const _c: CrossCheck = { claimedNotChanged: [], changedNotClaimed: [] };
		const _d: TrackerUnit = "stage";
		expect(_a).toBeNull();
		expect(_b.filesCreated).toEqual([]);
		expect(_c.claimedNotChanged).toEqual([]);
		expect(_d).toBe("stage");
	});
});
