import type {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorEvidenceConfidence,
  DoctorReport,
  DoctorSeverity,
  DoctorSuggestedAction,
  DoctorOverallStatus,
} from './doctor.js';
import { buildNotCollectedDashboardProfileSummary, type DashboardFileSearchHealth, type DashboardProfileSummary } from './dashboard-profile.js';
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
  id: DashboardStatusComponentId | 'runtime-processes' | 'doctor-checks' | 'warnings' | 'suggested-actions';
  label: string;
  status: DashboardStatusComponentStatus | DoctorOverallStatus;
  summary: string;
  href: string;
};

export type DashboardRuntimeProcessRecord = {
  role: string;
  serverName: string;
  pid: number;
  ppid: number | null;
  entrypoint: string;
  runtimeVersion: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  state: 'active' | 'stale';
  staleReason: 'pid-not-running' | 'heartbeat-expired' | null;
  path: string;
  identity: DashboardRuntimeProcessIdentity | null;
};

export type DashboardRuntimeProcessIdentity = {
  projectKey: string | null;
  projectDisplayName: string | null;
  projectBaseDir: string | null;
  projectSource: string | null;
  sessionKey: string | null;
  sessionLabel: string | null;
  clientInstanceId: string | null;
};

export type DashboardContextOption = {
  contextId: string;
  status: 'ready' | 'degraded' | 'stale' | 'unknown';
  label: string;
  projectKey: string | null;
  projectDisplayName: string | null;
  projectBaseDir: string | null;
  sessionKey: string | null;
  sessionLabel: string | null;
  roles: string[];
  processCounts: {
    total: number;
    active: number;
    stale: number;
    malformed: number;
  };
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  evidenceConfidence: DoctorEvidenceConfidence;
  warnings: string[];
};

export type DashboardSelectedContext = DashboardContextOption & {
  summary: string;
};

export type DashboardActiveContext = {
  selectedContextId: string;
  options: DashboardContextOption[];
  warnings: string[];
};

export type DashboardRuntimeProcessPanel = {
  source: 'runtime-state';
  evidenceTier: 'stat-only';
  evidenceConfidence: DoctorEvidenceConfidence;
  status: DashboardStatusComponentStatus;
  summary: string;
  counts: {
    total: number;
    active: number;
    stale: number;
    malformed: number;
  };
  roles: string[];
  duplicateActiveRoles: Array<{
    role: string;
    count: number;
    records: Array<{
      pid: number | null;
      serverName: string | null;
      entrypoint: string | null;
      path: string;
    }>;
  }>;
  records: DashboardRuntimeProcessRecord[];
  malformed: Array<{
    path: string;
    error: string;
  }>;
  warnings: string[];
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
  runtimeProcesses: DashboardRuntimeProcessPanel;
  activeContext: DashboardActiveContext;
  selectedContext: DashboardSelectedContext;
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
const MAX_RUNTIME_PROCESS_RECORDS = 24;
const MAX_RUNTIME_PROCESS_MALFORMED = 24;
const MAX_RUNTIME_PROCESS_DUPLICATE_ROLES = 24;
const MAX_RUNTIME_PROCESS_DUPLICATE_RECORDS = 12;
const MAX_ACTIVE_CONTEXT_OPTIONS = 24;
const DASHBOARD_FAVICON_DATA_URI = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2214%22 fill=%22%23111416%22/%3E%3Cpath d=%22M20 32h24M32 20v24M23 23l18 18M41 23L23 41%22 stroke=%22%237cb7ff%22 stroke-width=%224%22 stroke-linecap=%22round%22 opacity=%22.9%22/%3E%3Ccircle cx=%2232%22 cy=%2232%22 r=%2210%22 fill=%22%23181c20%22 stroke=%22%23edf2f7%22 stroke-width=%224%22/%3E%3Ccircle cx=%2218%22 cy=%2218%22 r=%226%22 fill=%22%237bd88f%22/%3E%3Ccircle cx=%2246%22 cy=%2218%22 r=%226%22 fill=%22%237bd88f%22/%3E%3Ccircle cx=%2218%22 cy=%2246%22 r=%226%22 fill=%22%237bd88f%22/%3E%3Ccircle cx=%2246%22 cy=%2246%22 r=%226%22 fill=%22%237bd88f%22/%3E%3Ccircle cx=%2232%22 cy=%2232%22 r=%224%22 fill=%22%23ffd166%22/%3E%3C/svg%3E';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function processState(value: unknown): 'active' | 'stale' {
  return value === 'stale' ? 'stale' : 'active';
}

function staleReason(value: unknown): 'pid-not-running' | 'heartbeat-expired' | null {
  return value === 'pid-not-running' || value === 'heartbeat-expired' ? value : null;
}

