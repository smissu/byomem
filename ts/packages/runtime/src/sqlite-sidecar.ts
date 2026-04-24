import {
  openSqliteSidecarInternal,
  type SqliteSidecar,
  type SqliteSidecarOptions,
  type SqliteSidecarReader,
} from './sqlite-sidecar-internal.js';

export type { SqliteSidecar, SqliteSidecarOptions, SqliteSidecarReader } from './sqlite-sidecar-internal.js';
export { EMBEDDING_TEXT_MAX_CHARS } from './embedding-vector.js';

export function openSqliteSidecar(options: SqliteSidecarOptions): SqliteSidecar {
  return openSqliteSidecarInternal(options).sidecar;
}
