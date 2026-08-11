/**
 * Plan 2 Tier 1 — hollow-assertion guard. A RED test file with no recognizable
 * assertion proves nothing: a trivial implementation would make it "pass". The
 * static, deterministic `assertionPresenceGaps` check flags such files at RED
 * time so tdd-guide adds real assertions before the implementer runs. (Weak-but-
 * present assertions are Tier 2's job — this only catches TRULY hollow tests.)
 */
import { describe, it, expect } from "vitest";
import { assertionPresenceGaps } from "../src/stages/implementation.ts";

const snap = (entries: Record<string, string | null>) => new Map(Object.entries(entries));

describe("assertionPresenceGaps", () => {
	it("flags a test file with no assertion call", () => {
		const gaps = assertionPresenceGaps(snap({ "a.test.ts": "it('does a thing', () => { doThing(); });" }));
		expect(gaps).toEqual(["a.test.ts"]);
	});

	it("passes ts/js files that contain expect(...)", () => {
		expect(assertionPresenceGaps(snap({ "a.test.ts": "it('x', () => { expect(f()).toBe(1); });" }))).toEqual([]);
	});

	it("passes rust assert! / assert_eq! macros", () => {
		expect(assertionPresenceGaps(snap({ "lib.rs": "#[test] fn t() { assert_eq!(f(), 1); }" }))).toEqual([]);
	});

	it("passes python assert and go t.Fatal / require", () => {
		expect(assertionPresenceGaps(snap({ "t.py": "def test_x():\n    assert f() == 1" }))).toEqual([]);
		expect(assertionPresenceGaps(snap({ "x_test.go": "func TestX(t *testing.T){ if f()!=1 { t.Fatalf(\"no\") } }" }))).toEqual([]);
		expect(assertionPresenceGaps(snap({ "y_test.go": "require.Equal(t, 1, f())" }))).toEqual([]);
	});

	it("skips unreadable (null) files — absence of content is not evidence of hollowness", () => {
		expect(assertionPresenceGaps(snap({ "gone.test.ts": null }))).toEqual([]);
	});

	it("reports only the hollow files in a mixed set", () => {
		const gaps = assertionPresenceGaps(snap({
			"good.test.ts": "expect(x).toBe(1)",
			"hollow.test.ts": "it('todo', () => {})",
		}));
		expect(gaps).toEqual(["hollow.test.ts"]);
	});
});
