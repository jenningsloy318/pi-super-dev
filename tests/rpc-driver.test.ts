/**
 * RpcDriver unit tests (v0.2.10 W1) — synthetic NDJSON lines, no child
 * process, no LLM. These pin the protocol contract verified live against
 * `pi --mode rpc`: prompt/follow_up events, id-matched response acks, the
 * last-non-empty assistant text rule, per-turn timeouts, and dispose.
 */

import { describe, it, expect, vi } from "vitest";
import { RpcDriver } from "../src/rpc-driver.ts";

const msgEnd = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
const response = (id: string, success = true) => JSON.stringify({ id, type: "response", command: "prompt", success });

function makeDriver() {
	const written: string[] = [];
	const raw: Array<Record<string, unknown>> = [];
	const driver = new RpcDriver({ write: (line) => { written.push(line); }, onRawEvent: (event) => { raw.push(event); } });
	return { driver, written, raw };
}

describe("RpcDriver", () => {
	it("sends a prompt event with a unique id and completes on response ack + agent_settled", async () => {
		const { driver, written } = makeDriver();
		const pending = driver.send("prompt", "remember FALCON-3319", 1000);
		expect(written).toHaveLength(1);
		const event = JSON.parse(written[0]!) as { id: string; type: string; message: string };
		expect(event.type).toBe("prompt");
		expect(event.message).toBe("remember FALCON-3319");
		driver.ingest(msgEnd("noted"));
		driver.ingest(response(event.id));
		driver.ingest(JSON.stringify({ type: "agent_settled" }));
		const result = await pending;
		expect(result.text).toBe("noted");
		expect(result.error).toBeUndefined();
	});

	it("PIN (verified live): the response ack alone is NOT completion — it arrives BEFORE agent_start; only a later agent_settled completes the turn", async () => {
		const { driver, written } = makeDriver();
		const pending = driver.send("prompt", "task", 60);
		const id = (JSON.parse(written[0]!) as { id: string }).id;
		driver.ingest(response(id)); // ack only — pi emits this before the turn runs
		driver.ingest(msgEnd("partial"));
		const result = await pending; // times out: no agent_settled after the ack
		expect(result.error).toContain("timed out");
	});

	it("PIN (verified live, probe follow_up): the ack may arrive AFTER agent_settled — out-of-order signals still complete", async () => {
		// The prompt ack arrives before agent_start, but the follow_up ack was
		// observed arriving after agent_settled. Completion requires BOTH
		// signals, in EITHER order.
		const { driver, written } = makeDriver();
		const pending = driver.send("follow_up", "task", 1000);
		const id = (JSON.parse(written[0]!) as { id: string }).id;
		driver.ingest(msgEnd("answer"));
		driver.ingest(JSON.stringify({ type: "agent_settled" })); // settle first
		driver.ingest(response(id)); // ack second — completes
		const result = await pending;
		expect(result.error).toBeUndefined();
		expect(result.text).toBe("answer");
	});

	it("a settle from a PREVIOUS turn (before the request was written) never satisfies the new turn", async () => {
		const { driver, written } = makeDriver();
		// Turn 1 completes normally.
		const first = driver.send("prompt", "one", 1000);
		const id1 = (JSON.parse(written[0]!) as { id: string }).id;
		driver.ingest(msgEnd("one"));
		driver.ingest(response(id1));
		driver.ingest(JSON.stringify({ type: "agent_settled" }));
		await first;
		// Turn 2 is written AFTER that settle; a bare ack with no new settle
		// must not complete it.
		const second = driver.send("prompt", "two", 60);
		const id2 = (JSON.parse(written[1]!) as { id: string }).id;
		driver.ingest(response(id2));
		const result = await second;
		expect(result.error).toContain("timed out");
	});

	it("sends follow_up as the SAME-SESSION second turn kind (the corrective primitive)", async () => {
		const { driver, written } = makeDriver();
		const pending = driver.send("follow_up", "emit the control object now", 1000);
		const event = JSON.parse(written[0]!) as { type: string };
		expect(event.type).toBe("follow_up");
		driver.ingest(msgEnd('<control>{"ok":true}</control>'));
		driver.ingest(response(JSON.parse(written[0]!)["id"]));
		driver.ingest(JSON.stringify({ type: "agent_settled" }));
		expect((await pending).text).toContain('<control>{"ok":true}</control>');
	});

	it("keeps the LAST NON-EMPTY assistant text (a trailing tool-call turn must not discard the control)", async () => {
		const { driver, written } = makeDriver();
		const pending = driver.send("prompt", "task", 1000);
		driver.ingest(msgEnd('done\n<control>{"a":1}</control>'));
		driver.ingest(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "tool_use", name: "read" }] } }));
		driver.ingest(response(JSON.parse(written[0]!)["id"]));
		driver.ingest(JSON.stringify({ type: "agent_settled" }));
		expect((await pending).text).toContain('{"a":1}');
	});

	it("resolves with an error when the response ack reports success:false", async () => {
		const { driver, written } = makeDriver();
		const pending = driver.send("prompt", "task", 1000);
		const id = (JSON.parse(written[0]!) as { id: string }).id;
		driver.ingest(response(id, false));
		const result = await pending;
		expect(result.error).toContain("reported failure");
	});

	it("resolves with an error (not a hang) when no response ack arrives before the turn timeout", async () => {
		const { driver } = makeDriver();
		const result = await driver.send("prompt", "task", 25);
		expect(result.error).toContain("timed out after 25ms");
	});

	it("dispose resolves in-flight waiters with an error and refuses later turns", async () => {
		const { driver } = makeDriver();
		const pending = driver.send("prompt", "task", 5000);
		driver.dispose("process exited");
		const result = await pending;
		expect(result.error).toContain("disposed");
		const after = await driver.send("prompt", "again", 1000);
		expect(after.error).toContain("disposed");
	});

	it("captures the model id from message_end events", async () => {
		const { driver, written } = makeDriver();
		const pending = driver.send("prompt", "task", 1000);
		driver.ingest(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "zai-coding-cn/glm-5.3", content: [{ type: "text", text: "hi" }] } }));
		driver.ingest(response((JSON.parse(written[0]!) as { id: string }).id));
		driver.ingest(JSON.stringify({ type: "agent_settled" }));
		expect((await pending).model).toBe("zai-coding-cn/glm-5.3");
	});

	it("surfaces non-captured events to the onRawEvent hook (progress rendering)", async () => {
		const { driver, written, raw } = makeDriver();
		const pending = driver.send("prompt", "task", 1000);
		driver.ingest(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/x" } }));
		driver.ingest(msgEnd("ok"));
		driver.ingest(response((JSON.parse(written[0]!) as { id: string }).id));
		await pending;
		expect(raw.some((event) => event.type === "tool_execution_start")).toBe(true);
	});

	it("ignores garbage lines and empty input without throwing", () => {
		const { driver } = makeDriver();
		expect(() => {
			driver.ingest("");
			driver.ingest("   ");
			driver.ingest("not json at all");
			driver.ingest(JSON.stringify([1, 2, 3]));
			driver.ingest(JSON.stringify("bare string"));
		}).not.toThrow();
	});

	it("uses distinct ids across sequential turns", async () => {
		const { driver, written } = makeDriver();
		const first = driver.send("prompt", "one", 1000);
		const id1 = (JSON.parse(written[0]!) as { id: string }).id;
		driver.ingest(msgEnd("one"));
		driver.ingest(response(id1));
		await first;
		const second = driver.send("follow_up", "two", 1000);
		const id2 = (JSON.parse(written[1]!) as { id: string }).id;
		expect(id2).not.toBe(id1);
		driver.ingest(msgEnd("two"));
		driver.ingest(response(id2));
		driver.ingest(JSON.stringify({ type: "agent_settled" }));
		expect((await second).text).toBe("two");
	});
});
