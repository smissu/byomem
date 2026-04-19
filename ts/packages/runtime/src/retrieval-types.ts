import type { MemoryScope } from './contracts.js';

export type RetrievalReason = 'identity' | 'scope-filtered' | 'baseline';

export interface RetrievalShape {
  scope?: MemoryScope;
  id?: string;
  leafName?: string;
  namespace?: string;
  parentContext?: string;
}
