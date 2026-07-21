# Behavior Scenarios: Per-Stage Log Sections: Tag, Group, and Render Each Pipeline Stage as Its Own Themed Section

- **Date**: 2026-07-21
- **Author**: super-dev:bdd-scenario-writer
- **Source**: /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/docs/specifications/12-per-stage-log-sections/01-requirements.md
- **Total Scenarios**: 24

---
## Feature: Stage Tagging of Transcript Entries

### SCENARIO-001: Pre-stage entries tagged with default setup stage

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a pipeline run that has not yet emitted any stage banner
**When** a transcript entry is recorded before the first banner
**Then** the entry is tagged with the default pre-stage stage identifier and label
### SCENARIO-002: Entries inherit the current stage after each banner

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a run mid-execution where a stage banner has fired
**When** subsequent log, thinking, trim, and user-input entries are recorded
**Then** each entry inherits the current stage's identifier and label until the next banner
### SCENARIO-003: Implementation sub-phases collapse to a single stage

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** implementation sub-phase entries emitted within the implementation stage
**When** those sub-phase entries are recorded
**Then** they collapse to the single implementation stage identifier without finer sub-phase grouping
### SCENARIO-004: Stage identifier resolved from structured event, not label parsing

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** the structured dashboard stage event carries the canonical stage identifier
**When** the stage tag is resolved
**Then** the identifier comes from the structured stage event rather than by parsing the human-readable banner label
## Feature: groupByStage Partitioning

### SCENARIO-005: Groups partitioned in first-appearance order

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** a transcript whose entries span multiple stages in execution order
**When** the transcript is grouped by stage
**Then** groups appear in first-appearance order, each containing only that stage's lines
### SCENARIO-006: All-one-stage transcript yields a single group

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** a transcript whose entries all belong to one stage
**When** the transcript is grouped by stage
**Then** a single group is returned containing all of that stage's lines
### SCENARIO-007: Untagged legacy entries collapse to a fallback group

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** legacy entries missing a stage identifier
**When** the transcript is grouped by stage
**Then** those entries collapse into a single fallback group
### SCENARIO-008: Empty transcript yields an empty partition

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** an empty transcript
**When** the transcript is grouped by stage
**Then** an empty array of groups is returned
### SCENARIO-009: Group status resolved from tracker or left unset

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** a dashboard tracker holding a status for some stages and none for others
**When** each group's status is resolved
**Then** groups whose stage has a tracker status carry that status and the rest are left unset
## Feature: Streaming Per-Stage Sections

### SCENARIO-010: Live flush renders a stack of per-stage sections in TUI

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a live stream in TUI mode with a theme available
**When** the stream is flushed
**Then** a stack of per-stage sections is emitted
**And** each section has a status-themed header
**And** each section's lines are themed per kind and indented
**And** a blank line separates consecutive sections
### SCENARIO-011: Running stage shows recent tail while completed stages render compact

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a running stage with many recent lines alongside completed stages
**When** the live view renders
**Then** the running stage shows only its most recent bounded number of lines
**And** completed stages render compact with at most a small bounded tail or header only
**And** the per-stage line budgets are named constants with a total cap
### SCENARIO-012: Per-stage trim notice preserved within its section

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** a stage's rendered tail was trimmed
**When** that stage's section renders
**Then** a trim notice is preserved within that section rather than globally
### SCENARIO-013: Non-TUI flush emits raw text with zero ANSI bytes

- **Acceptance Criteria**: AC-03
- **Priority**: high

**Given** a live stream in a non-TUI mode or with no theme
**When** the stream is flushed
**Then** raw text is emitted with plain stage headers and indented logs
**And** the output contains zero ANSI bytes preserving the byte-clean contract
## Feature: Result Component Per-Stage Blocks

### SCENARIO-014: Result section one becomes a stack of per-stage blocks

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** the final result details carry stage-tagged transcript lines
**When** the result component is built
**Then** the first section is a stack of per-stage blocks replacing the single merged log
**And** each block has a bold status-themed header
**And** each block's lines are themed per kind
### SCENARIO-015: Each stage block receives a status-colored background

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** a stage with a terminal or running status
**When** its block renders
**Then** it receives a status-colored background via the public text custom background API
**And** the background color corresponds to the stage status without importing internal framework components
### SCENARIO-016: Failed and running stages expand while completed stages render compact

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** a report with completed stages and at least one failed or running stage
**When** the report renders
**Then** the failed and running stages expand while completed stages render compact
**And** the report remains scannable with active and failed work foregrounded
### SCENARIO-017: Legacy transcript tail falls back to a single section

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** legacy transcript tail entries missing stage tags or string-shaped entries
**When** the result component is built
**Then** it falls back to today's single merged section without throwing
### SCENARIO-018: Stage progress and markdown summary sections remain unchanged

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** the stage progress and markdown summary sections already exist
**When** the first section is rebuilt into per-stage blocks
**Then** the stage progress and markdown summary sections remain unchanged
## Feature: End-to-End Threading and Backward Compatibility

