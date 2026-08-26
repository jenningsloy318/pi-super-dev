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

	it("does NOT flag a test-only SUPPORT artifact (non-test-named file, e.g. a fixture)", () => {
		// A RED set may include a fixture/helper imported by the test; it legitimately
		// has no assertion and must not be treated as a hollow test.
		const gaps = assertionPresenceGaps(snap({
			"src/runtime/manifest_fixture.ts": "export const fixture = 'red';",
			"src/session-policy.test.ts": "expect(f()).toBe(1)",
		}));
		expect(gaps).toEqual([]);
	});
});

// ─── v0.3.17: conftest.py exemption (run 2026-08-26T02-36-42-419Z phase-02) ─

describe("conftest.py exemption (v0.3.17)", () => {
	it("does NOT flag python/tests/conftest.py — pytest's canonical support artifact (sys.path bootstrap), legitimately assertion-free", () => {
		// The exact incident shape: a real RED set whose sys.path fix lives in
		// conftest.py. Pre-fix, the guard flagged conftest.py and the cleanup
		// deleted the ENTIRE RED set (twice — tries 3 and 5).
		const gaps = assertionPresenceGaps(snap({
			"python/tests/conftest.py": "import sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parents[1]))\n",
			"python/tests/test_financials.py": "from omisis import financials\n\ndef test_x():\n    assert financials.run({}) is not None\n",
		}));
		expect(gaps).toEqual([]);
	});

	it("package-root conftest.py is exempt via the FIRST gate (not the basename regex) — a control for where the exemption actually lives", () => {
		// 'python/conftest.py' matches no TEST_FILE_NAME_RE branch (no tests/
		// segment, no test/spec basename marker), so it is skipped as a support
		// artifact before the new regex ever fires — on BOTH trees. This test
		// therefore pins the first-gate behavior (and the run's try-8 boundary
		// denial was the classifier's doing, not this guard's), not any-depth.
		const gaps = assertionPresenceGaps(snap({
			"python/conftest.py": "import sys\nsys.path.insert(0, '.')\n",
			"python/tests/test_financials.py": "import omisis.financials as fin\n\ndef test_stub_raises():\n    try:\n        fin.run({})\n    except NotImplementedError:\n        return\n    assert False, 'stub did not raise'\n",
		}));
		expect(gaps).toEqual([]);
	});

	it("exempts a conftest.py nested at arbitrary depth under tests/ — the basename regex is depth-agnostic", () => {
		// The new regex only ever fires for conftests that PASS the first gate
		// (i.e. live under tests/ or a test-named dir). Pin the deep-nesting
		// case so a future narrowing of either regex trips this first.
		const gaps = assertionPresenceGaps(snap({
			"a/b/c/tests/conftest.py": "import sys\n",
			"__tests__/conftest.py": "import sys\n",
		}));
		expect(gaps).toEqual([]);
	});

	it("still flags a genuinely hollow TEST file in the same set — the exemption is conftest-only, not tests/-directory-wide", () => {
		const gaps = assertionPresenceGaps(snap({
			"python/tests/conftest.py": "import sys\nsys.path.insert(0, '.')\n",
			"python/tests/hollow_test.py": "def test_todo():\n    pass\n",
		}));
		expect(gaps).toEqual(["python/tests/hollow_test.py"]);
	});

	it("still flags a hollow conftest-LOOKALIKE with a different basename — the match is on the reserved filename, not a substring", () => {
		const gaps = assertionPresenceGaps(snap({
			"python/tests/my_conftest_helper.py": "import sys\n",
		}));
		// matches the (^|/)tests?/ directory branch → treated as a test file, hollow → flagged (current semantics preserved)
		expect(gaps).toEqual(["python/tests/my_conftest_helper.py"]);
	});
});
