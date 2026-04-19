import { isLegacyRuntimeMode, resolveRuntimeMode } from './runtime-mode.js';

export function assertNoPythonDefaultPath(input?: string): void {
  if (isLegacyRuntimeMode(input)) {
    throw new Error('Python default runtime path is disabled by default');
  }
  resolveRuntimeMode(input);
}
