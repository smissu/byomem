export type MemoryScope = 'project' | 'dir' | 'user' | 'agent';

/**
 * Transitional/optional scopes are intentionally not treated as canonical Sprint 16 scope values.
 * Keep them out of the native contract surface until later migration phases explicitly require them.
 */
export type TransitionalMemoryScope = 'session' | 'global';

export interface MemoryProvenance {
  source: string;
  timestamp?: string;
  adapter?: string;
  origin?: string;
}

export interface MemoryIdentity {
  namespace: string;
  leafName: string;
  parentContext?: string;
  stableKey?: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  provenance: MemoryProvenance;
  identity: MemoryIdentity;
  content: {
    text?: string;
    structured?: Record<string, unknown>;
  };
  metadata?: {
    createdAt?: string;
    updatedAt?: string;
    sourcePath?: string;
  };
}

export interface WriteIntent {
  identity: MemoryIdentity;
  scope: MemoryScope;
  content: MemoryRecord['content'];
  provenance?: MemoryProvenance;
}

export interface QueueEvent {
  eventId: string;
  sessionId: string;
  recordId: string;
  kind: 'capture' | 'flush' | 'write' | 'replay';
  createdAt: string;
  payload?: Record<string, unknown>;
}
