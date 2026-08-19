/**
 * v0.2.10 spawn-resilience argv & helper pins — W1 RPC argv shape, W2 @file
 * delivery, W4 skills toggle, W3 control schema / extension resolution /
 * capture reading, and the RPC corrective message contract. Pure unit tests:
 * no child process, no LLM (the real-pi round trip lives at the bottom behind
 * SUPER_DEV_SPAWN_E2E=1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSpawnArgs,
	skillsEnabled,
	rpcSpawnEnabled,
	TASK_ARG_LIMIT,
	controlSchemaJson,
	structuredOutputExtensionPath,
	readToolCapture,
	buildRpcCorrectiveMessage,
} from "../src/pi-spawn.ts";

const base = { agent: "requirements-clarifier", prompt: "do X", cwd: "/tmp" };

describe("v0.2.10 toggle helpers", () => {
	afterEach(() => { vi.unstubAllEnvs(); });

	it("skills are enabled by default (capability parity with the session backend)", () => {
		expect(skillsEnabled({})).toBe(true);
		expect(skillsEnabled({ SUPER_DEV_NO_SKILLS: "0" })).toBe(true);
	});

	it("SUPER_DEV_NO_SKILLS=1 restores the pre-v0.2.10 isolation", () => {
		expect(skillsEnabled({ SUPER_DEV_NO_SKILLS: "1" })).toBe(false);
	});

	it("the RPC backend is the default; SUPER_DEV_NO_RPC_SPAWN=1 selects the json fallback", () => {
		expect(rpcSpawnEnabled({})).toBe(true);
		expect(rpcSpawnEnabled({ SUPER_DEV_NO_RPC_SPAWN: "1" })).toBe(false);
	});

	it("buildSpawnArgs omits --no-skills by default and adds it under the kill-switch", () => {
		expect(buildSpawnArgs(base, "/tmp/a.md")).not.toContain("--no-skills");
		vi.stubEnv("SUPER_DEV_NO_SKILLS", "1");
		expect(buildSpawnArgs(base, "/tmp/a.md")).toContain("--no-skills");
	});
});

describe("W1 — RPC argv shape", () => {
	it("uses --mode rpc, drops -p and the positional Task (the task rides the stdin prompt event)", () => {
		const args = buildSpawnArgs({ ...base, spawnMode: "rpc" }, "/tmp/a.md");
		expect(args[args.indexOf("--mode") + 1]).toBe("rpc");
		expect(args).not.toContain("-p");
		expect(args.some((arg) => arg.startsWith("Task: "))).toBe(false);
		expect(args).toContain("--no-session");
		expect(args).toContain("--no-extensions");
		expect(args).toContain("--system-prompt");
	});

	it("keeps model/thinking/exclude-tools wiring identical to json mode", () => {
		const rpc = buildSpawnArgs({ ...base, spawnMode: "rpc", model: "prov/m" }, "/tmp/a.md");
		expect(rpc[rpc.indexOf("--model") + 1]).toBe("prov/m");
		expect(rpc).toContain("--thinking");
		expect(rpc[rpc.indexOf("--exclude-tools") + 1]).toBe("super_dev");
	});
});

describe("W2 — @file task delivery (json fallback)", () => {
	afterEach(() => { vi.unstubAllEnvs(); });

	it("delivers the task via @<path> when taskFile is set", () => {
		vi.stubEnv("SUPER_DEV_NO_RPC_SPAWN", "1");
		const args = buildSpawnArgs({ ...base, taskFile: "/tmp/task.md" }, "/tmp/a.md");
		expect(args.at(-1)).toBe("@/tmp/task.md");
		expect(args.some((arg) => arg.startsWith("Task: "))).toBe(false);
	});

	it("short tasks still ride argv in json mode (audit-visible, no extra file)", () => {
		const args = buildSpawnArgs(base, "/tmp/a.md");
		expect(args.at(-1)).toBe("Task: do X");
	});

	it("TASK_ARG_LIMIT matches the pi-subagents EDR-motivated value", () => {
		expect(TASK_ARG_LIMIT).toBe(8_000);
	});
});

describe("W3 — control schema, extension path, capture", () => {
	it("controlSchemaJson declares every key permissively (values unconstrained, nothing required)", () => {
		const schema = controlSchemaJson(["docPath", "summary"]) as { type: string; properties: Record<string, unknown>; additionalProperties: boolean; required?: unknown };
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties)).toEqual(["docPath", "summary"]);
		expect(schema.additionalProperties).toBe(true);
		expect(schema.required).toBeUndefined();
	});

		it("F-3 parity: controlSchemaJson stays semantically identical to the session backend's controlSchema construction", async () => {
			// session-agent.ts cannot be imported here (heavy module graph — the
			// dynamic import times out in vitest), so this mirrors its EXACT
			// construction (src/session-agent.ts controlSchema): every key
			// Type.Optional(Type.Any()) under Type.Object(..., { additionalProperties:
			// true }). If that construction changes, this mirror must change WITH it
			// — the parity pin is the semantic equivalence below.
			const { Type } = await import("typebox");
			const keys = ["docPath", "summary", "title"];
			const props: Record<string, ReturnType<typeof Type.Any>> = {};
			for (const k of keys) props[k] = Type.Optional(Type.Any());
			const built = Type.Object(props, { additionalProperties: true }) as unknown as {
				type?: string;
				properties: Record<string, unknown>;
				required?: unknown;
				additionalProperties?: unknown;
			};
			const json = controlSchemaJson(keys) as { type: string; properties: Record<string, unknown>; additionalProperties: boolean; required?: unknown };
			// Same declared keys, nothing required (all Optional), open objects.
			expect(Object.keys(built.properties)).toEqual(Object.keys(json.properties));
			expect(built.required ?? []).toEqual([]);
			expect(json.required).toBeUndefined();
			expect(built.additionalProperties).toBe(true);
			expect(json.additionalProperties).toBe(true);
			expect(json.type).toBe("object");
		});

	it("structuredOutputExtensionPath resolves the sibling runtime extension", () => {
		const path = structuredOutputExtensionPath();
		expect(path).toBeTruthy();
		expect(path!.endsWith("subprocess-structured-output.ts")).toBe(true);
	});

	it("readToolCapture returns the JSON object, and null on absent/garbage/array", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-cap-"));
		try {
			const good = join(dir, "good.json");
			writeFileSync(good, JSON.stringify({ docPath: "x", summary: "y" }));
			expect(readToolCapture(good)).toEqual({ docPath: "x", summary: "y" });
			expect(readToolCapture(join(dir, "missing.json"))).toBeNull();
			const garbage = join(dir, "garbage.json");
			writeFileSync(garbage, "not json");
			expect(readToolCapture(garbage)).toBeNull();
			const array = join(dir, "array.json");
			writeFileSync(array, JSON.stringify([1, 2]));
			expect(readToolCapture(array)).toBeNull();
			expect(readToolCapture(null)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("W1 — RPC corrective message", () => {
	it("names the real cause, the required keys, both delivery channels, and forbids redoing work", () => {
		const message = buildRpcCorrectiveMessage(["docPath", "summary"], ["docPath", "summary", "title"]);
		expect(message).toContain("ended WITHOUT the required control object");
		expect(message).toContain("Missing required keys: docPath, summary");
		expect(message).toContain("structured_output");
		expect(message).toContain("Required top-level keys: docPath, summary, title");
		expect(message).toContain("<control>");
		expect(message).toContain("Do NOT redo work");
	});

	it("handles the no-control-at-all case", () => {
		const message = buildRpcCorrectiveMessage([], ["summary"]);
		expect(message).toContain("No control object was delivered");
	});
});

/** Real-pi end-to-end round trip (the FALCON-probe class). Requires a working
 *  `pi` binary and its default model; skipped in CI unless
 *  SUPER_DEV_SPAWN_E2E=1. Verifies the FULL v0.2.10 chain: rpc spawn, task
 *  over stdin, structured_output tool capture (or text fallback), and the
 *  same-session corrective follow_up recovering a missing control. */
