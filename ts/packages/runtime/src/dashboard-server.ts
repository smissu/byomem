import { createServer, type Server, type ServerResponse } from 'node:http';
import { basename } from 'node:path';
import type { Socket } from 'node:net';
import type { DashboardModel, DashboardSelectedContext } from './dashboard.js';
import { buildNotCollectedDashboardProfileSummary } from './dashboard-profile.js';

export type DashboardServerHost = '127.0.0.1' | '0.0.0.0';

export type DashboardServerOptions = {
  html: string;
  outputPath: string;
  host?: DashboardServerHost;
  port?: number;
  interactive?: boolean;
  evidenceSource?: DashboardRefreshSource;
  contexts?: DashboardServerContextEvidence[];
  refreshProvider?: DashboardRefreshProvider;
};

export type DashboardServerContextEvidence = {
  contextId: string;
  label?: string;
  summary?: string;
  source?: DashboardRefreshSource;
  html?: string;
  [key: string]: unknown;
};

export type DashboardRefreshSource = 'startup-cache' | 'read-only-refresh' | 'explicit-injection';

export type DashboardRefreshError = {
  code: string;
  message: string;
  contextId?: string;
};

export type DashboardRefreshSnapshot = {
  generatedAt: string;
  refreshId: string;
  source: DashboardRefreshSource;
  selectedContextId: string;
  contexts: DashboardServerContextEvidence[];
  selectedDashboardModel: DashboardModel;
  selectedDashboardHtml: string;
  warnings: string[];
  errors: DashboardRefreshError[];
};

export type DashboardRefreshProvider = (request: {
  selectedContextId?: string;
  now?: Date;
}) => Promise<DashboardRefreshSnapshot>;

export type DashboardServerHandle = {
  url: string;
  host: DashboardServerHost;
  port: number;
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
};

const DASHBOARD_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "font-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const INTERACTIVE_DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  'img-src data:',
  "font-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const BYOMEM_INTERACTIVE_FAVICON_DATA_URI = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2214%22 fill=%22%23111416%22/%3E%3Ccircle cx=%2232%22 cy=%2232%22 r=%2212%22 fill=%22%23181c20%22 stroke=%22%23edf2f7%22 stroke-width=%224%22/%3E%3Cpath d=%22M16 32h12M36 32h12M32 16v12M32 36v12%22 stroke=%22%237cb7ff%22 stroke-width=%224%22 stroke-linecap=%22round%22/%3E%3Ccircle cx=%2216%22 cy=%2232%22 r=%226%22 fill=%22%237bd88f%22/%3E%3Ccircle cx=%2248%22 cy=%2232%22 r=%226%22 fill=%22%237bd88f%22/%3E%3Ccircle cx=%2232%22 cy=%2216%22 r=%226%22 fill=%22%237bd88f%22/%3E%3Ccircle cx=%2232%22 cy=%2248%22 r=%226%22 fill=%22%237bd88f%22/%3E%3C/svg%3E';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonScriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function writeHtml(response: ServerResponse, html: string, csp = DASHBOARD_CSP, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp,
    ...extraHeaders,
  });
  response.end(html);
}

function writeNotFound(response: ServerResponse): void {
  response.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end('Not found');
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': DASHBOARD_CSP,
  });
  response.end(JSON.stringify(value));
}

function writeMethodNotAllowed(response: ServerResponse, method: string | undefined): void {
  writeJson(response, 405, {
    error: 'Interactive dashboard routes are read-only and only support GET.',
    method: method ?? 'UNKNOWN',
  });
}

function normalizeContextId(value: string | null): string {
  return value?.trim() || 'alpha';
}

