import type {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorEvidenceConfidence,
  DoctorReport,
  DoctorSeverity,
  DoctorSuggestedAction,
  DoctorOverallStatus,
} from './doctor.js';
import { buildNotCollectedDashboardProfileSummary, type DashboardProfileSummary } from './dashboard-profile.js';
import type { StatusComponentState, StatusReport } from './status-report.js';

export type DashboardSchemaVersion = 1;
export type DashboardCommand = 'dashboard';
export type DashboardStatusComponentId = 'memory' | 'file-search' | 'graph' | 'runtime-state' | 'codex-config';
export type DashboardStatusComponentStatus = 'ready' | 'degraded' | 'missing';
export type DashboardEvidenceTier =
  | 'stat-only'
  | 'local-runtime-info'
  | 'db-read-only'
  | 'active-mcp-runtime-info'
  | 'not-collected';

export type DashboardIdentityMeta = {
  runtimeVersion: string;
  projectBaseDir: string;
  runtimeBaseDir: string;
  generatedAt: string;
  overallStatus: DoctorOverallStatus;
};

export type DashboardKpiCard = {
  id: string;
  label: string;
  value: string;
  summary: string;
};

export type DashboardCapabilityBanner = {
  id: string;
  label: string;
  state: 'available' | 'degraded' | 'missing' | 'not-collected' | 'connected';
  evidenceTier: DashboardEvidenceTier;
  summary: string;
};

export type DashboardCommandCard = {
  id: string;
  label: string;
  command: string;
  mode: 'read-only';
  summary: string;
};

export type DashboardSectionSummary = {
  id: DashboardStatusComponentId | 'doctor-checks' | 'warnings' | 'suggested-actions';
  label: string;
  status: DashboardStatusComponentStatus | DoctorOverallStatus;
  summary: string;
  href: string;
};

export type DashboardStatusComponent = {
  id: DashboardStatusComponentId;
  label: string;
  status: DashboardStatusComponentStatus;
  evidenceTier: DashboardEvidenceTier;
  summary: string;
  warnings: string[];
};

export type DashboardDoctorCheck = {
  id: string;
  label: string;
  component: string;
  status: DoctorCheckStatus;
  severity: DoctorSeverity;
  evidenceConfidence: DoctorEvidenceConfidence;
  evidenceTier: DashboardEvidenceTier;
  summary: string;
  warnings: string[];
  suggestedActions: DashboardSuggestedAction[];
  skippedReason: string | null;
};

export type DashboardSuggestedAction = DoctorSuggestedAction;

export type DashboardModel = {
  schemaVersion: DashboardSchemaVersion;
  command: DashboardCommand;
  runtimeVersion: string;
  generatedAt: string;
  overallStatus: DoctorOverallStatus;
  identityMeta: DashboardIdentityMeta;
  projectBaseDir: string;
  runtimeBaseDir: string;
  paths: {
    projectBaseDir: string;
    runtimeBaseDir: string;
  };
  degradedComponents: DashboardStatusComponentId[];
  kpiCards: DashboardKpiCard[];
  capabilityBanners: DashboardCapabilityBanner[];
  profileSummary: DashboardProfileSummary;
  firstRunGuidance: DashboardCommandCard[];
  sectionSummaries: DashboardSectionSummary[];
  commandCards: DashboardCommandCard[];
  statusComponents: DashboardStatusComponent[];
  doctorChecks: DashboardDoctorCheck[];
  warnings: string[];
  suggestedActions: DashboardSuggestedAction[];
};

export type BuildByomemDashboardModelOptions = {
  statusReport: StatusReport;
  doctorReport: DoctorReport;
  generatedAt?: Date | string;
  profileSummary?: DashboardProfileSummary;
  activeMcpRuntimeInfo?: {
    server?: string;
    collectedAt?: string;
    status?: 'connected' | 'degraded' | 'missing';
  };
};

const MAX_STATUS_COMPONENTS = 8;
const MAX_DOCTOR_CHECKS = 32;
const MAX_WARNINGS = 20;
const MAX_SUGGESTED_ACTIONS = 20;
const MAX_KPI_CARDS = 8;
const MAX_CAPABILITY_BANNERS = 8;
const MAX_FIRST_RUN_GUIDANCE = 8;
const MAX_SECTION_SUMMARIES = 10;
const MAX_COMMAND_CARDS = 12;

const STATUS_COMPONENT_LABELS: Record<DashboardStatusComponentId, string> = {
  memory: 'Memory',
  'file-search': 'File search',
  graph: 'Graph',
  'runtime-state': 'Runtime state',
  'codex-config': 'Codex config',
};

