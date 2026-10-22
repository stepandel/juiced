/** package.json version, injected by scripts/build.mjs; unbundled runs use the source default. */
declare const JUICED_VERSION: string | undefined;
export const VERSION = typeof JUICED_VERSION === 'string' ? JUICED_VERSION : '0.2.5';
