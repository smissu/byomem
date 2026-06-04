import { createServer, type Server, type ServerResponse } from 'node:http';
import { basename } from 'node:path';
import type { Socket } from 'node:net';

export type DashboardServerHost = '127.0.0.1' | '0.0.0.0';

export type DashboardServerOptions = {
  html: string;
  outputPath: string;
  host?: DashboardServerHost;
  port?: number;
  interactive?: boolean;
  evidenceSource?: 'startup-cache' | 'explicit-injection';
  contexts?: DashboardServerContextEvidence[];
};

export type DashboardServerContextEvidence = {
  contextId: string;
  label?: string;
  summary?: string;
  source?: 'startup-cache' | 'explicit-injection';
  [key: string]: unknown;
};

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

function writeHtml(response: ServerResponse, html: string, csp = DASHBOARD_CSP): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp,
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

function renderInteractiveDashboardShell(html: string, contexts: DashboardServerContextEvidence[]): string {
  const options = contexts.map((context) => (
    `<option value="${escapeHtml(context.contextId)}">${escapeHtml(context.label ?? context.contextId)}</option>`
  )).join('');
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
    .summary { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
    .badge { display: inline-flex; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--accent); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; text-transform: uppercase; }
    .snapshot { display: block; }
  </style>
</head>
<body>
  <div class="switcher">
    <div class="switcher-row">
      <label for="byomem-context-select">BYOMem context</label>
      <select id="byomem-context-select">${options}</select>
      <span id="byomem-context-status" class="badge">startup-cache</span>
    </div>
    <p id="byomem-context-summary" class="summary">${escapeHtml(contexts[0]?.summary ?? 'No active BYOMem contexts are available.')}</p>
  </div>
  <div class="snapshot">${html}</div>
  <script>
    const contextsUrl = ${jsonScriptString('/api/contexts')};
    const dashboardUrl = ${jsonScriptString('/api/dashboard.json')};
    const select = document.getElementById('byomem-context-select');
    const summary = document.getElementById('byomem-context-summary');
    const status = document.getElementById('byomem-context-status');
    async function loadContext(contextId) {
      const response = await fetch(dashboardUrl + '?contextId=' + encodeURIComponent(contextId), { method: 'GET' });
      const payload = await response.json();
      summary.textContent = payload.summary || payload.label || payload.contextId || 'Context evidence is unavailable.';
      status.textContent = payload.status || payload.source || 'startup-cache';
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
      if (url.pathname === '/api/contexts') {
        writeJson(response, 200, { contexts, evidenceSource });
        return;
      }
      if (url.pathname === '/api/dashboard.json') {
        const contextId = normalizeContextId(url.searchParams.get('contextId'));
        const context = contexts.find((entry) => entry.contextId === contextId);
        if (options.contexts?.length && !context) {
          writeJson(response, 400, { error: 'Unknown dashboard context id.', contextId });
          return;
        }
        writeJson(response, 200, context ?? { contextId, source: evidenceSource });
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
