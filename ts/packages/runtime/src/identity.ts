import type { MemoryIdentity, MemoryScope } from './contracts.js';
import { resolveProjectContext, type ProjectContext } from './project-context.js';

const canonicalScopeOrder: MemoryScope[] = ['project', 'dir', 'user', 'agent'];

export function normalizeScope(scope: MemoryScope): MemoryScope {
  if (!canonicalScopeOrder.includes(scope)) {
    throw new Error(`Unsupported canonical scope: ${scope}`);
  }
  return scope;
}

export function normalizeLeafName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function normalizeStableKey(scope: MemoryScope, identity: MemoryIdentity): string {
  const normalizedScope = normalizeScope(scope);
  const namespace = identity.namespace.trim().toLowerCase();
  const leafName = normalizeLeafName(identity.leafName);
  const parentContext = identity.parentContext?.trim().toLowerCase() || 'root';
  return [normalizedScope, namespace, parentContext, leafName].join(':');
}

export function normalizeIdentity(scope: MemoryScope, identity: MemoryIdentity): MemoryIdentity {
  return {
    namespace: identity.namespace.trim().toLowerCase(),
    leafName: normalizeLeafName(identity.leafName),
    parentContext: identity.parentContext?.trim().toLowerCase() || undefined,
    stableKey: normalizeStableKey(scope, identity),
  };
}

export function resolveActiveProjectContext(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ProjectContext {
  return resolveProjectContext(env, cwd);
}
