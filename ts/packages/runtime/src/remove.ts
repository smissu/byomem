import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  buildCodexHookCommands,
  guidanceBlock,
  normalizeHookCommand,
  parseMcpSections,
  resolveDefaultCodexConfigPath,
  sectionHasCanonicalBody,
  sectionLooksByomem,
  type ConnectCodexRefusal,
  type McpRole,
} from './codex-config.js';
import { readRuntimeProcessInventory, type RuntimeProcessInventoryEntry } from './runtime-state.js';

export type RemoveCodexMode = 'dry-run' | 'apply';

export type RemoveCodexOptions = {
  mode: RemoveCodexMode;
  runtimeBaseDir?: string;
  codexConfigPath?: string;
  projectDir?: string;
  runtimeEntrypoint?: string;
  now?: Date;
  beforeFileApply?: () => void;
  beforeRuntimeStateApply?: () => void;
};

export type RemoveCodexAction = {
  kind: 'remove-codex-mcp-section' | 'remove-guidance-block' | 'remove-hook-command' | 'remove-runtime-state-record';
  path: string;
  description: string;
};

export type RemoveCodexPreserved = {
  kind: 'durable-data' | 'runtime-state-record';
  path: string;
  reason: string;
};

export type RemoveCodexRefusal = ConnectCodexRefusal | {
  path: string;
  reason: 'ambiguous-hook-command' | 'malformed-hooks-file' | 'malformed-runtime-state' | 'stale-runtime-state-not-owned' | 'edited-guidance-block' | 'duplicate-mcp-entry' | 'conflicting-mcp-entry' | 'stale-mcp-entry';
  detail: string;
};

export type RemoveCodexReport = {
  command: 'remove codex';
  mode: RemoveCodexMode;
  applied: boolean;
  changed: boolean;
  paths: {
    codexConfig: string;
    projectAgents: string;
    projectHooks: string;
    runtimeBaseDir: string;
  };
  actions: RemoveCodexAction[];
  preserved: RemoveCodexPreserved[];
  refusals: RemoveCodexRefusal[];
  backups: string[];
  suggestedActions: Array<{ label: string; command: string }>;
};

type FilePlan = {
  path: string;
  before: string | null;
  after: string;
  changed: boolean;
  action: RemoveCodexAction;
};

type HookRemoval = {
  eventName: string;
  groupIndex: number;
  hookIndex: number;
  command: string;
  canonicalKind: keyof ReturnType<typeof buildCodexHookCommands>;
};

const REMOVE_BACKUP_SUFFIX = '.byomem-remove-backup-';
const RUNTIME_STATE_STALE_AFTER_MS = 5 * 60 * 1000;
const BYOMEM_RUNTIME_ROLES = new Map<McpRole, { serverName: string; script: string }>([
  ['memory', { serverName: 'byomem-mcp-memory', script: 'memory.js' }],
  ['graph', { serverName: 'byomem-mcp-graph', script: 'graph.js' }],
  ['file-search', { serverName: 'byomem-mcp-file-search', script: 'file-search.js' }],
]);

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function backupPath(path: string, now: Date): string {
  return `${path}${REMOVE_BACKUP_SUFFIX}${timestamp(now)}`;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function compactWhitespace(text: string): string {
  return normalizeNewlines(text).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '') + '\n';
}

function removeLineRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  const lines = normalizeNewlines(text).split('\n');
  const remove = new Set<number>();
  for (const range of ranges) {
    for (let line = range.start; line < range.end; line += 1) remove.add(line);
  }
  const remaining = lines.filter((_, index) => !remove.has(index)).join('\n');
  return compactWhitespace(remaining);
}

function fileAction(path: string, kind: RemoveCodexAction['kind'], description: string): RemoveCodexAction {
  return { kind, path, description };
}

function preserve(path: string, reason: string): RemoveCodexPreserved {
  return { kind: 'durable-data', path, reason };
}

function preserveRuntimeState(path: string, reason: string): RemoveCodexPreserved {
  return { kind: 'runtime-state-record', path, reason };
}

function buildRemovalRefusal(path: string, reason: RemoveCodexRefusal['reason'], detail: string): RemoveCodexRefusal {
  return { path, reason, detail };
}