function normalizeTimestamp(value?: Date | string): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error('generatedAt must be a valid date');
    return parsed.toISOString();
  }
  return value.toISOString();
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\bon([a-z]+)=/gi, 'on$1&#61;');
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function dedupeActions(values: DashboardSuggestedAction[]): DashboardSuggestedAction[] {
  const seen = new Set<string>();
  const deduped: DashboardSuggestedAction[] = [];
  for (const value of values) {
    const key = `${value.mode}\u0000${value.label}\u0000${value.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function isSafeReadOnlyAction(action: { label?: string; command?: string; mode?: string }): boolean {
  if (action.mode && action.mode !== 'read-only' && action.mode !== 'copy') return false;
  const text = `${action.label ?? ''} ${action.command ?? ''}`.toLowerCase();
  return !/\b(apply|delete|kill|cleanup|stop|force|prune|remove|uninstall|scan|graph-update|refresh|serve|watch)\b/.test(text)
    && !text.includes(' --apply')
    && !text.includes(' --delete-data')
    && !text.includes(' --kill-processes')
    && !text.includes(' --open');
}

function withOverflowWarning(values: string[], max: number, overflowWarning: string): string[] {
  if (values.length <= max) return values;
  if (max <= 0) return [overflowWarning];
  return [...values.slice(0, max - 1), overflowWarning];
}

function truncateItems<T>(values: T[], max: number): { items: T[]; truncated: boolean } {
  if (values.length <= max) return { items: values, truncated: false };
  return { items: values.slice(0, max), truncated: true };
}

function toDashboardStatusComponentStatus(status: StatusComponentState): DashboardStatusComponentStatus {
  return status === 'ready' ? 'ready' : status === 'degraded' ? 'degraded' : 'missing';
}

function evidenceTierForDoctorCheck(check: DoctorCheck): DashboardEvidenceTier {
  if (check.id === 'runtime-info.active-mcp' || check.id === 'file-search.embedding-health') return 'not-collected';
  if (check.id === 'version.runtime-alignment') return 'local-runtime-info';
  return 'stat-only';
}

function doctorCheckSummary(check: DoctorCheck): string {
  if (check.skippedReason) return check.skippedReason;
  if (check.warnings.length > 0) return check.warnings[0];
  return check.title;
}

function statusComponentSummary(
  id: DashboardStatusComponentId,
  status: DashboardStatusComponentStatus,
  warnings: string[],
  statusReport: StatusReport,
): string {
  switch (id) {
    case 'memory':
      if (status === 'ready') return 'Memory artifacts are present.';
      if (status === 'degraded') return warnings[0] ?? 'Memory artifacts need attention.';
      return 'Memory artifacts are missing.';
    case 'file-search':
      if (status === 'ready') return 'File-search artifacts are present.';
      if (status === 'degraded') return warnings[0] ?? 'File-search artifacts need attention.';
      return 'File-search artifacts are missing.';
    case 'graph':
      if (status === 'ready') return 'Graph artifacts are present.';
      if (status === 'degraded') return warnings[0] ?? 'Graph artifacts need attention.';
      return 'Graph artifacts are missing.';
    case 'runtime-state': {
      const stale = statusReport.mcpProcesses.staleCount;
      const malformed = statusReport.mcpProcesses.malformedCount;
      if (stale === 0 && malformed === 0) return 'Runtime process inventory is clean.';
      const parts = [
        stale > 0 ? `${stale} stale runtime-state record${stale === 1 ? '' : 's'}` : '',
        malformed > 0 ? `${malformed} malformed runtime-state record${malformed === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      return `${parts.join(' and ')} need review.`;
    }
    case 'codex-config':
      return 'Reads host-global ~/.codex/config.toml.';
  }
}

function statusComponentWarnings(
  id: DashboardStatusComponentId,
  statusReport: StatusReport,
  doctorReport: DoctorReport,
): string[] {
  switch (id) {
    case 'memory':
      return dedupeStrings(statusReport.artifacts.memory.warnings);
    case 'file-search':
      return dedupeStrings(statusReport.artifacts.fileSearch.warnings);
    case 'graph':
      return dedupeStrings(statusReport.artifacts.graph.warnings);
    case 'runtime-state':
      return dedupeStrings([
        ...statusReport.mcpProcesses.warnings,
        ...doctorReport.checks.filter((check) => check.id.startsWith('runtime-state.')).flatMap((check) => check.warnings),
      ]);
    case 'codex-config': {
      const check = doctorReport.checks.find((entry) => entry.id === 'codex.config-presence');
      return dedupeStrings(check?.warnings ?? []);
    }
  }
}

function buildStatusComponent(
  id: DashboardStatusComponentId,
  statusReport: StatusReport,
  doctorReport: DoctorReport,
): DashboardStatusComponent {
  if (id === 'memory') {
    const status = toDashboardStatusComponentStatus(statusReport.artifacts.memory.status);
    const warnings = statusComponentWarnings(id, statusReport, doctorReport);
    return {
      id,
      label: STATUS_COMPONENT_LABELS[id],
      status,
      evidenceTier: 'stat-only',
      summary: statusComponentSummary(id, status, warnings, statusReport),
      warnings,
    };
  }
  if (id === 'file-search') {
    const status = toDashboardStatusComponentStatus(statusReport.artifacts.fileSearch.status);
    const warnings = statusComponentWarnings(id, statusReport, doctorReport);
    return {
      id,
      label: STATUS_COMPONENT_LABELS[id],
      status,
      evidenceTier: 'stat-only',
      summary: statusComponentSummary(id, status, warnings, statusReport),
      warnings,
    };
  }
  if (id === 'graph') {
    const status = toDashboardStatusComponentStatus(statusReport.artifacts.graph.status);
    const warnings = statusComponentWarnings(id, statusReport, doctorReport);
    return {
      id,
      label: STATUS_COMPONENT_LABELS[id],
      status,
      evidenceTier: 'stat-only',
      summary: statusComponentSummary(id, status, warnings, statusReport),
      warnings,
    };
  }
  if (id === 'runtime-state') {
    const degraded = statusReport.mcpProcesses.staleCount > 0 || statusReport.mcpProcesses.malformedCount > 0;
    const status: DashboardStatusComponentStatus = degraded ? 'degraded' : 'ready';
    const warnings = statusComponentWarnings(id, statusReport, doctorReport);
    return {
      id,
      label: STATUS_COMPONENT_LABELS[id],
      status,
      evidenceTier: 'stat-only',
      summary: statusComponentSummary(id, status, warnings, statusReport),
      warnings,
    };
  }

  const check = doctorReport.checks.find((entry) => entry.id === 'codex.config-presence');
  const status: DashboardStatusComponentStatus = !check || check.status === 'skipped' ? 'missing' : check.status === 'pass' ? 'ready' : 'degraded';
  const warnings = statusComponentWarnings(id, statusReport, doctorReport);
  return {
    id,
    label: STATUS_COMPONENT_LABELS[id],
    status,
    evidenceTier: 'stat-only',
    summary: statusComponentSummary(id, status, warnings, statusReport),
    warnings,
  };
}

function buildDoctorCheck(check: DoctorCheck): DashboardDoctorCheck {
  const evidenceTier = evidenceTierForDoctorCheck(check);
  return {
    id: check.id,
    label: check.title,
    component: check.component,
    status: check.status,
    severity: check.severity,
    evidenceConfidence: check.evidenceConfidence,
    evidenceTier,
    summary: doctorCheckSummary(check),
    warnings: dedupeStrings(check.warnings),
    suggestedActions: dedupeActions(check.suggestedActions).filter(isSafeReadOnlyAction),
    skippedReason: check.skippedReason,
  };
}

