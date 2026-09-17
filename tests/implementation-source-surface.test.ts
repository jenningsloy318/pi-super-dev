/**
 * The implementation stage's source-contract tripwire — v0.4.26/v0.4.27.
 *
 * tests/helpers/implementation-source.ts derives the stage's source surface
 * from DISK so a pin living in a sibling module can never silently read as
 * absent (the v0.4.26 extraction of run-prepare.ts failed five pins until the
 * list stopped being hand-maintained). The flip side the adversarial gate
 * named: any `.ts` in the directory satisfies `toContain` pins, so a stray
 * scratch file could make a pin pass vacuously. This snapshot pins the exact
 * part set.
 *
 * Adding a part (the next split increment) is a DELIBERATE act: update this
 * snapshot in the same commit. The snapshot is the reminder that the tripwire
 * now covers the new module — which is the point.
 */
import { describe, expect, it } from "vitest";

import { implementationParts } from "./helpers/implementation-source.ts";

const KNOWN_PARTS = [
	"index.ts",
	"phase-emit.ts",
	"phase-reentry.ts",
	"phase-status.ts",
	"red-evidence.ts",
	"run-prepare.ts",
	"stage.ts",
];

describe("implementation-source tripwire surface", () => {
	it("reads exactly the known implementation parts — a new split must be acknowledged here", () => {
		const parts = implementationParts();
		expect(parts).toEqual(KNOWN_PARTS.filter((p) => p !== "index.ts").sort());
		// the snapshot must stay sorted, or the equality above is order-flaky
		expect([...parts]).toEqual([...parts].sort());
	});

	it("no stray scratch/backup .ts has joined the surface", () => {
		const stray = implementationParts().filter((p) => !KNOWN_PARTS.includes(p));
		expect(stray).toEqual([]);
	});
});
