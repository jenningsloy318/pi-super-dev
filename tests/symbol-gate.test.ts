/**
 * Unit tests for `computeSymbolGate` (src/build-runner/gates.ts) — the
 * silent-empty-success / hollow-file killer. A claimed source deliverable that
 * EXISTS but contains only comments/whitespace (no language symbols) must FAIL
 * the gate and be listed in `hollowFiles`; real code, unknown languages, and
 * phases with no source files must PASS (never block on infrastructure).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSymbolGate } from "../src/build-runner.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "symbol-gate-"));
});
afterEach(() => {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("computeSymbolGate", () => {
	it("a real Rust source file (has fn/struct) → PASS", () => {
		writeFileSync(join(dir, "run.rs"), "//! runtime driver\npub fn run() -> u32 { 42 }\n");
		const r = computeSymbolGate(dir, ["run.rs"], "rust");
		expect(r.pass).toBe(true);
		expect(r.hollowFiles).toEqual([]);
	});

	it("a doc-comment-only Rust shell → FAIL + listed (the empty-shell case)", () => {
		// Mirrors the omniAnasis failure: ~1.5KB of //! comments, zero symbols.
		writeFileSync(join(dir, "events.rs"), "//! Event stream bridge.\n//!\n//! Maps adk-graph StreamEvent onto the SSE sink.\n//! TODO: implement mapping.\n");
		const r = computeSymbolGate(dir, ["events.rs"], "rust");
		expect(r.pass).toBe(false);
		expect(r.hollowFiles).toEqual(["events.rs"]);
	});

	it("a TS/JS file with const/function → PASS; comments-only → FAIL", () => {
		writeFileSync(join(dir, "a.ts"), "/** module */\nexport const x = 1;\n");
		expect(computeSymbolGate(dir, ["a.ts"], "frontend").pass).toBe(true);
		writeFileSync(join(dir, "b.ts"), "/** just docs */\n// TODO implement\n");
		expect(computeSymbolGate(dir, ["b.ts"], "frontend").pass).toBe(false);
	});

	it("mixed: one real + one hollow → FAIL, only the hollow file listed", () => {
		writeFileSync(join(dir, "good.rs"), "pub fn ok() {}");
		writeFileSync(join(dir, "bad.rs"), "//! shell only\n");
		const r = computeSymbolGate(dir, ["good.rs", "bad.rs"], "rust");
		expect(r.pass).toBe(false);
		expect(r.hollowFiles).toEqual(["bad.rs"]);
	});

	it("unknown language → PASS (never block)", () => {
		writeFileSync(join(dir, "x.xyz"), "just text");
		expect(computeSymbolGate(dir, ["x.xyz"], "klingon").pass).toBe(true);
	});

	it("no source files (config/docs only) → PASS (never block doc-only phases)", () => {
		writeFileSync(join(dir, "README.md"), "# docs");
		writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
		expect(computeSymbolGate(dir, ["README.md", "Cargo.toml"], "rust").pass).toBe(true);
	});

	it("an unreadable / missing file is SKIPPED (not hollow) → PASS", () => {
		// claimed but never created — the deliverable/change gates handle absence;
		// the symbol gate must not block (and never throw) on a read failure.
		expect(computeSymbolGate(dir, ["never-created.rs"], "rust").pass).toBe(true);
	});

	it("block comments are stripped before symbol counting", () => {
		// a file that is ONLY a /* ... */ block comment (no code) → hollow
		writeFileSync(join(dir, "c.rs"), "/* this whole file is a comment\nwith fn mentioned in prose but no real code */\n");
		expect(computeSymbolGate(dir, ["c.rs"], "rust").pass).toBe(false);
	});

	it("python: def/class present → PASS; only docstrings/comments → FAIL", () => {
		writeFileSync(join(dir, "m.py"), '"""module"""\ndef main():\n    pass\n');
		expect(computeSymbolGate(dir, ["m.py"], "python").pass).toBe(true);
		writeFileSync(join(dir, "n.py"), '"""only a docstring"""\n# TODO\n');
		expect(computeSymbolGate(dir, ["n.py"], "python").pass).toBe(false);
	});
});
