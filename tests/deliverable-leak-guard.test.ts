/**
 * Cross-phase deliverable leakage guard (run 2026-08-27T12-33-43-088Z).
 *
 * Phase-2's implementer committed root index.html — phase-3's DECLARED
 * deliverable — out of scope. Phase 3 could then never author an honest RED
 * (its deliverable already existed) and burned 9 tries flagging the honest
 * workaround as "RED pollution". The write boundary saw it only as an
 * advisory. laterPhaseDeliverableHits() makes the intersection computable so
 * the advisory site can BLOCK it.
 */
import { describe, it, expect } from "vitest";
import { laterPhaseDeliverableHits } from "../src/stages/implementation.ts";

const phases = [
	{ name: "phase-01", deliverables: { requireFiles: ["src/a.js"] } },
	{ name: "phase-02", deliverables: { requireFiles: ["src/b.js"], requireContains: [{ file: "src/b.js", pattern: "export" }] } },
	{ name: "phase-03", deliverables: { requireFiles: ["index.html"], requireContains: [{ file: "index.html", pattern: "card--fission" }], requireTests: ["tests/x.test.mjs"] } },
] as never[];

describe("laterPhaseDeliverableHits", () => {
	it("flags a changed file that a LATER phase declares as a deliverable (run-1 shape)", () => {
		expect(laterPhaseDeliverableHits(["index.html"], phases, 1)).toEqual(["index.html"]);
		expect(laterPhaseDeliverableHits(["tests/x.test.mjs"], phases, 0)).toEqual(["tests/x.test.mjs"]);
	});
	it("ignores the CURRENT phase's own deliverables and undeclared files", () => {
		expect(laterPhaseDeliverableHits(["index.html"], phases, 2)).toEqual([]);
		expect(laterPhaseDeliverableHits(["src/b.js"], phases, 1)).toEqual([]);
		expect(laterPhaseDeliverableHits(["README.md"], phases, 1)).toEqual([]);
	});
	it("normalizes path drift (./, backslashes, trailing slash)", () => {
		expect(laterPhaseDeliverableHits(["./index.html", "tests\\x.test.mjs", "index.html/"], phases, 0)).toEqual(["./index.html", "tests\\x.test.mjs", "index.html/"]);
	});
	it("tolerates phases without deliverables", () => {
		expect(laterPhaseDeliverableHits(["index.html"], [{ name: "p0" }, { name: "p1" }] as never[], 0)).toEqual([]);
	});
});
