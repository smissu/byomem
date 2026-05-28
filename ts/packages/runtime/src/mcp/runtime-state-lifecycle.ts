import { resolveDefaultRuntimeBaseDir } from '../readonly-core.js';
import { registerRuntimeProcess, type RuntimeProcessRegistration, type RuntimeProcessRole } from '../runtime-state.js';

export type RuntimeStateLifecycleOptions = {
  role: RuntimeProcessRole;
  serverName: string;
  entrypoint: string;
  env?: NodeJS.ProcessEnv;
};

export type RuntimeStateLifecycle = {
  registration: RuntimeProcessRegistration;
  unregister(): boolean;
};

export function registerMcpRuntimeState(options: RuntimeStateLifecycleOptions): RuntimeStateLifecycle {
  const registration = registerRuntimeProcess({
    runtimeBaseDir: resolveDefaultRuntimeBaseDir(options.env ?? process.env),
    role: options.role,
    serverName: options.serverName,
    entrypoint: options.entrypoint,
  });
  let unregistered = false;
  const unregister = (): boolean => {
    if (unregistered) return false;
    unregistered = true;
    return registration.unregister();
  };
  return { registration, unregister };
}

export function installRuntimeStateSignalHandlers(lifecycle: RuntimeStateLifecycle): () => void {
  const onExit = () => { lifecycle.unregister(); };
  const onSigint = () => {
    lifecycle.unregister();
    process.exitCode = 130;
    process.exit(130);
  };
  const onSigterm = () => {
    lifecycle.unregister();
    process.exitCode = 143;
    process.exit(143);
  };
  process.once('exit', onExit);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}
