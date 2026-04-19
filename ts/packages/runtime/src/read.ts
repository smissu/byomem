import type { RetrievalQuery, RetrievalResult } from './retrieval.js';
import type { NativeStore } from './store.js';
import { retrieveBaseline } from './retrieval.js';

export interface ReadPath {
  retrieve(query: RetrievalQuery): RetrievalResult[];
}

export function openReadPath(store: NativeStore): ReadPath {
  return {
    retrieve(query: RetrievalQuery): RetrievalResult[] {
      return retrieveBaseline(store, query);
    },
  };
}
