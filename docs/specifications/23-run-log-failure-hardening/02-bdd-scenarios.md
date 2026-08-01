# BDD Scenarios: Run Log Failure Hardening

## SCENARIO-001 — Late backend-affecting requirement reruns earlier phases

Given implementation phase 1 and 2 have completed green
When a runtime user instruction changes filter semantics to backend-backed multi-select
Then the next implementation convergence pass reruns earlier phases instead of skipping them.

## SCENARIO-002 — Case-insensitive deliverable patterns match

Given a deliverable requires `(?i)permission`
And the file contains `Permission denied`
When deliverable check runs
Then the pattern passes.

## SCENARIO-003 — Pre-merge build runs before cleanup

Given dependencies are installed for build/test
When the pipeline reaches final verification
Then pre-merge build runs before cleanup removes dependency directories.
