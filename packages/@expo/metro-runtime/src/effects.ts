declare let global: {
  __DEV__?: boolean;
  RN$Bridgeless?: boolean;
  __METRO_GLOBAL_PREFIX__?: string;
  __RCTProfileIsProfiling?: boolean;
  WebSocket: any;
};

if (
  // Only during development.
  process.env.NODE_ENV !== 'production' &&
  // Disable for SSR
  typeof window !== 'undefined' &&
  // Disable for non-metro runtimes
  // NOTE(EvanBacon): This can probably be removed in favor of `expo/metro-config` injecting this file.
  global.__METRO_GLOBAL_PREFIX__ != null
) {
  require('./setupFastRefresh');
  require('./setupHMR');
  require('./messageSocket');
}
