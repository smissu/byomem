import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDefaultGraphDbPath } from './graph-db.js';
import { resolveDefaultFileSearchDbPath } from './file-search-db.js';
import { resolveProjectContext } from './project-context.js';
import { resolveDefaultRuntimeBaseDir } from './readonly-core.js';
import { readRuntimeProcessInventory } from './runtime-state.js';
import { BYOMEM_RUNTIME_VERSION } from './version.js';

export type StatusArtifactFile = {
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
  mtime: string | null;
  error?: string;
};

export type StatusComponentState = 'ready' | 'degraded' | 'missing';

export type StatusMcpProcesses = {
  source: 'runtime-state';
  count: number;
  roles: string[];
  staleCount: number;
  malformedCount: number;
  warnings: string[];
};

export type StatusReport = {
  version: string;
  runtimeVersion: string;
  generatedAt: string;
  projectBaseDir: string;
  runtimeBaseDir: string;
  projectKey: string;
  paths: {
    memory: {
      json: string;
      sqlite: string;
    };
    fileSearch: {
      sqlite: string;
    };
    graph: {
      sqlite: string;
    };
  };
  artifacts: {
    memory: {
      status: StatusComponentState;
      warnings: string[];
      json: StatusArtifactFile;
      sqlite: StatusArtifactFile;
    };
    fileSearch: {
      status: StatusComponentState;
      warnings: string[];
      sqlite: StatusArtifactFile;
    };
    graph: {
      status: StatusComponentState;
      warnings: string[];
      sqlite: StatusArtifactFile;
    };
  };
  warnings: string[];
  degradedComponents: Array<'memory' | 'fileSearch' | 'graph'>;
  mcpProcesses: StatusMcpProcesses;
};

type BuildStatusReportOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  projectBaseDir?: string;
  runtimeBaseDir?: string;
  generatedAt?: Date | string;
};

function normalizeTimestamp(value?: Date | string): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error('generatedAt must be a valid date');
    return parsed.toISOString();
  }
  return value.toISOString();
}

function statArtifact(path: string): StatusArtifactFile {
  try {
    const stats = statSync(path);
    return {
      path,
      exists: true,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      mtime: stats.mtime.toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as NodeJS.ErrnoException).code ?? '') : '';
    const missing = code === 'ENOENT';
    return {
      path,
      exists: false,
      sizeBytes: null,
      mtimeMs: null,
      mtime: null,
      ...(missing ? {} : { error: message }),
    };
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildComponentState(primaryExists: boolean, secondaryExists: boolean, secondaryRequired = false): StatusComponentState {
  if (primaryExists) return 'ready';
  if (secondaryExists || secondaryRequired) return 'degraded';
  return 'missing';
}

export function buildByomemStatusReport(options: BuildStatusReportOptions = {}): StatusReport {
  const env = options.env ?? process.env;
  const projectContext = resolveProjectContext(env, options.projectBaseDir ?? options.cwd ?? process.cwd());
  const projectBaseDir = resolve(options.projectBaseDir ?? projectContext.repoRoot);
  const runtimeBaseDir = resolve(options.runtimeBaseDir ?? resolveDefaultRuntimeBaseDir(env));
  const generatedAt = normalizeTimestamp(options.generatedAt);

  const memoryPaths = {
    json: resolve(runtimeBaseDir, 'native-store.json'),
    sqlite: resolve(runtimeBaseDir, 'byomem-index.sqlite'),
  };
  const fileSearchPath = resolveDefaultFileSearchDbPath({ dbBaseDir: runtimeBaseDir });
  const graphPath = resolveDefaultGraphDbPath({ dbBaseDir: runtimeBaseDir });

  const memoryArtifacts = {
    json: statArtifact(memoryPaths.json),
    sqlite: statArtifact(memoryPaths.sqlite),
  };
  const fileSearchArtifact = statArtifact(fileSearchPath);
  const graphArtifact = statArtifact(graphPath);

  const memoryWarnings: string[] = [];
  const fileSearchWarnings: string[] = [];
  const graphWarnings: string[] = [];
  const warnings: string[] = [];
  const degradedComponents: Array<'memory' | 'fileSearch' | 'graph'> = [];

  const memoryStatus = buildComponentState(memoryArtifacts.sqlite.exists, memoryArtifacts.json.exists, false);
  if (!memoryArtifacts.sqlite.exists) {
    memoryWarnings.push(`memory SQLite artifact missing: ${memoryArtifacts.sqlite.path}`);
    if (memoryArtifacts.json.exists) {
      memoryWarnings.push(`legacy native-store.json is present without the SQLite memory DB: ${memoryArtifacts.json.path}`);
    }
  }
  if (!memoryArtifacts.sqlite.exists && !memoryArtifacts.json.exists) degradedComponents.push('memory');
  else if (!memoryArtifacts.sqlite.exists && memoryArtifacts.json.exists) degradedComponents.push('memory');

  const fileSearchStatus = buildComponentState(fileSearchArtifact.exists, false, false);
  if (!fileSearchArtifact.exists) {
    fileSearchWarnings.push(`file-search SQLite artifact missing: ${fileSearchArtifact.path}`);
    degradedComponents.push('fileSearch');
  }

  const graphStatus = buildComponentState(graphArtifact.exists, false, false);
  if (!graphArtifact.exists) {
    graphWarnings.push(`graph SQLite artifact missing: ${graphArtifact.path}`);
    degradedComponents.push('graph');
  }

  const processInventory = readRuntimeProcessInventory({ runtimeBaseDir });
  const mcpProcesses: StatusMcpProcesses = {
    source: 'runtime-state',
    count: processInventory.counts.total,
    roles: dedupe(processInventory.records.map((entry) => entry.record.role)).sort(),
    staleCount: processInventory.counts.stale,
    malformedCount: processInventory.counts.malformed,
    warnings: processInventory.warnings,
  };

  warnings.push(...memoryWarnings, ...fileSearchWarnings, ...graphWarnings, ...mcpProcesses.warnings);

  return {
    version: BYOMEM_RUNTIME_VERSION,
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    generatedAt,
    projectBaseDir,
    runtimeBaseDir,
    projectKey: projectContext.projectKey,
    paths: {
      memory: memoryPaths,
      fileSearch: { sqlite: fileSearchPath },
      graph: { sqlite: graphPath },
    },
    artifacts: {
      memory: {
        status: memoryStatus,
        warnings: dedupe(memoryWarnings),
        json: memoryArtifacts.json,
        sqlite: memoryArtifacts.sqlite,
      },
      fileSearch: {
        status: fileSearchStatus,
        warnings: dedupe(fileSearchWarnings),
        sqlite: fileSearchArtifact,
      },
      graph: {
        status: graphStatus,
        warnings: dedupe(graphWarnings),
        sqlite: graphArtifact,
      },
    },
    warnings: dedupe(warnings),
    degradedComponents: dedupe(degradedComponents) as Array<'memory' | 'fileSearch' | 'graph'>,
    mcpProcesses,
  };
}
