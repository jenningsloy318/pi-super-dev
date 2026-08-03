/**
 * Super-dev extension version metadata.
 *
 * Versioning rule:
 * - Every commit that changes the extension MUST increment the patch number.
 * - Patch is bounded to 0..99. After 99, increment minor and reset patch to 0.
 * - Minor is bounded to 0..99. After 99, increment major and reset minor/patch.
 *
 * This is intentionally separate from package.json's package version so the
 * runtime-visible extension version can advance at the stricter per-commit
 * cadence without implying an npm/package release.
 */
export const SUPER_DEV_EXTENSION_VERSION = "0.1.0";
export const SUPER_DEV_EXTENSION_NAME = "super-dev";
export const SUPER_DEV_VERSION_POLICY = "increment patch every commit; patch 0-99 then bump minor/reset patch; minor 0-99 then bump major/reset minor+patch";

export interface SuperDevVersionMetadata {
	name: typeof SUPER_DEV_EXTENSION_NAME;
	version: typeof SUPER_DEV_EXTENSION_VERSION;
	policy: typeof SUPER_DEV_VERSION_POLICY;
}

export const SUPER_DEV_VERSION_METADATA: SuperDevVersionMetadata = {
	name: SUPER_DEV_EXTENSION_NAME,
	version: SUPER_DEV_EXTENSION_VERSION,
	policy: SUPER_DEV_VERSION_POLICY,
};

export function superDevVersionLabel(): string {
	return `${SUPER_DEV_EXTENSION_NAME} v${SUPER_DEV_EXTENSION_VERSION}`;
}

export function superDevRunMetadataLine(): string {
	return `${superDevVersionLabel()} · version policy: ${SUPER_DEV_VERSION_POLICY}`;
}
