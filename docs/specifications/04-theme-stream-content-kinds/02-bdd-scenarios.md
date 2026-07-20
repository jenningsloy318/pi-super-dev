# Behavior Scenarios: Stream & Result Per-Kind Theming (pi-native content separation)

- **Date**: 2026-07-20
- **Author**: super-dev:bdd-scenario-writer
- **Source**: /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/.worktree/04-theme-stream-content-kinds/docs/specifications/04-theme-stream-content-kinds/01-requirements.md
- **Total Scenarios**: 18

---
## Feature: Stream Line Classification

### SCENARIO-001: Each content kind is classified to its matching LineKind

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** the full ten-kind content taxonomy is defined for stream lines
**When** classifyLine inspects a representative line for every known prefix and keyword marker
**Then** the correct LineKind is returned for all ten kinds
**And** the command-done marker is recognized before the generic command marker
**And** leading whitespace on stored lines is trimmed before matching
### SCENARIO-002: Structured-output success line is not mistaken for a generic command

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** a line that begins with the structured-output success marker
**When** it is classified
**Then** it is recognized as command-done rather than a plain command
### SCENARIO-003: Indentation on stored lines does not defeat prefix matching

- **Acceptance Criteria**: AC-01
- **Priority**: medium

**Given** lines are stored with a leading two-space indent
**When** classifyLine evaluates them
**Then** the indent is ignored so a prefixed line still matches its intended kind
## Feature: Theme Token Mapping

### SCENARIO-004: Each kind is styled with its designated pi foreground token

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** a theme is available
**When** themeLine styles a line of each kind
**Then** each kind receives its designated pi foreground token
**And** commands render in toolTitle with the command name bolded
**And** thinking renders in thinkingText
**And** phase markers render in accent and bold
**And** errors render in error
**And** corrective notices render in warning
**And** trim notices render in muted
### SCENARIO-005: Absent theme degrades to raw text with no styling

- **Acceptance Criteria**: AC-02
- **Priority**: critical

**Given** no theme is available such as in print, json, RPC, or headless mode
**When** themeLine styles any kind
**Then** the raw text is returned unchanged with zero ANSI escape codes
**And** commandBackground returns no background when no theme is available
### SCENARIO-006: Command lines resolve to the correct tool-bubble background

- **Acceptance Criteria**: AC-02
- **Priority**: high

**Given** a theme is available
**When** commandBackground resolves the background for a kind
**Then** commands resolve to the pending tool background
**And** completed commands resolve to the success tool background
**And** all other kinds resolve to no background
## Feature: Dashboard Theme Shape Extension

### SCENARIO-007: Extended theme shape accepts the real theme without breaking callers

- **Acceptance Criteria**: AC-03
- **Priority**: medium

**Given** the theme shape is extended with optional background and bold members
**When** the real pi Theme is supplied as that shape
**Then** it satisfies the shape structurally without requiring changes to existing importers
**And** existing token-string usage such as success, error, accent, and dim continues to work
## Feature: Live Transcript Kind Tagging

### SCENARIO-008: Every streamed line is stored with its content kind

- **Acceptance Criteria**: AC-04
- **Priority**: high

**Given** the live transcript records every streamed line
**When** phase banners, stage logs, and agent thinking text flow through the sink
**Then** each entry is stored with its correct kind rather than as undifferentiated text
**And** phase banners are tagged as phase
**And** stage log lines are tagged by classification
**And** agent thinking text is tagged as thinking
### SCENARIO-009: Rolling tail retains recent entries and records a trim notice

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** the transcript exceeds the rolling tail limit
**When** older lines are rolled off
**Then** the most recent entries are retained and a trim notice is recorded tagged as the trim kind
## Feature: Mode-Aware Flush Output

### SCENARIO-010: Interactive terminal flush styles each line per kind

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** the live stream is rendered in interactive terminal mode
**When** the stream is flushed
**Then** each line is styled according to its kind
**And** command lines additionally receive a best-effort tool-bubble background
### SCENARIO-011: Non-interactive flush stays byte-clean

- **Acceptance Criteria**: AC-05
- **Priority**: critical

**Given** the live stream is rendered in a non-interactive mode such as print, json, or headless
**When** the stream is flushed
**Then** only raw text is emitted with no styling codes
**And** the saved log file likewise contains only raw text with no kind prefix or codes
## Feature: End-to-End Kind Propagation

