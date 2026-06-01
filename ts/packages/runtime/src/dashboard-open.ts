import { spawn } from 'node:child_process';

export class DashboardOpenUnsupportedPlatformError extends Error {
  readonly code = 'UNSUPPORTED_DASHBOARD_OPEN_PLATFORM';
  readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform) {
    super(`dashboard --open is not supported on ${platform}`);
    this.name = 'DashboardOpenUnsupportedPlatformError';
    this.platform = platform;
  }
}

export class DashboardOpenCommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(command: string, exitCode: number | null, signal: NodeJS.Signals | null) {
    super(`dashboard --open failed: ${command} exited with code ${exitCode ?? 'null'}${signal === null ? '' : ` signal ${signal}`}`);
    this.name = 'DashboardOpenCommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export type DashboardOpenRunner = (command: string, args: string[]) => Promise<void>;

export type DashboardOpenFailureDetails = {
  name: string;
  message: string;
  code?: string;
  platform?: string;
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
};

function defaultRunCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (exitCode === 0 && signal === null) {
        resolve();
        return;
      }
      reject(new DashboardOpenCommandError(command, exitCode, signal));
    });
  });
}

export function createDashboardOpener(options: { platform?: NodeJS.Platform; runCommand?: DashboardOpenRunner } = {}): (outputPath: string) => Promise<void> {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;

  return async (outputPath: string) => {
    if (platform === 'darwin') {
      await runCommand('open', [outputPath]);
      return;
    }
    if (platform === 'linux') {
      await runCommand('xdg-open', [outputPath]);
      return;
    }
    throw new DashboardOpenUnsupportedPlatformError(platform);
  };
}

export function serializeDashboardOpenFailure(error: unknown): DashboardOpenFailureDetails {
  if (error instanceof DashboardOpenUnsupportedPlatformError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      platform: error.platform,
    };
  }
  if (error instanceof DashboardOpenCommandError) {
    return {
      name: error.name,
      message: error.message,
      command: error.command,
      exitCode: error.exitCode,
      signal: error.signal,
    };
  }
  if (error instanceof Error) {
    const errno = error as NodeJS.ErrnoException & {
      command?: string;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      platform?: string;
    };
    return {
      name: error.name,
      message: error.message,
      code: typeof errno.code === 'string' ? errno.code : undefined,
      platform: typeof errno.platform === 'string' ? errno.platform : undefined,
      command: typeof errno.command === 'string' ? errno.command : undefined,
      exitCode: typeof errno.exitCode === 'number' || errno.exitCode === null ? errno.exitCode : undefined,
      signal: typeof errno.signal === 'string' || errno.signal === null ? errno.signal : undefined,
    };
  }
  return {
    name: 'Error',
    message: String(error),
  };
}