function deriveOverallStatus(
  doctorChecks: DashboardDoctorCheck[],
  statusComponents: DashboardStatusComponent[],
): DoctorOverallStatus {
  if (doctorChecks.some((check) => check.status === 'fail')) return 'fail';
  if (doctorChecks.some((check) => check.status === 'warn')) return 'warn';
  if (statusComponents.some((component) => component.status !== 'ready')) return 'warn';
  return 'pass';
}

function formatActionLabel(action: string | DashboardSuggestedAction): string {
  if (typeof action === 'string') return action;
  if (action.label && action.command) return `${action.label}: ${action.command}`;
  if (action.command) return action.command;
  return action.label;
}

function renderList(items: string[]): string {
  if (items.length === 0) return '<p class="empty">None.</p>';
  return `<ul class="list">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

function renderActionList(items: Array<string | DashboardSuggestedAction>): string {
  if (items.length === 0) return '<p class="empty">None.</p>';
  return `<ul class="list">${items
    .filter((item) => typeof item === 'string' || isSafeReadOnlyAction(item))
    .map((item) => `<li><code>${escapeHtml(formatActionLabel(item))}</code></li>`)
    .join('')}</ul>`;
}

function renderDisclosureSection(options: {
  title: string;
  status: string;
  countLabel: string;
  open: boolean;
  bodyHtml: string;
}): string {
  return `
        <details class="disclosure"${options.open ? ' open' : ''}>
          <summary>
            <span class="disclosure-indicator" aria-hidden="true"></span>
            <span class="disclosure-title">${escapeHtml(options.title)} (${escapeHtml(options.countLabel)})</span>
            <span class="badge">${escapeHtml(options.status)}</span>
          </summary>
          <div class="disclosure-body">
            ${options.bodyHtml}
          </div>
        </details>`;
}

function toCommandCard(id: string, action: DashboardSuggestedAction, summary = 'Copy and run manually if appropriate.'): DashboardCommandCard {
  return {
    id,
    label: action.label,
    command: action.command,
    mode: 'read-only',
    summary,
  };
}

function buildKpiCards(
  statusComponents: DashboardStatusComponent[],
  doctorChecks: DashboardDoctorCheck[],
  warnings: string[],
  overallStatus: DoctorOverallStatus,
): DashboardKpiCard[] {
  const degraded = statusComponents.filter((component) => component.status !== 'ready').length;
  return [
    { id: 'overall-status', label: 'Overall status', value: overallStatus, summary: 'Derived from injected status and doctor reports.' },
    { id: 'status-components', label: 'Status components', value: String(statusComponents.length), summary: `${degraded} component${degraded === 1 ? '' : 's'} need review.` },
    { id: 'doctor-checks', label: 'Doctor checks', value: String(doctorChecks.length), summary: 'Read-only doctor checks included in this snapshot.' },
    { id: 'warnings', label: 'Warnings', value: String(warnings.length), summary: 'Bounded and deduplicated warning count.' },
  ].slice(0, MAX_KPI_CARDS);
}

function buildCapabilityBanners(options: BuildByomemDashboardModelOptions): DashboardCapabilityBanner[] {
  const activeMcp = options.activeMcpRuntimeInfo;
  const banners: DashboardCapabilityBanner[] = [
    {
      id: 'active-mcp-runtime-info',
      label: 'Active MCP runtime-info',
      state: activeMcp?.status ?? 'not-collected',
      evidenceTier: activeMcp ? 'active-mcp-runtime-info' : 'not-collected',
      summary: activeMcp
        ? `Injected runtime-info from ${activeMcp.server ?? 'MCP runtime'} at ${activeMcp.collectedAt ?? 'unknown time'}.`
        : 'Not collected by static dashboard generation; no live MCP server is probed.',
    },
    {
      id: 'static-html',
      label: 'Static HTML',
      state: 'available',
      evidenceTier: 'local-runtime-info',
      summary: 'Generated as a self-contained, no-network, no-script HTML snapshot.',
    },
    {
      id: 'read-only-boundary',
      label: 'Read-only boundary',
      state: 'available',
      evidenceTier: 'local-runtime-info',
      summary: 'Dashboard generation does not scan, refresh, update graphs, terminate processes, or mutate config.',
    },
  ];
  return banners.slice(0, MAX_CAPABILITY_BANNERS);
}

function buildFirstRunGuidance(statusComponents: DashboardStatusComponent[], runtimeBaseDir: string): DashboardCommandCard[] {
  if (!statusComponents.some((component) => component.status === 'missing')) return [];
  const guidance: DashboardCommandCard[] = [
    {
      id: 'create-initial-artifacts',
      label: 'Inspect first-run status',
      command: `byomem-runtime status --base-dir ${runtimeBaseDir}`,
      mode: 'read-only',
      summary: 'Review missing local artifacts without creating or repairing them.',
    },
    {
      id: 'inspect-doctor',
      label: 'Inspect doctor diagnostics',
      command: `byomem-runtime doctor --base-dir ${runtimeBaseDir} --json`,
      mode: 'read-only',
      summary: 'Collect read-only diagnostic evidence before deciding on setup steps.',
    },
  ];
  return guidance.slice(0, MAX_FIRST_RUN_GUIDANCE);
}

function buildSectionSummaries(
  statusComponents: DashboardStatusComponent[],
  doctorChecks: DashboardDoctorCheck[],
  warnings: string[],
  suggestedActionCount: number,
): DashboardSectionSummary[] {
  const componentSummaries = statusComponents.map((component) => ({
    id: component.id,
    label: component.label,
    status: component.status,
    summary: component.summary,
    href: `#${component.id}`,
  }));
  return [
    ...componentSummaries,
    {
      id: 'doctor-checks',
      label: 'Doctor checks',
      status: doctorChecks.some((check) => check.status === 'fail') ? 'fail' : doctorChecks.some((check) => check.status === 'warn') ? 'warn' : 'pass',
      summary: `${doctorChecks.length} read-only check${doctorChecks.length === 1 ? '' : 's'} included.`,
      href: '#doctor-checks',
    },
    {
      id: 'warnings',
      label: 'Warnings',
      status: warnings.length > 0 ? 'warn' : 'pass',
      summary: `${warnings.length} warning${warnings.length === 1 ? '' : 's'} included.`,
      href: '#warnings',
    },
    {
      id: 'suggested-actions',
      label: 'Suggested actions',
      status: suggestedActionCount > 0 ? 'warn' : 'pass',
      summary: `${suggestedActionCount} copy-only command${suggestedActionCount === 1 ? '' : 's'} included.`,
      href: '#suggested-actions',
    },
  ].slice(0, MAX_SECTION_SUMMARIES) as DashboardSectionSummary[];
}

