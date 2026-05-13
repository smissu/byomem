import { assertNoPythonDefaultPath as noPythonDefaultPath } from '../no-python-default-path.js';
import { resolveActiveProjectContext } from '../identity.js';
import { buildByomemRuntimeStatus, openReadOnlyRuntimeContext } from '../readonly-core.js';
import { resolveRuntimeMode } from '../runtime-mode.js';
import { openNativeStore } from '../store.js';
import type { OperationsMcpRuntimeContext } from './operations-tools.js';

export function buildOperationsRuntimeContext(): OperationsMcpRuntimeContext {
  const runtime = openReadOnlyRuntimeContext({});
  const activeProject = resolveActiveProjectContext(process.env, process.cwd());
  let nativeStore: ReturnType<typeof openNativeStore> | undefined;
  const noPythonDisabled = (() => {
    try {
      noPythonDefaultPath('python-default');
      return false;
    } catch {
      return true;
    }
  })();

  return {
    ...runtime,
    get nativeStore() {
      nativeStore ??= openNativeStore({
        baseDir: runtime.runtimeBaseDir,
        fileSearchSemanticEnabled: true,
        fileSearchScanOnOpen: false,
        fileSearchSchedulerEnabled: false,
        fileSearchScannerExcludedExtensions: runtime.fileSearchConfig.excludedExtensions,
        fileSearchBinaryDetectionEnabled: runtime.fileSearchConfig.binaryDetectionEnabled,
      });
      return nativeStore;
    },
    status: buildByomemRuntimeStatus({
      runtimeMode: resolveRuntimeMode(),
      noPythonDefaultPath: noPythonDisabled,
      runtimeBaseDir: runtime.runtimeBaseDir,
      nativeStoreBaseDir: runtime.runtimeBaseDir,
      activeProject,
      embeddingConfig: runtime.embeddingConfig,
      sessionCaptureConfig: runtime.sessionCaptureConfig,
      summarizerConfig: runtime.summarizerConfig,
      fileSearchConfig: runtime.fileSearchConfig,
    }),
  };
}
