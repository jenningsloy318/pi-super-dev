/**
 * v0.3.70 W3 — STRUCTURED DELEGATION (plan §5, decision D7 Option C).
 *
 * F10-6 root cause: `call.schema` flowed into the delegation options but the
 * backend hardcoded `result:{kind:"text"}` — the schema never reached the
 * child, prose was re-parsed, and the only engine-side check was missing-key
 * names (a wrong-TYPED field burned a full corrective round with no signal).
 *
 * W3 wiring (default ON when a schema is present; SUPER_DEV_STRUCTURED=0 is
 * the escape hatch; two automatic sticky degrades keep old owners alive):
 *  1. schema-carrying calls send result:{kind:"structured", schema} — the
 *     child gains a structured_output tool validated AT CALL TIME in its own
 *     conversation (0.65 subagent-prompt-runtime.ts:420) so retries don't
 *     burn delegation rounds.
 *  2. engine-side validation stays AUTHORITATIVE (P5): whatever arrives —
 *     structured value or parsed prose — is re-checked with TypeBox
 *     Value.Errors, and the corrective re-prompt now carries DETAILED
 *     violations (`/verdict: must be equal to one of the allowed values`),
 *     not just missing-key names (industry validate→repair pattern).
 *  3. owners without structured support (0.64 skew) answer invalid_request —
 *     ONE WARN, sticky per-process degrade to text mode, and the CALL itself
 *     retries in text mode (never fatal; P4 fail-open-harmless).
 *  4. three consecutive structured_output_failed terminal states degrade
 *     sticky to text mode too (mirrors AGENT_ERROR_FATAL_CONSECUTIVE).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { runAgentViaDelegation, resetStructuredModeForTests } from "../src/agents/delegation-backend.ts";
import { schemaViolationErrors, structuredModeEnabled } from "../src/agents/structured-output.ts";

const VERDICT_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["approve", "reject"] },
		notes: { type: "array", items: { type: "string" } },
	},
	required: ["verdict"],
} as const;

/** Fake bus playing the pi-subagents owner; `answer(req)` returns a terminal. */
function bus(answer: (req: any) => any, onLog?: (line: string) => void) {
	const b = new EventEmitter() as any;
	const requests: any[] = [];
	b.on("prompt-template:subagent:request", (req: any) => {
		requests.push(req);
		queueMicrotask(() => b.emit("prompt-template:subagent:response", { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, ...answer(req) }));
	});
	const progress = { event: (m: string) => onLog?.(m) };
	return { b, requests, progress };
}

const OPTS = (b: any, progress: any, schema?: unknown) => ({
	agent: "requirements-reviewer", prompt: "ORIG PROMPT", cwd: "/tmp", id: "n1",
	controlKeys: ["verdict"], events: b, ownerRunId: "run-1", onProgress: progress,
	...(schema ? { schema } : {}),
} as any);

const completedText = (text: string) => ({ status: "completed", result: { kind: "text", text }, model: "fake/m" });

describe("v0.3.70 W3 — request wiring", () => {
	beforeEach(() => resetStructuredModeForTests());

	it("a schema-carrying call sends result {kind:'structured'} with the schema deep-equal; text calls unchanged", async () => {
		const { b, requests, progress } = bus(() => completedText('ok <control>{"verdict":"approve"}</control>'));
		await runAgentViaDelegation(OPTS(b, progress, VERDICT_SCHEMA));
		expect(requests[0].result).toEqual({ kind: "structured", schema: VERDICT_SCHEMA });

		const t = bus(() => completedText('ok <control>{"verdict":"approve"}</control>'));
		await runAgentViaDelegation(OPTS(t.b, t.progress));
		expect(t.requests[0].result).toEqual({ kind: "text" });
	});

	it("SUPER_DEV_STRUCTURED=0 is the escape hatch — schema calls go out as text", async () => {
		process.env.SUPER_DEV_STRUCTURED = "0";
		try {
			const { b, requests, progress } = bus(() => completedText('ok <control>{"verdict":"approve"}</control>'));
			await runAgentViaDelegation(OPTS(b, progress, VERDICT_SCHEMA));
			expect(requests[0].result).toEqual({ kind: "text" });
		} finally { delete process.env.SUPER_DEV_STRUCTURED; }
	});
});