function buildCommandCards(doctorReport: DoctorReport, runtimeBaseDir: string): DashboardCommandCard[] {
  const baseActions: DashboardSuggestedAction[] = [
    { label: 'Inspect status', command: `byomem-runtime status --base-dir ${runtimeBaseDir}`, mode: 'read-only' },
    { label: 'Inspect doctor', command: `byomem-runtime doctor --base-dir ${runtimeBaseDir} --json`, mode: 'read-only' },
  ];
  return dedupeActions([...baseActions, ...doctorReport.suggestedActions])
    .filter(isSafeReadOnlyAction)
    .slice(0, MAX_COMMAND_CARDS)
    .map((action, index) => toCommandCard(index === 0 ? 'status' : index === 1 ? 'doctor' : `action-${index}`, action));
}

function renderStatusComponent(component: DashboardStatusComponent): string {
  const warnings = Array.isArray(component.warnings) ? component.warnings : [];
  return `
        <article class="panel component status-${escapeHtml(component.status)}">
          <div class="panel-head">
            <h3>${escapeHtml(component.label)}</h3>
            <span class="badge">${escapeHtml(component.status)}</span>
          </div>
          <p class="summary">${escapeHtml(component.summary)}</p>
          <dl class="meta">
            <div><dt>Evidence</dt><dd>${escapeHtml(component.evidenceTier)}</dd></div>
          </dl>
          <div class="subsection">
            <h4>Warnings</h4>
            ${renderList(warnings.map((warning) => escapeHtml(warning)))}
          </div>
        </article>`;
}

function renderDoctorCheck(check: DashboardDoctorCheck): string {
  const warnings = Array.isArray(check.warnings) ? check.warnings : [];
  const suggestedActions = Array.isArray(check.suggestedActions) ? check.suggestedActions : [];
  return `
        <article class="panel check check-${escapeHtml(check.status)}">
          <div class="panel-head">
            <h3>${escapeHtml(check.label)}</h3>
            <span class="badge">${escapeHtml(check.status)}</span>
          </div>
          <p class="summary">${escapeHtml(check.summary)}</p>
          <dl class="meta">
            <div><dt>Id</dt><dd><code>${escapeHtml(check.id)}</code></dd></div>
            <div><dt>Component</dt><dd>${escapeHtml(check.component)}</dd></div>
            <div><dt>Severity</dt><dd>${escapeHtml(check.severity)}</dd></div>
            <div><dt>Evidence</dt><dd>${escapeHtml(check.evidenceConfidence)} / ${escapeHtml(check.evidenceTier)}</dd></div>
          </dl>
          ${check.skippedReason ? `<p class="skipped">${escapeHtml(check.skippedReason)}</p>` : ''}
          <div class="subsection">
            <h4>Warnings</h4>
            ${renderList(warnings.map((warning) => escapeHtml(warning)))}
          </div>
          <div class="subsection">
            <h4>Suggested actions</h4>
            ${renderActionList(suggestedActions)}
          </div>
        </article>`;
}

