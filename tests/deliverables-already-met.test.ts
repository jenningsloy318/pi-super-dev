/**
 * F8 (incident 2026-09-04T14-45-04-784Z, phase 5) — deliverablesAlreadyMet must
 * evaluate EVERY contract clause kind, not only requireFiles.
 *
 * Enumeration table (contract-shape grammar, P2-style defense for the A-class):
 *
 * | # | contract shape                       | expected |
 * |---|--------------------------------------|----------|
 * | 1 | requireFiles only, files exist       | true     |
 * | 2 | requireFiles only, one missing       | false    |
 * | 3 | requireContains only, all satisfied  | true     | ← incident phase 5/3 shape (was false pre-fix)
 * | 4 | requireContains only, one missing    | false    |
 * | 5 | requireNotContains only, clean       | true     | (pure-negative contract; runDeliverableCheck already supports it)
 * | 6 | requireNotContains only, violated    | false    |
 * | 7 | requireScenarios only, tags present  | true     | (was false pre-fix)
 * | 8 | requireScenarios only, tag missing   | false    |
 * | 9 | mixed files+contains, all satisfied  | true     |
 * |10 | mixed, contains clause missing       | false    |
 * |11 | completely empty contract            | false    | (fail-closed: nothing checkable)
 * |12 | multiline regex spans array lines    | true     | (schemas.ts PYTHON_SCRIPTS live form)
 *
 * Real-fs fixtures (mkdtemp) — no mocks: the function's semantics ARE the unit
 * under test. requireFiles-only rows pin the pre-existing behavior (no regression).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverablesAlreadyMet, type DeliverableContract } from "../src/build-runner.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sd-dam-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const abs = join(dir, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

describe("deliverablesAlreadyMet — contract-shape enumeration (F8)", () => {
	it("1. requireFiles only, files exist → true (pre-existing behavior pinned)", () => {
		write("src/feature.ts", "export const x = 1;");
		write("tests/feature.test.ts", "test('x', () => {});");
		const contract: DeliverableContract = { requireFiles: ["src/feature.ts", "tests/feature.test.ts"] };
		expect(deliverablesAlreadyMet(dir, contract)).toBe(true);
	});

	it("2. requireFiles only, one missing → false", () => {
		write("src/feature.ts", "export const x = 1;");
		const contract: DeliverableContract = { requireFiles: ["src/feature.ts", "tests/feature.test.ts"] };
		expect(deliverablesAlreadyMet(dir, contract)).toBe(false);
	});

	it("3. requireContains only, all satisfied → true (incident phase-5 shape; RED pre-fix)", () => {
		write("tests/registry.test.ts", "const CLOSED_THIRTEEN = 13;\nexpect(n).toBe(13);");
		const contract: DeliverableContract = {
			requireContains: [
				{ file: "tests/registry.test.ts", pattern: "CLOSED_THIRTEEN" },
				{ file: "tests/registry.test.ts", pattern: "toBe\\(13\\)" },
			],
		};
		expect(deliverablesAlreadyMet(dir, contract)).toBe(true);
	});

	it("4. requireContains only, one missing → false", () => {
		write("tests/registry.test.ts", "const CLOSED_THIRTEEN = 13;\n");
		const contract: DeliverableContract = {
			requireContains: [
				{ file: "tests/registry.test.ts", pattern: "CLOSED_THIRTEEN" },
				{ file: "tests/registry.test.ts", pattern: "toBe\\(13\\)" },
			],
		};
		expect(deliverablesAlreadyMet(dir, contract)).toBe(false);
	});

	it("5. requireNotContains only, clean → true (pure-negative contract)", () => {
		write("docs/tooling.md", "| `macro` | snapshot |");
		const contract: DeliverableContract = {
			requireNotContains: [{ file: "docs/tooling.md", pattern: "macro op" }],
		};
		expect(deliverablesAlreadyMet(dir, contract)).toBe(true);
	});

	it("6. requireNotContains only, violated → false", () => {
		write("docs/tooling.md", "market_data (macro op)");
		const contract: DeliverableContract = {
			requireNotContains: [{ file: "docs/tooling.md", pattern: "macro op" }],
		};
		expect(deliverablesAlreadyMet(dir, contract)).toBe(false);
	});

	it("7. requireScenarios only, tags present → true (RED pre-fix)", () => {
		write("tests/scenarios.test.ts", "// SCENARIO-025 SCENARIO-026 coverage\ntest('s', () => {});");
		const contract: DeliverableContract = { requireScenarios: ["SCENARIO-025", "SCENARIO-026"] };
		expect(deliverablesAlreadyMet(dir, contract)).toBe(true);
	});

	it("8. requireScenarios only, tag missing → false", () => {
		write("tests/scenarios.test.ts", "// SCENARIO-025 coverage\ntest('s', () => {});");
		const contract: DeliverableContract = { requireScenarios: ["SCENARIO-025", "SCENARIO-027"] };
		expect(deliverablesAlreadyMet(dir, contract)).toBe(false);
	});

	it("9. mixed files+contains, all satisfied → true", () => {
		write("src/schemas.ts", "export const PYTHON_SCRIPTS = [\n\t\"a\", \"macro\",\n] as const;");
		const contract: DeliverableContract = {
			requireFiles: ["src/schemas.ts"],
			requireContains: [{ file: "src/schemas.ts", pattern: "PYTHON_SCRIPTS\\s*=\\s*\\[[^\\]]*\"macro\"" }],
		};
		expect(deliverablesAlreadyMet(dir, contract)).toBe(true);
	});

	it("10. mixed, contains clause missing → false", () => {
		write("src/schemas.ts", "export const OTHER = 1;");
		const contract: DeliverableContract = {
			requireFiles: ["src/schemas.ts"],
			requireContains: [{ file: "src/schemas.ts", pattern: "PYTHON_SCRIPTS\\s*=\\s*\\[[^\\]]*\"macro\"" }],
		};
		expect(deliverablesAlreadyMet(dir, contract)).toBe(false);
	});

	it("11. completely empty contract → false (fail-closed: nothing checkable)", () => {
		write("src/anything.ts", "export const x = 1;");
		expect(deliverablesAlreadyMet(dir, {})).toBe(false);
		expect(deliverablesAlreadyMet(dir, { requireFiles: [] })).toBe(false);
	});

	it("12. multiline regex spans array lines (schemas.ts live form)", () => {
		write("src/schemas.ts", "export const PYTHON_SCRIPTS = [\n\t\"sizing\", \"ue_model\",\n\t\"sentiment\", \"macro\",\n] as const;");
		const contract: DeliverableContract = {
			requireContains: [{ file: "src/schemas.ts", pattern: "PYTHON_SCRIPTS\\s*=\\s*\\[[^\\]]*\"macro\"" }],
		};
		expect(deliverablesAlreadyMet(dir, contract)).toBe(true);
	});

	it("13. missing deliverable file for requireContains → false (no crash)", () => {
		const contract: DeliverableContract = {
			requireContains: [{ file: "does/not/exist.ts", pattern: "anything" }],
		};
		expect(deliverablesAlreadyMet(dir, contract)).toBe(false);
	});
});
