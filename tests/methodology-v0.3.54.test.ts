/**
 * v0.3.54 — regression tests for the first application of docs/methodology
 * findings F3–F6 (F1/F2 shipped in v0.3.53, F7 verified already-resolved).
 *
 * F3-real: concurrent-writer boundary violations QUARANTINE (never blind
 *   git-restore) and the join attributes each path against the implementer's
 *   claimed files (L4 real-git lane).
 * F4: prose-array coercion is schema-derived (any stage, not a hand map).
 * F5: contract-drift telemetry is drainable (run.log, not console.warn).
 * F6: extractControl fallbacks after a tag-parse failure are guarded against
 *   wrong-object acceptance (validate-after-repair pattern).
 * Near-miss: missing-required errors name a present near-miss key.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { extractControl, extractControlKeys, drainControlDrift, noteControlDrift } from "../src/control.ts";
import { attributQuarantinedViolations } from "../src/stages/implementation.ts";
import { normalizeProseArrays, renderStage, validateData } from "../src/render/render.ts";
import { STAGE_MODELS } from "../src/render/schemas.ts";
import { boundaryQuarantinePayload, formatBoundaryQuarantineError, sweepStaleQuarantineDirs } from "../src/workflow.ts";

describe("v0.3.54 F6 — extractControl fallback guard after tag-parse failure", () => {
	it("tag body fails AND fallback object carries NONE of the declared keys → null (wrong-object rejected)", () => {
		drainControlDrift();
		const text = [
			"<control>{\"verdict\": \"Changes Requested\", oops}</control>", // tag body broken
			"Here is an unrelated example:",
			"```json",
			"{\"foo\": 1, \"bar\": [2, 3]}",
			"```",
		].join("\n");
		const control = extractControl(text, ["verdict", "findings"]);
		expect(control).toBeNull();
		const drift = drainControlDrift().join("\n");
		expect(drift).toContain("REJECTED after <control>-tag parse failure");
		expect(drift).toContain("none of the declared keys");
	});

	it("tag body fails but fallback object carries a declared key → accepted with a loud note", () => {
		drainControlDrift();
		const text = [
			"<control>{\"verdict\": broken}</control>",
			"```json",
			"{\"verdict\": \"Approved\", \"findings\": []}",
			"```",
		].join("\n");
		const control = extractControl(text, ["verdict", "findings"]);
		expect(control).not.toBeNull();
		expect((control as Record<string, unknown>).verdict).toBe("Approved");
		const drift = drainControlDrift().join("\n");
		expect(drift).toContain("fallback fenced-block object accepted after <control>-tag parse failure");
	});

	it("no declared keys (legacy callers) → fallback still accepted (status quo + telemetry)", () => {
		drainControlDrift();
		const text = "<control>{nope</control>\n```json\n{\"anything\": true}\n```";
		const control = extractControl(text);
		expect(control).not.toBeNull();
		expect(drainControlDrift().join("\n")).toContain("no expected keys declared");
	});

	it("healthy tag path never touches the fallback machinery and emits no drift", () => {
		drainControlDrift();
		const control = extractControl("<control>{\"verdict\": \"Approved\"}</control>", ["verdict"]);
		expect(control).not.toBeNull();
		expect(drainControlDrift()).toEqual([]);
	});
});

describe("v0.3.54 F5 — drift telemetry drains (run.log, not console.warn)", () => {
	it("unbalanced-paren drift from extractControlKeys lands in the drain buffer", () => {
		drainControlDrift();
		// Unbalanced paren: prose leaked into the control line.
		extractControlKeys("<control> JSON with: verdict, findings (oops, summary: string");
		const drift = drainControlDrift().join("\n");
		expect(drift).toContain("unbalanced parentheses in control-key line");
		expect(drainControlDrift()).toEqual([]); // drained is empty
	});

	it("noteControlDrift is bounded (ring buffer)", () => {
		drainControlDrift();
		for (let i = 0; i < 60; i++) noteControlDrift(`e${i}`);
		const drained = drainControlDrift();
		expect(drained.length).toBeLessThanOrEqual(50);
		expect(drained[drained.length - 1]).toContain("e59");
	});
});

describe("v0.3.54 F4 — prose-array coercion is schema-derived", () => {
	it("bdd traceability[].scenarios (never in the old hand map) coerces prose → array", () => {
		drainControlDrift();
		// Minimal render-valid BDD control with the prose drift on the
		// traceability[].scenarios slot — a (container, field) pair the old
		// PROSE_ARRAY_FIELDS map did not list, so pre-0.3.54 this render failed.
		const control = {
			title: "T",
			date: "2026-09-01",
			source: "./01-requirements.md",
			features: [
				{
					name: "F",
					scenarios: [
						{ id: "001", title: "t", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "th" },
					],
				},
			],
			traceability: [
				{ acId: "AC-01", description: "d", scenarios: "SCENARIO-001 stays red until the shell mounts the card" },
			],
		};
		const result = renderStage("bdd", control);
		expect(result.errors).toEqual([]);
		expect(result.markdown.length).toBeGreaterThan(0);
	});

	it("v0.3.54 review fix (code F7): item-level enum string arrays stay untouched (no prose wrap)", () => {
		drainControlDrift();
		const schema = {
			type: "object",
			properties: {
				levels: {
					type: "array",
					items: {
						type: "object",
						properties: {
							grade: { type: "array", items: { type: "string", enum: ["low", "high"] } },
						},
					},
				},
			},
		};
		const data = { levels: [{ grade: "high scores everywhere" }] };
		normalizeProseArrays("custom", data, schema);
		// An enum'd slot must stay a REJECTED string (located error), never a
		// 1-element garbage array that fails the enum check with worse context.
		expect((data.levels as Array<{ grade: unknown }>)[0].grade).toBe("high scores everywhere");
	});
});

describe("v0.3.54 — near-miss hint on missing required properties", () => {
	it("a typo'd required key gets a did-you-mean hint naming the near miss", () => {
		const design = STAGE_MODELS["design"];
		const bad: Record<string, unknown> = {
			title: "t", date: "d", sumary: "s", designer: "x",
			modules: [], hasNumericConstants: "true", contracts: [],
		};
		const errors = validateData(design.schema, bad);
		expect(errors.some((e) => e.includes("must have required properties summary") && e.includes("did you mean \"summary\"") && e.includes("sumary"))).toBe(true);
	});

	it("unrelated missing keys get no spurious hint", () => {
		const design = STAGE_MODELS["design"];
		const bad: Record<string, unknown> = {
			title: "t", date: "d", designer: "x",
			modules: [], hasNumericConstants: "true", contracts: [], zzzz: 1,
		};
		const errors = validateData(design.schema, bad);
		expect(errors.length).toBeGreaterThan(0);
		for (const e of errors) expect(e).not.toContain("did you mean");
	});

	it("v0.3.54 review fix (adv F4): a NESTED near miss on an array item now gets the hint", () => {
		const bdd = STAGE_MODELS["bdd"];
		// traceability[].description emitted as "descrition" — the errored object
		// is the ARRAY ITEM, not the root; pre-fix the hint scanned root keys and
		// never fired for its motivating nested class.
		const bad: Record<string, unknown> = {
			title: "T", date: "2026-09-01", source: "./01-requirements.md",
			features: [
				{ name: "F", scenarios: [{ id: "001", title: "t", acRef: "AC-01", priority: "high", given: "g", when: "w", then: "th" }] },
			],
			traceability: [{ acId: "AC-01", descrition: "d", scenarios: ["SCENARIO-001"] }],
		};
		const errors = validateData(bdd.schema, bad);
		expect(errors.some((e) => e.includes("must have required properties description") && e.includes("descrition"))).toBe(true);
	});
});

describe("v0.3.54 F3-real — attributQuarantinedViolations (real git repo)", () => {
	let wt: string;
	beforeEach(() => {
		wt = mkdtempSync(join(tmpdir(), "sd54-quarantine-"));
		const git = (args: string[]) => spawnSync("git", args, { cwd: wt, encoding: "utf8" });
		git(["init", "-q"]);
		git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
		git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
		writeFileSync(join(wt, "main.ts"), "export const a = 1;\n");
		writeFileSync(join(wt, "index.html"), "<html></html>\n");
		git(["add", "-A"]);
		git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "app files"]);
	});
	afterEach(() => rmSync(wt, { recursive: true, force: true }));

	it("restores paths the implementer never claimed; keeps implementer-owned paths in place", () => {
		// Reviewer violated both files (quarantined, not restored). The error is
		// built through the REAL producer so the producer↔parser format coupling
		// is pinned (v0.3.54 review fix, code F3).
		writeFileSync(join(wt, "main.ts"), "reviewer junk\n");
		writeFileSync(join(wt, "index.html"), "reviewer junk too\n");
		// v0.3.55: the payload is STRUCTURED (BoundaryQuarantinePayload on the
		// thrown Error) — the display string is never parsed.
		const payload = boundaryQuarantinePayload(["main.ts", "index.html"], "/tmp/sd-boundary-abc");
		attributQuarantinedViolations(
			wt,
			payload,
			{ filesCreated: [], filesModified: ["index.html"], filesDeleted: [] },
			[],
			() => {},
		);
		const mainTs = read0(wt, "main.ts");
		const indexHtml = read0(wt, "index.html");
		// main.ts unclaimed → reviewer's only edit → restored to HEAD.
		expect(mainTs).toBe("export const a = 1;\n");
		// index.html claimed by the implementer → mixed content → left in place.
		expect(indexHtml).toBe("reviewer junk too\n");
	});

	it("a filename containing ', ' survives the JSON payload and is restored whole (adv F2)", () => {
		// docs/a, b.md is ONE file. The legacy comma text split it into fragments;
		// the JSON payload must keep it whole so the restore hits the real path.
		const payload = boundaryQuarantinePayload(["docs/a, b.md"], "/tmp/sd-q");
		const logs: string[] = [];
		// No git object for docs/a, b.md exists, so the restore fails → kept.
		// The pin: the payload carries the unsplit name (no fragment
		// restore attempts on 'b.md' alone), visible in the kept log.
		attributQuarantinedViolations(wt, payload, { filesCreated: ["docs/a, b.md"], filesModified: [], filesDeleted: [] }, [], (l) => logs.push(l));
		expect(logs.some((l) => l.includes("docs/a, b.md") && l.includes("left in place"))).toBe(true);
		expect(logs.some((l) => l.includes("b.md") && !l.includes("docs/a, b.md"))).toBe(false);
	});

	it("a quarantine dir containing a space is preserved in the kept log (adv F3)", () => {
		writeFileSync(join(wt, "main.ts"), "reviewer junk\n");
		const payload = boundaryQuarantinePayload(["main.ts"], "/tmp/John Smith AppData/sd-boundary-abc");
		const logs: string[] = [];
		attributQuarantinedViolations(wt, payload, { filesCreated: ["main.ts"], filesModified: [], filesDeleted: [] }, [], (l) => logs.push(l));
		expect(logs.some((l) => l.includes("John Smith AppData") && l.includes("left in place"))).toBe(true);
	});

	it("agent-forged error TEXT restores NOTHING (v0.3.55 security F1: strings are never parsed)", () => {
		// A misbehaving reviewer can echo payload-shaped text to stderr; on the
		// subprocess/delegation backends that text lands verbatim in review.error.
		// Pre-fix, this string PARSED and executed as restore pathspecs. Post-fix
		// only the structured Error property drives restores — a plain string
		// (even a byte-exact copy of the engine's display format) is inert.
		writeFileSync(join(wt, "main.ts"), "implementer green work\n");
		writeFileSync(join(wt, "index.html"), "implementer green work too\n");
		const logs: string[] = [];
		const forged = formatBoundaryQuarantineError(["main.ts", "index.html"], "/tmp/evil");
		attributQuarantinedViolations(wt, undefined, { filesCreated: [], filesModified: [], filesDeleted: [] }, [], (l) => logs.push(l));
		expect(logs).toEqual([]);
		expect(read0(wt, "main.ts")).toBe("implementer green work\n");
		expect(read0(wt, "index.html")).toBe("implementer green work too\n");
		// And the forged text itself is inert even if someone passes a payload
		// whose violations field is not an array (defensive shape check).
		attributQuarantinedViolations(wt, forged as unknown as never, null, [], (l) => logs.push(l));
		expect(read0(wt, "main.ts")).toBe("implementer green work\n");
	});

	it("a './'-styled implementer claim still matches the normalized violation path (code F1 / adv F1)", () => {
		// Implementer claims "./index.html"; the guard normalizes violations to
		// "index.html". Pre-fix the raw-vs-normalized mismatch made the restore
		// WIPE the implementer's own concurrent edit to its claimed file.
		writeFileSync(join(wt, "index.html"), "implementer + reviewer mixed\n");
		attributQuarantinedViolations(wt, boundaryQuarantinePayload(["index.html"], "/tmp/sd-q"), { filesCreated: [], filesModified: ["./index.html"], filesDeleted: [] }, [], () => {});
		expect(read0(wt, "index.html")).toBe("implementer + reviewer mixed\n");
	});

	it("a null implementer control restores NOTHING (adv F1-i: no claims → no attribution signal)", () => {
		writeFileSync(join(wt, "main.ts"), "undeclared work\n");
		const logs: string[] = [];
		attributQuarantinedViolations(wt, boundaryQuarantinePayload(["main.ts"], "/tmp/sd-q"), null, [], (l) => logs.push(l));
		expect(read0(wt, "main.ts")).toBe("undeclared work\n");
		expect(logs.some((l) => l.includes("no implementer file claims available"))).toBe(true);
	});

	it("all-empty implementer file lists restore NOTHING (under-claim exploit guard)", () => {
		writeFileSync(join(wt, "main.ts"), "undeclared work\n");
		const logs: string[] = [];
		attributQuarantinedViolations(wt, boundaryQuarantinePayload(["main.ts"], "/tmp/sd-q"), { filesCreated: [], filesModified: [], filesDeleted: [] }, [], (l) => logs.push(l));
		expect(read0(wt, "main.ts")).toBe("undeclared work\n");
		expect(logs.some((l) => l.includes("no implementer file claims available"))).toBe(true);
	});

	it("phase test files are treated as implementer-owned (never restored away)", () => {
		writeFileSync(join(wt, "phase1.test.mjs"), "reviewer junk\n");
		spawnSync("git", ["add", "-A"], { cwd: wt });
		spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "tests"], { cwd: wt });
		writeFileSync(join(wt, "phase1.test.mjs"), "reviewer junk 2\n");
		const payload = boundaryQuarantinePayload(["phase1.test.mjs"], "/tmp/sd-boundary-abc");
		const logs: string[] = [];
		attributQuarantinedViolations(wt, payload, { filesCreated: [], filesModified: [], filesDeleted: [] }, ["phase1.test.mjs"], (l) => logs.push(l));
		const out = spawnSync("cat", [join(wt, "phase1.test.mjs")], { encoding: "utf8" }).stdout;
		expect(out).toBe("reviewer junk 2\n");
		expect(logs.some((l) => l.includes("left in place"))).toBe(true);
	});

	it("non-payload shapes degrade to NO-OP with no git action (null / malformed)", () => {
		const logs: string[] = [];
		writeFileSync(join(wt, "main.ts"), "precious work\n");
		attributQuarantinedViolations(wt, null, null, [], (l) => logs.push(l));
		attributQuarantinedViolations(wt, { violations: "not-an-array", dir: "/tmp/x" } as never, null, [], (l) => logs.push(l));
		expect(logs).toEqual([]);
		expect(read0(wt, "main.ts")).toBe("precious work\n");
	});

	it("a file literally named ':(top)*' restores ONLY itself — no pathspec-magic widening (v0.3.55 security F2)", () => {
		// git status -z reports the file raw as ':(top)*'. Pre-fix, the restore
		// argv carried that path verbatim: git parsed magic `top` + pattern `*`
		// (wildmatch without WM_PATHNAME, so * crosses '/') and reverted EVERY
		// tracked modified file in the worktree — the implementer's uncommitted
		// GREEN work included. The `:(literal)` prefix defuses the magic.
		writeFileSync(join(wt, "main.ts"), "implementer green work\n");
		writeFileSync(join(wt, ":(top)*"), "reviewer junk\n");
		attributQuarantinedViolations(
			wt,
			boundaryQuarantinePayload([":(top)*"], "/tmp/sd-q"),
			{ filesCreated: [], filesModified: ["main.ts"], filesDeleted: [] },
			[],
			() => {},
		);
		// main.ts is claimed → untouched; and the restore of the magic-named file
		// must not have widened to it either.
		expect(read0(wt, "main.ts")).toBe("implementer green work\n");
		// The magic-named file itself is untracked → restore cannot remove it;
		// it stays (logged as kept/manual).
		expect(existsSync(join(wt, ":(top)*"))).toBe(true);
	});

	it("interior './' segments in an honest claim still attribute (v0.3.55 security F3: resolve-based norm)", () => {
		mkdirSync(join(wt, "src"), { recursive: true });
		writeFileSync(join(wt, "src", "main.ts"), "export const b = 2;\n");
		spawnSync("git", ["add", "-A"], { cwd: wt });
		spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "src"], { cwd: wt });
		writeFileSync(join(wt, "src", "main.ts"), "implementer + reviewer mixed\n");
		// The violation path arrives canonical ("src/main.ts") while the
		// implementer styled its claim with an interior './' — the v0.3.54
		// string-surgery norm missed this and the restore wiped the edit.
		attributQuarantinedViolations(
			wt,
			boundaryQuarantinePayload(["src/main.ts"], "/tmp/sd-q"),
			{ filesCreated: [], filesModified: ["src/./main.ts"], filesDeleted: [] },
			[],
			() => {},
		);
		expect(read0(wt, join("src", "main.ts"))).toBe("implementer + reviewer mixed\n");
	});
});

function read0(wt: string, rel: string): string {
	return spawnSync("cat", [join(wt, rel)], { encoding: "utf8" }).stdout;
}

describe("v0.3.54 F6 wiring — production extractControl call sites pass expectedKeys", () => {
	it("source-contract invariant: every production extractControl( call carries a declared-keys argument", async () => {
		// Class-E source-contract test (docs/testing-strategy.md): the F6 wrong-object
		// guard only engages when the caller passes the stage's declared keys. A future
		// call site that forgets the second argument silently re-opens the
		// wrong-object-acceptance hole; this invariant fails the suite at commit time.
		const { readFile } = await import("node:fs/promises");
		const files = [
			"src/bench/session-agent.ts",
			"src/agents/delegation-backend.ts",
			"src/resume.ts",
		];
		let checked = 0;
		for (const rel of files) {
			const src = await readFile(new URL(`../${rel}`, import.meta.url), "utf-8");
			for (const m of src.matchAll(/extractControl\(([^)\n]*)\)/g)) {
				const line = src.slice(0, m.index ?? 0).split("\n").length;
				const isDefinition = /function\s+extractControl\(/.test(src.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 10));
				if (isDefinition) continue;
				checked++;
				const args = m[1];
				// top-level comma = at least two arguments (text, expectedKeys)
				let depth = 0;
				let hasComma = false;
				for (const ch of args) {
					if (ch === "(" || ch === "[") depth++;
					else if (ch === ")" || ch === "]") depth--;
					else if (ch === "," && depth === 0) { hasComma = true; break; }
				}
				expect(hasComma, `${rel}:${line} must pass expectedKeys to extractControl (got: extractControl(${args}))`).toBe(true);
			}
		}
		// sanity: the invariant actually saw the production sites (4 since
		// v0.3.64: the subprocess backend's two sites were deleted with it)
		expect(checked).toBeGreaterThanOrEqual(4);
	});
});

// v0.3.57 — the L5 quarantine test lane the v0.3.56 code comments CLAIMED but
// never shipped (security review P10 honesty defect): sweepStaleQuarantineDirs
// (fresh survives / >24h swept / planted symlink removed link-only) executed
// against the real os.tmpdir() conventions.
describe("v0.3.57 L5 — sweepStaleQuarantineDirs (real fs)", () => {
	const made: string[] = [];
	afterEach(() => { for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ } } });

	it("a fresh quarantine dir survives; a >24h dir is swept; a swept dir's planted symlink never deletes its target", () => {
		const fresh = join(tmpdir(), `sd-boundary-test-fresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		const stale = join(tmpdir(), `sd-boundary-test-stale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(fresh, { recursive: true, mode: 0o700 });
		mkdirSync(stale, { recursive: true, mode: 0o700 });
		made.push(fresh, stale);
		const target = join(stale, "target.txt");
		writeFileSync(target, "precious");
		symlinkSync(target, join(stale, "planted-link"));
		// Backdate the stale dir past the 24h GC horizon.
		const old = new Date(Date.now() - 25 * 3_600_000);
		utimesSync(stale, old, old);

		sweepStaleQuarantineDirs();

		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(stale)).toBe(false);
		// rmSync removed the directory (and the link entry), never the target's
		// bytes — the "planted symlinks skipped" claim, proven not presumed.
		expect(existsSync(target)).toBe(false); // target lived INSIDE the swept dir
	});

	it("a symlink pointing OUTSIDE a swept dir keeps its target bytes (link-only removal)", () => {
		const outer = mkdtempSync(join(tmpdir(), "sd-boundary-target-"));
		made.push(outer);
		const target = join(outer, "outside.txt");
		writeFileSync(target, "precious");
		const stale = join(tmpdir(), `sd-boundary-test-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(stale, { recursive: true, mode: 0o700 });
		made.push(stale);
		symlinkSync(target, join(stale, "escape-link"));
		const old = new Date(Date.now() - 25 * 3_600_000);
		utimesSync(stale, old, old);

		sweepStaleQuarantineDirs();

		expect(existsSync(stale)).toBe(false);
		expect(readFileSync(target, "utf8")).toBe("precious");
	});
});
