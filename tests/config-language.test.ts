/**
 * Configured output language (run docs/artifacts in a fixed natural language).
 *
 * Motivation: a Chinese-language task against a repo under a Chinese-named
 * path made EVERY generated artifact (spec docs, reports, ledger summaries,
 * commit messages) Chinese, which the operator then had to decode as UTF-8
 * noise. `config.json` gains a `language` key (default `"english"`) that
 * forces ALL agent-written output into one language regardless of the task's
 * language.
 *
 * SCENARIO-L1: defaults to english with no config at all.
 * SCENARIO-L2: config.json `language` is honored (normalized: trim+lowercase).
 * SCENARIO-L3: SUPER_DEV_LANGUAGE env (incl. config.json env map) wins over
 *              the `language` key — same precedence family as other tunables.
 * SCENARIO-L4: empty/garbage values fall back to english, never throw.
 * SCENARIO-L5: realAgent appends the directive as the LAST prompt section on
 *              every agent call (both backends share the same prompt seam).
 * SCENARIO-L6: reflection (which bypasses realAgent) gets the directive too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const captured: { session?: Record<string, unknown>; prompt?: string } = {};

vi.mock("../src/session-agent.ts", () => ({
	runAgentViaSession: vi.fn(async (opts: Record<string, unknown>) => {
		captured.session = opts;
		captured.prompt = opts.prompt as string | undefined;
		return { text: "", control: {} };
	}),
	summarizeSlug: vi.fn(async () => "x"),
}));
vi.mock("../src/pi-spawn.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/pi-spawn.ts")>(),
	spawnAgent: vi.fn(async () => ({ text: "", control: {} })),
	isBrowserAgent: vi.fn(() => false),
	needsWebResearch: vi.fn(() => false),
}));
vi.mock("../src/render/knowledge.ts", () => ({
	knowledgeForAgent: vi.fn(() => ""),
}));

import {
	DEFAULT_CONFIG,
	outputLanguage,
	languageDirective,
} from "../src/render/super-dev-dir.ts";
import { buildReflectionTask } from "../src/render/reflection.ts";
import { makeContext } from "../src/workflow.ts";
import { extractControlKeys } from "../src/control.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

describe("configured output language", () => {
	beforeEach(() => {
		captured.session = undefined;
		captured.prompt = undefined;
		// Machine-independence (review P2): realAgent's backend selection and the
		// no-arg config path must not observe this developer's env/config.
		delete process.env.SUPER_DEV_LANGUAGE;
		delete process.env.SUPER_DEV_BACKEND;
	});
	afterEach(() => {
		delete process.env.SUPER_DEV_LANGUAGE;
		delete process.env.SUPER_DEV_BACKEND;
	});

	it("SCENARIO-L1: DEFAULT_CONFIG.language is english", () => {
		expect(DEFAULT_CONFIG.language).toBe("english");
	});

	it("SCENARIO-L1: outputLanguage defaults to english with no explicit config", () => {
		// explicit-empty config object — the no-arg form reads the operator's real
		// ~/.super-dev/config.json and only has to yield a valid normalized string.
		expect(outputLanguage({})).toBe("english");
		expect(outputLanguage()).toMatch(/^[a-z][a-z0-9-]*$/);
	});

	it("SCENARIO-L2: config language is honored and normalized", () => {
		expect(outputLanguage({ language: " Japanese " })).toBe("japanese");
		expect(outputLanguage({ language: "CHINESE" })).toBe("chinese");
	});

	it("SCENARIO-L3: SUPER_DEV_LANGUAGE env beats the config key", () => {
		// process-env channel; the config.json `env` map rides the identical
		// superDevEnv precedence and is covered by its own tests.
		process.env.SUPER_DEV_LANGUAGE = " German ";
		expect(outputLanguage({ language: "french" })).toBe("german");
	});

	it("SCENARIO-L4: empty/whitespace falls back to english, never throws", () => {
		expect(outputLanguage({ language: "   " })).toBe("english");
		expect(outputLanguage({ language: "" })).toBe("english");
	});

	it("SCENARIO-L4 (review P1): NON-STRING config values degrade to english, never throw", () => {
		// config.json is spread-merged with no schema validation — 42/true/null/
		// arrays must not reach .trim() (this runs on every agent call).
		expect(outputLanguage({ language: 42 as unknown as string })).toBe("english");
		expect(outputLanguage({ language: true as unknown as string })).toBe("english");
		expect(outputLanguage({ language: null as unknown as string })).toBe("english");
		expect(outputLanguage({ language: [] as unknown as string })).toBe("english");
		expect(outputLanguage({ language: {} as unknown as string })).toBe("english");
	});

	it("languageDirective names the language and covers control fields + commits", () => {
		const d = languageDirective({ language: "english" });
		expect(d).toContain("## Output language");
		expect(d).toContain("english");
		expect(d).toMatch(/<control>/);
		expect(d).toMatch(/commit message/i);
		expect(d).toMatch(/regardless of the language/i);
		// the directive follows the configured language, not the env default
		expect(languageDirective({ language: "japanese" })).toContain("japanese");
	});

	it("SCENARIO-L5: realAgent appends the directive as the LAST section of every prompt", async () => {
		const mkCtx = (state: PipelineState, options: RunOptions = {}) =>
			makeContext(state, "t", options, () => {});
		const call: AgentCall = { id: "pipeline.spec", agent: "spec-writer", prompt: "ORIG PROMPT\nOutput <control> JSON with: title." };
		// force the session backend so a real config.json env map can't flip it
		await mkCtx({} as PipelineState, { backend: "session" }).agent(call);
		expect(captured.prompt).toBeDefined();
		expect(captured.prompt!.startsWith("ORIG PROMPT")).toBe(true);
		// control-key extraction still works off the original prompt text
		expect(captured.prompt!).toContain("Output <control> JSON with: title.");
		// the language directive is appended AFTER the original prompt
		const idxOrig = captured.prompt!.indexOf("ORIG PROMPT");
		const idxDirective = captured.prompt!.indexOf("## Output language");
		expect(idxDirective).toBeGreaterThan(idxOrig);
		// and it is the final section AT THIS SEAM (the real backends wrap their
		// delivery-discipline sections after it — asserted here against the
		// backend-boundary prompt the mock captures)
		expect(captured.prompt!.trimEnd().endsWith(languageDirective().trimEnd())).toBe(true);
		// control-key extraction must be unaffected by the directive's mention of
		// <control> (review P2c): keys come from the ORIGINAL prompt line only.
		expect(extractControlKeys(captured.prompt!)).toEqual(["title"]);
	});

	it("SCENARIO-L6: reflection task (bypasses realAgent) carries the directive", () => {
		const task = buildReflectionTask();
		expect(task).toContain("## Output language");
		expect(task).toContain(outputLanguage());
	});
});
