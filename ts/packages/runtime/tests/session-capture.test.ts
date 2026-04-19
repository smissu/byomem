import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { openSessionCapture } from '../src/session-capture.js';

type SessionCaptureRuntime = ReturnType<typeof openSessionCapture>['runtime'];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-session-'));
}

describe('session capture', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('opens a real native queue runtime flow', () => {
    const dir = tempDir();
    dirs.push(dir);
    const result = openSessionCapture(openNativeStore({ baseDir: dir }), { baseDir: dir });

    expect((result.runtime as SessionCaptureRuntime).state().offset).toBe(0);
  });
});
