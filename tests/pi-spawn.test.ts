/**
 * Tests for the spawn-output parsing in pi-spawn.ts. No subprocess, no LLM —
 * these feed captured NDJSON event streams directly to the parser to assert
 * the resilient text-capture behavior that recovers control JSON even when an
 * agent ends on a trailing tool-call turn or is killed mid-stream.
 */

import { describe, it, expect } from "vitest";
import { extractFinalAssistant } from "../src/pi-spawn.ts";

const line = (obj: unknown) => JSON.stringify(obj);

describe("extractFinalAssistant", () => {
	it("returns the assistant text from a single message_end", () => {
		const stdout = [line({ type: "message_start" }), line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })].join("\n");
		expect(extractFinalAssistant(stdout).text).toBe("hello");
	});

	it("keeps the LAST NON-EMPTY text when a later turn ends on a tool call", () => {
		// Turn N emits the control block as text; turn N+1 ends on a tool_use
		// (no text). The trailing empty message_end must NOT discard the control.
		const stdout = [
			line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: 'done\n<control>{"ok":true}</control>' }] } }),
			line({ type: "message_end", message: { role: "assistant", content: [{ type: "tool_use", name: "write" }] } }),
		].join("\n");
		expect(extractFinalAssistant(stdout).text).toContain('<control>{"ok":true}</control>');
	});

	it("returns empty when no assistant text ever appeared", () => {
		const stdout = [
			line({ type: "message_end", message: { role: "assistant", content: [{ type: "tool_use", name: "read" }] } }),
			line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "tool result" }] } }),
		].join("\n");
		expect(extractFinalAssistant(stdout).text).toBe("");
	});

	it("ignores malformed/non-JSON lines without throwing", () => {
		const stdout = ["not json at all", "", line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }), "{ broken"];
		expect(extractFinalAssistant(stdout.join("\n")).text).toBe("ok");
	});

	it("captures the model from the final assistant message", () => {
		const stdout = [line({ type: "message_end", message: { role: "assistant", model: "glm-5.2", content: [{ type: "text", text: "hi" }] } })].join("\n");
		expect(extractFinalAssistant(stdout).model).toBe("glm-5.2");
	});
});
