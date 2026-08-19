/**
 * subprocess-structured-output runtime extension tests (v0.2.10 W3) — the
 * child-side structured_output tool contract, exercised against a fake pi
 * ExtensionAPI with real temp files. No child process, no LLM.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, {
	SO_CAPTURE_ENV,
	SO_SCHEMA_ENV,
	STRUCTURED_OUTPUT_INSTRUCTIONS,
	structuredOutputToolParameters,
	validateStructurally,
	rewriteLocalRefs,
} from "../src/subprocess-structured-output.ts";

interface RegisteredTool {
	name: string;
	parameters: unknown;
	execute: (_id: string, params: unknown) => Promise<unknown>;
}

interface FakePi {
	tools: RegisteredTool[];
	systemPromptRewrites: Array<(event: unknown) => unknown>;
	registerTool(tool: RegisteredTool): void;
	on(event: string, handler: (event: unknown) => unknown): void;
}

function makeFakePi(): FakePi {
	const pi: FakePi = {
		tools: [],
		systemPromptRewrites: [],
		registerTool(tool) { this.tools.push(tool); },
		on(event, handler) {
			if (event === "before_agent_start") this.systemPromptRewrites.push(handler);
		},
	};
	return pi;
}

describe("structuredOutputToolParameters / rewriteLocalRefs", () => {
	it("wraps the control schema under {value} with required:[value] and closed additionalProperties", () => {
		const parameters = structuredOutputToolParameters({ type: "object", properties: { docPath: {}, summary: {} }, additionalProperties: true }) as {
			type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean;
		};
		expect(parameters.type).toBe("object");
		expect(Object.keys(parameters.properties)).toEqual(["value"]);
		expect(parameters.required).toEqual(["value"]);
		expect(parameters.additionalProperties).toBe(false);
	});

	it("rewrites local $refs to live under #/properties/value so they don't dangle after wrapping", () => {
		const schema = {
			type: "object",
			properties: { inner: { $ref: "#/$defs/row" } },
			$defs: { row: { type: "object", properties: { nested: { $ref: "#/$defs/row" } } } },
		};
		const wrapped = structuredOutputToolParameters(schema as never) as { properties: { value: unknown } };
		const value = wrapped.properties.value as { properties: { inner: { $ref: string } }; $defs: { row: { properties: { nested: { $ref: string } } } } };
		expect(value.properties.inner.$ref).toBe("#/properties/value/$defs/row");
		expect(value.$defs.row.properties.nested.$ref).toBe("#/properties/value/$defs/row");
		expect(rewriteLocalRefs({ $ref: "#" }, "#/properties/value")).toEqual({ $ref: "#/properties/value" });
	});
});

describe("validateStructurally", () => {
	it("rejects non-object values for object schemas", () => {
		const result = validateStructurally({ type: "object" }, [1, 2, 3]);
		expect(result.ok).toBe(false);
		expect(result.problems[0]).toContain("must be a JSON object");
	});

	it("flags missing required keys", () => {
		const result = validateStructurally({ type: "object", properties: { a: {}, b: {} }, required: ["a", "b"] }, { a: 1 });
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("b: required key missing");
	});

	it("flags unknown keys against a closed schema", () => {
		const result = validateStructurally({ type: "object", properties: { a: {} }, required: ["a"], additionalProperties: false }, { a: 1, rogue: 2 });
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("rogue: unknown key");
	});

	it("accepts a complete object", () => {
		expect(validateStructurally({ type: "object", properties: { a: {} }, required: ["a"], additionalProperties: false }, { a: 1 }).ok).toBe(true);
	});
});

describe("register (runtime extension)", () => {
	let dir: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sd-so-test-"));
		for (const key of [SO_SCHEMA_ENV, SO_CAPTURE_ENV]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("registers NO tool when either env var is absent (inert without the contract)", () => {
		const pi = makeFakePi();
		expect(() => register(pi)).not.toThrow();
		expect(pi.tools).toHaveLength(0);
	});

	it("registers NO tool when the schema file is unreadable", () => {
		process.env[SO_SCHEMA_ENV] = join(dir, "missing.json");
		process.env[SO_CAPTURE_ENV] = join(dir, "out.json");
		const pi = makeFakePi();
		register(pi);
		expect(pi.tools).toHaveLength(0);
	});

	it("writes the capture file and terminates the step on a valid submission", async () => {
		const schemaPath = join(dir, "schema.json");
		const capturePath = join(dir, "nested", "out.json");
		writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { docPath: {}, summary: {} }, required: ["docPath", "summary"] }));
		process.env[SO_SCHEMA_ENV] = schemaPath;
		process.env[SO_CAPTURE_ENV] = capturePath;
		const pi = makeFakePi();
		register(pi);
		expect(pi.tools).toHaveLength(1);
		const tool = pi.tools[0]!;
		expect(tool.name).toBe("structured_output");
		const result = (await tool.execute("call-1", { value: { docPath: "docs/x.md", summary: "ok" } })) as {
			content: Array<{ type: string }>; details: { path: string }; terminate: boolean;
		};
		expect(result.terminate).toBe(true);
		expect(result.details.path).toBe(capturePath);
		expect(readFileSync(capturePath, "utf-8")).toBe(JSON.stringify({ docPath: "docs/x.md", summary: "ok" }));
	});

	it("throws a self-correctable validation error on a missing required key (model retries in-session)", async () => {
		const schemaPath = join(dir, "schema.json");
		const capturePath = join(dir, "out.json");
		writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { a: {}, b: {} }, required: ["a", "b"] }));
		process.env[SO_SCHEMA_ENV] = schemaPath;
		process.env[SO_CAPTURE_ENV] = capturePath;
		const pi = makeFakePi();
		register(pi);
		await expect(pi.tools[0]!.execute("call-1", { value: { a: 1 } })).rejects.toThrow(/b: required key missing/);
		expect(existsSync(capturePath)).toBe(false);
	});

	it("tolerates a bare control object submitted without the {value} wrapper", async () => {
		const schemaPath = join(dir, "schema.json");
		const capturePath = join(dir, "out.json");
		writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { ok: {} }, required: ["ok"] }));
		process.env[SO_SCHEMA_ENV] = schemaPath;
		process.env[SO_CAPTURE_ENV] = capturePath;
		const pi = makeFakePi();
		register(pi);
		const result = (await pi.tools[0]!.execute("call-1", { ok: true })) as { terminate: boolean };
		expect(result.terminate).toBe(true);
		expect(JSON.parse(readFileSync(capturePath, "utf-8"))).toEqual({ ok: true });
	});

	it("prepends the hard final-action instruction to the system prompt, idempotently", () => {
		process.env[SO_SCHEMA_ENV] = writeSchema(join(dir, "s.json"));
		process.env[SO_CAPTURE_ENV] = join(dir, "o.json");
		const pi = makeFakePi();
		register(pi);
		expect(pi.systemPromptRewrites).toHaveLength(1);
		const rewrite = pi.systemPromptRewrites[0]!;
		const once = rewrite({ systemPrompt: "ROLE PROMPT" }) as { systemPrompt: string };
		expect(once.systemPrompt.startsWith(STRUCTURED_OUTPUT_INSTRUCTIONS)).toBe(true);
		expect(once.systemPrompt).toContain("ROLE PROMPT");
		// Second application is a no-op (instruction already present).
		expect(rewrite({ systemPrompt: once.systemPrompt })).toBeUndefined();
	});

	it("F-5: a role prompt that merely MENTIONS structured_output still receives the hard instructions (sentinel idempotency)", () => {
		process.env[SO_SCHEMA_ENV] = writeSchema(join(dir, "s.json"));
		process.env[SO_CAPTURE_ENV] = join(dir, "o.json");
		const pi = makeFakePi();
		register(pi);
		const rewrite = pi.systemPromptRewrites[0]!;
		// agents/spec-writer.md, bdd-scenario-writer.md, task-classifier.md, … all
		// mention the tool name in their own prose — pre-fix the bare-name
		// idempotency check silently dropped the boundary instructions for exactly
		// these writer roles.
		const rolePrompt = "You are the spec writer. Emit your result via the structured_output tool.\nROLE BODY";
		const once = rewrite({ systemPrompt: rolePrompt }) as { systemPrompt: string };
		expect(once.systemPrompt.startsWith(STRUCTURED_OUTPUT_INSTRUCTIONS)).toBe(true);
		expect(once.systemPrompt).toContain("ROLE BODY");
		// …and a genuinely-prepended prompt is still not double-prepended.
		expect(rewrite({ systemPrompt: once.systemPrompt })).toBeUndefined();
	});
});

function writeSchema(path: string): string {
	writeFileSync(path, JSON.stringify({ type: "object", properties: { ok: {} } }));
	return path;
}
