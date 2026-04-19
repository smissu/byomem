export type RuntimeMode = 'ts-native' | 'ts-native-shadow';

const DEFAULT_RUNTIME_MODE: RuntimeMode = 'ts-native';
const DISABLED_BY_DEFAULT_LEGACY_MODE = 'python-default' as const;

export function resolveRuntimeMode(input?: string): RuntimeMode {
  switch (input) {
    case 'ts-native':
    case 'ts-native-shadow':
      return input;
    case DISABLED_BY_DEFAULT_LEGACY_MODE:
      return DEFAULT_RUNTIME_MODE;
    default:
      return DEFAULT_RUNTIME_MODE;
  }
}

export function isLegacyRuntimeMode(input?: string): boolean {
  return input === DISABLED_BY_DEFAULT_LEGACY_MODE;
}
