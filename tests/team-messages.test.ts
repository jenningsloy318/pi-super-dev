/**
 * P3.1 (dsh-09 v3 Phase P): the durable role-to-role message bus — roundtrip,
 * ledger double-write, inbox lifecycle, and the real wiring pair (replan
 * trigger → owning stage; owning convergence approval → reply).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendMessage, replyTo, pendingMessagesFor, recordInstruction, MESSAGES_FILE } from "../src/team/messages.ts";
import { maybeTriggerReplan, consumeReplanRequests, REPLAN_REQUESTS_FILE } from "../src/replan/replan.ts";
import { readRunEvents } from "../src/runlog.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

function tmp(): string { return mkdtempSync(join(tmpdir(), "sd-msg-")); }

describe("message bus core (P3.1)", () => {
	it("send → pending inbox → reply → inbox drains; ledger double-writes both", () => {
		const d = tmp();
		try {
			const id = sendMessage(d, { senderRole: "verify", receiverRole: "spec", subject: "replan round 1: revise spec artifact", body: "resume protocol undefined" }, "run-1");
			expect(id).toBeTruthy();
			expect(existsSync(join(d, MESSAGES_FILE))).toBe(true);
			const inbox = pendingMessagesFor(d, "spec");
			expect(inbox).toHaveLength(1);
			expect(inbox[0].subject).toContain("replan round 1");
			expect(pendingMessagesFor(d, "requirements")).toHaveLength(0); // role-scoped

			const rid = replyTo(d, id!, { senderRole: "spec", subject: "revision verified by spec review" }, "run-2");
			expect(rid).toBeTruthy();
			expect(pendingMessagesFor(d, "spec")).toHaveLength(0); // replied → drained

			const events = readRunEvents(d);
			expect(events.map((e) => e.type)).toEqual(["message.sent", "message.replied"]);
			expect(events[0].data.senderRole).toBe("verify");
			expect(events[1].data.inReplyTo).toBe(id);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("threaded replies route back to the original sender; best-effort everywhere", () => {
		const d = tmp();
		try {
			const id = sendMessage(d, { senderRole: "verify", receiverRole: "design", subject: "s" }, "r");
			const rid = replyTo(d, id!, { senderRole: "design", subject: "re: s" }, "r");
			const stored = readFileSync(join(d, MESSAGES_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(stored).toHaveLength(2);
			expect(stored[1].receiverRole).toBe("verify"); // routed back
			expect(stored[1].inReplyTo).toBe(id);
			// never throws on a bad dir
			expect(sendMessage("/nonexistent/x", { senderRole: "a", receiverRole: "b", subject: "s" })).toBeNull();
			expect(replyTo(undefined, "x", { senderRole: "a", subject: "s" })).toBeNull();
			expect(pendingMessagesFor(undefined, "x")).toEqual([]);
			recordInstruction(undefined, "x"); // no-op, no throw
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("instruction.received lands in the ledger", () => {
		const d = tmp();
		try {
			recordInstruction(d, "please use the new tolerance table", "run-1");
			const [e] = readRunEvents(d);
			expect(e.type).toBe("instruction.received");
			expect(e.data.text).toContain("tolerance table");
			expect(e.data.source).toBe("user-mid-run");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("replan ↔ messages wiring (P3.1 real pair)", () => {
	it("the trigger messages each owning stage; approval replies and drains the inbox", async () => {
		const d = tmp();
		try {
			const state = {
				task: "t", options: {},
				setup: { worktreePath: d, specDirectory: d, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "03-x", worktreeCreated: false, initializedRepo: false },
				review: {
					verdict: "Changes Requested", findings: [],
					deferredFindings: [{
						id: "AR-9", severity: "high", title: "Acceptance criteria contradict on tolerance", detail: "AC-02 vs AC-07",
						ownerStage: "requirements", blocking: true,
					}],
				},
			} as unknown as PipelineState;
			const ctx = {
				task: "t", options: {}, state: {} as PipelineState,
				budget: { check: () => true, spent: () => true, count: 0 },
				log: () => {}, phase: () => {}, events: { on() {}, off() {}, emit() {} }, results: [], signal: undefined,
				async agent() { return { text: "", control: { owner: "human", confidence: 0.9, reason: "x", evidence: [] } }; },
				async helper() { return { value: {}, digest: "" }; },
				async parallel() { return []; },
			} as unknown as StageContext;
			expect(await maybeTriggerReplan(state, ctx, "03-x")).toBe(true);
			// message.sent to the owner (requirements), ledger event included
			expect(pendingMessagesFor(d, "requirements")).toHaveLength(1);
			const events = readRunEvents(d);
			expect(events.some((e) => e.type === "message.sent" && e.data.receiverRole === "requirements")).toBe(true);

			// approval path: consumeReplanRequests flips the request AND replies
			const n = consumeReplanRequests(d, "requirements");
			expect(n).toBe(1);
			expect(pendingMessagesFor(d, "requirements")).toHaveLength(0);
			const after = readRunEvents(d);
			expect(after.some((e) => e.type === "message.replied")).toBe(true);
			const requests = JSON.parse(readFileSync(join(d, REPLAN_REQUESTS_FILE), "utf8"));
			expect(requests.requests[0].status).toBe("addressed");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
