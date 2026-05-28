import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type ConnectCodexMode = 'dry-run' | 'apply';

export type ConnectCodexOptions = {
  mode: ConnectCodexMode;
  codexConfigPath?: string;
  projectDir?: string;
  runtimeEntrypoint?: string;
  now?: Date;
};

export type ConnectCodexChange = {
  path: string;
  kind: 'create' | 'update';
  description: string;
};

export type ConnectCodexRefusal = {
  path: string;
  reason: 'conflicting-mcp-entry' | 'duplicate-mcp-entry' | 'malformed-guidance-block' | 'stale-mcp-entry';
  detail: string;
};

export type ConnectCodexReport = {
  command: 'connect codex';
  mode: ConnectCodexMode;
  applied: boolean;
  changed: boolean;
  paths: {
    codexConfig: string;
    projectAgents: string;
    runtimeEntrypoint: string;
  };
  changes: ConnectCodexChange[];
  refusals: ConnectCodexRefusal[];
  backups: string[];
  suggestedActions: Array<{ label: string; command: string }>;
};

type TextPlan = {
  path: string;
  before: string | null;
  after: string;
  changed: boolean;
  change: ConnectCodexChange;
};

type McpRole = 'memory' | 'graph' | 'file-search';

type McpSection = {
  name: string;
  start: number;
  end: number;
  lines: string[];
};

const CODEX_CONFIG_DEFAULT = resolve(process.env.HOME ?? process.cwd(), '.codex', 'config.toml');
const RUNTIME_ENTRYPOINT_DEFAULT = resolve(process.cwd(), 'ts', 'packages', 'runtime', 'dist');
const GUIDANCE_START = '<!-- BYOMEM-CODEX-CONNECT:START -->';
const GUIDANCE_END = '<!-- BYOMEM-CODEX-CONNECT:END -->';

const MCP_ROLES: Array<{ role: McpRole; section: string; script: string }> = [
  { role: 'memory', section: 'byomem-memory', script: 'memory.js' },
  { role: 'graph', section: 'byomem-graph', script: 'graph.js' },
  { role: 'file-search', section: 'byomem-file-search', script: 'file-search.js' },
];

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function backupPath(path: string, now: Date): string {
  return `${path}.byomem-connect-backup-${timestamp(now)}`;
}

function activeLine(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return '';
  return line;
}

