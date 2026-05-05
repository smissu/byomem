import type { FileSearchDbHandle, FileSearchEmbeddingDiagnostics } from './file-search-db.js';

export interface FileSearchSemanticRefreshAfterScanResult {
  automatic: boolean;
  attempted: boolean;
  reason?: 'not-configured' | 'disabled' | 'already-ready';
  limit?: number;
  diagnostics: FileSearchEmbeddingDiagnostics;
}

export async function refreshSemanticIndexAfterManualScan(
  fileDb: FileSearchDbHandle,
  options: { enabled?: boolean; limit?: number; concurrency?: number } = {},
): Promise<FileSearchSemanticRefreshAfterScanResult> {
  const before = fileDb.getEmbeddingDiagnostics();
  if (options.enabled === false) {
    return { automatic: false, attempted: false, reason: 'not-configured', diagnostics: before };
  }
  if (!before.enabled) {
    return { automatic: true, attempted: false, reason: 'disabled', diagnostics: before };
  }
  if (before.refreshNeededChunks <= 0) {
    return { automatic: true, attempted: false, reason: 'already-ready', diagnostics: before };
  }
  const limit = options.limit ?? before.refreshNeededChunks;
  const diagnostics = await fileDb.refreshSemanticIndex({ limit, concurrency: options.concurrency });
  return { automatic: true, attempted: true, limit, diagnostics };
}
