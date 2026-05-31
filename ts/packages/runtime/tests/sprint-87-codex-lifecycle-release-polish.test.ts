import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';

const repoRoot = join(__dirname, '..', '..', '..', '..');

function readRepo(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function readRepoOptional(path: string): string {
  const fullPath = join(repoRoot, path);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
}

function lifecycleDocs(): string {
  return [
    readRepo('README.md'),
    readRepo('docs/byomem-runtime-operations-runbook.md'),
    readRepoOptional('docs/codex-hooks-reference.md'),
  ].join('\n\n');
}

function expectCommandBeforeApply(text: string, command: 'connect codex' | 'remove codex'): void {
  const dryRunPattern = new RegExp(`npm run byomem:cli -- ${command}(?![^\\n]*--apply)`);
  const applyPattern = new RegExp(`npm run byomem:cli -- ${command}[^\\n]*--apply`);
  const dryRun = dryRunPattern.exec(text);
  const apply = applyPattern.exec(text);
  expect(dryRun?.index).toBeDefined();
  expect(apply?.index).toBeDefined();
  expect(dryRun!.index).toBeLessThan(apply!.index);
}

describe('S87 lifecycle docs contract', () => {
  it('documents connect and remove as paired dry-run-first lifecycle operations', () => {
    const text = lifecycleDocs();

    expect(text).toMatch(/paired lifecycle operations/i);
    expectCommandBeforeApply(text, 'connect codex');
    expectCommandBeforeApply(text, 'remove codex');
    expect(text).toMatch(/dry-run first/i);
    expect(text).toMatch(/apply-after-review/i);
  });

  it('states safe uninstall boundaries with exact durable-data and process language', () => {
    const text = lifecycleDocs();

    expect(text).toContain('integration rollback does not delete durable data');
    expect(text).toMatch(/remove codex.*(?:does not|doesn't).*(?:kill|terminate).*live processes/is);
    expect(text).toContain('~/.codex/config.toml');
    expect(text).toMatch(/all-project Codex config change/i);
  });

  it('enumerates recognized artifacts and config-only backups', () => {
    const text = lifecycleDocs();

    expect(text).toMatch(/canonical BYOMem MCP config sections/i);
    expect(text).toMatch(/marked AGENTS guidance block/i);
    expect(text).toMatch(/canonical Codex hook commands/i);
    expect(text).toMatch(/stale BYOMem-owned runtime-state records/i);
    expect(text).toMatch(/backups? (?:cover|are for).*config\/integration files/i);
    expect(text).toMatch(/not durable (?:BYOMem )?data/i);
  });
});

describe('S87 version verification contract', () => {
  it('keeps the local runtime version at the Sprint 87 release version', () => {
    expect(BYOMEM_RUNTIME_VERSION).toBe('0.1.10');
  });

  it('requires installed and global runtime-info evidence with expected fields', () => {
    const text = lifecycleDocs();

    expect(text).toMatch(/installed\/global/i);
    expect(text).toMatch(/byomem_runtime_info\.runtime\.packageVersion\s*===\s*"0\.1\.10"/);
    expect(text).toMatch(/byomem_runtime_info\.server\.version\s*===\s*"0\.1\.10"/);
    expect(text).toMatch(/repo-local commands are necessary but not sufficient/i);
  });
});

describe('S87 extension exposure decision', () => {
  it('defaults extension exposure to defer unless explicitly overridden', () => {
    const text = [
      lifecycleDocs(),
      readRepoOptional('docs/sprint-87-codex-lifecycle-release-polish.md'),
    ].join('\n\n');

    expect(text).toMatch(/Extension Exposure Decision Record/i);
    expect(text).toMatch(/Initial decision:\s*`defer`/);
    expect(text).toMatch(/defer menu\/help exposure unless implementation records an explicit override/i);
  });

  it('does not leave the active Sprint 87 backlog assigned to the dashboard', () => {
    const backlog = readRepo('docs/byomem-operational-polish-backlog.md');

    expect(backlog).not.toMatch(/Sprint 87[^\n]*Dashboard/i);
    expect(backlog).not.toMatch(/Dashboard[^\n]*Sprint 87/i);
    expect(backlog).toMatch(/Sprint 87:\s*Codex Lifecycle Release Polish/i);
  });
});
