import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConnectCodexReport, runConnectCodex } from '../src/codex-connect.js';
import { main } from '../src/cli.js';

type Fixture = {
  root: string;
  configPath: string;
  projectDir: string;
  runtimeEntrypoint: string;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'byomem-connect-codex-'));
  const projectDir = join(root, 'project');
  const runtimeEntrypoint = join(root, 'runtime', 'dist');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(runtimeEntrypoint, { recursive: true });
  return {
    root,
    configPath: join(root, 'config.toml'),
    projectDir,
    runtimeEntrypoint,
  };
}

function args(fx: Fixture, extra: string[] = []): string[] {
  return [
    'connect',
    'codex',
    '--codex-config-path',
    fx.configPath,
    '--project-dir',
    fx.projectDir,
    '--runtime-entrypoint',
    fx.runtimeEntrypoint,
    ...extra,
  ];
}

describe('sprint 85 connect codex', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function makeFixture(): Fixture {
    const fx = fixture();
    roots.push(fx.root);
    return fx;
  }

  it('dry-run reports planned config and guidance changes without writing files', () => {
    const fx = makeFixture();

    const report = buildConnectCodexReport({
      mode: 'dry-run',
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
    });

    expect(report).toMatchObject({ mode: 'dry-run', applied: false, changed: true, refusals: [] });
    expect(report.changes.map((change) => change.path).sort()).toEqual([fx.configPath, join(fx.projectDir, 'AGENTS.md')].sort());
    expect(existsSync(fx.configPath)).toBe(false);
    expect(existsSync(join(fx.projectDir, 'AGENTS.md'))).toBe(false);
  });

  it('apply writes canonical entries, creates backups, and is idempotent', () => {
    const fx = makeFixture();
    writeFileSync(fx.configPath, '# existing config\n', 'utf8');
    writeFileSync(join(fx.projectDir, 'AGENTS.md'), '# Existing guidance\n', { encoding: 'utf8', flag: 'w' });

    const first = runConnectCodex({
      mode: 'apply',
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
      now: new Date('2026-05-28T12:00:00.000Z'),
    });
    const second = runConnectCodex({
      mode: 'apply',
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
      now: new Date('2026-05-28T12:01:00.000Z'),
    });

    const config = readFileSync(fx.configPath, 'utf8');
    expect(first.applied).toBe(true);
    expect(first.backups).toHaveLength(2);
    expect(first.backups.every((path) => existsSync(path))).toBe(true);
    expect(config.match(/\[mcp_servers\.byomem-memory]/g)).toHaveLength(1);
    expect(config).toContain(`args = ["${join(fx.runtimeEntrypoint, 'mcp', 'memory.js')}"]`);
    expect(readFileSync(join(fx.projectDir, 'AGENTS.md'), 'utf8')).toContain('BYOMEM-CODEX-CONNECT:START');
    expect(second).toMatchObject({ applied: false, changed: false, backups: [] });
  });

  it('refuses conflicting and stale byomem MCP entries instead of editing them', () => {
    const fx = makeFixture();
    writeFileSync(fx.configPath, [
      '[mcp_servers.byomem-memory]',
      'command = "node"',
      'args = ["/tmp/stale/memory.js"]',
      '',
      '[mcp_servers.old-byomem]',
      'command = "node"',
      'args = ["/tmp/byomem.js"]',
      '',
    ].join('\n'), 'utf8');

    const report = runConnectCodex({
      mode: 'apply',
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
    });

    expect(report.applied).toBe(false);
    expect(report.refusals.map((refusal) => refusal.reason).sort()).toEqual(['conflicting-mcp-entry', 'stale-mcp-entry']);
    expect(readFileSync(fx.configPath, 'utf8')).toContain('/tmp/stale/memory.js');
  });

  it('recognizes valid TOML MCP headers with whitespace, quoted keys, and inline comments', () => {
    const fx = makeFixture();
    writeFileSync(fx.configPath, [
      '  [mcp_servers.byomem-memory] # canonical with comment',
      'command = "node"',
      `args = ["${join(fx.runtimeEntrypoint, 'mcp', 'memory.js')}"]`,
      '',
      '[mcp_servers."byomem-graph"]',
      'command = "node"',
      `args = ["${join(fx.runtimeEntrypoint, 'mcp', 'graph.js')}"]`,
      '',
      '[mcp_servers.byomem-file-search]',
      'command = "node"',
      `args = ["${join(fx.runtimeEntrypoint, 'mcp', 'file-search.js')}"]`,
      '',
    ].join('\n'), 'utf8');

    const report = runConnectCodex({
      mode: 'apply',
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
    });

    const config = readFileSync(fx.configPath, 'utf8');
    expect(report.refusals).toEqual([]);
    expect(config.match(/mcp_servers\.(?:"byomem-memory"|byomem-memory)/g)).toHaveLength(1);
    expect(config.match(/mcp_servers\.(?:"byomem-graph"|byomem-graph)/g)).toHaveLength(1);
  });

  it('stops MCP section parsing at later TOML tables with inline comments', () => {
    const fx = makeFixture();
    writeFileSync(fx.configPath, [
      '[mcp_servers.unrelated]',
      'command = "node"',
      'args = ["/tmp/unrelated.js"]',
      '',
      '[projects."/Users/example/byomem"] # trusted project table, not MCP',
      'trust_level = "trusted"',
      '',
    ].join('\n'), 'utf8');

    const report = runConnectCodex({
      mode: 'apply',
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
    });

    expect(report.refusals).toEqual([]);
    expect(readFileSync(fx.configPath, 'utf8')).toContain('[projects."/Users/example/byomem"] # trusted project table');
  });

  it('ignores commented TOML sections when checking for existing canonical entries', () => {
    const fx = makeFixture();
    writeFileSync(fx.configPath, [
      '# [mcp_servers.byomem-memory]',
      '# command = "node"',
      `# args = ["${join(fx.runtimeEntrypoint, 'mcp', 'memory.js')}"]`,
      '',
    ].join('\n'), 'utf8');

    const report = runConnectCodex({
      mode: 'apply',
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
    });

    expect(report.refusals).toEqual([]);
    const activeMemorySections = readFileSync(fx.configPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#') && line.includes('[mcp_servers.byomem-memory]'));
    expect(activeMemorySections).toHaveLength(1);
  });

  it('refuses duplicate guidance markers', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.projectDir, 'AGENTS.md'), [
      '<!-- BYOMEM-CODEX-CONNECT:START -->',
      'old',
      '<!-- BYOMEM-CODEX-CONNECT:END -->',
      '<!-- BYOMEM-CODEX-CONNECT:START -->',
      'older',
      '<!-- BYOMEM-CODEX-CONNECT:END -->',
    ].join('\n'), { encoding: 'utf8', flag: 'w' });

    const report = runConnectCodex({
      mode: 'apply',
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
    });

    expect(report.refusals).toEqual([expect.objectContaining({ reason: 'malformed-guidance-block' })]);
    expect(report.applied).toBe(false);
  });

  it('CLI supports dry-run refusal exits and rejects contradictory mode flags', async () => {
    const fx = makeFixture();
    writeFileSync(fx.configPath, [
      '[mcp_servers.byomem-memory]',
      'command = "node"',
      'args = ["/tmp/stale/memory.js"]',
    ].join('\n'), 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(args(fx));
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')).refusals).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    await main(args(fx, ['--apply', '--dry-run']));
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ error: 'connect codex does not support --apply with --dry-run' });
    expect(process.exitCode).toBe(1);
  });

  it('CLI rejects unknown flags', async () => {
    const fx = makeFixture();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(args(fx, ['--surprise']));

    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ error: 'Unknown flag --surprise' });
    expect(process.exitCode).toBe(1);
  });
});
