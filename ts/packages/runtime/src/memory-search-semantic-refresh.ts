import type { NativeStore } from './store.js';
import type { MemoryEmbeddingDiagnostics, MemorySemanticRefreshResult } from './sqlite-sidecar-internal.js';

export interface MemorySemanticRefreshAfterWriteResult {
  automatic: boolean;
  attempted: boolean;
  reason?: 'not-configured' | 'already-ready';
  limit?: number;
  diagnostics?: MemoryEmbeddingDiagnostics;
  result?: MemorySemanticRefreshResult;
}

export async function refreshMemorySemanticIndex(
  store: Pick<NativeStore, 'sidecar'>,
  options: { enabled?: boolean; limit?: number; concurrency?: number } = {},
): Promise<MemorySemanticRefreshAfterWriteResult> {
  const sidecar = store.sidecar;
  if (!sidecar || options.enabled === false) return { automatic: false, attempted: false, reason: 'not-configured' };
  const before = sidecar.getEmbeddingDiagnostics();
  if (!before.refreshNeeded) return { automatic: true, attempted: false, reason: 'already-ready', diagnostics: before };
  const result = await sidecar.refreshSemanticIndex({ limit: options.limit, concurrency: options.concurrency });
  return {
    automatic: true,
    attempted: true,
    limit: options.limit ?? before.missingRecords + before.incompatibleRecords + before.staleRecords + before.failedRecords,
    diagnostics: result.diagnostics,
    result,
  };
}
