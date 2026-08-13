/**
 * Super-dev extension version metadata.
 *
 * Versioning rule:
 * - Every commit that changes the extension MUST increment the patch number.
 * - Patch is bounded to 1..99. After 99, increment minor and reset patch to 1.
 * - Minor is bounded to 1..99. After 99, increment major and reset minor/patch to 1.
 *
 * This is intentionally advanced at the stricter per-extension-commit cadence.
 * package.json/package-lock.json use the same semver value.
 */
export const SUPER_DEV_EXTENSION_VERSION = "0.1.48";
export const SUPER_DEV_EXTENSION_NAME = "super-dev";
export const SUPER_DEV_VERSION_POLICY = "increment patch every commit; patch 1-99 then bump minor/reset patch to 1; minor 1-99 then bump major/reset minor+patch to 1";

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
	return superDevVersionLabel();
}
