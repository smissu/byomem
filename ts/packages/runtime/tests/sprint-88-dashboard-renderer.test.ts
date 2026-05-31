import { describe, expect, it } from 'vitest';
import { renderByomemDashboardHtml } from '../src/dashboard.js';

function buildDashboardModel() {
  return {
    schemaVersion: 1,
    command: 'dashboard',
    runtimeVersion: '0.1.10',
    generatedAt: '2026-05-31T00:00:00.000Z',
    overallStatus: 'warn',
    projectBaseDir: '/Users/ericsmith/Documents/byomem-sprint88-runtime-dashboard',
    runtimeBaseDir: '/tmp/byomem-runtime',
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
      {
        id: 'graph',
        label: 'Graph',
        status: 'missing',
        evidenceTier: 'stat-only',
        summary: 'Graph SQLite is missing',
        warnings: [],
      },
      {
        id: 'runtime-state',
        label: 'Runtime state',
        status: 'ready',
        evidenceTier: 'stat-only',
        summary: 'Runtime process inventory is read only',
        warnings: [],
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
        label: 'Version alignment',
        status: 'pass',
        severity: 'low',
        evidenceConfidence: 'definite',
        summary: 'Package and runtime versions match',
        warnings: [],
      },
      {
        id: 'file-search.embedding-health',
        label: 'Embedding health',
        status: 'skipped',
        severity: 'low',
        evidenceConfidence: 'not-applicable',
        summary: 'Not collected in Sprint 88',
        skippedReason: 'Active MCP verification belongs to later health work',
        warnings: [],
      },
      {
        id: 'doctor.read-only-boundary',
        label: 'Read only boundary',
        status: 'pass',
        severity: 'low',
        evidenceConfidence: 'definite',
        summary: 'Dashboard does not mutate runtime data',
        warnings: [],
        suggestedActions: [],
      },
    ],
    warnings: ['file-search is degraded because the SQLite artifact is missing'],
    suggestedActions: [
      'Inspect the missing file-search database at /tmp/byomem-runtime/byomem-file-search.sqlite',
      'Re-run the read-only status and doctor commands after restoring the missing artifact',
    ],
  };
}

describe('sprint 88 dashboard renderer', () => {
  it('renders a complete static HTML document with the dashboard sections', () => {
    const html = renderByomemDashboardHtml(buildDashboardModel());

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html');
    expect(html).toContain('<head>');
    expect(html).toContain('<body');
    expect(html).toContain('<title>');
    expect(html).toContain('Byomem');
    expect(html).toContain('Runtime Dashboard');
    expect(html).toContain('2026-05-31T00:00:00.000Z');
    expect(html).toContain('Status components');
    expect(html).toContain('Doctor checks');
    expect(html).toContain('Warnings');
    expect(html).toContain('Suggested actions');
    expect(html).toContain('Memory');
    expect(html).toContain('File search');
    expect(html).toContain('Graph');
    expect(html).toContain('Runtime state');
    expect(html).toContain('Codex config');
    expect(html).toContain('version.runtime-alignment');
    expect(html).toContain('file-search.embedding-health');
    expect(html).toContain('doctor.read-only-boundary');
  });

  it('escapes dynamic content from paths, warnings, check labels, evidence, and actions', () => {
    const html = renderByomemDashboardHtml({
      ...buildDashboardModel(),
      projectBaseDir: '/tmp/<byomem> "dashboard" & \'escape\'',
      runtimeBaseDir: '/tmp/runtime?<danger>',
      warnings: ['warning <strong> & "quoted" / dashboard'],
      statusComponents: [
        {
          id: 'memory',
          label: 'Memory <script>alert(1)</script>',
          status: 'ready',
          evidenceTier: 'stat-only',
          summary: 'Summary with <b>markup</b> & "quotes"',
          warnings: ['component warning <img src=x onerror=alert(1)>'],
        },
      ],
      doctorChecks: [
        {
          id: 'doctor.read-only-boundary',
          label: 'Read only boundary <svg onload=alert(1)>',
          status: 'pass',
          severity: 'low',
          evidenceConfidence: 'definite',
          summary: 'Evidence with <angle> brackets and "quotes"',
          warnings: ['check warning <iframe src=x></iframe>'],
          suggestedActions: ['Run `npm test` & inspect <dashboard>'],
          skippedReason: 'skip <reason> & "value"',
        },
      ],
      suggestedActions: ['Open /tmp/<byomem> and review "dashboard" <details>'],
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('onload=');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;strong&gt;');
    expect(html).toContain('&quot;dashboard&quot;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;dashboard&gt;');
    expect(html).toContain('&lt;iframe src=x&gt;');
    expect(html).not.toContain('/tmp/<byomem>');
    expect(html).not.toContain('warning <strong>');
    expect(html).not.toContain('Run `npm test` & inspect <dashboard>');
  });

  it('keeps the output self-contained with at most one style block and no interactive or remote features', () => {
    const html = renderByomemDashboardHtml({
      ...buildDashboardModel(),
      warnings: ['compact warning'],
      suggestedActions: ['compact action'],
    });

    expect((html.match(/<style\b/gi) ?? []).length).toBeLessThanOrEqual(1);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<input\b/i);
    expect(html).not.toMatch(/<textarea\b/i);
    expect(html).not.toMatch(/<select\b/i);
    expect(html).not.toMatch(/<option\b/i);
    expect(html).not.toMatch(/<button\b/i);
    expect(html).not.toMatch(/contenteditable\s*=/i);
    expect(html).not.toMatch(/http-equiv\s*=\s*["']refresh["']/i);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(html).not.toContain('javascript:');
    expect(html).not.toMatch(/\b(?:src|action)\s*=\s*["'](?:https?:)?\/\//i);
    expect(html).not.toMatch(/\b(?:src|href|action)\s*=\s*["']javascript:/i);
  });
});