function parseTomlTableName(line: string): string | null {
  const match = /^\s*\[([^\]]+)](?:\s*(?:#.*)?)$/.exec(line);
  if (!match) return null;
  return match[1]
    .split('.')
    .map((part) => {
      const trimmed = part.trim();
      const quoted = /^"((?:\\"|[^"])*)"$/.exec(trimmed);
      return quoted ? quoted[1].replace(/\\"/g, '"') : trimmed;
    })
    .join('.');
}

function parseMcpSections(text: string): McpSection[] {
  const lines = text.split(/\r?\n/);
  const sections: McpSection[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const tableName = parseTomlTableName(lines[index]);
    if (!tableName?.startsWith('mcp_servers.')) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (parseTomlTableName(lines[next]) !== null) {
        end = next;
        break;
      }
    }
    sections.push({
      name: tableName.slice('mcp_servers.'.length),
      start: index,
      end,
      lines: lines.slice(index, end),
    });
    index = end - 1;
  }
  return sections;
}

function desiredScriptPath(runtimeEntrypoint: string, role: McpRole): string {
  const script = MCP_ROLES.find((entry) => entry.role === role)?.script;
  if (!script) throw new Error(`Unknown MCP role ${role}`);
  return join(runtimeEntrypoint, 'mcp', script);
}

function desiredSection(runtimeEntrypoint: string, role: McpRole): string {
  const entry = MCP_ROLES.find((item) => item.role === role);
  if (!entry) throw new Error(`Unknown MCP role ${role}`);
  return [
    `[mcp_servers.${entry.section}]`,
    'command = "node"',
    `args = ["${desiredScriptPath(runtimeEntrypoint, role).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
  ].join('\n');
}

function sectionMatchesDesired(section: McpSection, runtimeEntrypoint: string, role: McpRole): boolean {
  const body = section.lines.map(activeLine).join('\n');
  return /(?:^|\n)\s*command\s*=\s*"node"\s*(?:\n|$)/.test(body)
    && body.includes(`"${desiredScriptPath(runtimeEntrypoint, role).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
}

function sectionLooksByomem(section: McpSection): boolean {
  const body = section.lines.map(activeLine).join('\n').toLowerCase();
  return section.name.toLowerCase().includes('byomem') || body.includes('byomem');
}

function mergeMcpConfig(path: string, before: string | null, runtimeEntrypoint: string): { after: string; refusals: ConnectCodexRefusal[] } {
  const text = before ?? '';
  const sections = parseMcpSections(text);
  const refusals: ConnectCodexRefusal[] = [];
  for (const entry of MCP_ROLES) {
    const matching = sections.filter((section) => section.name === entry.section);
    if (matching.length > 1) {
      refusals.push({ path, reason: 'duplicate-mcp-entry', detail: `Multiple [mcp_servers.${entry.section}] tables already exist.` });
      continue;
    }
    if (matching.length === 1 && !sectionMatchesDesired(matching[0], runtimeEntrypoint, entry.role)) {
      refusals.push({ path, reason: 'conflicting-mcp-entry', detail: `[mcp_servers.${entry.section}] exists but does not match the canonical BYOMem runtime command.` });
    }
  }
  for (const section of sections) {
    if (MCP_ROLES.some((entry) => entry.section === section.name)) continue;
    if (sectionLooksByomem(section)) {
      refusals.push({ path, reason: 'stale-mcp-entry', detail: `[mcp_servers.${section.name}] appears to reference BYOMem but is not a canonical Sprint 85 entry.` });
    }
  }
  if (refusals.length) return { after: text, refusals };

  const existingNames = new Set(sections.map((section) => section.name));
  const missing = MCP_ROLES.filter((entry) => !existingNames.has(entry.section)).map((entry) => desiredSection(runtimeEntrypoint, entry.role));
  let after = text.replace(/\s+$/, '');
  if (missing.length) after = [after, ...missing].filter(Boolean).join('\n\n');
  return { after: after ? `${after}\n` : `${missing.join('\n\n')}\n`, refusals };
}

function guidanceBlock(): string {
  return [
    GUIDANCE_START,
    '# BYOMem Codex MCP',
    '- Prefer the global BYOMem runtime MCP servers configured in `~/.codex/config.toml`.',
    '- Run `byomem-runtime doctor` after changing BYOMem runtime configuration.',
    '- Do not add duplicate project-local BYOMem MCP server entries.',
    GUIDANCE_END,
  ].join('\n');
}

function mergeGuidance(path: string, before: string | null): { after: string; refusals: ConnectCodexRefusal[] } {
  const text = before ?? '';
  const starts = [...text.matchAll(new RegExp(GUIDANCE_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  const ends = [...text.matchAll(new RegExp(GUIDANCE_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length) {
    return {
      after: text,
      refusals: [{ path, reason: 'malformed-guidance-block', detail: 'BYOMem Codex guidance markers are duplicated or unbalanced.' }],
    };
  }
  const block = guidanceBlock();
  if (starts.length === 1) {
    const start = starts[0].index ?? 0;
    const end = (ends[0].index ?? text.length) + GUIDANCE_END.length;
    return { after: `${text.slice(0, start)}${block}${text.slice(end)}`, refusals: [] };
  }
  const after = `${text.replace(/\s+$/, '')}${text.trim() ? '\n\n' : ''}${block}\n`;
  return { after, refusals: [] };
}

function planText(path: string, before: string | null, after: string, description: string): TextPlan {
  return {
    path,
    before,
    after,
    changed: before !== after,
    change: { path, kind: before === null ? 'create' : 'update', description },
  };
}

export function buildConnectCodexReport(options: ConnectCodexOptions): ConnectCodexReport {
  const codexConfigPath = resolve(options.codexConfigPath ?? CODEX_CONFIG_DEFAULT);
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const projectAgents = join(projectDir, 'AGENTS.md');
  const runtimeEntrypoint = resolve(options.runtimeEntrypoint ?? RUNTIME_ENTRYPOINT_DEFAULT);
  const codexBefore = readText(codexConfigPath);
  const agentsBefore = readText(projectAgents);
  const codexMerge = mergeMcpConfig(codexConfigPath, codexBefore, runtimeEntrypoint);
  const guidanceMerge = mergeGuidance(projectAgents, agentsBefore);
  const refusals = [...codexMerge.refusals, ...guidanceMerge.refusals];
  const plans = [
    planText(codexConfigPath, codexBefore, codexMerge.after, 'Install canonical BYOMem MCP server entries for Codex.'),
    planText(projectAgents, agentsBefore, guidanceMerge.after, 'Install BYOMem Codex project guidance marker block.'),
  ];
  const changedPlans = refusals.length ? [] : plans.filter((plan) => plan.changed);
  return {
    command: 'connect codex',
    mode: options.mode,
    applied: false,
    changed: changedPlans.length > 0,
    paths: { codexConfig: codexConfigPath, projectAgents, runtimeEntrypoint },
    changes: changedPlans.map((plan) => plan.change),
    refusals,
    backups: [],
    suggestedActions: [{ label: 'Run BYOMem doctor', command: 'byomem-runtime doctor' }],
  };
}

export function runConnectCodex(options: ConnectCodexOptions): ConnectCodexReport {
  const now = options.now ?? new Date();
  const report = buildConnectCodexReport(options);
  if (options.mode !== 'apply' || report.refusals.length || !report.changed) return report;

  const plans: TextPlan[] = [];
  const codexBefore = readText(report.paths.codexConfig);
  const agentsBefore = readText(report.paths.projectAgents);
  plans.push(planText(report.paths.codexConfig, codexBefore, mergeMcpConfig(report.paths.codexConfig, codexBefore, report.paths.runtimeEntrypoint).after, 'Install canonical BYOMem MCP server entries for Codex.'));
  plans.push(planText(report.paths.projectAgents, agentsBefore, mergeGuidance(report.paths.projectAgents, agentsBefore).after, 'Install BYOMem Codex project guidance marker block.'));

  const changedPlans = plans.filter((plan) => plan.changed);
  for (const plan of changedPlans) {
    if (plan.before !== null && statSync(plan.path).isFile()) {
      const backup = backupPath(plan.path, now);
      writeFileSync(backup, plan.before, 'utf8');
      report.backups.push(backup);
    }
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, plan.after, 'utf8');
  }
  report.applied = changedPlans.length > 0;
  report.changed = changedPlans.length > 0;
  report.changes = changedPlans.map((plan) => plan.change);
  return report;
}