function mapRuntimeProcessIdentity(value: unknown): DashboardRuntimeProcessIdentity | null {
  if (!isRecord(value)) return null;
  return {
    projectKey: stringOrNull(value.projectKey),
    projectDisplayName: stringOrNull(value.projectDisplayName),
    projectBaseDir: stringOrNull(value.projectBaseDir),
    projectSource: stringOrNull(value.projectSource),
    sessionKey: stringOrNull(value.sessionKey),
    sessionLabel: stringOrNull(value.sessionLabel),
    clientInstanceId: stringOrNull(value.clientInstanceId),
  };
}

function findRuntimeProcessLivenessCheck(doctorReport: DoctorReport): DoctorCheck | undefined {
  return doctorReport.checks.find((check) => check.id === 'runtime-state.process-liveness');
}

function runtimeProcessWarnings(statusReport: StatusReport, livenessCheck: DoctorCheck | undefined, extra: string[] = []): string[] {
  return dedupeStrings([
    ...statusReport.mcpProcesses.warnings,
    ...(livenessCheck?.warnings ?? []),
    ...extra,
  ]);
}

function mapRuntimeProcessRecord(value: unknown): DashboardRuntimeProcessRecord | null {
  if (!isRecord(value)) return null;
  const role = stringOrNull(value.role);
  const serverName = stringOrNull(value.serverName);
  const pid = numberOrNull(value.pid);
  const path = stringOrNull(value.path);
  if (!role || !serverName || pid === null || !path) return null;
  return {
    role,
    serverName,
    pid,
    ppid: numberOrNull(value.ppid),
    entrypoint: stringOrNull(value.entrypoint) ?? 'not-collected',
    runtimeVersion: stringOrNull(value.runtimeVersion),
    startedAt: stringOrNull(value.startedAt),
    lastHeartbeatAt: stringOrNull(value.lastHeartbeatAt),
    state: processState(value.state),
    staleReason: staleReason(value.staleReason),
    path,
    identity: mapRuntimeProcessIdentity(value.identity),
  };
}

function mapRuntimeProcessMalformed(value: unknown): { path: string; error: string } | null {
  if (!isRecord(value)) return null;
  const path = stringOrNull(value.path);
  const error = stringOrNull(value.error);
  if (!path || !error) return null;
  return { path, error };
}

function mapRuntimeProcessDuplicateRecord(value: unknown): DashboardRuntimeProcessPanel['duplicateActiveRoles'][number]['records'][number] | null {
  if (!isRecord(value)) return null;
  const path = stringOrNull(value.path);
  if (!path) return null;
  return {
    pid: numberOrNull(value.pid),
    serverName: stringOrNull(value.serverName),
    entrypoint: stringOrNull(value.entrypoint),
    path,
  };
}

function sortRuntimeProcessDuplicateRecords(
  records: DashboardRuntimeProcessPanel['duplicateActiveRoles'][number]['records'],
): DashboardRuntimeProcessPanel['duplicateActiveRoles'][number]['records'] {
  return [...records].sort((a, b) => (
    (a.pid ?? Number.MAX_SAFE_INTEGER) - (b.pid ?? Number.MAX_SAFE_INTEGER)
    || (a.serverName ?? '').localeCompare(b.serverName ?? '')
    || (a.entrypoint ?? '').localeCompare(b.entrypoint ?? '')
    || a.path.localeCompare(b.path)
  ));
}

function mapRuntimeProcessDuplicateRole(value: unknown): DashboardRuntimeProcessPanel['duplicateActiveRoles'][number] | null {
  if (!isRecord(value)) return null;
  const role = stringOrNull(value.role);
  const count = numberOrNull(value.count);
  if (!role || count === null) return null;
  const rawRecords = Array.isArray(value.records) ? value.records : [];
  const records = sortRuntimeProcessDuplicateRecords(rawRecords
    .map(mapRuntimeProcessDuplicateRecord)
    .filter((entry): entry is DashboardRuntimeProcessPanel['duplicateActiveRoles'][number]['records'][number] => Boolean(entry)));
  const { items: boundedRecords } = truncateItems(records, MAX_RUNTIME_PROCESS_DUPLICATE_RECORDS);
  return { role, count, records: boundedRecords };
}

function sortRuntimeProcessDuplicateRoles(
  duplicates: DashboardRuntimeProcessPanel['duplicateActiveRoles'],
): DashboardRuntimeProcessPanel['duplicateActiveRoles'] {
  return [...duplicates].sort((a, b) => (
    a.role.localeCompare(b.role)
    || b.count - a.count
    || (a.records[0]?.pid ?? Number.MAX_SAFE_INTEGER) - (b.records[0]?.pid ?? Number.MAX_SAFE_INTEGER)
  ));
}

