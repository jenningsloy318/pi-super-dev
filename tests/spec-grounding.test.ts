import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specGroundingErrors } from "../src/doc-validators.ts";

let dir: string;

beforeEach(() => {
	dir = join(tmpdir(), `sd-grounding-${process.pid}-${Date.now()}`);
	mkdirSync(join(dir, "frontend/src/app/api/v1/auth/[...slug]"), { recursive: true });
	mkdirSync(join(dir, "frontend/src/app/api/v1/auth/refresh"), { recursive: true });
	writeFileSync(join(dir, "frontend/src/app/api/v1/auth/[...slug]/route.ts"), "export const POST = () => Response.json({});\n");
	writeFileSync(join(dir, "frontend/src/app/api/v1/auth/refresh/route.ts"), "export const POST = () => Response.json({});\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("specGroundingErrors", () => {
	it("rejects specs that assign a specific Next route endpoint to an existing catch-all route", () => {
		const spec = "Update frontend/src/app/api/v1/auth/[...slug]/route.ts to clear cookies for the refresh endpoint.";

		expect(specGroundingErrors(dir, spec)).toEqual([
			expect.stringContaining("existing specific route frontend/src/app/api/v1/auth/refresh/route.ts will take precedence"),
		]);
	});

	it("passes when the spec names the existing specific route explicitly", () => {
		const spec = "Update frontend/src/app/api/v1/auth/[...slug]/route.ts and frontend/src/app/api/v1/auth/refresh/route.ts for refresh cookie cleanup.";

		expect(specGroundingErrors(dir, spec)).toEqual([]);
	});
});
