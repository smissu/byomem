import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexHookCommands, desiredSection, guidanceBlock } from '../src/codex-config.js';
import { buildRemoveCodexReport, runRemoveCodex } from '../src/remove.js';
import { registerRuntimeProcess } from '../src/runtime-state.js';

type Fixture = {
  root: string;
  configPath: string;
  projectDir: string;
  runtimeBaseDir: string;
  runtimeEntrypoint: string;
  hooksPath: string;
  agentsPath: string;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'byomem-remove-codex-'));
  const projectDir = join(root, 'project');
  const runtimeBaseDir = join(root, 'runtime');
  const runtimeEntrypoint = join(root, 'runtime', 'dist');
  mkdirSync(join(projectDir, '.codex'), { recursive: true });
  mkdirSync(join(runtimeBaseDir, 'runtime-state', 'processes'), { recursive: true });
  mkdirSync(join(runtimeEntrypoint, 'mcp'), { recursive: true });
  return {
    root,
    configPath: join(root, 'config.toml'),
    projectDir,
    runtimeBaseDir,
    runtimeEntrypoint,
    hooksPath: join(projectDir, '.codex', 'hooks.json'),
    agentsPath: join(projectDir, 'AGENTS.md'),
  };
}

function writeCanonicalConfig(fx: Fixture): void {
  writeFileSync(fx.configPath, [
    desiredSection(fx.runtimeEntrypoint, 'memory'),
    '',
    desiredSection(fx.runtimeEntrypoint, 'graph'),
    '',
    desiredSection(fx.runtimeEntrypoint, 'file-search'),
    '',
    '[mcp_servers.unrelated]',
    'command = "node"',
    'args = ["/tmp/unrelated.js"]',
    '',
  ].join('\n'), 'utf8');
}

function writeCanonicalAgents(fx: Fixture): void {
  writeFileSync(fx.agentsPath, [
    '# Project guidance',
    '',
    guidanceBlock(),
    '',
    'Unrelated guidance stays.',
    '',
  ].join('\n'), 'utf8');
}

function writeCanonicalHooks(fx: Fixture): void {
  const commands = buildCodexHookCommands(fx.runtimeEntrypoint, process.env.HOME ?? process.cwd());
  writeFileSync(fx.hooksPath, `${JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: commands.stop }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: commands.graph }] },
        { hooks: [{ type: 'command', command: commands.memory }] },
        { hooks: [{ type: 'command', command: commands.fileSearch }] },
      ],
      PermissionRequest: [
        { hooks: [{ type: 'command', command: 'echo unrelated' }] },
      ],
    },
  }, null, 2)}\n`, 'utf8');
}

function writeRuntimeStateFixtures(fx: Fixture, options: { malformed?: boolean } = {}): { activePath: string; stalePath: string; malformedPath?: string } {
  const active = registerRuntimeProcess({
    runtimeBaseDir: fx.runtimeBaseDir,
    role: 'memory',
    serverName: 'byomem-mcp-memory',
    entrypoint: 'mcp-memory',
    argv: ['node', join(fx.runtimeEntrypoint, 'mcp', 'memory.js')],
    cwd: fx.projectDir,
    now: '2026-05-29T10:09:30.000Z',
  });
  const stale = registerRuntimeProcess({
    runtimeBaseDir: fx.runtimeBaseDir,
    role: 'graph',
    serverName: 'byomem-mcp-graph',
    entrypoint: 'mcp-graph',
    argv: ['node', join(fx.runtimeEntrypoint, 'mcp', 'graph.js')],
    cwd: fx.projectDir,
    pid: 999999,
    now: '2026-05-29T09:30:00.000Z',
  });
  const malformedPath = options.malformed ? join(fx.runtimeBaseDir, 'runtime-state', 'processes', 'broken.json') : undefined;
  if (malformedPath) writeFileSync(malformedPath, '{not-json}\n', 'utf8');
  return { activePath: active.path, stalePath: stale.path, malformedPath };
}

