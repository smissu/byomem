import type { WriteIntent } from './contracts.js';

export function isShadowFixtureReady(intent: WriteIntent): boolean {
  return Boolean(intent.identity?.stableKey && intent.provenance?.source);
}
