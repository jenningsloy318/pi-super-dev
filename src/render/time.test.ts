import { describe, expect, it } from "vitest";

import { localTimestamp } from "./time.js";

describe("localTimestamp", () => {
	it("formats local time with a numeric timezone offset instead of UTC Z", () => {
		const formatted = localTimestamp(new Date(2026, 7, 6, 21, 36, 33, 429));
		expect(formatted).toMatch(/^2026-08-06T21:36:33\.429[+-]\d{2}:\d{2}$/);
		expect(formatted.endsWith("Z")).toBe(false);
	});
});