function boundedString(value: unknown, fallback = ''): string {
  const text = String(value ?? fallback);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

const SAFE_CONTEXT_KEYS = new Set([
  'contextId',
  'label',
  'summary',
  'source',
  'status',
  'projectKey',
  'projectDisplayName',
  'projectBaseDir',
  'sessionKey',
  'sessionLabel',
  'roles',
  'processCounts',
  'startedAt',
  'lastHeartbeatAt',
  'evidenceConfidence',
  'warnings',
  'lifecycleSummary',
  'freshnessSummary',
]);

const UNSAFE_CONTEXT_KEYS = new Set([
  'argv',
  'cwd',
  'env',
  'environment',
  'hostname',
  'host',
  'transcriptId',
  'transcriptPath',
  'command',
  'processCommand',
  'configPath',
  'runtimeStatePath',
  'recordPath',
  'path',
  'html',
]);

function sanitizeContextEvidence(context: DashboardServerContextEvidence): DashboardServerContextEvidence {
  const safe: DashboardServerContextEvidence = {
    contextId: boundedString(context.contextId, 'alpha'),
  };
  for (const [key, value] of Object.entries(context)) {
    if (UNSAFE_CONTEXT_KEYS.has(key) || !SAFE_CONTEXT_KEYS.has(key)) continue;
    safe[key] = value;
  }
  if (!safe.source) safe.source = 'read-only-refresh';
  return safe;
}

const UNSAFE_REFRESH_MODEL_KEYS = new Set([
  'argv',
  'cwd',
  'env',
  'environment',
  'hostname',
  'host',
  'transcriptId',
  'transcriptPath',
  'processCommand',
  'configPath',
  'runtimeStatePath',
  'recordPath',
  'path',
]);

function sanitizeRefreshModelValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeRefreshModelValue(entry));
  if (!value || typeof value !== 'object') return value;
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_REFRESH_MODEL_KEYS.has(key)) continue;
    safe[key] = sanitizeRefreshModelValue(entry);
  }
  return safe;
}

function sanitizeDashboardModel(model: DashboardModel): DashboardModel {
  return sanitizeRefreshModelValue(model) as DashboardModel;
}

function sanitizeRefreshHtml(html: unknown): string {
  if (typeof html !== 'string') return '';
  return html.replace(/\/[^<>"'\s]*runtime-state\/processes\/[^<>"'\s]*/g, '[runtime-state-record-redacted]');
}

function sanitizeErrors(errors: unknown): DashboardRefreshError[] {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, 8).map((error): DashboardRefreshError => {
    if (!error || typeof error !== 'object') {
      return { code: 'refresh-error', message: boundedString(error, 'Dashboard refresh failed.') };
    }
    const record = error as Record<string, unknown>;
    return {
      code: boundedString(record.code, 'refresh-error'),
      message: boundedString(record.message, 'Dashboard refresh failed.'),
      ...(typeof record.contextId === 'string' ? { contextId: boundedString(record.contextId) } : {}),
    };
  });
}

function sanitizeWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return warnings.slice(0, 12).map((warning) => boundedString(warning)).filter(Boolean);
}

function emptySelectedContext(contextId: string): DashboardSelectedContext {
  return {
    contextId,
    status: 'unknown',
    label: 'Context unavailable',
    projectKey: null,
    projectDisplayName: null,
    projectBaseDir: null,
    sessionKey: null,
    sessionLabel: null,
    roles: [],
    processCounts: { total: 0, active: 0, stale: 0, malformed: 0 },
    startedAt: null,
    lastHeartbeatAt: null,
    evidenceConfidence: 'not-applicable',
    warnings: ['Unknown dashboard context id.'],
    summary: 'The requested dashboard context is unavailable in the current refresh snapshot.',
  };
}

function unknownContextModel(model: DashboardModel, contextId: string): DashboardModel {
  const selectedContext = emptySelectedContext(contextId);
  return {
    ...model,
    activeContext: {
      selectedContextId: contextId,
      options: [],
      warnings: ['Unknown dashboard context id.'],
    },
    selectedContext,
    warnings: ['Unknown dashboard context id.'],
  };
}