describe("v0.3.70 W3 — structured responses", () => {
	beforeEach(() => resetStructuredModeForTests());

	it("a structured {kind:'structured', value} result becomes the control directly (engine still validates)", async () => {
		const { b, requests, progress } = bus(() => ({ status: "completed", result: { kind: "structured", value: { verdict: "approve" } }, model: "fake/m" }));
		const out = await runAgentViaDelegation(OPTS(b, progress, VERDICT_SCHEMA));
		expect(out.control).toEqual({ verdict: "approve" });
		expect(out.error).toBeUndefined();
		expect(requests).toHaveLength(1); // no corrective round needed
	});

	it("a schema-INVALID structured value triggers ONE corrective attempt whose task names the violation path; the valid retry converges", async () => {
		let call = 0;
		const { b, requests, progress } = bus(() => {
			call++;
			return call === 1
				? { status: "completed", result: { kind: "structured", value: { verdict: "bogus" } }, model: "fake/m" }
				: { status: "completed", result: { kind: "structured", value: { verdict: "reject" } }, model: "fake/m" };
		});
		const out = await runAgentViaDelegation(OPTS(b, progress, VERDICT_SCHEMA));
		expect(requests).toHaveLength(2);
		expect(requests[1].task).toContain("verdict");
		expect(requests[1].task).toMatch(/allowed values|enum/i);
		expect(out.control).toEqual({ verdict: "reject" });
	});

	it("still-violating after the corrective round → honest error naming the violations (P10), never a silent wrong control", async () => {
		const { b, requests, progress } = bus(() => ({ status: "completed", result: { kind: "structured", value: { verdict: "bogus" } }, model: "fake/m" }));
		const out = await runAgentViaDelegation(OPTS(b, progress, VERDICT_SCHEMA));
		expect(requests).toHaveLength(2);
		expect(out.control).toBeNull();
		expect(out.error).toMatch(/schema violation/i);
		expect(out.error).toContain("verdict");
	});
});