function renderCommandCards(cards: DashboardCommandCard[], empty = 'None.'): string {
  if (cards.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<div class="command-grid">${cards
    .filter(isSafeReadOnlyAction)
    .map((card) => `
        <article class="command-card" id="command-${escapeHtml(card.id)}">
          <div class="panel-head">
            <h3>${escapeHtml(card.label)}</h3>
            <span class="badge">${escapeHtml(card.mode)}</span>
          </div>
          <p class="summary">${escapeHtml(card.summary)}</p>
          <code>${escapeHtml(card.command)}</code>
        </article>`)
    .join('')}</div>`;
}

function renderCapabilityBanners(banners: DashboardCapabilityBanner[]): string {
  if (banners.length === 0) return '<p class="empty">No capability data.</p>';
  return `<div class="banner-grid">${banners
    .map((banner) => `
        <article class="summary-panel capability-${escapeHtml(banner.state)}">
          <div class="panel-head">
            <h3>${escapeHtml(banner.label)}</h3>
            <span class="badge">${escapeHtml(banner.state)}</span>
          </div>
          <p class="summary">${escapeHtml(banner.summary)}</p>
          <dl class="meta">
            <div><dt>Evidence</dt><dd>${escapeHtml(banner.evidenceTier)}</dd></div>
          </dl>
        </article>`)
    .join('')}</div>`;
}

function formatNullableCount(value: number | null): string {
  return value === null ? 'not-collected' : String(value);
}

function renderLanguageCounts(languageCounts: Record<string, number>): string {
  const entries = Object.entries(languageCounts);
  if (entries.length === 0) return '<p class="empty">not-collected</p>';
  return `<ul class="list">${entries.map(([language, count]) => `<li>${escapeHtml(language)}: ${escapeHtml(count)}</li>`).join('')}</ul>`;
}

function renderRelationCounts(relationCounts: Record<string, number>): string {
  const entries = Object.entries(relationCounts);
  if (entries.length === 0) return '<p class="empty">not-collected</p>';
  return `<ul class="list">${entries.map(([relation, count]) => `<li>${escapeHtml(relation)}: ${escapeHtml(count)}</li>`).join('')}</ul>`;
}

function renderProfileSummary(profileSummary: DashboardProfileSummary): string {
  return `
      <div class="profile-grid">
        <article class="summary-panel profile-${escapeHtml(profileSummary.fileSearch.state)}">
          <div class="panel-head">
            <h3>File search profile</h3>
            <span class="badge">${escapeHtml(profileSummary.fileSearch.state)}</span>
          </div>
          <p class="summary">${escapeHtml(profileSummary.fileSearch.summary)}</p>
          <dl class="meta">
            <div><dt>Evidence</dt><dd>${escapeHtml(profileSummary.fileSearch.evidenceTier)} / ${escapeHtml(profileSummary.fileSearch.source)}</dd></div>
            <div><dt>Database</dt><dd><code>${escapeHtml(profileSummary.fileSearch.dbPath)}</code></dd></div>
            <div><dt>Files</dt><dd>${escapeHtml(formatNullableCount(profileSummary.fileSearch.indexedFileCount))}</dd></div>
            <div><dt>Chunks</dt><dd>${escapeHtml(formatNullableCount(profileSummary.fileSearch.chunkCount))}</dd></div>
            <div><dt>Last indexed</dt><dd>${escapeHtml(profileSummary.fileSearch.lastIndexedAt ?? 'not-collected')}</dd></div>
          </dl>
          <div class="subsection">
            <h4>Languages</h4>
            ${renderLanguageCounts(profileSummary.fileSearch.languageCounts)}
          </div>
          ${profileSummary.fileSearch.warnings.length > 0 ? `<div class="subsection"><h4>Warnings</h4>${renderList(profileSummary.fileSearch.warnings.map((warning) => escapeHtml(warning)))}</div>` : ''}
        </article>

        <article class="summary-panel profile-${escapeHtml(profileSummary.graph.state)}">
          <div class="panel-head">
            <h3>Graph profile</h3>
            <span class="badge">${escapeHtml(profileSummary.graph.state)}</span>
          </div>
          <p class="summary">${escapeHtml(profileSummary.graph.summary)}</p>
          <dl class="meta">
            <div><dt>Evidence</dt><dd>${escapeHtml(profileSummary.graph.evidenceTier)} / ${escapeHtml(profileSummary.graph.source)}</dd></div>
            <div><dt>Database</dt><dd><code>${escapeHtml(profileSummary.graph.dbPath)}</code></dd></div>
            <div><dt>Nodes</dt><dd>${escapeHtml(formatNullableCount(profileSummary.graph.nodeCount))}</dd></div>
            <div><dt>Edges</dt><dd>${escapeHtml(formatNullableCount(profileSummary.graph.edgeCount))}</dd></div>
            <div><dt>Communities</dt><dd>${escapeHtml(formatNullableCount(profileSummary.graph.communityCount))}</dd></div>
            <div><dt>Last import</dt><dd>${escapeHtml(profileSummary.graph.lastImportTimestamp ?? 'not-collected')}</dd></div>
            <div><dt>Source</dt><dd>${escapeHtml(profileSummary.graph.lastUpdateSource ?? 'not-collected')}</dd></div>
          </dl>
          <div class="subsection">
            <h4>Relations</h4>
            ${renderRelationCounts(profileSummary.graph.relationCounts)}
          </div>
          ${profileSummary.graph.warnings.length > 0 ? `<div class="subsection"><h4>Warnings</h4>${renderList(profileSummary.graph.warnings.map((warning) => escapeHtml(warning)))}</div>` : ''}
        </article>

        <article class="summary-panel profile-${escapeHtml(profileSummary.embedding.state)}">
          <div class="panel-head">
            <h3>Embedding profile</h3>
            <span class="badge">${escapeHtml(profileSummary.embedding.readiness)}</span>
          </div>
          <p class="summary">${escapeHtml(profileSummary.embedding.summary)}</p>
          <dl class="meta">
            <div><dt>Evidence</dt><dd>${escapeHtml(profileSummary.embedding.evidenceTier)} / ${escapeHtml(profileSummary.embedding.source)}</dd></div>
            <div><dt>Model</dt><dd>${escapeHtml(profileSummary.embedding.model ?? 'not-collected')}</dd></div>
            <div><dt>Provider</dt><dd>${escapeHtml(profileSummary.embedding.providerKey ?? 'not-collected')}</dd></div>
            <div><dt>Embedded</dt><dd>${escapeHtml(formatNullableCount(profileSummary.embedding.embeddedChunkCount))}</dd></div>
            <div><dt>Missing</dt><dd>${escapeHtml(formatNullableCount(profileSummary.embedding.missingChunkCount))}</dd></div>
            <div><dt>Failed</dt><dd>${escapeHtml(formatNullableCount(profileSummary.embedding.failedChunkCount))}</dd></div>
          </dl>
          <div class="subsection">
            <h4>Dimensions</h4>
            ${profileSummary.embedding.dimensions.length > 0
              ? `<ul class="list">${profileSummary.embedding.dimensions.map((entry) => `<li>${escapeHtml(entry.dimension)}: ${escapeHtml(entry.chunks)} chunk${entry.chunks === 1 ? '' : 's'}</li>`).join('')}</ul>`
              : '<p class="empty">not-collected</p>'}
          </div>
          ${profileSummary.embedding.warnings.length > 0 ? `<div class="subsection"><h4>Warnings</h4>${renderList(profileSummary.embedding.warnings.map((warning) => escapeHtml(warning)))}</div>` : ''}
        </article>
      </div>`;
}

export function buildByomemDashboardModel(options: BuildByomemDashboardModelOptions): DashboardModel {
  const statusReport = options.statusReport;
  const doctorReport = options.doctorReport;
  const generatedAt = normalizeTimestamp(options.generatedAt ?? statusReport.generatedAt ?? doctorReport.generatedAt);

  const allStatusComponents: DashboardStatusComponent[] = [
    buildStatusComponent('memory', statusReport, doctorReport),
    buildStatusComponent('file-search', statusReport, doctorReport),
    buildStatusComponent('graph', statusReport, doctorReport),
    buildStatusComponent('runtime-state', statusReport, doctorReport),
    buildStatusComponent('codex-config', statusReport, doctorReport),
  ];
  const { items: statusComponents, truncated: statusComponentsTruncated } = truncateItems(allStatusComponents, MAX_STATUS_COMPONENTS);

  const allDoctorChecks = doctorReport.checks.map((check) => buildDoctorCheck(check));
  const { items: doctorChecks, truncated: doctorChecksTruncated } = truncateItems(allDoctorChecks, MAX_DOCTOR_CHECKS);

  const warnings = dedupeStrings([
    ...statusReport.warnings,
    ...allStatusComponents.flatMap((component) => component.warnings),
    ...doctorReport.warnings,
    ...doctorChecks.flatMap((check) => check.warnings),
  ]);

  const overflowWarnings: string[] = [
    ...(statusComponentsTruncated ? [`Status components were truncated to ${MAX_STATUS_COMPONENTS} items; additional components were omitted.`] : []),
    ...(doctorChecksTruncated ? [`Doctor checks were truncated to ${MAX_DOCTOR_CHECKS} items; additional checks were omitted.`] : []),
  ];

  const suggestedActions = dedupeActions([
    ...doctorReport.suggestedActions,
    ...doctorChecks.flatMap((check) => check.suggestedActions),
  ]);
  const safeSuggestedActions = suggestedActions.filter(isSafeReadOnlyAction);
  const { items: boundedSuggestedActions, truncated: suggestedActionsTruncated } = truncateItems(safeSuggestedActions, MAX_SUGGESTED_ACTIONS);
  const finalSuggestedActions = boundedSuggestedActions;
  const boundedWarnings = withOverflowWarning(
    dedupeStrings([
      ...warnings,
      ...overflowWarnings,
      ...(suggestedActionsTruncated ? ['Suggested actions were truncated to 20 items; additional actions were omitted.'] : []),
    ]),
    MAX_WARNINGS,
    'Dashboard warnings were truncated to 20 items; additional warnings were omitted.',
  );
  const identityMeta: DashboardIdentityMeta = {
    runtimeVersion: statusReport.runtimeVersion,
    projectBaseDir: statusReport.projectBaseDir,
    runtimeBaseDir: statusReport.runtimeBaseDir,
    generatedAt,
    overallStatus: deriveOverallStatus(allDoctorChecks, allStatusComponents),
  };
  const kpiCards = buildKpiCards(statusComponents, doctorChecks, boundedWarnings, identityMeta.overallStatus);
  const capabilityBanners = buildCapabilityBanners(options);
  const profileSummary = options.profileSummary ?? buildNotCollectedDashboardProfileSummary({
    projectBaseDir: statusReport.projectBaseDir,
    runtimeBaseDir: statusReport.runtimeBaseDir,
    collectedAt: generatedAt,
  });
  const firstRunGuidance = buildFirstRunGuidance(statusComponents, statusReport.runtimeBaseDir);
  const commandCards = buildCommandCards(doctorReport, statusReport.runtimeBaseDir);
  const sectionSummaries = buildSectionSummaries(statusComponents, doctorChecks, boundedWarnings, commandCards.length);

  return {
    schemaVersion: 1,
    command: 'dashboard',
    runtimeVersion: statusReport.runtimeVersion,
    generatedAt,
    overallStatus: identityMeta.overallStatus,
    identityMeta,
    projectBaseDir: statusReport.projectBaseDir,
    runtimeBaseDir: statusReport.runtimeBaseDir,
    paths: {
      projectBaseDir: statusReport.projectBaseDir,
      runtimeBaseDir: statusReport.runtimeBaseDir,
    },
    degradedComponents: allStatusComponents
      .filter((component) => component.status !== 'ready')
      .map((component) => component.id),
    kpiCards,
    capabilityBanners,
    profileSummary,
    firstRunGuidance,
    sectionSummaries,
    commandCards,
    statusComponents,
    doctorChecks,
    warnings: boundedWarnings,
    suggestedActions: finalSuggestedActions,
  };
}

export function renderByomemDashboardHtml(model: DashboardModel): string {
  const dashboard = model as DashboardModel & {
    paths?: { projectBaseDir?: string; runtimeBaseDir?: string };
    projectBaseDir?: string;
    runtimeBaseDir?: string;
    identityMeta?: DashboardIdentityMeta;
    kpiCards?: DashboardKpiCard[];
    capabilityBanners?: DashboardCapabilityBanner[];
    profileSummary?: DashboardProfileSummary;
    firstRunGuidance?: DashboardCommandCard[];
    sectionSummaries?: DashboardSectionSummary[];
    commandCards?: DashboardCommandCard[];
    statusComponents?: DashboardStatusComponent[];
    doctorChecks?: DashboardDoctorCheck[];
    warnings?: string[];
    suggestedActions?: Array<string | DashboardSuggestedAction>;
  };
  const projectBaseDir = dashboard.paths?.projectBaseDir ?? dashboard.projectBaseDir ?? '';
  const runtimeBaseDir = dashboard.paths?.runtimeBaseDir ?? dashboard.runtimeBaseDir ?? '';
  const statusComponents = Array.isArray(dashboard.statusComponents) ? dashboard.statusComponents : [];
  const doctorChecks = Array.isArray(dashboard.doctorChecks) ? dashboard.doctorChecks : [];
  const warnings = Array.isArray(dashboard.warnings) ? dashboard.warnings : [];
  const suggestedActions = Array.isArray(dashboard.suggestedActions) ? dashboard.suggestedActions.filter((action) => typeof action === 'string' || isSafeReadOnlyAction(action)) : [];
  const identityMeta = dashboard.identityMeta ?? {
    runtimeVersion: dashboard.runtimeVersion,
    projectBaseDir,
    runtimeBaseDir,
    generatedAt: dashboard.generatedAt,
    overallStatus: dashboard.overallStatus,
  };

  const componentStatusSummary = statusComponents.reduce<Record<string, number>>((acc, component) => {
    acc[component.status] = (acc[component.status] ?? 0) + 1;
    return acc;
  }, {});
  const checkStatusSummary = doctorChecks.reduce<Record<string, number>>((acc, check) => {
    acc[check.status] = (acc[check.status] ?? 0) + 1;
    return acc;
  }, {});
  const kpiCards = Array.isArray(dashboard.kpiCards) && dashboard.kpiCards.length > 0
    ? dashboard.kpiCards
    : buildKpiCards(statusComponents, doctorChecks, warnings, dashboard.overallStatus);
  const capabilityBanners = Array.isArray(dashboard.capabilityBanners) && dashboard.capabilityBanners.length > 0
    ? dashboard.capabilityBanners
    : buildCapabilityBanners({ statusReport: {} as StatusReport, doctorReport: {} as DoctorReport });
  const profileSummary = dashboard.profileSummary ?? buildNotCollectedDashboardProfileSummary({
    projectBaseDir,
    runtimeBaseDir,
    collectedAt: dashboard.generatedAt,
  });
  const firstRunGuidance = Array.isArray(dashboard.firstRunGuidance) && dashboard.firstRunGuidance.length > 0
    ? dashboard.firstRunGuidance
    : buildFirstRunGuidance(statusComponents, runtimeBaseDir);
  const suggestedActionCards = suggestedActions
    .filter((action): action is DashboardSuggestedAction => typeof action !== 'string' && isSafeReadOnlyAction(action))
    .map((action, index) => toCommandCard(`action-${index}`, action));
  const commandCards: DashboardCommandCard[] = Array.isArray(dashboard.commandCards)
    ? (dashboard.commandCards.length > 0 ? dashboard.commandCards : suggestedActionCards)
    : [
        { id: 'status', label: 'Inspect status', command: `byomem-runtime status --base-dir ${runtimeBaseDir}`, mode: 'read-only' as const, summary: 'Copy and run manually for read-only status.' },
        { id: 'doctor', label: 'Inspect doctor', command: `byomem-runtime doctor --base-dir ${runtimeBaseDir} --json`, mode: 'read-only' as const, summary: 'Copy and run manually for read-only diagnostics.' },
        ...suggestedActionCards,
      ].slice(0, MAX_COMMAND_CARDS);
  const suggestedActionCount = commandCards.length > 0 ? commandCards.length : suggestedActions.length;
  const suggestedActionsBody = commandCards.length > 0
    ? renderCommandCards(commandCards)
    : renderActionList(suggestedActions);
  const sectionSummaries = Array.isArray(dashboard.sectionSummaries) && dashboard.sectionSummaries.length > 0
    ? dashboard.sectionSummaries
    : buildSectionSummaries(statusComponents, doctorChecks, warnings, suggestedActionCount);

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Byomem Runtime Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111416;
      --panel: #181c20;
      --panel-soft: #20262b;
      --text: #edf2f7;
      --muted: #a9b5c2;
      --line: #34404a;
      --accent: #7cb7ff;
      --warn: #ffd166;
      --fail: #ff8a80;
      --pass: #7bd88f;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.24);
    }
    :root[data-theme="light"], html:has(#theme-light:target) {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-soft: #fbfcfe;
      --text: #1f2937;
      --muted: #667085;
      --line: #d0d5dd;
      --accent: #275efe;
      --warn: #b54708;
      --fail: #b42318;
      --pass: #027a48;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
    }
    @media (prefers-color-scheme: light) {
      :root[data-theme="dark"] {
        color-scheme: dark;
      }
    }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      padding: 24px;
    }
    main {
      display: grid;
      gap: 20px;
    }
    .theme-target {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    a {
      color: var(--accent);
    }
    .hero, section, .panel, footer {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .hero, section, footer {
      padding: 20px;
    }
    .hero h1 {
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.2;
    }
    .hero .lead, .summary, .empty, .skipped {
      margin: 8px 0 0;
      color: var(--muted);
    }
    .grid {
      display: grid;
      gap: 20px;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .panel, .summary-panel, .command-card {
      padding: 16px;
      min-width: 0;
      max-width: 100%;
    }
    .summary-panel, .command-card {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-soft);
    }
    .panel-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
    }
    .panel-head h3, .section-head h2, .subsection h4 {
      margin: 0;
    }
    .hero h1,
    .panel-head h3,
    .section-head h2,
    .subsection h4,
    .disclosure-title,
    .summary,
    .empty,
    .skipped,
    .meta dd,
    .list li,
    .command-card code {
      min-width: 0;
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0;
      white-space: nowrap;
    }
    .badge, code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .meta {
      margin: 12px 0 0;
      display: grid;
      gap: 8px;
    }
    .meta > div {
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 12px;
    }
    .meta dt {
      color: var(--muted);
      font-weight: 600;
    }
    .meta dd {
      margin: 0;
      min-width: 0;
    }
    .subsection {
      margin-top: 14px;
    }
    .list {
      margin: 8px 0 0;
      padding-left: 18px;
    }
    .disclosure {
      margin-top: 16px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-soft);
    }
    .disclosure summary {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      cursor: pointer;
      list-style: none;
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .disclosure summary::-webkit-details-marker {
      display: none;
    }
    .disclosure-indicator {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      inline-size: 20px;
      block-size: 20px;
      border: 1px solid var(--line);
      border-radius: 4px;
      color: var(--accent);
      font: 700 14px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .disclosure-indicator::before {
      content: "+";
    }
    .disclosure[open] .disclosure-indicator::before {
      content: "-";
    }
    .disclosure summary:hover {
      color: var(--accent);
    }
    .disclosure summary:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 4px;
      border-radius: 4px;
    }
    .disclosure-title {
      flex: 1 1 auto;
      min-width: 0;
      font-weight: 600;
    }
    .disclosure-body {
      margin-top: 14px;
    }
    .status-ready .badge, .check-pass .badge {
      color: var(--pass);
      border-color: rgba(2, 122, 72, 0.35);
    }
    .status-degraded .badge, .status-missing .badge, .check-warn .badge, .check-skipped .badge {
      color: var(--warn);
      border-color: rgba(181, 71, 8, 0.35);
    }
    .check-fail .badge {
      color: var(--fail);
      border-color: rgba(180, 35, 24, 0.35);
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .kpi {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-soft);
      min-width: 0;
    }
    .kpi .value {
      display: block;
      margin-top: 4px;
      font-size: 20px;
      font-weight: 700;
      color: var(--text);
    }
    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .section-head p {
      margin: 0;
      color: var(--muted);
    }
    .stack {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }
    .banner-grid, .command-grid, .summary-grid, .profile-grid, nav, .theme-samples {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      margin-top: 16px;
    }
    nav a {
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-soft);
      text-decoration: none;
    }
    .theme-switch {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }
    .theme-switch a {
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-soft);
      text-decoration: none;
    }
    .theme-sample {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-soft);
    }
    .theme-sample[data-theme="light"] {
      color-scheme: light;
      color: #1f2937;
      background: #fbfcfe;
      border-color: #d0d5dd;
    }
    code {
      white-space: break-spaces;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <div id="theme-dark" class="theme-target" aria-hidden="true"></div>
  <div id="theme-light" class="theme-target" aria-hidden="true"></div>
  <main>
    <header class="hero">
      <h1>Byomem Runtime Dashboard</h1>
      <p class="lead">Read-only snapshot of runtime status and doctor evidence.</p>
      <p class="lead">Generated at <time datetime="${escapeHtml(identityMeta.generatedAt)}">${escapeHtml(identityMeta.generatedAt)}</time>. Overall status: <strong>${escapeHtml(identityMeta.overallStatus)}</strong>.</p>
      <div class="kpis">
        <div class="kpi"><span>Runtime version</span><span class="value">${escapeHtml(identityMeta.runtimeVersion)}</span></div>
        <div class="kpi"><span>Project base dir</span><span class="value"><code>${escapeHtml(identityMeta.projectBaseDir)}</code></span></div>
        <div class="kpi"><span>Runtime base dir</span><span class="value"><code>${escapeHtml(identityMeta.runtimeBaseDir)}</code></span></div>
      </div>
      <div class="kpis">
        ${kpiCards.map((card) => `<div class="kpi"><span>${escapeHtml(card.label)}</span><span class="value">${escapeHtml(card.value)}</span><p class="summary">${escapeHtml(card.summary)}</p></div>`).join('')}
      </div>
    </header>

    <nav aria-label="Dashboard sections">
      <a href="#profile-summary">Profile summary</a>
      <a href="#status-components">Status components</a>
      <a href="#doctor-checks">Doctor checks</a>
      <a href="#warnings">Warnings</a>
      <a href="#suggested-actions">Suggested actions</a>
    </nav>

    <section id="capabilities">
      <div class="section-head">
        <h2>Capabilities</h2>
        <p>Static feature evidence without live runtime probes.</p>
      </div>
      ${renderCapabilityBanners(capabilityBanners)}
      <div class="theme-switch" aria-label="Theme mode">
        <a href="#theme-dark">Dark</a>
        <a href="#theme-light">Light</a>
      </div>
      <div class="theme-samples" aria-label="Theme samples">
        <div class="theme-sample" data-theme="dark">Dark theme default</div>
        <div class="theme-sample" data-theme="light">Light theme CSS path</div>
      </div>
    </section>

    <section id="profile-summary">
      <div class="section-head">
        <h2>Profile summary</h2>
        <p>Read-only project profile evidence collected at ${escapeHtml(profileSummary.collectedAt)}.</p>
      </div>
      ${renderProfileSummary(profileSummary)}
    </section>

    <section id="first-run-guidance">
      <div class="section-head">
        <h2>First run guidance</h2>
        <p>Copy-only read-only checks for missing local artifacts.</p>
      </div>
      ${renderCommandCards(firstRunGuidance, 'No first-run guidance needed.')}
    </section>

    <section id="section-summaries">
      <div class="section-head">
        <h2>Section summaries</h2>
        <p>Fast scan of dashboard areas.</p>
      </div>
      <div class="summary-grid">
        ${sectionSummaries.map((summary) => `
        <article class="summary-panel">
          <div class="panel-head">
            <h3>${escapeHtml(summary.label)}</h3>
            <span class="badge">${escapeHtml(summary.status)}</span>
          </div>
          <p class="summary">${escapeHtml(summary.summary)}</p>
        </article>`).join('')}
      </div>
    </section>

    <section id="status-components">
      <div class="section-head">
        <h2>Status components</h2>
        <p>Presentation layer over status-report evidence.</p>
      </div>
      <div class="grid">
        ${statusComponents.map((component) => renderStatusComponent(component)).join('')}
      </div>
    </section>

    <section id="doctor-checks">
      <div class="section-head">
        <h2>Doctor checks</h2>
        <p>Read-only diagnostics remain separate from status components.</p>
      </div>
      ${renderDisclosureSection({
        title: 'Doctor checks',
        status: doctorChecks.some((check) => check.status === 'fail') ? 'fail' : doctorChecks.some((check) => check.status === 'warn') ? 'warn' : doctorChecks.length > 0 ? 'pass' : 'empty',
        countLabel: String(doctorChecks.length),
        open: doctorChecks.some((check) => check.status === 'fail' || check.status === 'warn'),
        bodyHtml: doctorChecks.length > 0 ? `<div class="stack">${doctorChecks.map((check) => renderDoctorCheck(check)).join('')}</div>` : '<p class="empty">None.</p>',
      })}
    </section>

    <section id="warnings">
      <div class="section-head">
        <h2>Warnings</h2>
        <p>Bounded and deduplicated for compact inspection.</p>
      </div>
      ${renderDisclosureSection({
        title: 'Warnings',
        status: warnings.length > 0 ? 'present' : 'empty',
        countLabel: String(warnings.length),
        open: warnings.length > 0,
        bodyHtml: warnings.length > 0 ? renderList(warnings.map((warning) => escapeHtml(warning))) : '<p class="empty">None.</p>',
      })}
    </section>

    <section id="suggested-actions">
      <div class="section-head">
        <h2>Suggested actions</h2>
        <p>Copy-friendly read-only commands. Nothing runs from this page.</p>
      </div>
      ${renderDisclosureSection({
        title: 'Suggested actions',
        status: suggestedActionCount > 0 ? 'copy-only' : 'empty',
        countLabel: String(suggestedActionCount),
        open: suggestedActionCount > 0,
        bodyHtml: suggestedActionCount > 0 ? suggestedActionsBody : '<p class="empty">None.</p>',
      })}
    </section>
  </main>
  <footer>
    <p>BYOMem runtime ${escapeHtml(dashboard.runtimeVersion)}. Static, read-only, self-contained dashboard.</p>
    <p>Docs: <a href="https://github.com/ericsmith/byomem/blob/main/README.md">README</a> · Runtime runbook: <a href="https://github.com/ericsmith/byomem/blob/main/docs/byomem-runtime-operations-runbook.md">operations runbook</a> · Repository: <a href="https://github.com/ericsmith/byomem">GitHub</a> · Issues: <a href="https://github.com/ericsmith/byomem/issues">report an issue</a></p>
  </footer>
</body>
</html>`;
}