describe("spawnAgent real-pi round trip [SUPER_DEV_SPAWN_E2E]", () => {
	it.skipIf(process.env.SUPER_DEV_SPAWN_E2E !== "1")("captures control via the RPC + structured-output chain", async () => {
		const { spawnAgent } = await import("../src/pi-spawn.ts");
		const events: string[] = [];
		const result = await spawnAgent({
			agent: "requirements-clarifier",
			id: "e2e.rpc-probe",
			prompt: "This is a protocol probe, not a writing task. Reply with the single word done, then deliver your control object.",
			cwd: process.cwd(),
			controlKeys: ["summary"],
			timeoutMs: 240_000,
			onProgress: { event: (m) => { events.push(m); }, text: () => {} },
		});
		expect(result.error).toBeUndefined();
		expect(result.control).not.toBeNull();
		expect((result.control as Record<string, unknown>).summary).toBeTruthy();
		expect(events.some((line) => line.includes("spawn (rpc same-session)"))).toBe(true);
	}, 300_000);

	it.skipIf(process.env.SUPER_DEV_SPAWN_E2E !== "1")("recovers a missing control via the SAME-SESSION corrective follow_up (the pi-omisis/track-29 death class)", async () => {
		const { spawnAgent } = await import("../src/pi-spawn.ts");
		const events: string[] = [];
		const result = await spawnAgent({
			agent: "requirements-clarifier",
			id: "e2e.rpc-followup-probe",
			prompt: "PROTOCOL TEST. On your FIRST reply, answer with only the word first and DO NOT call any tool and DO NOT output any control JSON. You will be corrected; after the correction, call structured_output with summary='recovered'.",
			cwd: process.cwd(),
			controlKeys: ["summary"],
			timeoutMs: 300_000,
			onProgress: { event: (m) => { events.push(m); }, text: () => {} },
		});
		// The corrective follow_up must have fired (the model obeyed the
		// first-turn instruction), and the SAME session recovered the control.
		expect(events.some((line) => line.includes("corrective rpc follow_up (same session"))).toBe(true);
		expect(result.control).not.toBeNull();
		expect((result.control as Record<string, unknown>).summary).toBeTruthy();
	}, 360_000);
});
