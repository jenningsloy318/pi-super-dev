# conftest.py hollow-guard exemption (v0.3.17)

Status: implemented (this commit — v0.3.17)

## Incident

Run 2026-08-26T02-36-42-419Z (pi-omisis, spec 16-dimension-financials), Phase
2/3 (Python Decimal financials pipeline): the RED generation loop burned 8
tries. A pre-existing packaging gap — `python/pyproject.toml` declares
`readme = "README.md"` but `python/README.md` is absent, and the `omisis`
package was never installed — makes the module unimportable under the oracle's
bare `pytest` invocation (cwd is NOT on `sys.path` for bare `pytest`, unlike
`python3 -m pytest`). The tdd-guide's only clean escape — a
`python/tests/conftest.py` that bootstraps `sys.path` — was twice destroyed by
the harness itself:

- try 3 and try 5 delivered a REAL RED suite (oracle `status=red exit=1`, all
  17–19 failures the intended missing-behavior class) with `conftest.py`
  classified `test:allow` by the RED boundary. The hollow-assertion guard then
  flagged `python/tests/conftest.py` as a hollow test ("no assertion call
  found"), and `restoreUnacceptedRedChanges` deleted the entire RED set.
- The red-no-progress judge diagnosed the packaging gap correctly (confidence
  0.78) and routed `fix-environment` — which the RED loop answers only by
  "restarting RED with the diagnosis": no actor ever repairs the environment,
  so the loop deterministically repeats (the judge's own words).

## Root causes

- **RC-1 (deterministic, this fix):** `TEST_FILE_NAME_RE`'s `(^|\/)tests?\/`
  branch classifies ANY file under `tests/` as a test file. `conftest.py` is
  pytest's canonical SUPPORT artifact (auto-loaded fixtures/sys.path
  bootstrap) and legitimately contains no assertions; the guard's own doc
  comment already exempts "a fixture/helper imported by a test" in spirit,
  but the regex never exempted pytest's reserved filename.
- **RC-2 (design gap, documented here):** `fix-environment` routed from the
  red-no-progress judge has no executor in the RED loop.
- **RC-3 (design gap, documented here):** the agent self-verifies with
  `python3 -m pytest` while the oracle runs bare `pytest` — the oracle
  failure diagnostic does not surface the exact command line, so the agent
  cannot align (command-blindness, the same honesty class as v0.2.2's
  comment-blindness).

## Fixes

### F1 — conftest.py exemption (this commit)

`assertionPresenceGaps` (src/stages/implementation.ts) gains a basename
exemption for `conftest.py` at ANY directory depth (`(^|\/)conftest\.py$`,
case-insensitive). pytest collects conftest.py from every directory on the
rootdir→test path (`python/conftest.py` is as legal as
`python/tests/conftest.py`), so the match is on basename, not a fixed path.

### F2/F3 — design dispositions (backlog, not this commit)

- F2 (`fix-environment` executor): candidate design — a routed
  fix-environment verdict at red-no-progress offers a bounded environment
  repair surface (allow-listing the judge-named files for ONE retry, or
  surfacing HITL with the repair commands) instead of a bare restart.
- F3 (oracle command honesty): candidate design — the RED runner diagnostic
  already logs the full command; surface it verbatim in the retry hint so the
  agent self-verifies with the oracle's invocation, not an equivalent.

## Verification

- `tests/hollow-assertion-guard.test.ts` gains: conftest.py under tests/ is
  exempt (RED-first on the pre-fix tree); a hollow test beside an exempt
  conftest is still flagged (RED-first — pre-fix also flagged the conftest,
  so the gap list differs); package-root conftest is exempt via the FIRST
  gate (control — it never reaches the new regex; pinned so a future
  narrowing of either regex trips); deep-nested conftests under tests/ and
  __tests__/ are exempt; a lookalike (`my_conftest_helper.py`, matching the
  `tests?/` directory branch) keeps current semantics.
- Full suite + `npx tsc --noEmit`.

## Review outcome

Dual review (code-reviewer CHANGES REQUESTED, adversarial APPROVED WITH
COMMENTS); both confirmed the mechanical change correct (regex precise, no
false positives on myconftest.py / conftest.py.bak / .pyc; over-exemption
bounded — pytest collects no tests from conftest). Remediated: **both
reviewers' F-1/F-2** — the "package-root any-depth" test was vacuous w.r.t.
the new regex (package-root conftest is first-gate-exempt on both trees) and
the RED-first count was 2 of 4, not 3: reframed as a first-gate control,
added an explicit deep-nesting pin, corrected the Verification wording and
the branch-misattributing test comment. **ADV F-5** — title trimmed to the
shipped scope. Recorded residuals (accepted): case-insensitive `/i` exempts
`Conftest.py`, which pytest neither auto-loads nor collects — inert for the
oracle, so harmless (CODE F-4 / ADV F-3); backslash paths reach neither gate
(pre-existing convention, unchanged — CODE F-5 / ADV F-4). **CODE F-1
(sibling death path)**: `classifyObviousRedPath('python/conftest.py')`
returns ambiguous/allowed=false — a package-root conftest still dies at the
RED BOUNDARY classifier, not the hollow guard; folded into the F2 backlog
design below (the boundary classifier needs the same pytest-reserved-filename
knowledge).
