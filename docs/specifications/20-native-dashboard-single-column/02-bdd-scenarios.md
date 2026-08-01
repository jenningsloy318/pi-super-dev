# BDD Scenarios: Native Single-Column Super-Dev Dashboard

## SCENARIO-001 — Stages are not packed into columns

Given six dashboard stages
When the dashboard is rendered
Then there are six stage rows
And no stage row contains two stage labels.

## SCENARIO-002 — Running and completed stages are separated

Given one running stage and multiple completed stages
When the dashboard is rendered
Then it contains a `running` section
And it contains a `completed` section
And the rows are under their matching section.

## SCENARIO-003 — Failed stages are visually isolated

Given a failed stage exists
When the dashboard is rendered
Then it appears under a `needs attention` section
And keeps the error status glyph/color.

## SCENARIO-004 — Recent commands and logs are distinct

Given recent log lines include tool/command lines and ordinary progress lines
When the dashboard is rendered
Then command-like lines use a command/progress prefix and accent styling
And ordinary log lines use a separate muted progress prefix.

## SCENARIO-005 — Header remains stable

Given elapsed time and stop hint are supplied
When the dashboard is rendered
Then the header still includes done/total, elapsed time, current running stage, and stop hint.
