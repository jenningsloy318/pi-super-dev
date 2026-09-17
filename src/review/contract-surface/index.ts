// v0.4.22: contract-surface.ts split into 7 modules (pure code motion — every
// name below keeps its pre-split resolution path). The layer's doctrine doc
// lives at the head of ./types.ts.
//
// The pre-existing contract-surface ↔ claim-spine runtime cycle is preserved
// and NOT widened: claim-spine imports from the specific parts
// (scanners/inventory/reconcile), and only inventory.ts imports back from
// claim-spine. The barrel is never imported by the parts.
export { mintPinId } from "./types.ts";
export type { IdiomFamily, PinSourceForm, ContractPin, ContractInventory } from "./types.ts";
export { PROTECT_QUALIFIER_RE, scanSourceFile } from "./scanners.ts";
export { extractContractInventory } from "./inventory.ts";
export { CONTRACT_SLICE_MAX_PINS, CONTRACT_SLICE_MAX_LINES, CONTRACT_SLICE_TRUNCATION_MARKER, CONTRACT_INVENTORY_ERROR_BANNER, touchedProtectedFiles, buildContractSlice } from "./slice.ts";
export type { ContractSlice } from "./slice.ts";
export { normalizeAmendmentFamily, contractInventoryReconciliationSection } from "./reconcile.ts";
export type { NormalizedAmendmentFamilyEntry } from "./reconcile.ts";
export { writerContractSlice, EMPTY_CONTRACT_SLICE, stampContractSlice, persistCurrentStateStamp, readStateSliceStamp, readContractSliceStamp, contractSliceView } from "./stamps.ts";
export type { ContractSliceStamp } from "./stamps.ts";
