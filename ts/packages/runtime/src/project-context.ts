import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { normalizeLeafName } from './identity.js';

export interface ProjectContext {
  cwd: string;
  repoRoot: string;
  projectKey: string;
  activeProjectMetadata: {
    source: 'env' | 'git' | 'cwd';
    path: string;
    leafName: string;
    normalizedLeafName: string;
  };
}

function resolveGitRoot(startDir: string): string | undefined {
  let currentDir = resolve(startDir);
  while (true) {
    if (existsSync(resolve(currentDir, '.git'))) return currentDir;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return undefined;
    currentDir = parentDir;
  }
}

function normalizeProjectLeafName(value: string): string {
  return normalizeLeafName(value).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project';
}

export function resolveProjectContext(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ProjectContext {
  const envOverride = env.BYOMEM_PROJECT_KEY?.trim();
  const gitRoot = resolveGitRoot(cwd);
  const repoRoot = gitRoot || resolve(cwd);
  const projectLeafName = envOverride
    ? envOverride
    : normalizeProjectLeafName(repoRoot === resolve(cwd) ? cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project' : repoRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project');
  const normalizedLeafName = normalizeProjectLeafName(projectLeafName);
  const projectKey = envOverride ? normalizeProjectLeafName(envOverride) : normalizedLeafName;
  const source: ProjectContext['activeProjectMetadata']['source'] = envOverride ? 'env' : gitRoot ? 'git' : 'cwd';
  return {
    cwd: resolve(cwd),
    repoRoot,
    projectKey,
    activeProjectMetadata: {
      source,
      path: repoRoot,
      leafName: projectLeafName,
      normalizedLeafName,
    },
  };
}