describe('sprint 86 remove codex', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  function makeFixture(): Fixture {
    const fx = fixture();
    roots.push(fx.root);
    return fx;
  }

  it('dry-run reports canonical removals, preserved artifacts, and stale runtime-state cleanup without writing', () => {
    const fx = makeFixture();
    writeCanonicalConfig(fx);
    writeCanonicalAgents(fx);
    writeCanonicalHooks(fx);
    const runtime = writeRuntimeStateFixtures(fx);
    writeFileSync(join(fx.runtimeBaseDir, 'byomem-index.sqlite'), 'memory-db', 'utf8');
    writeFileSync(join(fx.runtimeBaseDir, 'byomem-file-search.sqlite'), 'search-db', 'utf8');
    writeFileSync(join(fx.runtimeBaseDir, 'byomem-graph.sqlite'), 'graph-db', 'utf8');

    const report = buildRemoveCodexReport({
      mode: 'dry-run',
      runtimeBaseDir: fx.runtimeBaseDir,
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
      now: new Date('2026-05-29T10:10:00.000Z'),
    });

    expect(report).toMatchObject({
      command: 'remove codex',
      mode: 'dry-run',
      applied: false,
      changed: true,
      refusals: [],
    });
    expect(report.actions.map((action) => action.kind).sort()).toEqual([
      'remove-codex-mcp-section',
      'remove-guidance-block',
      'remove-hook-command',
      'remove-runtime-state-record',
    ].sort());
    expect(report.preserved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: runtime.activePath, kind: 'runtime-state-record' }),
      expect.objectContaining({ path: join(fx.runtimeBaseDir, 'byomem-index.sqlite') }),
      expect.objectContaining({ path: join(fx.runtimeBaseDir, 'byomem-file-search.sqlite') }),
      expect.objectContaining({ path: join(fx.runtimeBaseDir, 'byomem-graph.sqlite') }),
    ]));
    expect(existsSync(fx.configPath)).toBe(true);
    expect(existsSync(fx.agentsPath)).toBe(true);
    expect(existsSync(fx.hooksPath)).toBe(true);
    expect(existsSync(runtime.stalePath)).toBe(true);
    expect(report.backups).toEqual([]);
  });

  it('apply removes canonical files, creates backups, and is idempotent on a second run', () => {
    const fx = makeFixture();
    writeCanonicalConfig(fx);
    writeCanonicalAgents(fx);
    writeCanonicalHooks(fx);
    const runtime = writeRuntimeStateFixtures(fx);

    const first = runRemoveCodex({
      mode: 'apply',
      runtimeBaseDir: fx.runtimeBaseDir,
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
      now: new Date('2026-05-29T10:10:00.000Z'),
    });
    const second = runRemoveCodex({
      mode: 'apply',
      runtimeBaseDir: fx.runtimeBaseDir,
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
      now: new Date('2026-05-29T10:11:00.000Z'),
    });

    expect(first.applied).toBe(true);
    expect(first.backups).toHaveLength(3);
    expect(first.backups.every((path) => path.includes('.byomem-remove-backup-'))).toBe(true);
    expect(first.backups.every((path) => existsSync(path))).toBe(true);
    expect(readFileSync(fx.configPath, 'utf8')).toContain('[mcp_servers.unrelated]');
    expect(readFileSync(fx.agentsPath, 'utf8')).toContain('Unrelated guidance stays.');
    expect(JSON.parse(readFileSync(fx.hooksPath, 'utf8'))).toMatchObject({
      hooks: {
        PermissionRequest: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }],
      },
    });
    expect(existsSync(runtime.stalePath)).toBe(false);
    expect(existsSync(runtime.activePath)).toBe(true);

    expect(second).toMatchObject({
      applied: false,
      changed: false,
      backups: [],
      refusals: [],
    });
  });

  it('uses the global Codex config path by default', () => {
    const fx = makeFixture();
    const originalHome = process.env.HOME;
    process.env.HOME = fx.root;
    try {
      mkdirSync(join(fx.root, '.codex'), { recursive: true });
      const globalConfigPath = join(fx.root, '.codex', 'config.toml');
      writeFileSync(globalConfigPath, desiredSection(fx.runtimeEntrypoint, 'memory'), 'utf8');

      const report = buildRemoveCodexReport({
        mode: 'dry-run',
        runtimeBaseDir: fx.runtimeBaseDir,
        projectDir: fx.projectDir,
        runtimeEntrypoint: fx.runtimeEntrypoint,
      });

      expect(report.paths.codexConfig).toBe(globalConfigPath);
      expect(report.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'remove-codex-mcp-section', path: globalConfigPath }),
      ]));
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('rechecks stale runtime-state ownership immediately before deleting', () => {
    const fx = makeFixture();
    const runtime = writeRuntimeStateFixtures(fx);

    const report = runRemoveCodex({
      mode: 'apply',
      runtimeBaseDir: fx.runtimeBaseDir,
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
      now: new Date('2026-05-29T10:10:00.000Z'),
      beforeRuntimeStateApply: () => {
        const record = JSON.parse(readFileSync(runtime.stalePath, 'utf8')) as Record<string, unknown>;
        record.serverName = 'not-byomem';
        writeFileSync(runtime.stalePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      },
    });

    expect(report).toMatchObject({
      applied: false,
      changed: false,
      backups: [],
    });
    expect(existsSync(runtime.stalePath)).toBe(true);
    expect(existsSync(runtime.activePath)).toBe(true);
  });

  it('refuses near-match runtime-state argv values instead of deleting them', () => {
    const fx = makeFixture();
    const stale = registerRuntimeProcess({
      runtimeBaseDir: fx.runtimeBaseDir,
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      argv: ['node', `${join(fx.runtimeEntrypoint, 'mcp', 'graph.js')}.bak`],
      cwd: fx.projectDir,
      pid: 999999,
      now: '2026-05-29T09:30:00.000Z',
    });

    const report = buildRemoveCodexReport({
      mode: 'dry-run',
      runtimeBaseDir: fx.runtimeBaseDir,
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
      now: new Date('2026-05-29T10:10:00.000Z'),
    });

    expect(report.changed).toBe(false);
    expect(report.actions).toEqual([]);
    expect(report.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: stale.path, reason: 'stale-runtime-state-not-owned' }),
    ]));
  });

  it('fails closed when canonical files change between plan and apply', () => {
    const fx = makeFixture();
    writeCanonicalConfig(fx);
    writeCanonicalAgents(fx);

    const report = runRemoveCodex({
      mode: 'apply',
      runtimeBaseDir: fx.runtimeBaseDir,
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
      beforeFileApply: () => {
        writeFileSync(fx.configPath, [
          '[mcp_servers.byomem-memory]',
          'command = "python"',
          'args = ["/tmp/not-byomem.py"]',
          '',
        ].join('\n'), 'utf8');
      },
    });

    expect(report).toMatchObject({
      applied: false,
      changed: false,
      backups: [],
      actions: [],
    });
    expect(report.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: fx.configPath, reason: 'conflicting-mcp-entry' }),
    ]));
    expect(readFileSync(fx.configPath, 'utf8')).toContain('/tmp/not-byomem.py');
    expect(readFileSync(fx.agentsPath, 'utf8')).toContain('BYOMEM-CODEX-CONNECT:START');
  });

  it('refuses edited guidance, duplicate canonical MCP sections, and ambiguous BYOMem hooks', () => {
    const fx = makeFixture();
    writeFileSync(fx.configPath, [
      desiredSection(fx.runtimeEntrypoint, 'memory'),
      '',
      desiredSection(fx.runtimeEntrypoint, 'memory'),
      '',
      '[mcp_servers.old-byomem]',
      'command = "node"',
      'args = ["/tmp/legacy.js"]',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(fx.agentsPath, [
      '<!-- BYOMEM-CODEX-CONNECT:START -->',
      '# BYOMem Codex MCP',
      '- edited text',
      '<!-- BYOMEM-CODEX-CONNECT:END -->',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(fx.hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'grep -q "byomem-memory" ~/.codex/config.toml && echo "edited" || true',
              },
            ],
          },
        ],
      },
    }, null, 2), 'utf8');

    const report = buildRemoveCodexReport({
      mode: 'dry-run',
      runtimeBaseDir: fx.runtimeBaseDir,
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
    });

    expect(report.changed).toBe(false);
    expect(report.actions).toEqual([]);
    expect(report.refusals.map((refusal) => refusal.reason).sort()).toEqual([
      'ambiguous-hook-command',
      'duplicate-mcp-entry',
      'edited-guidance-block',
      'stale-mcp-entry',
    ].sort());
  });

  it('preserves active runtime-state records and refuses malformed records without deleting anything', () => {
    const fx = makeFixture();
    writeCanonicalConfig(fx);
    writeCanonicalAgents(fx);
    writeCanonicalHooks(fx);
    const runtime = writeRuntimeStateFixtures(fx, { malformed: true });

    const report = buildRemoveCodexReport({
      mode: 'dry-run',
      runtimeBaseDir: fx.runtimeBaseDir,
      codexConfigPath: fx.configPath,
      projectDir: fx.projectDir,
      runtimeEntrypoint: fx.runtimeEntrypoint,
      now: new Date('2026-05-29T10:10:00.000Z'),
    });

    expect(report.refusals.some((refusal) => refusal.reason === 'malformed-runtime-state')).toBe(true);
    expect(report.preserved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: runtime.activePath, kind: 'runtime-state-record' }),
    ]));
    expect(existsSync(runtime.activePath)).toBe(true);
    expect(runtime.malformedPath && existsSync(runtime.malformedPath)).toBe(true);
  });
});