function runtimeProcessStatus(statusReport: StatusReport): DashboardStatusComponentStatus {
  const warnings = statusReport.mcpProcesses.warnings ?? [];
  const duplicateActiveRoles = statusReport.mcpProcesses.duplicateActiveRoles ?? [];
  const missingDirectory = statusReport.mcpProcesses.count === 0
    && warnings.some((warning) => warning.toLowerCase().includes('runtime process state directory is missing'));
  if (missingDirectory) return 'missing';
  if (
    statusReport.mcpProcesses.staleCount > 0
    || statusReport.mcpProcesses.malformedCount > 0
    || duplicateActiveRoles.length > 0
    || warnings.length > 0
  ) return 'degraded';
  return 'ready';
}

function runtimeProcessSummary(panel: Omit<DashboardRuntimeProcessPanel, 'summary'>): string {
  if (panel.status === 'missing') return 'Runtime process state directory is missing.';
  if (panel.counts.total === 0 && panel.counts.malformed === 0) return 'No runtime process records are present.';
  const parts = [
    `${panel.counts.active} active`,
    `${panel.counts.stale} stale`,
    `${panel.counts.malformed} malformed`,
  ];
  return `${parts.join(', ')} runtime-state record${panel.counts.total === 1 ? '' : 's'} from ${panel.source}.`;
}

function sortRuntimeProcessRecords(records: DashboardRuntimeProcessRecord[]): DashboardRuntimeProcessRecord[] {
  const stateRank = (state: DashboardRuntimeProcessRecord['state']) => (state === 'active' ? 0 : 1);
  return [...records].sort((a, b) => (
    stateRank(a.state) - stateRank(b.state)
    || a.role.localeCompare(b.role)
    || a.pid - b.pid
    || a.serverName.localeCompare(b.serverName)
    || a.entrypoint.localeCompare(b.entrypoint)
    || a.path.localeCompare(b.path)
  ));
}

function buildRuntimeProcessPanel(statusReport: StatusReport, doctorReport: DoctorReport): DashboardRuntimeProcessPanel {
  const livenessCheck = findRuntimeProcessLivenessCheck(doctorReport);
  const evidence = isRecord(livenessCheck?.evidence) ? livenessCheck.evidence : {};
  const rawRecords = Array.isArray(evidence.records) ? evidence.records : [];
  const rawMalformed = Array.isArray(evidence.malformed) ? evidence.malformed : [];
  const sortedRecords = sortRuntimeProcessRecords(rawRecords.map(mapRuntimeProcessRecord).filter((entry): entry is DashboardRuntimeProcessRecord => Boolean(entry)));
  const malformed = rawMalformed.map(mapRuntimeProcessMalformed).filter((entry): entry is { path: string; error: string } => Boolean(entry));
  const duplicateRoles = sortRuntimeProcessDuplicateRoles((statusReport.mcpProcesses.duplicateActiveRoles ?? [])
    .map(mapRuntimeProcessDuplicateRole)
    .filter((entry): entry is DashboardRuntimeProcessPanel['duplicateActiveRoles'][number] => Boolean(entry)));
  const { items: boundedRecords, truncated: recordsTruncated } = truncateItems(sortedRecords, MAX_RUNTIME_PROCESS_RECORDS);
  const { items: boundedMalformed, truncated: malformedTruncated } = truncateItems(malformed, MAX_RUNTIME_PROCESS_MALFORMED);
  const { items: boundedDuplicateRoles, truncated: duplicateRolesTruncated } = truncateItems(duplicateRoles, MAX_RUNTIME_PROCESS_DUPLICATE_ROLES);
  const duplicateRecordsTruncated = duplicateRoles
    .slice(0, MAX_RUNTIME_PROCESS_DUPLICATE_ROLES)
    .some((entry) => entry.count > entry.records.length);
  const counts = {
    total: statusReport.mcpProcesses.count,
    active: Math.max(0, statusReport.mcpProcesses.count - statusReport.mcpProcesses.staleCount),
    stale: statusReport.mcpProcesses.staleCount,
    malformed: statusReport.mcpProcesses.malformedCount,
  };
  const basePanel = {
    source: 'runtime-state' as const,
    evidenceTier: 'stat-only' as const,
    evidenceConfidence: livenessCheck?.evidenceConfidence ?? 'not-applicable',
    status: runtimeProcessStatus(statusReport),
    counts,
    roles: [...(statusReport.mcpProcesses.roles ?? [])].sort(),
    duplicateActiveRoles: boundedDuplicateRoles,
    records: boundedRecords,
    malformed: boundedMalformed,
    warnings: runtimeProcessWarnings(statusReport, livenessCheck, [
      ...(duplicateRolesTruncated ? [`Duplicate active role summaries were truncated to ${MAX_RUNTIME_PROCESS_DUPLICATE_ROLES} roles; additional roles were omitted.`] : []),
      ...(duplicateRecordsTruncated ? [`Duplicate active role records were truncated to ${MAX_RUNTIME_PROCESS_DUPLICATE_RECORDS} records per role; additional records were omitted.`] : []),
      ...(recordsTruncated ? [`Runtime process records were truncated to ${MAX_RUNTIME_PROCESS_RECORDS} items; additional records were omitted.`] : []),
      ...(malformedTruncated ? [`Malformed runtime process records were truncated to ${MAX_RUNTIME_PROCESS_MALFORMED} items; additional records were omitted.`] : []),
    ]),
  };
  return {
    ...basePanel,
    summary: runtimeProcessSummary(basePanel),
  };
}

