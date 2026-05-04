import { describe, expect, it } from 'vitest';
import { buildByomemRuntimeStatus, safeJson, shapeByomemSearchResult } from '../src/readonly-core.js';

const activeProject = {
  cwd: '/Users/ericsmith/Documents/byomem',
  repoRoot: '/Users/ericsmith/Documents/byomem',
  projectKey: 'byomem',
  activeProjectMetadata: {
    source: 'git' as const,
    path: '/Users/ericsmith/Documents/byomem',
    leafName: 'byomem',
    normalizedLeafName: 'byomem',
  },
};

describe('Sprint 45 read-only core', () => {
  it('builds the runtime status payload without adapter-specific logic', () => {
    const status = buildByomemRuntimeStatus({
      runtimeMode: 'ts-native',
      noPythonDefaultPath: true,
      runtimeBaseDir: '/tmp/byomem-runtime',
      nativeStoreBaseDir: '/tmp/byomem-runtime',
      activeProject,
      embeddingConfig: { source: 'default' },
      sessionCaptureConfig: { source: 'default', enabled: true },
      summarizerConfig: { source: 'default' },
      fileSearchConfig: { source: 'default', embeddingBatchSize: 31, embeddingConcurrency: 7 },
    });

    expect(status).toMatchObject({
      runtimeMode: 'ts-native',
      pythonDefaultDisabled: true,
      noPythonDefaultPath: true,
      packageSurface: 'ts/packages/runtime',
      storeBaseDir: '/tmp/byomem-runtime',
      nativeStorePath: '/tmp/byomem-runtime',
      projectKey: 'byomem',
      activeProject,
      fileSearchEmbeddingBatchSize: 31,
      fileSearchEmbeddingConcurrency: 7,
    });
  });

  it('shapes search results into the minimal read-only DTO', () => {
    const shaped = shapeByomemSearchResult({
      id: 'rec-1',
      scope: 'project',
      identity: {
        namespace: 'notes',
        leafName: 'sprint-45',
        parentContext: 'root',
      },
      content: {
        text: 'Read-only search target',
        structured: {
          kind: 'memo',
          ignored: 'field',
        },
      },
      provenance: {
        source: 'fixture',
      },
    });

    expect(shaped).toEqual({
      id: 'rec-1',
      scope: 'project',
      identity: {
        namespace: 'notes',
        leafName: 'sprint-45',
        parentContext: 'root',
      },
      text: 'Read-only search target',
      structured: { kind: 'memo' },
      provenance: { source: 'fixture' },
    });
    expect(safeJson({ encryptedContent: 'secret', ok: true })).not.toContain('secret');
    expect(safeJson({ encryptedContent: 'secret', ok: true })).toContain('ok');
  });
});