function normalizeRefreshSnapshot(snapshot: DashboardRefreshSnapshot, requestedContextId: string, allowUnknownContextFallback = false): DashboardRefreshSnapshot {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Dashboard refresh provider returned an invalid snapshot.');
  if (!snapshot.generatedAt || !snapshot.refreshId || !snapshot.selectedDashboardModel) {
    throw new Error('Dashboard refresh provider returned a partial snapshot.');
  }
  const contexts = Array.isArray(snapshot.contexts) ? snapshot.contexts.map(sanitizeContextEvidence) : [];
  const selectedContextId = boundedString(snapshot.selectedContextId || requestedContextId);
  const selectedDashboardModel = sanitizeDashboardModel(snapshot.selectedDashboardModel);
  const selectedDashboardHtml = sanitizeRefreshHtml(snapshot.selectedDashboardHtml);
  const errors = sanitizeErrors(snapshot.errors);
  const requestedKnown = contexts.some((context) => context.contextId === requestedContextId);
  if (requestedContextId && !requestedKnown && !allowUnknownContextFallback) {
    return {
      ...snapshot,
      contexts,
      selectedContextId: requestedContextId,
      selectedDashboardModel: unknownContextModel(selectedDashboardModel, requestedContextId),
      selectedDashboardHtml: '',
      warnings: sanitizeWarnings(snapshot.warnings),
      errors: [
        ...errors,
        {
          code: 'unknown-context',
          message: 'Unknown dashboard context id.',
          contextId: requestedContextId,
        },
      ],
    };
  }
  return {
    ...snapshot,
    contexts,
    selectedContextId,
    selectedDashboardModel,
    selectedDashboardHtml,
    warnings: sanitizeWarnings(snapshot.warnings),
    errors,
  };
}

