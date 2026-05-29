import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type McpRole = 'memory' | 'graph' | 'file-search';

export type ConnectCodexRefusal = {
  path: string;
  reason: 'conflicting-mcp-entry' | 'duplicate-mcp-entry' | 'malformed-guidance-block' | 'stale-mcp-entry';
  detail: string;
};

export type McpSection = {
  name: string;
  start: number;
  end: number;
  lines: string[];
};

export type CodexHookCommands = {
  graph: string;
  memory: string;
  fileSearch: string;
  stop: string;
};

const RUNTIME_ENTRYPOINT_DEFAULT = resolve(process.cwd(), 'ts', 'packages', 'runtime', 'dist');
const GUIDANCE_START = '<!-- BYOMEM-CODEX-CONNECT:START -->';
const GUIDANCE_END = '<!-- BYOMEM-CODEX-CONNECT:END -->';

const MCP_ROLES: Array<{ role: McpRole; section: string; script: string }> = [
  { role: 'memory', section: 'byomem-memory', script: 'memory.js' },
  { role: 'graph', section: 'byomem-graph', script: 'graph.js' },
  { role: 'file-search', section: 'byomem-file-search', script: 'file-search.js' },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePathForComparison(value: string, homeDir: string): string {
  const home = resolve(homeDir);
  const homePattern = new RegExp(escapeRegExp(home), 'g');
  return value.replace(homePattern, '~');
}

export function resolveDefaultCodexConfigPath(): string {
  return resolve(process.env.HOME ?? process.cwd(), '.codex', 'config.toml');
}

export function resolveDefaultRuntimeEntrypoint(): string {
  return RUNTIME_ENTRYPOINT_DEFAULT;
}

function activeLine(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return '';
  return line;
}

export function parseTomlTableName(line: string): string | null {
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

export function parseMcpSections(text: string): McpSection[] {
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

export function desiredScriptPath(runtimeEntrypoint: string, role: McpRole): string {
  const script = MCP_ROLES.find((entry) => entry.role === role)?.script;
  if (!script) throw new Error(`Unknown MCP role ${role}`);
  return join(runtimeEntrypoint, 'mcp', script);
}

export function desiredSection(runtimeEntrypoint: string, role: McpRole): string {
  const entry = MCP_ROLES.find((item) => item.role === role);
  if (!entry) throw new Error(`Unknown MCP role ${role}`);
  return [
    `[mcp_servers.${entry.section}]`,
    'command = "node"',
    `args = ["${desiredScriptPath(runtimeEntrypoint, role).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
  ].join('\n');
}

export function sectionHasCanonicalBody(section: McpSection, runtimeEntrypoint: string, role: McpRole): boolean {
  const expectedPath = desiredScriptPath(runtimeEntrypoint, role);
  const active = section.lines.slice(1).map(activeLine).map((line) => line.trim()).filter(Boolean);
  if (active.length !== 2) return false;
  const commandLine = active.find((line) => /^command\s*=/.test(line));
  const argsLine = active.find((line) => /^args\s*=/.test(line));
  const expectedCommand = /^command\s*=\s*"node"(?:\s*#.*)?$/;
  const expectedArgs = new RegExp(`^args\\s*=\\s*\\["${escapeRegExp(expectedPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"\\](?:\\s*#.*)?$`);
  return Boolean(commandLine && argsLine && expectedCommand.test(commandLine) && expectedArgs.test(argsLine));
}

export function sectionLooksByomem(section: McpSection): boolean {
  const body = section.lines.map(activeLine).join('\n').toLowerCase();
  return section.name.toLowerCase().includes('byomem') || body.includes('byomem');
}

export function mergeMcpConfig(path: string, before: string | null, runtimeEntrypoint: string): { after: string; refusals: ConnectCodexRefusal[] } {
  const text = before ?? '';
  const sections = parseMcpSections(text);
  const refusals: ConnectCodexRefusal[] = [];
  for (const entry of MCP_ROLES) {
    const matching = sections.filter((section) => section.name === entry.section);
    if (matching.length > 1) {
      refusals.push({ path, reason: 'duplicate-mcp-entry', detail: `Multiple [mcp_servers.${entry.section}] tables already exist.` });
      continue;
    }
    if (matching.length === 1 && !sectionHasCanonicalBody(matching[0], runtimeEntrypoint, entry.role)) {
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

export function guidanceBlock(): string {
  return [
    GUIDANCE_START,
    '# BYOMem Codex MCP',
    '- Prefer the global BYOMem runtime MCP servers configured in `~/.codex/config.toml`.',
    '- Run `byomem-runtime doctor` after changing BYOMem runtime configuration.',
    '- Do not add duplicate project-local BYOMem MCP server entries.',
    GUIDANCE_END,
  ].join('\n');
}

export function mergeGuidance(path: string, before: string | null): { after: string; refusals: ConnectCodexRefusal[] } {
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

export function buildCodexHookCommands(runtimeEntrypoint: string, homeDir = homedir()): CodexHookCommands {
  const codexConfig = `~/.codex/config.toml`;
  const memory = `grep -q 'byomem-memory' ${codexConfig} && echo '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"byomem: check project memory first, then user memory for stable preferences, skills, prior discussions, and durable project settings. Use byomem_search for recall and byomem_store only for stable decisions, lessons learned, and settings worth keeping.\"}}' || true`;
  const graph = `grep -q 'byomem-graph' ${codexConfig} && echo '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"byomem graph: use BYOMem graph MCP tools for architecture, communities, cross-file relationships, and shortest paths. Prefer byomem_graph_query, byomem_graph_explain, and byomem_graph_path for structural questions before raw grep. Run byomem_graph_update after code changes when graph context should be refreshed.\"}}' || true`;
  const fileSearch = `grep -q 'byomem-file-search' ${codexConfig} && echo '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"byomem file search: use byomem_file_search for exact file/chunk retrieval, source passages, and semantic code evidence. Use bm25 for exact symbol/string lookup and hybrid or semantic for conceptual code search before falling back to raw grep. For code, architecture, debugging, review, or cross-file investigation tasks, call byomem_file_search with includeGraph: true.\"}}' || true`;
  const stopRuntime = resolve(homeDir, '.byomem', 'runtime');
  const stopEntrypoint = join(runtimeEntrypoint, 'cli.js');
  const stop = `mkdir -p ${stopRuntime} && node ${stopEntrypoint} codex-session-capture >> ${join(stopRuntime, 'codex-stop-hook.log')} 2>&1 || true`;
  return { memory, graph, fileSearch, stop };
}

export function normalizeHookCommand(command: string, homeDir = homedir()): string {
  return normalizePathForComparison(command, homeDir);
}