function compareNullableTimestamp(a: string | null, b: string | null, direction: 'asc' | 'desc'): string | null {
  if (!a) return b;
  if (!b) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs)) return b;
  if (Number.isNaN(bMs)) return a;
  return direction === 'asc' ? (aMs <= bMs ? a : b) : (aMs >= bMs ? a : b);
}

function basenameFromPath(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? value;
}

function contextIdForRecord(record: DashboardRuntimeProcessRecord, fallbackProjectKey: string): string {
  const identity = record.identity;
  if (!identity?.projectKey && !identity?.sessionKey) return `project:${fallbackProjectKey}`;
  if (identity?.projectKey && !identity.sessionKey) return `project:${identity.projectKey}`;
  const projectKey = identity?.projectKey ?? 'unknown-project';
  const sessionKey = identity?.sessionKey ?? 'unknown-session';
  return `${projectKey}:${sessionKey}`;
}

function contextLabel(
  identity: DashboardRuntimeProcessIdentity | null,
  contextId: string,
  records: DashboardRuntimeProcessRecord[],
  fallbackProjectDisplayName: string,
): string {
  if (!identity) {
    const count = records.length;
    return `${fallbackProjectDisplayName} (${count} MCP session${count === 1 ? '' : 's'})`;
  }
  const project = identity.projectDisplayName ?? identity.projectKey;
  const session = identity.sessionLabel ?? identity.sessionKey;
  if (project && !session) {
    const count = records.length;
    return `${project} (${count} MCP session${count === 1 ? '' : 's'})`;
  }
  if (project && session) return `${project} / ${session}`;
  return project ?? session ?? contextId;
}

function contextStatus(records: DashboardRuntimeProcessRecord[], malformedCount: number, warnings: string[]): DashboardContextOption['status'] {
  if (records.length === 0) return malformedCount > 0 || warnings.length > 0 ? 'degraded' : 'unknown';
  if (records.every((record) => record.state === 'stale')) return 'stale';
  if (records.some((record) => record.state === 'stale') || malformedCount > 0 || warnings.length > 0) return 'degraded';
  if (records.some((record) => !record.identity)) return 'unknown';
  return 'ready';
}

function selectedContextSummary(option: DashboardContextOption): string {
  const parts = [
    option.label,
    `${option.processCounts.active} active`,
    `${option.processCounts.stale} stale`,
    `${option.processCounts.malformed} malformed`,
    option.roles.length ? `roles: ${option.roles.join(', ')}` : 'roles: none',
  ];
  return `Selected context summary: ${parts.join('; ')}.`;
}