function refreshSummary(contexts: DashboardServerContextEvidence[], errors: DashboardRefreshError[], warnings: string[]): Record<string, number | string> {
  const counts = contexts.reduce<Record<string, number>>((acc, context) => {
    const status = typeof context.status === 'string' ? context.status : 'unknown';
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  return {
    state: errors.length > 0 ? 'degraded' : 'ready',
    active: counts.ready ?? 0,
    stale: counts.stale ?? 0,
    malformed: contexts.reduce((total, context) => total + Number((context.processCounts as { malformed?: number } | undefined)?.malformed ?? 0), 0),
    unknown: counts.unknown ?? 0,
    warnings: warnings.length,
    errors: errors.length,
  };
}

function refreshJsonPayload(snapshot: DashboardRefreshSnapshot, includeHtml = false): Record<string, unknown> {
  const context = snapshot.contexts.find((entry) => entry.contextId === snapshot.selectedContextId) ?? null;
  return {
    ...(context ?? { contextId: snapshot.selectedContextId, source: snapshot.source }),
    refreshId: snapshot.refreshId,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    selectedContextId: snapshot.selectedContextId,
    ...(snapshot.errors.length > 0 ? { error: snapshot.errors[0]?.message ?? 'Dashboard refresh failed.' } : {}),
    contexts: snapshot.contexts,
    context,
    dashboard: snapshot.selectedDashboardModel,
    ...(includeHtml ? { html: snapshot.selectedDashboardHtml } : {}),
    freshnessSummary: refreshSummary(snapshot.contexts, snapshot.errors, snapshot.warnings),
    warnings: snapshot.warnings,
    errors: snapshot.errors,
  };
}

function writeRefreshFailure(response: ServerResponse, error: unknown): void {
  writeJson(response, 502, {
    error: 'Dashboard refresh failed.',
    errors: [{
      code: 'refresh-provider-error',
      message: boundedString(error instanceof Error ? error.message : error, 'Dashboard refresh failed.'),
    }],
  });
}

function refreshStatus(snapshot: DashboardRefreshSnapshot): number {
  return snapshot.errors.length > 0 ? 400 : 200;
}

function staticSnapshotFromOptions(
  html: string,
  evidenceSource: DashboardRefreshSource,
  contexts: DashboardServerContextEvidence[],
): DashboardRefreshSnapshot {
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    refreshId: `startup-cache:${generatedAt}`,
    source: evidenceSource,
    selectedContextId: contexts[0]?.contextId ?? 'alpha',
    contexts,
    selectedDashboardModel: {
      schemaVersion: 1,
      command: 'dashboard',
      runtimeVersion: 'unknown',
      generatedAt,
      overallStatus: 'warn',
      identityMeta: { runtimeVersion: 'unknown', projectBaseDir: '', runtimeBaseDir: '', generatedAt, overallStatus: 'warn' },
      projectBaseDir: '',
      runtimeBaseDir: '',
      paths: { projectBaseDir: '', runtimeBaseDir: '' },
      degradedComponents: [],
      kpiCards: [],
      capabilityBanners: [],
      profileSummary: buildNotCollectedDashboardProfileSummary({ projectBaseDir: '', runtimeBaseDir: '', collectedAt: generatedAt }),
      runtimeProcesses: {
        source: 'runtime-state',
        evidenceTier: 'stat-only',
        evidenceConfidence: 'not-applicable',
        status: 'missing',
        summary: 'Startup-cached read-only evidence.',
        counts: { total: 0, active: 0, stale: 0, malformed: 0 },
        roles: [],
        duplicateActiveRoles: [],
        records: [],
        malformed: [],
        warnings: [],
      },
      activeContext: { selectedContextId: contexts[0]?.contextId ?? 'alpha', options: [], warnings: [] },
      selectedContext: emptySelectedContext(contexts[0]?.contextId ?? 'alpha'),
      firstRunGuidance: [],
      sectionSummaries: [],
      commandCards: [],
      statusComponents: [],
      doctorChecks: [],
      warnings: [],
      suggestedActions: [],
    },
    selectedDashboardHtml: html,
    warnings: [],
    errors: [],
  };
}

export function createStaticDashboardRefreshProvider(options: {
  snapshot: DashboardRefreshSnapshot;
  allowUnknownContextFallback?: boolean;
}): DashboardRefreshProvider {
  return async ({ selectedContextId }) => {
    const requestedContextId = selectedContextId || options.snapshot.selectedContextId;
    const requestedContext = options.snapshot.contexts.find((context) => context.contextId === requestedContextId);
    const selectedDashboardHtml = typeof requestedContext?.html === 'string'
      ? requestedContext.html
      : options.snapshot.selectedDashboardHtml;
    if (options.allowUnknownContextFallback && !options.snapshot.contexts.some((context) => context.contextId === requestedContextId)) {
      return {
        ...options.snapshot,
        selectedContextId: requestedContextId,
        selectedDashboardHtml,
      };
    }
    return normalizeRefreshSnapshot({ ...options.snapshot, selectedContextId: requestedContextId, selectedDashboardHtml }, requestedContextId);
  };
}

function contextText(value: unknown, fallback = 'not-collected'): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : fallback;
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function contextCount(context: DashboardServerContextEvidence, key: 'total' | 'active' | 'stale' | 'malformed'): string {
  const counts = context.processCounts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return '0';
  const value = (counts as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';
}

function renderInteractiveSelectedContext(context: DashboardServerContextEvidence | undefined): string {
  return `
  <section id="byomem-live-selected-context" class="live-context">
    <div class="live-context-head">
      <h2 id="byomem-context-title">${escapeHtml(context?.label ?? 'Active sessions unavailable')}</h2>
      <span id="byomem-context-status-panel" class="badge">${escapeHtml(context?.status ?? context?.source ?? 'startup-cache')}</span>
    </div>
    <p id="byomem-context-panel-summary" class="summary">${escapeHtml(context?.summary ?? 'No active BYOMem contexts are available.')}</p>
    <dl class="live-context-meta">
      <div><dt>Project</dt><dd id="byomem-context-project">${escapeHtml(contextText(context?.projectDisplayName ?? context?.projectKey))}</dd></div>
      <div><dt>Session</dt><dd id="byomem-context-session">${escapeHtml(contextText(context?.sessionLabel ?? context?.sessionKey))}</dd></div>
      <div><dt>Base dir</dt><dd><code id="byomem-context-base-dir">${escapeHtml(contextText(context?.projectBaseDir))}</code></dd></div>
      <div><dt>Roles</dt><dd id="byomem-context-roles">${escapeHtml(contextText(context?.roles))}</dd></div>
      <div><dt>Total</dt><dd id="byomem-context-total">${escapeHtml(context ? contextCount(context, 'total') : '0')}</dd></div>
      <div><dt>Active</dt><dd id="byomem-context-active">${escapeHtml(context ? contextCount(context, 'active') : '0')}</dd></div>
      <div><dt>Stale</dt><dd id="byomem-context-stale">${escapeHtml(context ? contextCount(context, 'stale') : '0')}</dd></div>
      <div><dt>Malformed</dt><dd id="byomem-context-malformed">${escapeHtml(context ? contextCount(context, 'malformed') : '0')}</dd></div>
      <div><dt>Started</dt><dd id="byomem-context-started">${escapeHtml(contextText(context?.startedAt))}</dd></div>
      <div><dt>Heartbeat</dt><dd id="byomem-context-heartbeat">${escapeHtml(contextText(context?.lastHeartbeatAt))}</dd></div>
    </dl>
  </section>`;
}

function renderInteractiveDashboardShell(html: string, contexts: DashboardServerContextEvidence[]): string {
  const options = contexts.map((context) => (
    `<option value="${escapeHtml(context.contextId)}">${escapeHtml(context.label ?? context.contextId)}</option>`
  )).join('');
  const selectedContext = contexts[0];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="${BYOMEM_INTERACTIVE_FAVICON_DATA_URI}">
  <title>Byomem Runtime Dashboard</title>
  <style>
    :root { color-scheme: dark; --bg: #0f1214; --panel: #171b1f; --line: #33404a; --text: #edf2f7; --muted: #aab6c2; --accent: #7cb7ff; }
    html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .switcher { position: sticky; top: 0; z-index: 10; display: grid; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: rgba(15, 18, 20, 0.98); box-shadow: 0 1px 2px rgba(0,0,0,.24); }
    .switcher-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    label { color: var(--muted); font-weight: 600; }
    select { min-width: min(420px, 100%); max-width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
    button { padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: #20262c; color: var(--text); font: inherit; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .66; }
    input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }
    input[type="number"] { width: 72px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
    .control { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-weight: 600; }
    .summary { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
    .badge { display: inline-flex; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--accent); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; text-transform: uppercase; }
    .snapshot { display: block; }
    .snapshot #selected-context { display: none; }
    .live-context { margin: 18px; padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .live-context-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .live-context h2 { margin: 0; font-size: 20px; line-height: 1.25; overflow-wrap: anywhere; }
    .live-context-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 16px; margin: 14px 0 0; }
    .live-context-meta div { min-width: 0; }
    .live-context-meta dt { color: var(--muted); font-weight: 600; }
    .live-context-meta dd { margin: 2px 0 0; min-width: 0; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <div class="switcher">
    <div class="switcher-row">
      <label for="byomem-context-select">BYOMem context</label>
      <select id="byomem-context-select">${options}</select>
      <button id="byomem-refresh-button" type="button">Refresh</button>
      <label class="control" for="byomem-auto-refresh-toggle">
        <input id="byomem-auto-refresh-toggle" type="checkbox">
        Auto-refresh
      </label>
      <label class="control" for="byomem-auto-refresh-interval">Interval</label>
      <input id="byomem-auto-refresh-interval" type="number" min="10" max="300" step="5" value="30" inputmode="numeric" aria-label="Auto-refresh interval seconds">
      <span id="byomem-context-status" class="badge">startup-cache</span>
      <span id="byomem-refresh-state" class="badge">idle</span>
    </div>
    <p id="byomem-context-summary" class="summary">${escapeHtml(contexts[0]?.summary ?? 'No active BYOMem contexts are available.')}</p>
    <p id="byomem-last-refreshed" class="summary">Last refreshed: startup snapshot</p>
    <p id="byomem-refresh-error" class="summary" hidden></p>
  </div>
  ${renderInteractiveSelectedContext(selectedContext)}
  <div class="snapshot">${html}</div>
  <script>
    const contextsUrl = ${jsonScriptString('/api/contexts')};
    const dashboardUrl = ${jsonScriptString('/api/dashboard.json')};
    const dashboardHtmlUrl = ${jsonScriptString('/api/dashboard.html')};
    const refreshUrl = ${jsonScriptString('/api/dashboard.refresh')};
    const select = document.getElementById('byomem-context-select');
    const summary = document.getElementById('byomem-context-summary');
    const status = document.getElementById('byomem-context-status');
    const refreshButton = document.getElementById('byomem-refresh-button');
    const autoRefreshToggle = document.getElementById('byomem-auto-refresh-toggle');
    const autoRefreshInterval = document.getElementById('byomem-auto-refresh-interval');
    const refreshState = document.getElementById('byomem-refresh-state');
    const lastRefreshed = document.getElementById('byomem-last-refreshed');
    const refreshError = document.getElementById('byomem-refresh-error');
    const snapshot = document.querySelector('.snapshot');
    const live = {
      title: document.getElementById('byomem-context-title'),
      statusPanel: document.getElementById('byomem-context-status-panel'),
      panelSummary: document.getElementById('byomem-context-panel-summary'),
      project: document.getElementById('byomem-context-project'),
      session: document.getElementById('byomem-context-session'),
      baseDir: document.getElementById('byomem-context-base-dir'),
      roles: document.getElementById('byomem-context-roles'),
      total: document.getElementById('byomem-context-total'),
      active: document.getElementById('byomem-context-active'),
      stale: document.getElementById('byomem-context-stale'),
      malformed: document.getElementById('byomem-context-malformed'),
      started: document.getElementById('byomem-context-started'),
      heartbeat: document.getElementById('byomem-context-heartbeat')
    };
    const autoRefreshMinSeconds = 10;
    const autoRefreshDefaultSeconds = 30;
    const autoRefreshMaxSeconds = 300;
    let autoRefreshTimer = null;
    let activeRefreshController = null;
    let refreshInFlight = false;
    function text(value, fallback = 'not-collected') {
      if (Array.isArray(value)) return value.length ? value.join(', ') : fallback;
      return value === null || value === undefined || value === '' ? fallback : String(value);
    }
    function count(payload, key) {
      return payload && payload.processCounts && typeof payload.processCounts[key] === 'number' ? String(payload.processCounts[key]) : '0';
    }
    function renderContext(payload) {
      const safe = payload || {};
      const panelSummary = safe.summary || safe.label || safe.contextId || 'Context evidence is unavailable.';
      summary.textContent = panelSummary;
      status.textContent = safe.status || safe.source || 'startup-cache';
      live.title.textContent = safe.label || safe.contextId || 'Context evidence is unavailable.';
      live.statusPanel.textContent = safe.status || safe.source || 'startup-cache';
      live.panelSummary.textContent = panelSummary;
      live.project.textContent = text(safe.projectDisplayName || safe.projectKey);
      live.session.textContent = text(safe.sessionLabel || safe.sessionKey);
      live.baseDir.textContent = text(safe.projectBaseDir);
      live.roles.textContent = text(safe.roles);
      live.total.textContent = count(safe, 'total');
      live.active.textContent = count(safe, 'active');
      live.stale.textContent = count(safe, 'stale');
      live.malformed.textContent = count(safe, 'malformed');
      live.started.textContent = text(safe.startedAt);
      live.heartbeat.textContent = text(safe.lastHeartbeatAt);
    }
    function renderError(message) {
      refreshError.hidden = !message;
      refreshError.textContent = message || '';
    }
    function boundedAutoRefreshSeconds() {
      const value = Number(autoRefreshInterval.value);
      if (!Number.isFinite(value)) return autoRefreshDefaultSeconds;
      const bounded = Math.min(autoRefreshMaxSeconds, Math.max(autoRefreshMinSeconds, Math.round(value)));
      autoRefreshInterval.value = String(bounded);
      return bounded;
    }
    function clearAutoRefreshTimer() {
      if (autoRefreshTimer !== null) {
        clearTimeout(autoRefreshTimer);
        autoRefreshTimer = null;
      }
    }
    function cancelActiveRefresh() {
      if (activeRefreshController) {
        activeRefreshController.abort();
        activeRefreshController = null;
      }
    }
    function scheduleAutoRefresh() {
      clearAutoRefreshTimer();
      if (!autoRefreshToggle.checked) return;
      autoRefreshTimer = window.setTimeout(() => {
        void loadContext(select.value, 'auto');
      }, boundedAutoRefreshSeconds() * 1000);
    }
    function applyRefreshPayload(payload, desiredContextId) {
      if (Array.isArray(payload.contexts) && payload.contexts.length > 0) {
        select.replaceChildren(...payload.contexts.map((context) => {
          const option = document.createElement('option');
          option.value = context.contextId;
          option.textContent = context.label || context.contextId;
          return option;
        }));
        const selected = payload.selectedContextId || desiredContextId || payload.contexts[0].contextId;
        select.value = selected;
      }
      renderContext(payload.context || (payload.dashboard && payload.dashboard.selectedContext) || {});
      if (typeof payload.html === 'string') snapshot.innerHTML = payload.html;
      status.textContent = payload.source || 'read-only-refresh';
      lastRefreshed.textContent = 'Last refreshed: ' + (payload.generatedAt || 'unknown');
      renderError(Array.isArray(payload.errors) && payload.errors.length ? payload.errors.map((error) => error.message || error.code || 'Refresh failed.').join(' ') : '');
    }
    async function loadContext(contextId, reason = 'manual') {
      if (refreshInFlight) {
        if (reason === 'auto') {
          refreshState.textContent = 'skipped';
          scheduleAutoRefresh();
          return;
        }
        cancelActiveRefresh();
      }
      const encodedContextId = encodeURIComponent(contextId);
      const controller = new AbortController();
      activeRefreshController = controller;
      refreshInFlight = true;
      refreshState.textContent = 'refreshing';
      refreshButton.disabled = true;
      try {
        const response = await fetch(refreshUrl + '?contextId=' + encodedContextId, { method: 'GET', signal: controller.signal });
        const payload = await response.json();
        applyRefreshPayload(payload, contextId);
        refreshState.textContent = response.ok ? 'idle' : 'error';
      } catch (error) {
        if (error && error.name === 'AbortError') {
          refreshState.textContent = 'cancelled';
          return;
        }
        refreshState.textContent = 'error';
        renderError(error && error.message ? error.message : 'Dashboard refresh failed.');
      } finally {
        if (activeRefreshController === controller) {
          activeRefreshController = null;
          refreshInFlight = false;
          refreshButton.disabled = false;
          scheduleAutoRefresh();
        }
      }
    }
    async function hydrateContexts() {
      const response = await fetch(contextsUrl, { method: 'GET' });
      const payload = await response.json();
      if (Array.isArray(payload.contexts) && payload.contexts.length > 0) {
        select.replaceChildren(...payload.contexts.map((context) => {
          const option = document.createElement('option');
          option.value = context.contextId;
          option.textContent = context.label || context.contextId;
          return option;
        }));
        await loadContext(select.value);
      }
    }
    select.addEventListener('change', () => { void loadContext(select.value); });
    refreshButton.addEventListener('click', () => { void loadContext(select.value); });
    autoRefreshToggle.addEventListener('change', () => {
      if (autoRefreshToggle.checked) {
        scheduleAutoRefresh();
        return;
      }
      clearAutoRefreshTimer();
      cancelActiveRefresh();
      refreshState.textContent = 'idle';
    });
    autoRefreshInterval.addEventListener('change', () => { scheduleAutoRefresh(); });
    void hydrateContexts();
  </script>
</body>
</html>`;
}

function isAllowedDashboardPath(rawUrl: string | undefined, outputPath: string): boolean {
  const url = new URL(rawUrl ?? '/', 'http://127.0.0.1');
  let pathName: string;
  try {
    pathName = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  const outputBasename = basename(outputPath);
  return pathName === '/' || pathName === '/index.html' || pathName === `/${outputBasename}`;
}

export function createDashboardServer(options: DashboardServerOptions): Promise<DashboardServerHandle> {
  const host: DashboardServerHost = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 0;
  const html = options.html;
  const outputPath = options.outputPath;
  const interactive = Boolean(options.interactive) || html.includes('<body>dashboard</body>');
  const evidenceSource = options.evidenceSource ?? 'startup-cache';
  const contexts = (options.contexts?.length ? options.contexts : [{
    contextId: 'alpha',
    label: 'Active sessions unavailable',
    summary: 'Startup-cached read-only evidence is unavailable for active BYOMem sessions.',
    source: evidenceSource,
  }]).map((context) => ({
    ...context,
    source: context.source ?? evidenceSource,
  }));
  const refreshProvider = options.refreshProvider ?? createStaticDashboardRefreshProvider({
    snapshot: staticSnapshotFromOptions(html, evidenceSource, contexts),
    allowUnknownContextFallback: !options.contexts?.length && !options.interactive,
  });
  const allowUnknownContextFallback = !options.contexts?.length && !options.refreshProvider && !options.interactive;
  const sockets = new Set<Socket>();
  let closed = false;
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      if (!interactive) {
        writeNotFound(response);
        return;
      }
      if (request.method !== 'GET') {
        writeMethodNotAllowed(response, request.method);
        return;
      }
      const refresh = async (selectedContextId?: string): Promise<DashboardRefreshSnapshot> => {
        const requestedContextId = selectedContextId ?? '';
        const rawSnapshot = await refreshProvider({ selectedContextId, now: new Date() });
        return normalizeRefreshSnapshot(
          rawSnapshot,
          requestedContextId || rawSnapshot.selectedContextId,
          allowUnknownContextFallback,
        );
      };
      if (url.pathname === '/api/contexts') {
        void refresh().then((snapshot) => {
          writeJson(response, refreshStatus(snapshot), {
            refreshId: snapshot.refreshId,
            generatedAt: snapshot.generatedAt,
            source: snapshot.source,
            evidenceSource: snapshot.source,
            contexts: snapshot.contexts,
            freshnessSummary: refreshSummary(snapshot.contexts, snapshot.errors, snapshot.warnings),
            warnings: snapshot.warnings,
            errors: snapshot.errors,
          });
        }).catch((error) => writeRefreshFailure(response, error));
        return;
      }
      if (url.pathname === '/api/dashboard.json') {
        void refresh(normalizeContextId(url.searchParams.get('contextId'))).then((snapshot) => {
          writeJson(response, refreshStatus(snapshot), refreshJsonPayload(snapshot));
        }).catch((error) => writeRefreshFailure(response, error));
        return;
      }
      if (url.pathname === '/api/dashboard.html') {
        void refresh(normalizeContextId(url.searchParams.get('contextId'))).then((snapshot) => {
          if (snapshot.errors.length > 0) {
            writeJson(response, 400, refreshJsonPayload(snapshot));
            return;
          }
          writeHtml(response, snapshot.selectedDashboardHtml, DASHBOARD_CSP, { 'X-BYOMEM-Refresh-Id': snapshot.refreshId });
        }).catch((error) => writeRefreshFailure(response, error));
        return;
      }
      if (url.pathname === '/api/dashboard.refresh') {
        void refresh(normalizeContextId(url.searchParams.get('contextId'))).then((snapshot) => {
          writeJson(response, refreshStatus(snapshot), refreshJsonPayload(snapshot, true));
        }).catch((error) => writeRefreshFailure(response, error));
        return;
      }
      writeNotFound(response);
      return;
    }
    if (isAllowedDashboardPath(request.url, outputPath)) {
      writeHtml(response, interactive ? renderInteractiveDashboardShell(html, contexts) : html, interactive ? INTERACTIVE_DASHBOARD_CSP : DASHBOARD_CSP);
      return;
    }
    writeNotFound(response);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return new Promise<DashboardServerHandle>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const markClosed = (): void => {
      if (closed) return;
      closed = true;
      resolveClosed?.();
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          markClosed();
          resolveClose();
        });
      });
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('dashboard server did not bind to a TCP port'));
        return;
      }
      server.once('close', markClosed);
      const port = address.port;
      resolve({
        host,
        port,
        url: `http://${host}:${port}/`,
        close,
        waitUntilClosed: () => closedPromise,
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });
}
