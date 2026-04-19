import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WorkerState {
  workerId: string;
  sessionId: string;
  offset: number;
  lock: string | null;
}

export interface WorkerOptions {
  baseDir: string;
  workerFile?: string;
}

export interface NativeWorker {
  readState(): WorkerState;
  acquireLock(sessionId: string): WorkerState;
  advanceOffset(nextOffset: number): WorkerState;
  releaseLock(): WorkerState;
}

interface WorkerSnapshot {
  version: 1;
  state: WorkerState;
}

function loadWorkerSnapshot(filePath: string): WorkerSnapshot {
  if (!existsSync(filePath)) {
    return { version: 1, state: { workerId: randomUUID(), sessionId: '', offset: 0, lock: null } };
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || !(parsed as { state?: unknown }).state) {
    throw new Error('Invalid worker snapshot');
  }
  return parsed as WorkerSnapshot;
}

function persistWorkerSnapshot(filePath: string, snapshot: WorkerSnapshot): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);
}

export function openNativeWorker(options: WorkerOptions): NativeWorker {
  const filePath = resolve(options.baseDir, options.workerFile ?? 'worker.json');
  let snapshot = loadWorkerSnapshot(filePath);

  const persist = () => persistWorkerSnapshot(filePath, snapshot);

  return {
    readState(): WorkerState {
      return snapshot.state;
    },
    acquireLock(sessionId: string): WorkerState {
      snapshot = { ...snapshot, state: { ...snapshot.state, sessionId, lock: sessionId } };
      persist();
      return snapshot.state;
    },
    advanceOffset(nextOffset: number): WorkerState {
      snapshot = { ...snapshot, state: { ...snapshot.state, offset: nextOffset } };
      persist();
      return snapshot.state;
    },
    releaseLock(): WorkerState {
      snapshot = { ...snapshot, state: { ...snapshot.state, lock: null } };
      persist();
      return snapshot.state;
    },
  };
}
