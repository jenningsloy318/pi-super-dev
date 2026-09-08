/**
 * Unit tests for workflow resume (v0.3.0, Solution B: memoized replay).
 * No LLM; exercises the cache I/O, resumability detection, and the
 * createMemoizingAgent wrapper (incl. the loop-iteration seq disambiguation).
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendResumeResult,
	loadResumeCache,
	clearResumeCache,
	isResumable,
	isComplete,
	findResumableSpec,
	specDirFor,
	createMemoizingAgent,
	resumeCachePath,
	countStageRounds,
} from "../src/resume.ts";
import type { AgentCall, AgentResult } from "../src/types.ts";

const result = (control: Record<string, unknown> = {}): AgentResult => ({ text: "ok", control, model: "test" });
const call = (id: string): AgentCall => ({ id, agent: "x", prompt: "" });

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "sd-resume-"));
}

describe("resume cache I/O", () => {
	it("round-trips append → load", () => {
		const d = tmpDir();
		try {
			appendResumeResult(d, "a#1", result({ x: 1 }));
			appendResumeResult(d, "a#2", result({ x: 2 }));
			const map = loadResumeCache(d);
			expect(map.size).toBe(2);
			expect(map.get("a#1")?.control).toEqual({ x: 1 });
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("last value wins for a repeated key", () => {
		const d = tmpDir();
		try {
			appendResumeResult(d, "a#1", result({ v: "first" }));
			appendResumeResult(d, "a#1", result({ v: "second" }));
			const map = loadResumeCache(d);
			expect(map.get("a#1")?.control).toEqual({ v: "second" });
			expect(map.size).toBe(1);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("ignores a partial/corrupt trailing line", () => {
		const d = tmpDir();
		try {
			appendResumeResult(d, "a#1", result({ x: 1 }));
			// simulate a crash mid-write: a half line appended
			writeFileSync(resumeCachePath(d), '{"key":"a#1","result":{"text":"ok","control":{"x":1},"model":"test"}}\n{"key":"a#2","result":', { flag: "a" });
			const map = loadResumeCache(d);
			expect(map.get("a#1")?.control).toEqual({ x: 1 });
			expect(map.has("a#2")).toBe(false); // partial line dropped
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("load returns empty Map when no cache exists", () => {
		const d = tmpDir();
		try {
			expect(loadResumeCache(d).size).toBe(0);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("resumability detection", () => {
	it("isResumable: cache present + no complete marker", () => {
		const d = tmpDir();
		try {
			expect(isResumable(d)).toBe(false);
			appendResumeResult(d, "a#1", result());
			expect(isResumable(d)).toBe(true);
			clearResumeCache(d); // marks complete
			expect(isResumable(d)).toBe(false);
			expect(isComplete(d)).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("clearResumeCache truncates the log + writes .complete", () => {
		const d = tmpDir();
		try {
			appendResumeResult(d, "a#1", result());
			clearResumeCache(d);
			expect(readFileSync(resumeCachePath(d), "utf8").trim()).toBe("");
			expect(existsSync(join(d, ".complete"))).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("findResumableSpec + specDirFor", () => {
	it("finds a resumable spec in a worktree dir", () => {
		const cwd = tmpDir();
		try {
			const id = "07-foo";
			const specDir = `${join(cwd, ".worktree", id, "docs", "specifications", id)}/`;
			mkdirSync(specDir, { recursive: true });
			appendResumeResult(specDir, "a#1", result());
			expect(findResumableSpec(cwd)).toBe(id);
			expect(specDirFor(cwd, id).replace(/\\/g, "/")).toContain(id);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("returns undefined when nothing is resumable", () => {
		const cwd = tmpDir();
		try {
			expect(findResumableSpec(cwd)).toBeUndefined();
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("does not return a completed spec", () => {
		const cwd = tmpDir();
		try {
			const id = "08-bar";
			const specDir = `${join(cwd, ".worktree", id, "docs", "specifications", id)}/`;
			mkdirSync(specDir, { recursive: true });
			appendResumeResult(specDir, "a#1", result());
			clearResumeCache(specDir); // mark complete
			expect(findResumableSpec(cwd)).toBeUndefined();
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
});

describe("createMemoizingAgent", () => {
	it("returns the cached result without calling the real agent (hit)", async () => {
		const cache = new Map<string, AgentResult>([["x@root#1", result({ hit: true })]]);
		let calls = 0;
		const agent = createMemoizingAgent(async () => { calls++; return result({ hit: false }); }, cache, () => "/tmp", () => {});
		const r = await agent(call("x"));
		expect(r.control).toEqual({ hit: true });
		expect(calls).toBe(0);
	});

	it("runs + captures on a miss", async () => {
		const cache = new Map<string, AgentResult>();
		const specDir = tmpDir();
		try {
			const agent = createMemoizingAgent(async () => result({ ran: true }), cache, () => specDir, () => {});
			const r = await agent(call("x"));
			expect(r.control).toEqual({ ran: true });
			expect(cache.get("x@root#1")?.control).toEqual({ ran: true });
			// captured to disk too
			expect(loadResumeCache(specDir).get("x@root#1")?.control).toEqual({ ran: true });
		} finally { rmSync(specDir, { recursive: true, force: true }); }
	});

	it("disambiguates repeated call.ids via the monotonic seq (loop-iteration case)", async () => {
		// Simulate a verify-loop where code-review runs each iteration with the
		// SAME call.id. Pre-seed the cache as if iteration 1 completed (seq=1)
		// and iteration 2 was interrupted (seq=2 missing).
		const cache = new Map<string, AgentResult>([
			["pipeline.verify.code-review@root#1", result({ iter: 1 })],
		]);
		const seen: number[] = [];
		const agent = createMemoizingAgent(
			async (c) => { seen.push(Number(c.id)); return result({ iter: seen.length + 1 }); },
			cache, () => "/tmp", () => {},
		);
		// iteration 1 (cached) + iteration 2 (miss → runs)
		const r1 = await agent(call("pipeline.verify.code-review"));
		const r2 = await agent(call("pipeline.verify.code-review"));
		expect(r1.control).toEqual({ iter: 1 }); // cache hit (seq=1)
		expect(r2.control).toEqual({ iter: 2 }); // fresh run (seq=2)
		// the real agent ran exactly once (the miss)
		expect(seen.length).toBe(1);
	});
});

// ── F3 (RC2): the persisted round count a resumed convergence loop reads to
// grant itself FRESH rounds after its replay (effectiveCap = min(prior + cap,
// 3×cap)). Exact-prefix matching: pipeline.specReview@... must NOT count toward
// pipeline.spec.
// ── R8 (AC-21 fix-in-pass): torn-line repair + per-corrupt-line warning.
describe("R8 — torn-line repair + corrupt-line warning", () => {
	it("appendResumeResult repairs a torn (newline-less) trailing line: the good row survives as its own line", () => {
		const d = tmpDir();
		try {
			// simulate a crash mid-write: a half line with NO trailing newline
			writeFileSync(resumeCachePath(d), '{"key":"pipeline.x@root#1","result":{', "utf8");
			appendResumeResult(d, "pipeline.y@root#1", result({ ok: 1 }));
			const map = loadResumeCache(d);
			expect(map.has("pipeline.x@root#1")).toBe(false); // the torn entry is lost by design (one-shot repair)
			expect(map.get("pipeline.y@root#1")?.control).toEqual({ ok: 1 }); // the next good entry is saved
			const lines = readFileSync(resumeCachePath(d), "utf8").split("\n").filter(Boolean);
			expect(lines).toHaveLength(2); // the torn fragment is its own (dead) line; the good row is intact
			expect(lines[1]).toContain("pipeline.y@root#1");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("appendResumeResult is unchanged when the file is empty or ends with a newline", () => {
		const d = tmpDir();
		try {
			appendResumeResult(d, "a#1", result({ x: 1 }));
			appendResumeResult(d, "a#2", result({ x: 2 }));
			const lines = readFileSync(resumeCachePath(d), "utf8").split("\n").filter(Boolean);
			expect(lines).toHaveLength(2);
			expect(loadResumeCache(d).size).toBe(2);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("loadResumeCache warns exactly once per skipped corrupt line", () => {
		const d = tmpDir();
		try {
			writeFileSync(resumeCachePath(d), [
				"not-json-at-all",
				JSON.stringify({ key: "good@root#1", result: { text: "", control: {}, model: "t" } }),
				'{"broken":',
			].join("\n") + "\n");
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const map = loadResumeCache(d);
				expect(map.size).toBe(1); // only the good row loads
				expect(warn.mock.calls.filter((c) => String(c[0]).includes("[resume] skipping unparseable cache line"))).toHaveLength(2);
			} finally {
				warn.mockRestore();
			}
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("countStageRounds (F3 resume round budget)", () => {
	it("counts the max persisted occurrence for the exact call id", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-count-rounds-"));
		try {
			const cache = `${d}/.resume-cache.jsonl`;
			writeFileSync(cache, [
				JSON.stringify({ key: "pipeline.spec@root#1", result: { text: "r1" } }),
				JSON.stringify({ key: "pipeline.spec@root#2", result: { text: "r2" } }),
				JSON.stringify({ key: "pipeline.spec@root#8", result: { text: "r8" } }),
				JSON.stringify({ key: "pipeline.specReview@root#1", result: { text: "review" } }),
				JSON.stringify({ key: "pipeline.specification@root#3", result: { text: "other" } }),
			].join("\n") + "\n");
			expect(countStageRounds(d, "pipeline.spec")).toBe(8);
			expect(countStageRounds(d, "pipeline.specReview")).toBe(1);
			expect(countStageRounds(d, "pipeline.bdd")).toBe(0);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
	it("returns 0 when no cache exists (fresh run)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-count-rounds-2-"));
		try {
			expect(countStageRounds(d, "pipeline.spec")).toBe(0);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

// ── v0.3.83 — cached agent errors are never replayed ─────────────────────────
// Incident 2026-09-08 (spec 25, run 13-21-29-124Z): a live 429 recorded an
// AgentResult with error and empty text into .resume-cache.jsonl. Every later
// resume replayed the error verbatim ("resumed (cached): pipeline.requirements"
// → fatal) — invisible to restarts, quota resets, and exclusion-store deletion,
// because no live model call ever happened. Errors carry no replayable value;
// success is the only thing worth memoizing.
describe("v0.3.83 — cached agent errors are never replayed (2026-09-08 quota poison)", () => {
	const errorRow = (text: string): AgentResult => ({ text, control: null, error: "delegation ended with status failed: Requested subagent model 'zai-coding-cn/glm-5.3-flash' is excluded" });

	it("read side: a pure cached error (no control, no recoverable text) is NOT replayed — the call re-runs live and the fresh row shadows the old one", async () => {
		const d = tmpDir();
		try {
			appendResumeResult(d, "pipeline.requirements@root#1", errorRow(""));
			const cache = loadResumeCache(d);
			const logs: string[] = [];
			let live = 0;
			const agent = createMemoizingAgent(async () => { live++; return result({ healed: true }); }, cache, () => d, (m) => logs.push(m));
			const r = await agent(call("pipeline.requirements"));
			expect(live).toBe(1);                       // RED today: 0 (error replayed)
			expect(r.control).toEqual({ healed: true }); // RED today: null + error
			expect(logs.some((m) => m.includes("NOT replayed") && m.includes("re-running live"))).toBe(true);
			// append-only last-wins: the live row now shadows the error row
			const reloaded = loadResumeCache(d);
			expect(reloaded.get("pipeline.requirements@root#1")?.control).toEqual({ healed: true });
			expect(reloaded.get("pipeline.requirements@root#1")?.error).toBeUndefined();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("write side: a pure failure (error, no control, no body text) is never persisted", async () => {
		const d = tmpDir();
		try {
			const cache = new Map<string, AgentResult>();
			const agent = createMemoizingAgent(async () => errorRow(""), cache, () => d, () => {});
			const r = await agent(call("x"));
			expect(r.error).toBeDefined();
			expect(cache.has("x@root#1")).toBe(false);          // RED today: true
			expect(loadResumeCache(d).has("x@root#1")).toBe(false); // RED today: true
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("write side: an error WITH body text IS still persisted (keeps the v0.3.48 parse-boundary recovery chance)", async () => {
		const d = tmpDir();
		try {
			const cache = new Map<string, AgentResult>();
			const agent = createMemoizingAgent(async () => errorRow("long partial review text…"), cache, () => d, () => {});
			await agent(call("x"));
			expect(cache.get("x@root#1")?.error).toBeDefined();
			expect(loadResumeCache(d).get("x@root#1")?.text).toContain("partial review");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("v0.3.48 recovery still wins BEFORE the live re-run: a cached error whose text holds a valid control is recovered without calling the agent", async () => {
		const cache = new Map<string, AgentResult>([["x@root#1", { text: '{"verdict":"Approved","findings":[]}', control: null, error: "delegation ended with status failed" }]]);
		let live = 0;
		const agent = createMemoizingAgent(async () => { live++; return result(); }, cache, () => "/tmp", () => {});
		const r = await agent({ id: "x", agent: "a", prompt: "", controlKeys: ["verdict", "findings"] });
		expect(live).toBe(0);
		expect(r.control).toEqual({ verdict: "Approved", findings: [] });
		expect(r.error).toBeUndefined();
	});

	it("an unrecoverable error WITH text falls through to the live re-run (recovery attempted, failed, not replayed)", async () => {
		const d = tmpDir();
		try {
			appendResumeResult(d, "x@root#1", errorRow("truncated garbage, no control JSON"));
			const cache = loadResumeCache(d);
			let live = 0;
			const agent = createMemoizingAgent(async () => { live++; return result({ fresh: true }); }, cache, () => d, () => {});
			const r = await agent({ id: "x", agent: "a", prompt: "", controlKeys: ["verdict"] });
			expect(live).toBe(1); // RED today: 0 — the garbage-text error was replayed verbatim
			expect(r.control).toEqual({ fresh: true });
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("success rows still replay without a live call (regression)", async () => {
		const cache = new Map<string, AgentResult>([["x@root#1", result({ hit: true })]]);
		let live = 0;
		const agent = createMemoizingAgent(async () => { live++; return result(); }, cache, () => "/tmp", () => {});
		const r = await agent(call("x"));
		expect(r.control).toEqual({ hit: true });
		expect(live).toBe(0);
	});
});

// ── v0.3.83 r2 — dual fresh-context review fixes ─────────────────────────────
// adv-F1: delegation-backend.ts:505/:508 corrective-retry failures return
// {text, control, error} where the control is the FIRST attempt's
// schema-violating object — certified invalid by the engine (that is why the
// corrective fired). Persisting it verbatim replays poison that escapes BOTH
// escape hatches: the v0.3.65 agent-error marking (nodes.ts G21 needs
// error && !control) and the v0.3.83 miss path (needed control == null).
// Reviewer probe k5: live=0 — stale control + error replayed forever, the
// quota-wall disease wearing a control mask.
describe("v0.3.83 r2 — error+control rows and round accounting (dual-review fixes)", () => {
	const errorRow = (text: string): AgentResult => ({ text, control: null, error: "delegation ended with status failed: model excluded" });
	const errCtrlRow = (text: string, control: Record<string, unknown>): AgentResult => ({
		text,
		control: control as AgentResult["control"],
		error: "delegation retry after validation failure (missing: verdict): agent timed out after 1200000ms",
	});

	it("read side (adv-F1): a cached error+control row (corrective-retry strain) is NOT replayed — re-runs live and shadows", async () => {
		const d = tmpDir();
		try {
			appendResumeResult(d, "x@root#1", errCtrlRow("", { stale: true }));
			const cache = loadResumeCache(d);
			const logs: string[] = [];
			let live = 0;
			const agent = createMemoizingAgent(async () => { live++; return result({ fresh: true }); }, cache, () => d, (m) => logs.push(m));
			const r = await agent({ id: "x", agent: "a", prompt: "", controlKeys: ["verdict"] });
			expect(live).toBe(1);                          // RED today: 0 (stale control+error replayed verbatim)
			expect(r.control).toEqual({ fresh: true });    // RED today: { stale: true }
			expect(r.error).toBeUndefined();               // RED today: the poisoned error
			expect(logs.some((m) => m.includes("NOT replayed") && m.includes("re-running live"))).toBe(true);
			const reloaded = loadResumeCache(d);
			expect(reloaded.get("x@root#1")?.control).toEqual({ fresh: true });
			expect(reloaded.get("x@root#1")?.error).toBeUndefined();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("read side (adv-F1): recoverable text in an error+control row recovers BEFORE the live re-run (stale control discarded)", async () => {
		const cache = new Map<string, AgentResult>([
			["x@root#1", errCtrlRow('{"verdict":"Approved","findings":[]}', { stale: true })],
		]);
		let live = 0;
		const agent = createMemoizingAgent(async () => { live++; return result(); }, cache, () => "/tmp", () => {});
		const r = await agent({ id: "x", agent: "a", prompt: "", controlKeys: ["verdict", "findings"] });
		expect(live).toBe(0);
		expect(r.control).toEqual({ verdict: "Approved", findings: [] }); // from TEXT, not the stale control
		expect(r.error).toBeUndefined();
	});

	it("write side (adv-F1): an error+control result is persisted with the control STRIPPED — the live caller keeps the original", async () => {
		const d = tmpDir();
		try {
			const cache = new Map<string, AgentResult>();
			const agent = createMemoizingAgent(async () => errCtrlRow("partial first-attempt text", { stale: true }), cache, () => d, () => {});
			const r = await agent(call("x"));
			expect(r.control).toEqual({ stale: true });            // live caller sees the original result unchanged
			const persisted = cache.get("x@root#1");
			expect(persisted?.control).toBeNull();                // RED today: { stale: true } persisted verbatim
			expect(persisted?.text).toContain("partial first-attempt text"); // text survives as recovery material
			expect(persisted?.error).toBeDefined();
			expect(loadResumeCache(d).get("x@root#1")?.control).toBeNull();   // and on disk
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("write side (adv-F1): an error+control row with no text persists nothing at all (pure failure after strip)", async () => {
		const d = tmpDir();
		try {
			const cache = new Map<string, AgentResult>();
			const agent = createMemoizingAgent(async () => errCtrlRow("", { stale: true }), cache, () => d, () => {});
			const r = await agent(call("x"));
			expect(r.control).toEqual({ stale: true }); // live caller unchanged
			expect(cache.has("x@root#1")).toBe(false); // RED today: true
			expect(loadResumeCache(d).has("x@root#1")).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("write side (code-F1): whitespace-only body text is no text — nothing persisted; the read side degrades it to live", async () => {
		const d = tmpDir();
		try {
			const cache = new Map<string, AgentResult>();
			const agent = createMemoizingAgent(async () => errorRow("   "), cache, () => d, () => {});
			await agent(call("x"));
			expect(cache.has("x@root#1")).toBe(false);
			expect(loadResumeCache(d).has("x@root#1")).toBe(false);
			// read side: a pre-existing whitespace-text error row is not replayable either
			appendResumeResult(d, "y@root#1", errorRow("   "));
			let live = 0;
			const reader = createMemoizingAgent(async () => { live++; return result({ ok: 1 }); }, loadResumeCache(d), () => d, () => {});
			const r = await reader(call("y"));
			expect(live).toBe(1);
			expect(r.control).toEqual({ ok: 1 });
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("countStageRounds (adv-F2): error rows are holes, not banked work — excluded from the round count", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-count-errs-"));
		try {
			const row = (key: string, r: AgentResult) => JSON.stringify({ key, result: r });
			writeFileSync(`${d}/.resume-cache.jsonl`, [
				row("pipeline.spec@root#1", { text: "r1", control: null }),
				row("pipeline.spec@root#2", { text: "r2", control: null }),
				row("pipeline.spec@root#3", errorRow("")),
				row("pipeline.spec@root#4", errCtrlRow("", { stale: true })),
				row("pipeline.spec@root#5", errorRow("some text")),
			].join("\n") + "\n");
			expect(countStageRounds(d, "pipeline.spec")).toBe(2); // RED today: 5
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("countStageRounds (adv-F2): an all-error history counts 0 — every round re-runs fresh on resume", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-count-errs-2-"));
		try {
			const row = (key: string) => JSON.stringify({ key, result: errorRow("") });
			writeFileSync(`${d}/.resume-cache.jsonl`, [row("pipeline.spec@root#1"), row("pipeline.spec@root#2"), row("pipeline.spec@root#3")].join("\n") + "\n");
			expect(countStageRounds(d, "pipeline.spec")).toBe(0); // RED today: 3
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("tombstone (adv-F4): an all-pure-failure pass still leaves a non-empty cache file — the track stays resumable", async () => {
		const d = tmpDir();
		try {
			const cache = new Map<string, AgentResult>();
			const agent = createMemoizingAgent(async () => errorRow(""), cache, () => d, () => {});
			await agent(call("x"));
			await agent(call("y"));
			expect(existsSync(resumeCachePath(d))).toBe(true); // RED today: no file at all
			expect(isResumable(d)).toBe(true);                 // RED today: false → --resume/findReusableSpec skip the track
			// the tombstone is inert: no call key collides and no row carries poison
			const reloaded = loadResumeCache(d);
			expect([...reloaded.keys()].every((k) => k.startsWith("__tombstone__"))).toBe(true);
			expect([...reloaded.values()].every((v) => v.error == null)).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
