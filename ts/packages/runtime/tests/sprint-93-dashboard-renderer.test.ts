import { describe, expect, it } from 'vitest';
import { renderByomemDashboardHtml } from '../src/dashboard.js';

function sectionMarkup(html: string, sectionId: string): string {
  const pattern = new RegExp(`<section id="${sectionId}">[\\s\\S]*?<\\/section>`);
  const match = html.match(pattern);
  expect(match, `expected section ${sectionId} to be present`).toBeTruthy();
  return match?.[0] ?? '';
}

function buildDashboardModel() {
  const longContinuousPath = `/Users/ericsmith/Documents/byomem/${'dashboard-long-path-'.repeat(14)}artifact`;
  return {
    schemaVersion: 1,
    command: 'dashboard',
    runtimeVersion: '0.1.13',
    generatedAt: '2026-05-31T00:00:00.000Z',
    overallStatus: 'warn',
    projectBaseDir: '/Users/ericsmith/Documents/byomem-sprint93-runtime-dashboard',
    runtimeBaseDir: '/tmp/byomem-runtime',
    paths: {
      projectBaseDir: '/Users/ericsmith/Documents/byomem-sprint93-runtime-dashboard',
      runtimeBaseDir: '/tmp/byomem-runtime',
    },
    degradedComponents: ['file-search', 'graph'],
    statusComponents: [
      {
        id: 'memory',
        label: 'Memory',
        status: 'ready',
        evidenceTier: 'stat-only',
        summary: 'Memory artifacts are present',
        warnings: [],
      },
      {
        id: 'file-search',
        label: 'File search',
        status: 'degraded',
        evidenceTier: 'stat-only',
        summary: `file-search SQLite artifact missing: ${longContinuousPath}`,
        warnings: ['file-search SQLite artifact missing: /Users/ericsmith/Documents/byomem/byomem-file-search.sqlite'],
      },
      {
        id: 'graph',
        label: 'Graph',
        status: 'missing',
        evidenceTier: 'stat-only',
        summary: 'Graph SQLite artifact missing',
        warnings: ['graph SQLite artifact missing: /Users/ericsmith/Documents/byomem/byomem-graph.sqlite'],
      },
      {
        id: 'runtime-state',
        label: 'Runtime state',
        status: 'degraded',
        evidenceTier: 'stat-only',
        summary: 'runtime process state directory is missing',
        warnings: ['runtime process state directory is missing: /Users/ericsmith/Documents/byomem/runtime-state/processes'],
      },
      {
        id: 'codex-config',
        label: 'Codex config',
        status: 'ready',
        evidenceTier: 'stat-only',
        summary: 'Reads ~/.codex/config.toml',
        warnings: [],
      },
    ],
    doctorChecks: [
      {
        id: 'version.runtime-alignment',
        label: `Version alignment for ${longContinuousPath}`,
        component: 'dashboard',
        status: 'pass',
        severity: 'low',
        evidenceConfidence: 'definite',
        evidenceTier: 'local-runtime-info',
        summary: `Version alignment summary with ${longContinuousPath}`,
        warnings: [],
        suggestedActions: [],
        skippedReason: null,
      },
      {
        id: 'runtime-info.active-mcp',
        label: `Runtime info active MCP check for ${longContinuousPath}`,
        component: 'dashboard',
        status: 'warn',
        severity: 'medium',
        evidenceConfidence: 'probable',
        evidenceTier: 'not-collected',
        summary: `Active MCP check summary with ${longContinuousPath}`,
        warnings: ['check warning with /Users/ericsmith/Documents/byomem/runtime-state/processes and other long text'],
        suggestedActions: [{ mode: 'copy', label: 'Inspect runtime state', command: `byomem-runtime doctor --base-dir ${longContinuousPath} --json` }],
        skippedReason: null,
      },
      {
        id: 'file-search.embedding-health',
        label: 'Embedding health',
        component: 'file-search',
        status: 'fail',
        severity: 'high',
        evidenceConfidence: 'definite',
        evidenceTier: 'not-collected',
        summary: 'Embedding check failed',
        warnings: ['embedding health failed for /Users/ericsmith/Documents/byomem/byomem-file-search.sqlite'],
        suggestedActions: [{ mode: 'copy', label: 'Inspect file search', command: `byomem-runtime status --base-dir ${longContinuousPath} --json` }],
        skippedReason: null,
      },
    ],
    warnings: [
      'file-search SQLite artifact missing: /Users/ericsmith/Documents/byomem/byomem-file-search.sqlite',
      'graph SQLite artifact missing: /Users/ericsmith/Documents/byomem/byomem-graph.sqlite',
      'runtime process state directory is missing: /Users/ericsmith/Documents/byomem/runtime-state/processes',
      longContinuousPath,
    ],
    suggestedActions: [
      { mode: 'copy', label: `Inspect ${longContinuousPath}`, command: `byomem-runtime status --base-dir ${longContinuousPath} --json` },
      { mode: 'copy', label: 'Inspect warnings', command: `printf '%s\n' "${longContinuousPath}"` },
    ],
    commandCards: [
      {
        id: 'status',
        label: `Inspect ${longContinuousPath}`,
        command: `byomem-runtime status --base-dir ${longContinuousPath} --json`,
        mode: 'read-only',
        summary: `Copy-only status command for ${longContinuousPath}`,
      },
      {
        id: 'doctor',
        label: 'Inspect doctor',
        command: `byomem-runtime doctor --base-dir ${longContinuousPath} --json`,
        mode: 'read-only',
        summary: 'Copy-only doctor command',
      },
    ],
  };
}