function sectionRemovalPlan(path: string, before: string | null, runtimeEntrypoint: string): { after: string; refusals: RemoveCodexRefusal[]; changed: boolean; removals: Array<{ start: number; end: number; role: McpRole }>; preserved: RemoveCodexPreserved[] } {
  if (before === null) return { after: '', refusals: [], changed: false, removals: [], preserved: [] };
  const sections = parseMcpSections(before);
  const refusals: RemoveCodexRefusal[] = [];
  const removals: Array<{ start: number; end: number; role: McpRole }> = [];
  for (const entry of [
    { role: 'memory' as const, section: 'byomem-memory' },
    { role: 'graph' as const, section: 'byomem-graph' },
    { role: 'file-search' as const, section: 'byomem-file-search' },
  ]) {
    const matching = sections.filter((section) => section.name === entry.section);
    if (matching.length > 1) {
      refusals.push(buildRemovalRefusal(path, 'duplicate-mcp-entry', `Multiple [mcp_servers.${entry.section}] tables already exist.`));
      continue;
    }
    if (matching.length === 1) {
      if (sectionHasCanonicalBody(matching[0], runtimeEntrypoint, entry.role)) {
        removals.push({ start: matching[0].start, end: matching[0].end, role: entry.role });
      } else {
        refusals.push(buildRemovalRefusal(path, 'conflicting-mcp-entry', `[mcp_servers.${entry.section}] exists but is not an exact canonical Sprint 85 BYOMem entry.`));
      }
    }
  }
  for (const section of sections) {
    if (['byomem-memory', 'byomem-graph', 'byomem-file-search'].includes(section.name)) continue;
    if (sectionLooksByomem(section)) {
      refusals.push(buildRemovalRefusal(path, 'stale-mcp-entry', `[mcp_servers.${section.name}] appears to reference BYOMem but is not a canonical Sprint 85 entry.`));
    }
  }
  if (refusals.length) return { after: before, refusals, changed: false, removals: [], preserved: [] };
  if (!removals.length) return { after: before, refusals: [], changed: false, removals: [], preserved: [] };
  const after = removeLineRanges(before, removals.map((removal) => ({ start: removal.start, end: removal.end })));
  return {
    after,
    refusals: [],
    changed: normalizeNewlines(before) !== after,
    removals,
    preserved: [],
  };
}

function guidanceRemovalPlan(path: string, before: string | null): { after: string; refusals: RemoveCodexRefusal[]; changed: boolean } {
  if (before === null) return { after: '', refusals: [], changed: false };
  const normalized = normalizeNewlines(before);
  const canonical = guidanceBlock();
  const start = normalized.indexOf('<!-- BYOMEM-CODEX-CONNECT:START -->');
  const end = normalized.indexOf('<!-- BYOMEM-CODEX-CONNECT:END -->');
  if (start === -1 && end === -1) return { after: before, refusals: [], changed: false };
  if (start === -1 || end === -1 || normalized.indexOf('<!-- BYOMEM-CODEX-CONNECT:START -->', start + 1) !== -1 || normalized.indexOf('<!-- BYOMEM-CODEX-CONNECT:END -->', end + 1) !== -1 || end < start) {
    return {
      after: before,
      refusals: [buildRemovalRefusal(path, 'malformed-guidance-block', 'BYOMem Codex guidance markers are duplicated, missing, or unbalanced.')],
      changed: false,
    };
  }
  const sliceEnd = end + '<!-- BYOMEM-CODEX-CONNECT:END -->'.length;
  const block = normalized.slice(start, sliceEnd);
  if (block !== canonical) {
    return {
      after: before,
      refusals: [buildRemovalRefusal(path, 'edited-guidance-block', 'Marked BYOMem guidance content does not exactly match the canonical Sprint 85 block.')],
      changed: false,
    };
  }
  const after = compactWhitespace(`${normalized.slice(0, start)}${normalized.slice(sliceEnd)}`);
  return { after, refusals: [], changed: true };
}

function parseHooksJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function normalizeHookValue(command: string, homeDir: string): string {
  return normalizeHookCommand(command, homeDir);
}

