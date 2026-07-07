/**
 * Unit tests for workflow resume (v0.3.0, Solution B: memoized replay).
 * No LLM; exercises the cache I/O, resumability detection, and the
 * createMemoizingAgent wrapper (incl. the loop-iteration seq disambiguation).
 */

import { describe, it, expect } from "vitest";
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
		const cache = new Map<string, AgentResult>([["x#1", result({ hit: true })]]);
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
			expect(cache.get("x#1")?.control).toEqual({ ran: true });
			// captured to disk too
			expect(loadResumeCache(specDir).get("x#1")?.control).toEqual({ ran: true });
		} finally { rmSync(specDir, { recursive: true, force: true }); }
	});

	it("disambiguates repeated call.ids via the monotonic seq (loop-iteration case)", async () => {
		// Simulate a verify-loop where code-review runs each iteration with the
		// SAME call.id. Pre-seed the cache as if iteration 1 completed (seq=1)
		// and iteration 2 was interrupted (seq=2 missing).
		const cache = new Map<string, AgentResult>([
			["pipeline.verify.code-review#1", result({ iter: 1 })],
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
