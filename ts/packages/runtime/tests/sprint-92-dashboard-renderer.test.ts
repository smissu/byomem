import { describe, expect, it } from 'vitest';
import { renderByomemDashboardHtml } from '../src/dashboard.js';

function buildDashboardModel() {
  return {
    schemaVersion: 1,
    command: 'dashboard',
    runtimeVersion: '0.1.10',
    generatedAt: '2026-05-31T00:00:00.000Z',
    overallStatus: 'warn',
    projectBaseDir: '/Users/ericsmith/Documents/byomem-sprint92-runtime-dashboard',
    runtimeBaseDir: '/tmp/byomem-runtime',
    paths: {
      projectBaseDir: '/Users/ericsmith/Documents/byomem-sprint92-runtime-dashboard',
      runtimeBaseDir: '/tmp/byomem-runtime',
    },
    degradedComponents: ['file-search'],
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
        summary: 'File-search SQLite is missing',
        warnings: ['file-search SQLite artifact missing: /tmp/byomem-runtime/byomem-file-search.sqlite'],
      },
    ],
    doctorChecks: [
      {
        id: 'doctor.read-only-boundary',
        label: 'Read only boundary',
        component: 'dashboard',
        status: 'pass',
        severity: 'low',
        evidenceConfidence: 'definite',
        evidenceTier: 'stat-only',
        summary: 'Dashboard remains static and read-only',
        warnings: [],
        suggestedActions: [{ mode: 'copy', label: 'Copy diagnostics command', command: 'byomem doctor --readonly' }],
        skippedReason: null,
      },
    ],
    warnings: ['file-search is degraded because the SQLite artifact is missing'],
    suggestedActions: [
      { mode: 'copy', label: 'Copy status command', command: 'byomem status --readonly' },
      { mode: 'copy', label: 'Restore the missing database', command: 'byomem file-search-scan --apply' },
    ],
  };
}

describe('sprint 92 dashboard renderer RED contracts', () => {
  it('renders footer, first-run guidance, section navigation, command cards, richer summary panels, and CSS-only theme controls', () => {
    const html = renderByomemDashboardHtml(buildDashboardModel() as any);

    expect(html).toContain('<footer');
    expect(html).toContain('First run guidance');
    expect(html).toContain('<nav');
    expect(html).toContain('href="#status-components"');
    expect(html).toContain('href="#doctor-checks"');
    expect(html).toContain('href="#suggested-actions"');
    expect(html).toContain('command-card');
    expect(html).toContain('summary-panel');
    expect(html).toContain('href="#theme-dark"');
    expect(html).toContain('href="#theme-light"');
    expect(html).toContain('aria-label="Use dark theme"');
    expect(html).toContain('aria-label="Use light theme"');
    expect(html).toContain('title="Dark theme"');
    expect(html).toContain('title="Light theme"');
    expect(html).toContain('class="theme-to-light"');
    expect(html).toContain('class="theme-to-dark"');
    expect(html).toContain('html:has(#theme-light:target) .theme-switch .theme-to-light');
    expect(html).toContain('html:has(#theme-light:target) .theme-switch .theme-to-dark');
    expect(html).toContain('html:has(#theme-light:target)');
    expect(html).toContain(':root[data-theme="light"]');
    expect(html).not.toContain('Dark theme default');
    expect(html).not.toContain('Light theme CSS path');
    expect(html).toContain('https://github.com/ericsmith/byomem/blob/main/README.md');
    expect(html).toContain('https://github.com/ericsmith/byomem/blob/main/docs/byomem-runtime-operations-runbook.md');
  });

  it('escapes dynamic text and keeps suggested actions inert, copy-friendly text only', () => {
    const html = renderByomemDashboardHtml({
      ...buildDashboardModel(),
      warnings: ['warning <strong> & "quoted" / dashboard'],
      suggestedActions: [{ mode: 'copy', label: 'Open <script>alert(1)</script>', command: 'echo "<danger>" && whoami' }],
    } as any);

    expect(html).toContain('&lt;strong&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;danger&gt;');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/<a\s+[^>]*href=["']javascript:/i);
    expect(html).toContain('<code>');
  });

  it('enforces static safety boundaries and bans mutation wording in generated controls', () => {
    const html = renderByomemDashboardHtml(buildDashboardModel() as any);
    const lower = html.toLowerCase();

    expect(lower).not.toContain('<script');
    expect(lower).not.toContain('<form');
    expect(lower).not.toMatch(/\bon[a-z]+\s*=/);
    expect(lower).not.toContain('javascript:');
    expect(lower).not.toMatch(/\b(?:src|action)\s*=\s*["'](?:https?:)?\/\//);
    expect(lower).not.toMatch(/\b(?:localstorage|sessionstorage|document\.cookie|cookie)\b/);
    expect(lower).not.toContain('restore');
    expect(lower).not.toContain('delete');
    expect(lower).not.toContain('kill');
    expect(lower).not.toContain('cleanup');
    expect(lower).not.toContain('apply');
    expect(lower).not.toContain('stop');
  });
});
