# Specification: Runtime Instruction Replanning

## Fingerprint

Add:

```ts
runtimeInstructionFingerprint(specDir: string | undefined): string
```

It hashes `userNotesForAgent(specDir)` and includes the note text length.

## Implementation stage control fields

`implementationStage` returns two new control fields:

```ts
runtimeInstructionFingerprint: string
invalidatedByRuntimeInstructions: boolean
```

## Start-of-stage behavior

At Stage 9 start:

1. Compute `startInstructionFingerprint`.
2. Read `priorImpl.runtimeInstructionFingerprint` and `priorImpl.invalidatedByRuntimeInstructions`.
3. If prior invalidated or prior fingerprint differs from current fingerprint:
   - clear `phaseStatus`,
   - clear `lastFailures`,
   - log that runtime instructions changed and phases will rerun.

## End-of-stage behavior

Before returning control:

1. Compute `endInstructionFingerprint`.
2. If `end !== start` and at least one phase ran/completed:
   - set `allGreen=false`,
   - set `invalidatedByRuntimeInstructions=true`,
   - summary explains that a rerun is required.

## Next pass behavior

On the next pass, the invalidation flag clears carried green phases. If no new instruction arrives, the control can return `allGreen=true` and `invalidatedByRuntimeInstructions=false`.