function buildEmptyDashboardModel() {
  return {
    schemaVersion: 1,
    command: 'dashboard',
    runtimeVersion: '0.1.13',
    generatedAt: '2026-05-31T00:00:00.000Z',
    overallStatus: 'pass',
    projectBaseDir: '/Users/ericsmith/Documents/byomem-sprint93-runtime-dashboard',
    runtimeBaseDir: '/tmp/byomem-runtime',
    paths: {
      projectBaseDir: '/Users/ericsmith/Documents/byomem-sprint93-runtime-dashboard',
      runtimeBaseDir: '/tmp/byomem-runtime',
    },
    degradedComponents: [],
    statusComponents: [],
    doctorChecks: [],
    warnings: [],
    suggestedActions: [],
    commandCards: [],
  };
}

describe('sprint 93 dashboard renderer', () => {
  it('renders warnings, doctor checks, and suggested actions as semantic css-only collapsible sections', () => {
    const html = renderByomemDashboardHtml(buildDashboardModel() as any);

    expect(html).toContain('<section id="warnings">');
    expect(html).toContain('<section id="doctor-checks">');
    expect(html).toContain('<section id="suggested-actions">');
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('href="#warnings"');
    expect(html).toContain('href="#doctor-checks"');
    expect(html).toContain('href="#suggested-actions"');
    expect(html).toContain('Warnings (4)');
    expect(html).toContain('Doctor checks (3)');
    expect(html).toContain('Suggested actions (2)');
    expect(html).toContain('open');

    const warningsMarkup = sectionMarkup(html, 'warnings');
    const doctorMarkup = sectionMarkup(html, 'doctor-checks');
    const suggestedMarkup = sectionMarkup(html, 'suggested-actions');

    expect(warningsMarkup).toMatch(/<details[^>]*open[^>]*>/);
    expect(doctorMarkup).toMatch(/<details[^>]*open[^>]*>/);
    expect(suggestedMarkup).toMatch(/<details[^>]*open[^>]*>/);
    expect(suggestedMarkup).toContain('command-card');
    expect(suggestedMarkup).toContain('Copy-only status command');
    expect(html).toContain('2 copy-only commands included.');
  });

  it('keeps doctor checks collapsed unless a warn or fail check is present and renders empty sections as stable collapsed text', () => {
    const html = renderByomemDashboardHtml(buildEmptyDashboardModel() as any);

    const warningsMarkup = sectionMarkup(html, 'warnings');
    const doctorMarkup = sectionMarkup(html, 'doctor-checks');
    const suggestedMarkup = sectionMarkup(html, 'suggested-actions');

    expect(warningsMarkup).toContain('None.');
    expect(doctorMarkup).toContain('None.');
    expect(suggestedMarkup).toContain('None.');
    expect(warningsMarkup).not.toMatch(/<details[^>]*open[^>]*>/);
    expect(doctorMarkup).not.toMatch(/<details[^>]*open[^>]*>/);
    expect(suggestedMarkup).not.toMatch(/<details[^>]*open[^>]*>/);
    expect(html).toContain('Warnings (0)');
    expect(html).toContain('Doctor checks (0)');
    expect(html).toContain('Suggested actions (0)');
  });

  it('renders suggested actions from sparse legacy models when command cards are absent or empty', () => {
    const model = {
      ...buildEmptyDashboardModel(),
      suggestedActions: [
        { mode: 'copy', label: 'Inspect sparse status', command: 'byomem-runtime status --base-dir /tmp/byomem --json' },
      ],
    };
    const omittedCardsHtml = renderByomemDashboardHtml(({ ...model, commandCards: undefined }) as any);
    const emptyCardsHtml = renderByomemDashboardHtml(model as any);

    expect(sectionMarkup(omittedCardsHtml, 'suggested-actions')).toContain('Inspect sparse status');
    expect(sectionMarkup(emptyCardsHtml, 'suggested-actions')).toContain('Inspect sparse status');
    expect(sectionMarkup(emptyCardsHtml, 'suggested-actions')).toMatch(/<details[^>]*open[^>]*>/);
    expect(emptyCardsHtml).toContain('1 copy-only command included.');
  });

  it('wraps long paths warnings check labels summaries dd list items and command text inside card-safe css', () => {
    const html = renderByomemDashboardHtml(buildDashboardModel() as any);

    expect(html).toContain('overflow-wrap: anywhere');
    expect(html).toContain('min-width: 0');
    expect(html).toContain('.panel-head');
    expect(html).toContain('.section-head');
    expect(html).toContain('.list li');
    expect(html).toContain('.meta dd');
    expect(html).toContain('.summary');
    expect(html).toContain('code {');
    expect(html).toContain('word-break: break-word');
    expect(html).toContain('white-space: break-spaces');
    expect(html).toContain('file-search SQLite artifact missing: /Users/ericsmith/Documents/byomem/byomem-file-search.sqlite');
    expect(html).toContain('graph SQLite artifact missing: /Users/ericsmith/Documents/byomem/byomem-graph.sqlite');
    expect(html).toContain('runtime process state directory is missing: /Users/ericsmith/Documents/byomem/runtime-state/processes');
    expect(html).toContain('dashboard-long-path-dashboard-long-path');
  });

  it('keeps the collapsible dashboard static and non executable', () => {
    const html = renderByomemDashboardHtml(buildDashboardModel() as any);
    const lower = html.toLowerCase();

    expect(lower).not.toContain('<script');
    expect(lower).not.toContain('<form');
    expect(lower).not.toContain('<button');
    expect(lower).not.toContain('<input');
    expect(lower).not.toContain('<textarea');
    expect(lower).not.toContain('<select');
    expect(lower).not.toContain('onclick=');
    expect(lower).not.toContain('onload=');
    expect(lower).not.toContain('javascript:');
    expect(lower).not.toMatch(/\b(?:src|action)\s*=\s*["'](?:https?:)?\/\//);
    expect(lower).not.toMatch(/\b(?:src|href|action)\s*=\s*["']javascript:/);
    expect(lower).not.toMatch(/\b(?:localstorage|sessionstorage|document\.cookie|cookie)\b/);
    expect(lower).not.toContain('cleanup');
    expect(lower).not.toContain('graph-update');
    expect(lower).not.toContain('--serve');
    expect(lower).not.toContain('--watch');
    expect(lower).not.toContain('--apply');
    expect(lower).not.toContain('--delete-data');
    expect(lower).not.toContain('--kill-processes');
  });
});
