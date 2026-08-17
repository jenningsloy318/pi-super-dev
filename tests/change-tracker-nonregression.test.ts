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
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

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

// ---------------------------------------------------------------------------
// (F) SCENARIO-034 / AC-15 (spec-28) — non-ASCII tracked-path claims verify
// clean under `core.quotepath=false`. REAL git fixture: with git's default
// quotepath=true, `diff --name-status` and `status --porcelain` emit non-ASCII
// paths as quoted octal escapes (`"src/\346\226\207...ts"`), so a raw
// `src/图表.ts` claim can never match → a spurious claimed-miss. The tracker
// must force `-c core.quotepath=false` so both sides speak raw paths.
// ---------------------------------------------------------------------------

const sh = (cwd: string, cmd: string): string => {
	try { return execSync(cmd, { cwd, encoding: "utf8" }); } catch { return ""; }
};

/** A real repo with one base commit (no non-ASCII paths yet). The repo's
 *  local config EXPLICITLY sets `core.quotepath=true` — git's default — so the
 *  fixture does not inherit the host's global config (a developer machine with
 *  a global `core.quotepath=false` would otherwise mask the bug: git would emit
 *  raw paths even without the tracker forcing it). The tracker's command-line
 *  `-c core.quotepath=false` outranks the repo-local setting. */
function realGitRepo(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	sh(root, "git init -b main");
	sh(root, "git config user.email t@t && git config user.name t");
	sh(root, "git config core.quotepath true");
	writeFileSync(join(root, "base.txt"), "base\n");
	sh(root, "git add base.txt && git commit -m base");
	return root;
}

describe("AC-15 like-for-like non-ASCII path parity (SCENARIO-034, real git)", () => {
	it("a committed `src/图表.ts` created+claimed mid-bracket verifies clean (claimedNotChanged empty, verdict ok)", () => {
		const root = realGitRepo("sd-nonascii-");
		try {
			const specDir = join(root, "tmp-spec");
			const t = new ChangeTracker(specDir, root);
			t.begin("phase", "phase-01");
			// The implementer creates AND commits the non-ASCII file inside the bracket.
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "图表.ts"), "export const 图 = 1;\n");
			sh(root, "git add src/图表.ts && git commit -m add-nonascii");
			const rec = t.end("phase", "phase-01", {
				filesCreated: ["src/图表.ts"],
				filesModified: [],
				filesDeleted: [],
			});
			// Raw non-ASCII output parsed as-is — not a quoted octal-escape blob.
			expect(rec!.gitActual!.created).toContain("src/图表.ts");
			expect(rec!.crossCheck!.claimedNotChanged).toEqual([]);
			expect(rec!.verdict).toBe("ok");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("an UNCOMMITTED `src/图表.ts` porcelain claim also verifies clean (status --porcelain path parity)", () => {
		const root = realGitRepo("sd-nonascii-uncommitted-");
		try {
			const specDir = join(root, "tmp-spec");
			const t = new ChangeTracker(specDir, root);
			t.begin("phase", "phase-01");
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "图表.ts"), "export const 图 = 1;\n");
			const rec = t.end("phase", "phase-01", {
				filesCreated: ["src/图表.ts"],
				filesModified: [],
				filesDeleted: [],
			});
			expect(rec!.gitActual!.created).toContain("src/图表.ts");
			expect(rec!.crossCheck!.claimedNotChanged).toEqual([]);
			expect(rec!.verdict).toBe("ok");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
