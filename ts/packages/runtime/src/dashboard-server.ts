import { createServer, type Server, type ServerResponse } from 'node:http';
import { basename } from 'node:path';
import type { Socket } from 'node:net';

export type DashboardServerHost = '127.0.0.1';

export type DashboardServerOptions = {
  html: string;
  outputPath: string;
  host?: DashboardServerHost;
  port?: number;
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

function writeHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': DASHBOARD_CSP,
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
  const sockets = new Set<Socket>();
  let closed = false;
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const server: Server = createServer((request, response) => {
    if (isAllowedDashboardPath(request.url, outputPath)) {
      writeHtml(response, html);
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
