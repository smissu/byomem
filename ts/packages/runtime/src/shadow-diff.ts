import type { MemoryRecord } from './contracts.js';

export interface ShadowDiff {
  path: string;
  expected: unknown;
  actual: unknown;
}

function compareText(expected: MemoryRecord, actual: MemoryRecord, diffs: ShadowDiff[]): void {
  if ((expected.content.text ?? null) !== (actual.content.text ?? null)) {
    diffs.push({ path: 'content.text', expected: expected.content.text ?? null, actual: actual.content.text ?? null });
  }
}

function compareStructured(expected: MemoryRecord, actual: MemoryRecord, diffs: ShadowDiff[]): void {
  const expectedStructured = JSON.stringify(expected.content.structured ?? {});
  const actualStructured = JSON.stringify(actual.content.structured ?? {});
  if (expectedStructured !== actualStructured) {
    diffs.push({ path: 'content.structured', expected: expected.content.structured ?? null, actual: actual.content.structured ?? null });
  }
}

export function diffRecords(expected: MemoryRecord, actual: MemoryRecord): ShadowDiff[] {
  const diffs: ShadowDiff[] = [];
  if (expected.id !== actual.id) diffs.push({ path: 'id', expected: expected.id, actual: actual.id });
  if (expected.scope !== actual.scope) diffs.push({ path: 'scope', expected: expected.scope, actual: actual.scope });
  if (expected.identity.stableKey !== actual.identity.stableKey) {
    diffs.push({ path: 'identity.stableKey', expected: expected.identity.stableKey ?? null, actual: actual.identity.stableKey ?? null });
  }
  compareText(expected, actual, diffs);
  compareStructured(expected, actual, diffs);
  return diffs;
}
