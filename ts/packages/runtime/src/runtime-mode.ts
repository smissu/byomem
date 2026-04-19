export type RuntimeMode = 'python-default' | 'ts-native-shadow' | 'ts-native';

export function resolveRuntimeMode(input?: string): RuntimeMode {
  switch (input) {
    case 'ts-native':
    case 'ts-native-shadow':
    case 'python-default':
      return input;
    default:
      return 'python-default';
  }
}