### SCENARIO-019: Stage tags carried end-to-end through transcript tail

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** transcript lines are tagged with stage identifier and label at the sink
**When** they flow through the result details transcript tail to the result component
**Then** the stage tags are carried end-to-end
### SCENARIO-020: Additive type still accepts legacy string entries

- **Acceptance Criteria**: AC-05
- **Priority**: medium

**Given** the result details transcript tail type is updated additively
**When** legacy string-shaped entries are present in the tail
**Then** the type still accepts them without breaking existing callers
### SCENARIO-021: Orthogonal gates and surfaces remain undisturbed

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** the change-tracker, deliverable gate, change gate, mid-run input handling, scope-aware gate, and markdown summary
**When** the stage-tagging change is applied
**Then** none of those surfaces are disturbed and they remain green
## Feature: Tests, Theme Safety, and Full Suite Green

### SCENARIO-022: New per-stage tests pass

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** new tests for stage grouping, per-stage section rendering, no-ANSI regression, and real-theme parity
**When** the test suite runs
**Then** all of the new tests are green
### SCENARIO-023: All theme access uses method-style calls

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** all new theme color and background access
**When** theme styling is applied
**Then** it calls method-style theme methods
**And** no theme methods are destructured
**And** the class-theme regression guards and real-theme parity tests remain green
### SCENARIO-024: Typecheck and full test suite pass with no regression

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** the full codebase after the change
**When** the typecheck and the full test suite run
**Then** typecheck is strict-clean and the full test suite is green
**And** the dashboard widget remains unaffected
**And** themed stream kinds and classification remain unaffected
**And** the scope-aware gate, deliverable and change gates, mid-run input handling, and markdown summary remain green
---

## Traceability

- **AC-01**: TranscriptLine gains stageId/stageLabel; sink tracks current stage defaulting to setup/pre-stage, updated on each banner; implementation sub-phases collapse to implementation; stage-id resolved from structured dashboard stage event not label parsing. → SCENARIO-001, SCENARIO-002, SCENARIO-003, SCENARIO-004
- **AC-02**: groupByStage partitions tagged entries preserving first-appearance order; untagged/legacy collapse to one fallback group; empty -> empty array; status resolved from tracker or undefined; unit-tested. → SCENARIO-005, SCENARIO-006, SCENARIO-007, SCENARIO-008, SCENARIO-009
- **AC-03**: Streaming flush() renders a TUI stack of per-stage sections (status-themed headers, per-kind themed indented lines, blank separators, per-stage tail caps, trim notices); running stage expanded, completed compact; non-TUI emits raw text with zero ANSI. → SCENARIO-010, SCENARIO-011, SCENARIO-012, SCENARIO-013
- **AC-04**: buildResultComponent §1 becomes a stack of per-stage blocks (bold status-themed header, per-kind log lines, status-colored background via Text customBgFn); failed/running expanded, completed compact; §2/§3 unchanged; legacy tail falls back to single section. → SCENARIO-014, SCENARIO-015, SCENARIO-016, SCENARIO-017, SCENARIO-018
- **AC-05**: details.transcriptTail carries {kind,text,stageId,stageLabel}[] end-to-end; type updated additively to still accept legacy string entries; change-tracker/deliverable/change/mid-run input/scope-aware gates and Markdown §3 not disturbed. → SCENARIO-019, SCENARIO-020, SCENARIO-021
- **AC-06**: New tests green (groupByStage ordering/untagged/empty/all-one-stage; per-stage section rendering header+customBgFn+tail caps; no-ANSI-in-non-TUI regression for flush and buildResultComponent; real-Theme parity via withRealTheme); class-Theme guards stay green with method-style theme access. → SCENARIO-022, SCENARIO-023
- **AC-07**: npm run typecheck strict-clean; npm test all green (existing + new); no regression to dashboard widget, themed stream LineKinds/classification, scope-aware gate, deliverable/change gates, mid-run input, Markdown §3. → SCENARIO-024

## Coverage Summary

- **Total Acceptance Criteria**: 7
- **Covered by Scenarios**: 7
- **Uncovered**: 0
- **Total Scenarios**: 24