function removeHooksPlan(path: string, before: string | null, runtimeEntrypoint: string, homeDir: string): { after: string; refusals: RemoveCodexRefusal[]; changed: boolean; removals: HookRemoval[] } {
  if (before === null) return { after: '', refusals: [], changed: false, removals: [] };
  let parsed: unknown;
  try {
    parsed = parseHooksJson(before);
  } catch (error) {
    return {
      after: before,
      refusals: [buildRemovalRefusal(path, 'malformed-hooks-file', error instanceof Error ? error.message : String(error))],
      changed: false,
      removals: [],
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      after: before,
      refusals: [buildRemovalRefusal(path, 'malformed-hooks-file', 'hooks.json must be a JSON object.')],
      changed: false,
      removals: [],
    };
  }
  const root = parsed as Record<string, unknown>;
  const hooks = root.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return {
      after: before,
      refusals: [buildRemovalRefusal(path, 'malformed-hooks-file', 'hooks.json must contain a top-level hooks object.')],
      changed: false,
      removals: [],
    };
  }
  const commands = buildCodexHookCommands(runtimeEntrypoint, homeDir);
  const normalizedCommands: Array<[HookRemoval['canonicalKind'], string]> = [
    ['memory', normalizeHookValue(commands.memory, homeDir)],
    ['graph', normalizeHookValue(commands.graph, homeDir)],
    ['fileSearch', normalizeHookValue(commands.fileSearch, homeDir)],
    ['stop', normalizeHookValue(commands.stop, homeDir)],
  ];
  const ambiguousPatterns = ['byomem', 'session-capture', 'codex-session-capture', 'byomem-runtime'];
  const removals: HookRemoval[] = [];
  const refusals: RemoveCodexRefusal[] = [];
  const hookGroups = hooks as Record<string, unknown>;
  for (const [eventName, eventValue] of Object.entries(hookGroups)) {
    if (!Array.isArray(eventValue)) {
      return {
        after: before,
        refusals: [buildRemovalRefusal(path, 'malformed-hooks-file', `hooks.${eventName} must be an array.`)],
        changed: false,
        removals: [],
      };
    }
    eventValue.forEach((item, groupIndex) => {
      if (!item || typeof item !== 'object') {
        refusals.push(buildRemovalRefusal(path, 'malformed-hooks-file', `hooks.${eventName}[${groupIndex}] must be an object.`));
        return;
      }
      const group = item as Record<string, unknown>;
      if (!Array.isArray(group.hooks)) {
        refusals.push(buildRemovalRefusal(path, 'malformed-hooks-file', `hooks.${eventName}[${groupIndex}].hooks must be an array.`));
        return;
      }
      group.hooks.forEach((hook, hookIndex) => {
        if (!hook || typeof hook !== 'object') {
          refusals.push(buildRemovalRefusal(path, 'malformed-hooks-file', `hooks.${eventName}[${groupIndex}].hooks[${hookIndex}] must be an object.`));
          return;
        }
        const command = typeof (hook as Record<string, unknown>).command === 'string' ? (hook as Record<string, unknown>).command as string : '';
        const type = typeof (hook as Record<string, unknown>).type === 'string' ? (hook as Record<string, unknown>).type as string : '';
        if (type !== 'command' || !command) return;
        const normalized = normalizeHookValue(command, homeDir);
        const canonicalKind = normalizedCommands.find(([, candidate]) => candidate === normalized)?.[0];
        if (canonicalKind) {
          removals.push({ eventName, groupIndex, hookIndex, command, canonicalKind });
          return;
        }
        if (ambiguousPatterns.some((needle) => command.includes(needle))) {
          refusals.push(buildRemovalRefusal(path, 'ambiguous-hook-command', `hooks.${eventName}[${groupIndex}].hooks[${hookIndex}] looks BYOMem-related but is not a recognized canonical command.`));
        }
      });
    });
  }
  if (refusals.length) return { after: before, refusals, changed: false, removals: [] };
  if (!removals.length) return { after: before, refusals: [], changed: false, removals: [] };
  const nextRoot = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  const nextHooks = nextRoot.hooks as Record<string, unknown>;
  const grouped = new Map<string, Map<number, Set<number>>>();
  for (const removal of removals) {
    if (!grouped.has(removal.eventName)) grouped.set(removal.eventName, new Map());
    const eventGroups = grouped.get(removal.eventName)!;
    if (!eventGroups.has(removal.groupIndex)) eventGroups.set(removal.groupIndex, new Set());
    eventGroups.get(removal.groupIndex)!.add(removal.hookIndex);
  }
  for (const [eventName, groups] of grouped.entries()) {
    const eventValue = nextHooks[eventName];
    if (!Array.isArray(eventValue)) continue;
    const nextEventValue = eventValue.map((item) => ({ ...(item as Record<string, unknown>) }));
    const sortedGroupIndices = [...groups.keys()].sort((a, b) => b - a);
    for (const groupIndex of sortedGroupIndices) {
      const group = nextEventValue[groupIndex];
      if (!group || typeof group !== 'object') continue;
      const groupHooks = Array.isArray(group.hooks) ? [...group.hooks] : [];
      const hookIndices = [...groups.get(groupIndex)!.values()].sort((a, b) => b - a);
      for (const hookIndex of hookIndices) {
        groupHooks.splice(hookIndex, 1);
      }
      if (groupHooks.length) {
        group.hooks = groupHooks;
      } else {
        nextEventValue.splice(groupIndex, 1);
      }
    }
    if (nextEventValue.length) nextHooks[eventName] = nextEventValue;
    else delete nextHooks[eventName];
  }
  const after = `${JSON.stringify(nextRoot, null, 2)}\n`;
  return { after, refusals: [], changed: normalizeNewlines(before) !== after, removals };
}