### SCENARIO-012: Kinds travel from sink through details to the result panel

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** the final run details are assembled
**When** the transcript tail is carried into the result
**Then** each entry retains its kind so the result panel can render per kind
### SCENARIO-013: Legacy plain-string tail entries are tolerated

- **Acceptance Criteria**: AC-06
- **Priority**: medium

**Given** a legacy plain-string entry appears in the tail
**When** the result panel consumes it
**Then** it is treated as a plain log line rather than breaking rendering
## Feature: Result Detail Per-Kind Rendering

### SCENARIO-014: Result detail log visually separates all content kinds

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** the result detail panel renders the transcript tail
**When** it draws each line
**Then** commands appear as tool bubbles
**And** thinking appears in the thinking color
**And** phase markers appear in accent and bold
**And** errors appear in error red
**And** the stage header rows and the Markdown summary remain byte-identical to before
## Feature: Non-Interactive Byte Cleanliness

### SCENARIO-015: Theme-absent processing leaks no escape codes

- **Acceptance Criteria**: AC-08
- **Priority**: critical

**Given** the sink processes phase, log, and text events without a theme
**When** the output is assembled
**Then** the joined transcript contains zero ANSI escape bytes
**And** the on-disk log contains zero ANSI escape bytes
### SCENARIO-016: Interactive path emits the expected foreground tokens

- **Acceptance Criteria**: AC-08
- **Priority**: medium

**Given** the interactive terminal path runs with a theme
**When** the output is assembled
**Then** it contains the expected foreground tokens for each kind
## Feature: Verification Gates

### SCENARIO-017: New module and result rendering are covered by unit tests

- **Acceptance Criteria**: AC-09
- **Priority**: high

**Given** unit coverage is required for the new pure module and result rendering
**When** the test suite runs
**Then** classifyLine, themeLine, commandBackground, and per-kind result rendering are each exercised
**And** the command-done ordering, leading-whitespace trim, and each error, warning, and success keyword are asserted
### SCENARIO-018: Typecheck and tests pass with no regressions

- **Acceptance Criteria**: AC-10
- **Priority**: high

**Given** the change is a pure TypeScript addition scoped to the specified files
**When** the type checker and test suite run
**Then** both pass clean
**And** the dashboard widget is unchanged
**And** the in-scope build-gate is unchanged
**And** the Markdown summary is unchanged
**And** no new runtime dependencies were introduced
---

## Traceability

- **AC-01**: LineKind covers all 10 kinds; classifyLine matches the full order-sensitive taxonomy and trims leading whitespace. → SCENARIO-001, SCENARIO-002, SCENARIO-003
- **AC-02**: themeLine maps each kind to its exact pi-native token; commandBackground returns the correct bg or undefined; undefined theme yields raw identity. → SCENARIO-004, SCENARIO-005, SCENARIO-006
- **AC-03**: DashboardTheme extended with optional bg/bold members so the real Theme satisfies it without breaking existing callers. → SCENARIO-007
- **AC-04**: Transcript carries kinds; sink.phase/log/text tag correctly; rolling tail + trim notice retained. → SCENARIO-008, SCENARIO-009
- **AC-05**: TUI flush styles per kind with best-effort command bg; non-TUI flush and disk log emit raw text. → SCENARIO-010, SCENARIO-011
- **AC-06**: details.transcriptTail carries kinds end-to-end and tolerates legacy plain strings. → SCENARIO-012, SCENARIO-013
- **AC-07**: buildResultComponent renders per kind with command tool bubbles; stages and Markdown summary unchanged. → SCENARIO-014
- **AC-08**: No ANSI leak in no-theme transcript or disk log; TUI path emits expected fg tokens. → SCENARIO-015, SCENARIO-016
- **AC-09**: Unit tests cover classifyLine, themeLine, commandBackground, and render-per-kind. → SCENARIO-017
- **AC-10**: npm run typecheck and npm test pass with no regression to widget, build-gate, or Markdown summary. → SCENARIO-018

## Coverage Summary

- **Total Acceptance Criteria**: 10
- **Covered by Scenarios**: 10
- **Uncovered**: 0
- **Total Scenarios**: 18