describe("v0.3.70 W3 — sticky degrades (compat, never fatal)", () => {
	beforeEach(() => resetStructuredModeForTests());

	it("invalid_request naming structured support → ONE WARN, sticky degrade, and the CALL retries in text mode and succeeds", async () => {
		const logs: string[] = [];
		let call = 0;
		const { b, requests, progress } = bus(() => {
			call++;
			return call === 1
				? { status: "invalid_request", error: "Unsupported delegation field: result.kind=structured" }
				: completedText('ok <control>{"verdict":"approve"}</control>');
		}, (l) => logs.push(l));
		const out = await runAgentViaDelegation(OPTS(b, progress, VERDICT_SCHEMA));
		expect(out.control).toEqual({ verdict: "approve" }); // call NOT killed
		expect(requests[0].result.kind).toBe("structured");
		expect(requests[1].result).toEqual({ kind: "text" }); // retry in text mode
		const warns = logs.filter((l) => /WARN/.test(l));
		expect(warns.length).toBeGreaterThanOrEqual(1);
		// sticky: a LATER schema call goes straight out as text, no WARN repeat
		const later = bus(() => completedText('ok <control>{"verdict":"approve"}</control>'), (l) => logs.push(l));
		const out2 = await runAgentViaDelegation(OPTS(later.b, later.progress, VERDICT_SCHEMA));
		expect(later.requests[0].result).toEqual({ kind: "text" });
		expect(out2.control).toEqual({ verdict: "approve" });
		expect(logs.filter((l) => /WARN/.test(l))).toHaveLength(warns.length);
	});

	it("3 consecutive structured_output_failed terminal states degrade sticky to text; each failure is an honest per-call error", async () => {
		for (let i = 0; i < 3; i++) {
			const { b, progress } = bus(() => ({ status: "structured_output_failed", error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output." }));
			const out = await runAgentViaDelegation(OPTS(b, progress, VERDICT_SCHEMA));
			expect(out.control).toBeNull();
			expect(out.error).toContain("structured_output_failed"); // honest (P10)
		}
		const later = bus(() => completedText('ok <control>{"verdict":"approve"}</control>'));
		const out = await runAgentViaDelegation(OPTS(later.b, later.progress, VERDICT_SCHEMA));
		expect(later.requests[0].result).toEqual({ kind: "text" }); // degraded
		expect(out.control).toEqual({ verdict: "approve" });
	});

	it("a completed structured call resets the failure streak", async () => {
		const ok = bus(() => ({ status: "completed", result: { kind: "structured", value: { verdict: "approve" } }, model: "fake/m" }));
		await runAgentViaDelegation(OPTS(ok.b, ok.progress, VERDICT_SCHEMA)); // success resets
		const { b, progress } = bus(() => ({ status: "structured_output_failed", error: "x" }));
		await runAgentViaDelegation(OPTS(b, progress, VERDICT_SCHEMA));
		const still = bus(() => completedText('ok <control>{"verdict":"approve"}</control>'));
		await runAgentViaDelegation(OPTS(still.b, still.progress, VERDICT_SCHEMA));
		expect(still.requests[0].result.kind).toBe("structured"); // 1 failure ≠ degrade
	});
});

describe("v0.3.70 W3 — engine-side validation applies to TEXT controls too (corrective upgrade)", () => {
	beforeEach(() => resetStructuredModeForTests());

	it("a wrong-TYPED prose control gets the detailed violation in the corrective task (not just missing keys)", async () => {
		process.env.SUPER_DEV_STRUCTURED = "0"; // force the text path
		try {
			let call = 0;
			const { b, requests, progress } = bus(() => {
				call++;
				return completedText(call === 1
					? 'hmm <control>{"verdict":"maybe"}</control>'
					: 'fixed <control>{"verdict":"approve"}</control>');
			});
			const out = await runAgentViaDelegation(OPTS(b, progress, VERDICT_SCHEMA));
			expect(requests).toHaveLength(2);
			expect(requests[1].task).toMatch(/allowed values|enum/i);
			expect(out.control).toEqual({ verdict: "approve" });
		} finally { delete process.env.SUPER_DEV_STRUCTURED; }
	});
});

describe("v0.3.70 W3 — STAGE_MODELS audit (plan §5.2.5)", () => {
	it("JudgeControlData route union == stages/judge.ts JUDGE_ROUTES (P6 dynamic cross-check)", async () => {
		const { JUDGE_ROUTES } = await import("../src/stages/judge.ts");
		const { JudgeControlData } = await import("../src/render/schemas.ts");
		const literals = (JudgeControlData as { properties: { route: { anyOf?: Array<{ const: string }> } } }).properties.route.anyOf?.map((e) => e.const) ?? [];
		expect([...literals].sort()).toEqual([...JUDGE_ROUTES].sort());
	});

	it("every controlKeys call site in stages/ now carries a schema (grep source contract)", () => {
		const { readFileSync, readdirSync } = require("node:fs") as typeof import("node:fs");
		const { join } = require("node:path") as typeof import("node:path");
		const dir = join(process.cwd(), "src", "stages");
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
			const src = readFileSync(join(dir, f), "utf8");
			const lines = src.split("\n");
			lines.forEach((line, i) => {
				if (/controlKeys: \[/.test(line)) {
					const window = lines.slice(i, i + 6).join("\n");
					expect(window, `${f}:${i + 1} has controlKeys without a schema`).toMatch(/schema:/);
				}
			});
		}
	});
});

describe("v0.3.70 W3 — typebox/value spike (resolution + semantics)", () => {
	it("Value.Check/Errors resolve from the repo and produce JSON-pointer paths", async () => {
		expect(structuredModeEnabled()).toBe(true); // default ON (Option C)
		const errs = schemaViolationErrors(VERDICT_SCHEMA, { verdict: "bogus" });
		expect(errs.length).toBeGreaterThan(0);
		expect(errs.join("\n")).toContain("verdict");
		expect(schemaViolationErrors(VERDICT_SCHEMA, { verdict: "approve" })).toEqual([]);
		// a broken schema never throws — fail-open to the missing-key checks
		expect(() => schemaViolationErrors({ bogus: true } as any, {})).not.toThrow();
	});
});