function collectPreservedArtifacts(paths: Array<{ baseDir: string; relativePath: string; reason: string }>): RemoveCodexPreserved[] {
  return paths
    .map((entry) => ({ path: resolve(entry.baseDir, entry.relativePath), reason: entry.reason }))
    .filter((entry) => existsSync(entry.path))
    .map((entry) => preserve(entry.path, entry.reason));
}

function collectKnownDurableArtifacts(runtimeBaseDir: string, projectDir: string): RemoveCodexPreserved[] {
  const known = [
    { baseDir: runtimeBaseDir, relativePath: 'byomem-index.sqlite', reason: 'Durable BYOMem memory data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'byomem-index.sqlite-wal', reason: 'Durable BYOMem memory data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'byomem-index.sqlite-shm', reason: 'Durable BYOMem memory data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'byomem-file-search.sqlite', reason: 'Durable BYOMem file-search data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'byomem-file-search.sqlite-wal', reason: 'Durable BYOMem file-search data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'byomem-file-search.sqlite-shm', reason: 'Durable BYOMem file-search data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'byomem-graph.sqlite', reason: 'Durable BYOMem graph data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'byomem-graph.sqlite-wal', reason: 'Durable BYOMem graph data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'byomem-graph.sqlite-shm', reason: 'Durable BYOMem graph data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'queue.json', reason: 'Runtime queue state is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'worker.json', reason: 'Runtime worker state is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'queue/session-capture-state.json', reason: 'Runtime session-capture state is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'queue/debug/byomem-turn-end.jsonl', reason: 'Runtime debug artifacts are preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'native-store.json', reason: 'Durable BYOMem memory data is preserved by default.' },
    { baseDir: runtimeBaseDir, relativePath: 'native-store.json.migrated', reason: 'Durable BYOMem memory data is preserved by default.' },
    { baseDir: projectDir, relativePath: 'byomem-index.sqlite', reason: 'Durable BYOMem memory data is preserved by default.' },
    { baseDir: projectDir, relativePath: 'byomem-file-search.sqlite', reason: 'Durable BYOMem file-search data is preserved by default.' },
    { baseDir: projectDir, relativePath: 'native-store.json', reason: 'Durable BYOMem memory data is preserved by default.' },
  ];
  return collectPreservedArtifacts(known);
}

function isOwnedByomemRuntimeEntry(entry: RuntimeProcessInventoryEntry, runtimeEntrypoint: string): boolean {
  const expected = BYOMEM_RUNTIME_ROLES.get(entry.record.role as McpRole);
  const canonicalEntrypoint = expected ? join(runtimeEntrypoint, 'mcp', expected.script) : undefined;
  return Boolean(expected
    && entry.record.serverName === expected.serverName
    && entry.record.entrypoint === `mcp-${entry.record.role}`
    && canonicalEntrypoint !== undefined
    && entry.record.argv.some((arg) => resolve(normalizeNewlines(arg)) === resolve(canonicalEntrypoint)));
}

function runtimeStatePlan(runtimeBaseDir: string, runtimeEntrypoint: string, now: Date): { actions: RemoveCodexAction[]; preserved: RemoveCodexPreserved[]; refusals: RemoveCodexRefusal[]; changed: boolean; stalePaths: string[] } {
  const inventory = readRuntimeProcessInventory({ runtimeBaseDir, now, staleAfterMs: RUNTIME_STATE_STALE_AFTER_MS });
  const actions: RemoveCodexAction[] = [];
  const preserved: RemoveCodexPreserved[] = [];
  const refusals: RemoveCodexRefusal[] = [];
  const stalePaths: string[] = [];
  for (const record of inventory.records) {
    const owned = isOwnedByomemRuntimeEntry(record, runtimeEntrypoint);
    if (record.state === 'active') {
      preserved.push(preserveRuntimeState(record.path, 'Active runtime-state records are preserved by default.'));
      continue;
    }
    if (!owned) {
      refusals.push(buildRemovalRefusal(record.path, 'stale-runtime-state-not-owned', 'Stale runtime-state record does not satisfy the exact BYOMem ownership predicate.'));
      continue;
    }
    stalePaths.push(record.path);
    actions.push(fileAction(record.path, 'remove-runtime-state-record', 'Remove stale BYOMem-owned runtime-state record.'));
  }
  for (const entry of inventory.malformed) {
    refusals.push(buildRemovalRefusal(entry.path, 'malformed-runtime-state', entry.error));
  }
  return { actions, preserved, refusals, changed: actions.length > 0, stalePaths };
}

function applyFilePlan(plan: FilePlan, now: Date, backups: string[]): void {
  if (!plan.changed || plan.before === null) return;
  if (existsSync(plan.path) && statSync(plan.path).isFile()) {
    const backup = backupPath(plan.path, now);
    writeText(backup, plan.before);
    backups.push(backup);
  }
  writeText(plan.path, plan.after);
}

function planFileMutation(path: string, kind: RemoveCodexAction['kind'], description: string, before: string | null, after: string): FilePlan {
  return {
    path,
    before,
    after,
    changed: before !== after,
    action: fileAction(path, kind, description),
  };
}

export function buildRemoveCodexReport(options: RemoveCodexOptions): RemoveCodexReport {
  const runtimeBaseDir = resolve(options.runtimeBaseDir ?? process.cwd());
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const runtimeEntrypoint = resolve(options.runtimeEntrypoint ?? join(projectDir, 'ts', 'packages', 'runtime', 'dist'));
  const codexConfigPath = resolve(options.codexConfigPath ?? resolveDefaultCodexConfigPath());
  const projectAgents = join(projectDir, 'AGENTS.md');
  const projectHooks = join(projectDir, '.codex', 'hooks.json');
  const now = options.now ?? new Date();
  const codexBefore = readText(codexConfigPath);
  const agentsBefore = readText(projectAgents);
  const hooksBefore = readText(projectHooks);
  const configPlan = sectionRemovalPlan(codexConfigPath, codexBefore, runtimeEntrypoint);
  const guidancePlan = guidanceRemovalPlan(projectAgents, agentsBefore);
  const hooksPlan = removeHooksPlan(projectHooks, hooksBefore, runtimeEntrypoint, process.env.HOME ?? process.cwd());
  const runtimePlan = runtimeStatePlan(runtimeBaseDir, runtimeEntrypoint, now);
  const filePlans: FilePlan[] = [];
  if (codexBefore !== null && configPlan.changed) {
    filePlans.push(planFileMutation(codexConfigPath, 'remove-codex-mcp-section', 'Remove canonical Sprint 85 BYOMem MCP sections.', codexBefore, configPlan.after));
  }
  if (agentsBefore !== null && guidancePlan.changed) {
    filePlans.push(planFileMutation(projectAgents, 'remove-guidance-block', 'Remove canonical BYOMem AGENTS guidance block.', agentsBefore, guidancePlan.after));
  }
  if (hooksBefore !== null && hooksPlan.changed) {
    filePlans.push(planFileMutation(projectHooks, 'remove-hook-command', 'Remove exact canonical BYOMem Codex hook commands.', hooksBefore, hooksPlan.after));
  }
  const preserved = [
    ...collectKnownDurableArtifacts(runtimeBaseDir, projectDir),
    ...runtimePlan.preserved,
  ];
  const refusals = [
    ...configPlan.refusals,
    ...guidancePlan.refusals,
    ...hooksPlan.refusals,
    ...runtimePlan.refusals,
  ];
  const actions = refusals.length
    ? []
    : [
        ...filePlans.filter((plan) => plan.changed).map((plan) => plan.action),
        ...runtimePlan.actions,
      ];
  return {
    command: 'remove codex',
    mode: options.mode,
    applied: false,
    changed: refusals.length === 0 && actions.length > 0,
    paths: {
      codexConfig: codexConfigPath,
      projectAgents,
      projectHooks,
      runtimeBaseDir,
    },
    actions,
    preserved,
    refusals,
    backups: [],
    suggestedActions: [{ label: 'Run BYOMem doctor', command: 'byomem-runtime doctor' }],
  };
}

export function runRemoveCodex(options: RemoveCodexOptions): RemoveCodexReport {
  const now = options.now ?? new Date();
  const report = buildRemoveCodexReport(options);
  if (options.mode !== 'apply' || report.refusals.length || !report.changed) return report;

  const runtimeBaseDir = report.paths.runtimeBaseDir;
  const runtimeEntrypoint = resolve(options.runtimeEntrypoint ?? join(resolve(options.projectDir ?? process.cwd()), 'ts', 'packages', 'runtime', 'dist'));
  const homeDir = process.env.HOME ?? process.cwd();
  const filePlans: FilePlan[] = [];
  options.beforeFileApply?.();
  const configBefore = readText(report.paths.codexConfig);
  const configPlan = sectionRemovalPlan(report.paths.codexConfig, configBefore, runtimeEntrypoint);
  if (configPlan.changed) filePlans.push(planFileMutation(report.paths.codexConfig, 'remove-codex-mcp-section', 'Remove canonical Sprint 85 BYOMem MCP sections.', configBefore, configPlan.after));
  const agentsBefore = readText(report.paths.projectAgents);
  const guidancePlan = guidanceRemovalPlan(report.paths.projectAgents, agentsBefore);
  if (guidancePlan.changed) filePlans.push(planFileMutation(report.paths.projectAgents, 'remove-guidance-block', 'Remove canonical BYOMem AGENTS guidance block.', agentsBefore, guidancePlan.after));
  const hooksBefore = readText(report.paths.projectHooks);
  const hooksPlan = removeHooksPlan(report.paths.projectHooks, hooksBefore, runtimeEntrypoint, homeDir);
  if (hooksPlan.changed) filePlans.push(planFileMutation(report.paths.projectHooks, 'remove-hook-command', 'Remove exact canonical BYOMem Codex hook commands.', hooksBefore, hooksPlan.after));
  const secondPassRefusals = [
    ...configPlan.refusals,
    ...guidancePlan.refusals,
    ...hooksPlan.refusals,
  ];
  if (secondPassRefusals.length) {
    return {
      ...report,
      applied: false,
      changed: false,
      actions: [],
      refusals: secondPassRefusals,
      backups: [],
    };
  }

  const backups: string[] = [];
  for (const plan of filePlans) applyFilePlan(plan, now, backups);

  const initialStale = runtimeStatePlan(runtimeBaseDir, runtimeEntrypoint, now);
  const stalePaths = new Set(initialStale.stalePaths);
  const removedRuntimeStateActions: RemoveCodexAction[] = [];
  options.beforeRuntimeStateApply?.();
  for (const path of stalePaths) {
    const secondPass = readRuntimeProcessInventory({ runtimeBaseDir, now, staleAfterMs: RUNTIME_STATE_STALE_AFTER_MS });
    const entry = secondPass.records.find((candidate) => candidate.path === path);
    if (!entry || entry.state !== 'stale' || !isOwnedByomemRuntimeEntry(entry, runtimeEntrypoint)) continue;
    try {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        removedRuntimeStateActions.push(fileAction(path, 'remove-runtime-state-record', 'Remove stale BYOMem-owned runtime-state record.'));
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
    }
  }
  const appliedActions = [
    ...filePlans.filter((plan) => plan.changed).map((plan) => plan.action),
    ...removedRuntimeStateActions,
  ];

  return {
    ...report,
    applied: appliedActions.length > 0,
    changed: appliedActions.length > 0,
    actions: appliedActions,
    backups,
  };
}