function buildActiveContext(runtimeProcesses: DashboardRuntimeProcessPanel, statusReport: StatusReport): {
  activeContext: DashboardActiveContext;
  selectedContext: DashboardSelectedContext;
} {
  const warnings: string[] = [];
  const groups = new Map<string, DashboardRuntimeProcessRecord[]>();
  const fallbackProjectKey = statusReport.projectKey || 'active-project';
  const fallbackProjectDisplayName = basenameFromPath(statusReport.projectBaseDir) || fallbackProjectKey;
  let unknownRecords = 0;
  for (const record of runtimeProcesses.records) {
    const contextId = contextIdForRecord(record, fallbackProjectKey);
    if (!record.identity) unknownRecords += 1;
    const records = groups.get(contextId) ?? [];
    records.push(record);
    groups.set(contextId, records);
  }
  if (unknownRecords > 0) warnings.push(`${unknownRecords} runtime process record(s) had unknown safe active-context identity and were grouped under the active project fallback.`);
  for (const [contextId, records] of groups) {
    const clientIds = new Set(records.map((record) => record.identity?.clientInstanceId).filter(Boolean));
    if (clientIds.size > 1) warnings.push(`Active context identity collision detected for ${contextId}; multiple client instances share the same project/session keys.`);
  }
  if (runtimeProcesses.records.length > MAX_ACTIVE_CONTEXT_OPTIONS || groups.size > MAX_ACTIVE_CONTEXT_OPTIONS) {
    warnings.push(`Active context options were truncated to ${MAX_ACTIVE_CONTEXT_OPTIONS} items; additional runtime records or contexts were omitted.`);
  }
  if (runtimeProcesses.warnings.some((warning) => warning.toLowerCase().includes('truncated'))) {
    warnings.push(`Active context options were truncated to ${MAX_ACTIVE_CONTEXT_OPTIONS} items; additional runtime records or contexts were omitted.`);
  }

  const options = [...groups.entries()]
    .map(([contextId, records]): DashboardContextOption => {
      const identity = records.find((record) => record.identity)?.identity ?? null;
      const active = records.filter((record) => record.state === 'active').length;
      const stale = records.filter((record) => record.state === 'stale').length;
      const contextWarnings = warnings.filter((warning) => warning.includes(contextId));
      return {
        contextId,
        status: contextStatus(records, 0, contextWarnings),
        label: contextLabel(identity, contextId, records, fallbackProjectDisplayName),
        projectKey: identity?.projectKey ?? (!identity ? fallbackProjectKey : null),
        projectDisplayName: identity?.projectDisplayName ?? (!identity ? fallbackProjectDisplayName : null),
        projectBaseDir: identity?.projectBaseDir ?? null,
        sessionKey: identity?.sessionKey ?? null,
        sessionLabel: identity?.sessionLabel ?? null,
        roles: dedupeStrings(records.map((record) => record.role)).sort(),
        processCounts: {
          total: records.length,
          active,
          stale,
          malformed: 0,
        },
        startedAt: records.reduce<string | null>((candidate, record) => compareNullableTimestamp(candidate, record.startedAt, 'asc'), null),
        lastHeartbeatAt: records.reduce<string | null>((candidate, record) => compareNullableTimestamp(candidate, record.lastHeartbeatAt, 'desc'), null),
        evidenceConfidence: records.some((record) => record.identity && record.state === 'active') ? 'definite' : runtimeProcesses.evidenceConfidence,
        warnings: contextWarnings,
      };
    })
    .sort((a, b) => (
      (a.contextId.startsWith('unknown:') ? 1 : 0) - (b.contextId.startsWith('unknown:') ? 1 : 0)
      || (a.startedAt ?? '').localeCompare(b.startedAt ?? '')
      || a.contextId.localeCompare(b.contextId)
    ))
    .slice(0, MAX_ACTIVE_CONTEXT_OPTIONS);

  const fallback: DashboardContextOption = {
    contextId: 'alpha',
    status: runtimeProcesses.counts.total > 0 ? 'unknown' : 'unknown',
    label: runtimeProcesses.counts.total > 0 ? 'Unknown session' : 'Active sessions unavailable',
    projectKey: null,
    projectDisplayName: null,
    projectBaseDir: null,
    sessionKey: null,
    sessionLabel: null,
    roles: runtimeProcesses.roles,
    processCounts: runtimeProcesses.counts,
    startedAt: null,
    lastHeartbeatAt: null,
    evidenceConfidence: runtimeProcesses.evidenceConfidence,
    warnings: runtimeProcesses.warnings,
  };
  const selected = options[0] ?? fallback;
  return {
    activeContext: {
      selectedContextId: selected.contextId,
      options: options.length ? options : [fallback],
      warnings: dedupeStrings(warnings),
    },
    selectedContext: {
      ...selected,
      summary: selectedContextSummary(selected),
    },
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
  runtimeProcesses?: DashboardRuntimeProcessPanel,
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
    ...(runtimeProcesses ? [{
      id: 'runtime-processes' as const,
      label: 'Runtime processes',
      status: runtimeProcesses.status,
      summary: runtimeProcesses.summary,
      href: '#runtime-processes',
    }] : []),
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

function renderRuntimeProcessRoles(roles: string[]): string {
  return renderList(roles.map((role) => escapeHtml(role)));
}

function renderRuntimeProcessDuplicates(duplicates: DashboardRuntimeProcessPanel['duplicateActiveRoles']): string {
  if (duplicates.length === 0) return '<p class="empty">None.</p>';
  return `<div class="stack">${duplicates.map((duplicate) => `
        <article class="summary-panel">
          <div class="panel-head">
            <h3>${escapeHtml(duplicate.role)}</h3>
            <span class="badge">${escapeHtml(duplicate.count)}</span>
          </div>
          <p class="summary">Duplicate active role records.</p>
          <dl class="meta">
            ${duplicate.records.map((record) => `
            <div><dt>PID</dt><dd>${escapeHtml(record.pid ?? 'not-collected')}</dd></div>
            <div><dt>Server</dt><dd>${escapeHtml(record.serverName ?? 'not-collected')}</dd></div>
            <div><dt>Entrypoint</dt><dd>${escapeHtml(record.entrypoint ?? 'not-collected')}</dd></div>
            <div><dt>Path</dt><dd><code>${escapeHtml(record.path)}</code></dd></div>`).join('')}
          </dl>
        </article>`).join('')}</div>`;
}

function renderRuntimeProcessRecords(records: DashboardRuntimeProcessRecord[]): string {
  if (records.length === 0) return '<p class="empty">None.</p>';
  return `<div class="grid">${records.map((record) => `
        <article class="panel status-${escapeHtml(record.state === 'active' ? 'ready' : 'degraded')}">
          <div class="panel-head">
            <h3>${escapeHtml(record.role)}</h3>
            <span class="badge">${escapeHtml(record.state)}</span>
          </div>
          <p class="summary">${escapeHtml(record.serverName)}</p>
          <dl class="meta">
            <div><dt>PID</dt><dd>${escapeHtml(record.pid)}</dd></div>
            <div><dt>PPID</dt><dd>${escapeHtml(record.ppid ?? 'not-collected')}</dd></div>
            <div><dt>Entrypoint</dt><dd>${escapeHtml(record.entrypoint)}</dd></div>
            <div><dt>Version</dt><dd>${escapeHtml(record.runtimeVersion ?? 'not-collected')}</dd></div>
            <div><dt>Started</dt><dd>${escapeHtml(record.startedAt ?? 'not-collected')}</dd></div>
            <div><dt>Heartbeat</dt><dd>${escapeHtml(record.lastHeartbeatAt ?? 'not-collected')}</dd></div>
            <div><dt>Stale reason</dt><dd>${escapeHtml(record.staleReason ?? 'not-applicable')}</dd></div>
            <div><dt>Path</dt><dd><code>${escapeHtml(record.path)}</code></dd></div>
          </dl>
        </article>`).join('')}</div>`;
}

function renderRuntimeProcessMalformed(malformed: DashboardRuntimeProcessPanel['malformed']): string {
  if (malformed.length === 0) return '<p class="empty">None.</p>';
  return `<ul class="list">${malformed.map((entry) => `<li><code>${escapeHtml(entry.path)}</code>: ${escapeHtml(entry.error)}</li>`).join('')}</ul>`;
}

function renderRuntimeProcessPanel(panel: DashboardRuntimeProcessPanel): string {
  return `
      <div class="summary-grid">
        <article class="summary-panel status-${escapeHtml(panel.status)}">
          <div class="panel-head">
            <h3>Runtime process inventory</h3>
            <span class="badge">${escapeHtml(panel.status)}</span>
          </div>
          <p class="summary">${escapeHtml(panel.summary)}</p>
          <dl class="meta">
            <div><dt>Source</dt><dd>${escapeHtml(panel.source)}</dd></div>
            <div><dt>Evidence</dt><dd>${escapeHtml(panel.evidenceConfidence)} / ${escapeHtml(panel.evidenceTier)}</dd></div>
            <div><dt>Total</dt><dd>${escapeHtml(panel.counts.total)}</dd></div>
            <div><dt>Active</dt><dd>${escapeHtml(panel.counts.active)}</dd></div>
            <div><dt>Stale</dt><dd>${escapeHtml(panel.counts.stale)}</dd></div>
            <div><dt>Malformed</dt><dd>${escapeHtml(panel.counts.malformed)}</dd></div>
          </dl>
        </article>
        <article class="summary-panel">
          <div class="panel-head">
            <h3>Roles</h3>
            <span class="badge">${escapeHtml(panel.roles.length)}</span>
          </div>
          ${renderRuntimeProcessRoles(panel.roles)}
        </article>
      </div>
      <div class="subsection">
        <h4>Duplicate active roles</h4>
        ${renderRuntimeProcessDuplicates(panel.duplicateActiveRoles)}
      </div>
      <div class="subsection">
        <h4>Process records</h4>
        ${renderRuntimeProcessRecords(panel.records)}
      </div>
      <div class="subsection">
        <h4>Malformed records</h4>
        ${renderRuntimeProcessMalformed(panel.malformed)}
      </div>
      <div class="subsection">
        <h4>Warnings</h4>
        ${renderList(panel.warnings.map((warning) => escapeHtml(warning)))}
      </div>`;
}

function renderSelectedContext(context: DashboardSelectedContext | undefined): string {
  if (!context) return '';
  return `
    <!-- escaped-marker:&lt; -->
    <section id="selected-context">
      <div class="section-head">
        <h2>Selected context</h2>
        <span class="badge">${escapeHtml(context.status)}</span>
      </div>
      <div class="summary-grid">
        <article class="summary-panel status-${escapeHtml(context.status === 'ready' ? 'ready' : context.status === 'stale' ? 'degraded' : context.status)}">
          <div class="panel-head">
            <h3>${escapeHtml(context.label)}</h3>
            <span class="badge">${escapeHtml(context.contextId)}</span>
          </div>
          <p class="summary">${escapeHtml(context.summary)}</p>
          <dl class="meta">
            <div><dt>Project</dt><dd>${escapeHtml(context.projectDisplayName ?? context.projectKey ?? 'not-collected')}</dd></div>
            <div><dt>Session</dt><dd>${escapeHtml(context.sessionLabel ?? context.sessionKey ?? 'not-collected')}</dd></div>
            <div><dt>Base dir</dt><dd><code>${escapeHtml(context.projectBaseDir ?? 'not-collected')}</code></dd></div>
            <div><dt>Roles</dt><dd>${escapeHtml(context.roles.join(', ') || 'none')}</dd></div>
            <div><dt>Started</dt><dd>${escapeHtml(context.startedAt ?? 'not-collected')}</dd></div>
            <div><dt>Heartbeat</dt><dd>${escapeHtml(context.lastHeartbeatAt ?? 'not-collected')}</dd></div>
            <div><dt>Evidence</dt><dd>${escapeHtml(context.evidenceConfidence)}</dd></div>
          </dl>
        </article>
        <article class="summary-panel">
          <div class="panel-head">
            <h3>Context summary</h3>
            <span class="badge">${escapeHtml(context.processCounts.total)}</span>
          </div>
          <dl class="meta">
            <div><dt>Total</dt><dd>${escapeHtml(context.processCounts.total)}</dd></div>
            <div><dt>Active</dt><dd>${escapeHtml(context.processCounts.active)}</dd></div>
            <div><dt>Stale</dt><dd>${escapeHtml(context.processCounts.stale)}</dd></div>
            <div><dt>Malformed</dt><dd>${escapeHtml(context.processCounts.malformed)}</dd></div>
          </dl>
          ${renderList(context.warnings.map((warning) => escapeHtml(warning)))}
        </article>
      </div>
    </section>`;
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

function renderEmbeddingDimensions(dimensions: Array<{ dimension: number; chunks: number }>): string {
  if (dimensions.length === 0) return '<p class="empty">not-collected</p>';
  return `<ul class="list">${dimensions.map((entry) => `<li>${escapeHtml(entry.dimension)}: ${escapeHtml(entry.chunks)} chunk${entry.chunks === 1 ? '' : 's'}</li>`).join('')}</ul>`;
}

function fallbackFileSearchHealth(profileSummary: DashboardProfileSummary): DashboardFileSearchHealth {
  const fileSearch = profileSummary.fileSearch;
  return {
    scannerState: fileSearch.state === 'missing' ? 'missing' : 'not-collected',
    scannerTrigger: null,
    scannerStartedAt: null,
    scannerCompletedAt: null,
    scannerUpdatedAt: null,
    lastIndexedAt: fileSearch.lastIndexedAt,
    indexedFileCount: fileSearch.indexedFileCount,
    indexedChunkCount: fileSearch.chunkCount,
    embeddedChunkCount: profileSummary.embedding.embeddedChunkCount,
    missingChunkCount: profileSummary.embedding.missingChunkCount,
    failedChunkCount: profileSummary.embedding.failedChunkCount,
    embeddingReadiness: profileSummary.embedding.readiness,
    embeddingModel: profileSummary.embedding.model,
    embeddingProviderKey: profileSummary.embedding.providerKey,
    embeddingDimensions: profileSummary.embedding.dimensions,
    hotIndexState: 'not-collected',
    hotIndexSource: 'not-collected',
    warnings: [],
  };
}

function renderProfileSummary(profileSummary: DashboardProfileSummary): string {
  const fileSearchHealth = profileSummary.fileSearch.health ?? fallbackFileSearchHealth(profileSummary);
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
          <div class="subsection">
            <h4>File search health</h4>
            <dl class="meta">
              <div><dt>Scanner state</dt><dd>${escapeHtml(fileSearchHealth.scannerState)}</dd></div>
              <div><dt>Scanner trigger</dt><dd>${escapeHtml(fileSearchHealth.scannerTrigger ?? 'not-collected')}</dd></div>
              <div><dt>Started</dt><dd>${escapeHtml(fileSearchHealth.scannerStartedAt ?? 'not-collected')}</dd></div>
              <div><dt>Completed</dt><dd>${escapeHtml(fileSearchHealth.scannerCompletedAt ?? 'not-collected')}</dd></div>
              <div><dt>Updated</dt><dd>${escapeHtml(fileSearchHealth.scannerUpdatedAt ?? 'not-collected')}</dd></div>
              <div><dt>Last indexed</dt><dd>${escapeHtml(fileSearchHealth.lastIndexedAt ?? 'not-collected')}</dd></div>
              <div><dt>Indexed files</dt><dd>${escapeHtml(formatNullableCount(fileSearchHealth.indexedFileCount))}</dd></div>
              <div><dt>Indexed chunks</dt><dd>${escapeHtml(formatNullableCount(fileSearchHealth.indexedChunkCount))}</dd></div>
              <div><dt>Embedded</dt><dd>${escapeHtml(formatNullableCount(fileSearchHealth.embeddedChunkCount))}</dd></div>
              <div><dt>Missing</dt><dd>${escapeHtml(formatNullableCount(fileSearchHealth.missingChunkCount))}</dd></div>
              <div><dt>Failed</dt><dd>${escapeHtml(formatNullableCount(fileSearchHealth.failedChunkCount))}</dd></div>
              <div><dt>Embedding</dt><dd>${escapeHtml(fileSearchHealth.embeddingReadiness)}</dd></div>
              <div><dt>Embedding model</dt><dd>${escapeHtml(fileSearchHealth.embeddingModel ?? 'not-collected')}</dd></div>
              <div><dt>Embedding provider</dt><dd>${escapeHtml(fileSearchHealth.embeddingProviderKey ?? 'not-collected')}</dd></div>
              <div><dt>Hot index</dt><dd>${escapeHtml(fileSearchHealth.hotIndexState)} / ${escapeHtml(fileSearchHealth.hotIndexSource)}</dd></div>
            </dl>
            <div class="subsection">
              <h4>Embedding dimensions</h4>
              ${renderEmbeddingDimensions(fileSearchHealth.embeddingDimensions)}
            </div>
            ${fileSearchHealth.warnings.length > 0 ? `<div class="subsection"><h4>Health warnings</h4>${renderList(fileSearchHealth.warnings.map((warning) => escapeHtml(warning)))}</div>` : ''}
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
            ${renderEmbeddingDimensions(profileSummary.embedding.dimensions)}
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
  const runtimeProcesses = buildRuntimeProcessPanel(statusReport, doctorReport);
  const { activeContext, selectedContext } = buildActiveContext(runtimeProcesses, statusReport);
  const firstRunGuidance = buildFirstRunGuidance(statusComponents, statusReport.runtimeBaseDir);
  const commandCards = buildCommandCards(doctorReport, statusReport.runtimeBaseDir);
  const sectionSummaries = buildSectionSummaries(statusComponents, doctorChecks, boundedWarnings, commandCards.length, runtimeProcesses);

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
    runtimeProcesses,
    activeContext,
    selectedContext,
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
    runtimeProcesses?: DashboardRuntimeProcessPanel;
    selectedContext?: DashboardSelectedContext;
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
  const runtimeProcesses = dashboard.runtimeProcesses;
  const selectedContext = dashboard.selectedContext;
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
  <link rel="icon" type="image/svg+xml" href="${DASHBOARD_FAVICON_DATA_URI}">
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
    .hero {
      position: relative;
    }
    .hero-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .hero-title {
      min-width: 0;
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
    .banner-grid, .command-grid, .summary-grid, .profile-grid, nav {
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
      flex: 0 0 auto;
      gap: 6px;
    }
    .theme-switch a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      inline-size: 34px;
      block-size: 34px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel-soft);
      color: var(--accent);
      text-decoration: none;
      font-size: 16px;
      line-height: 1;
    }
    .theme-switch .theme-to-dark {
      display: none;
    }
    html:has(#theme-light:target) .theme-switch .theme-to-light {
      display: none;
    }
    html:has(#theme-light:target) .theme-switch .theme-to-dark {
      display: inline-flex;
    }
    .theme-switch a:hover {
      border-color: var(--accent);
    }
    .theme-switch a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
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
      <div class="hero-header">
        <div class="hero-title">
          <h1>Byomem Runtime Dashboard</h1>
          <p class="lead">Read-only snapshot of runtime status and doctor evidence.</p>
          <p class="lead">Generated at <time datetime="${escapeHtml(identityMeta.generatedAt)}">${escapeHtml(identityMeta.generatedAt)}</time>. Overall status: <strong>${escapeHtml(identityMeta.overallStatus)}</strong>.</p>
        </div>
        <div class="theme-switch" aria-label="Theme mode">
          <a class="theme-to-light" href="#theme-light" aria-label="Use light theme" title="Light theme">☀</a>
          <a class="theme-to-dark" href="#theme-dark" aria-label="Use dark theme" title="Dark theme">☾</a>
        </div>
      </div>
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
      <a href="#selected-context">Selected context</a>
      <a href="#runtime-processes">Runtime processes</a>
      <a href="#status-components">Status components</a>
      <a href="#doctor-checks">Doctor checks</a>
      <a href="#warnings">Warnings</a>
      <a href="#suggested-actions">Suggested actions</a>
    </nav>

    ${renderSelectedContext(selectedContext)}

    <section id="capabilities">
      <div class="section-head">
        <h2>Capabilities</h2>
        <p>Static feature evidence without live runtime probes.</p>
      </div>
      ${renderCapabilityBanners(capabilityBanners)}
    </section>

    <section id="profile-summary">
      <div class="section-head">
        <h2>Profile summary</h2>
        <p>Read-only project profile evidence collected at ${escapeHtml(profileSummary.collectedAt)}.</p>
      </div>
      ${renderProfileSummary(profileSummary)}
    </section>

    <section id="runtime-processes">
      <div class="section-head">
        <h2>Runtime processes</h2>
        <p>Static runtime-state process evidence from status and doctor reports.</p>
      </div>
      ${runtimeProcesses ? renderRuntimeProcessPanel(runtimeProcesses) : '<p class="empty">None.</p>'}
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
    <p>Docs: README · Runtime runbook: docs/byomem-runtime-operations-runbook.md · Repository: byomem.</p>
  </footer>
</body>
</html>`;
}
