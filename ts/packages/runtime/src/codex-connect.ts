import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mergeGuidance, mergeMcpConfig, resolveDefaultCodexConfigPath, resolveDefaultRuntimeEntrypoint, type ConnectCodexRefusal } from './codex-config.js';

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
  const codexConfigPath = resolve(options.codexConfigPath ?? resolveDefaultCodexConfigPath());
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const projectAgents = join(projectDir, 'AGENTS.md');
  const runtimeEntrypoint = resolve(options.runtimeEntrypoint ?? resolveDefaultRuntimeEntrypoint());
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
