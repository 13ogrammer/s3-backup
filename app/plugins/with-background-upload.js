// Expo config plugin for react-native-background-upload (RNBU).
// RNBU v6.6.0 ships no built-in Expo plugin, so we wire the native
// requirements here instead of manual Xcode / Gradle edits.
//
// iOS: merges 'fetch' (and any caller-supplied modes) into
//   UIBackgroundModes so URLSession background transfers survive app
//   suspension.
// Android: adds FOREGROUND_SERVICE, FOREGROUND_SERVICE_DATA_SYNC, and
//   POST_NOTIFICATIONS permissions to AndroidManifest.xml. All ops are
//   idempotent — running `expo prebuild` twice does not duplicate entries.
//
// Usage in app.json:
//   ["./plugins/with-background-upload", { "androidChannel": "background_uploads" }]

const {
  withInfoPlist,
  withAndroidManifest,
  AndroidConfig,
} = require('@expo/config-plugins');

// 'fetch' — keeps URLSession background transfers alive (RNBU).
// 'processing' — registers BGProcessingTask identifiers via expo-background-task
//   so the OS can invoke the auto-backup tick during device charging/idle windows.
const DEFAULT_IOS_BACKGROUND_MODES = ['fetch', 'processing'];
const DEFAULT_ANDROID_CHANNEL = 'background_uploads';
const DEFAULT_ANDROID_CHANNEL_NAME = 'Background uploads';

// Android permissions required for RNBU foreground service (Android 9+,
// 12+, and 13+ respectively). Declared statically; runtime grant for
// POST_NOTIFICATIONS (Android 13+) is deferred to a future card.
const ANDROID_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.POST_NOTIFICATIONS',
];

/**
 * @param {import('@expo/config-plugins').ExpoConfig} config
 * @param {{ iosBackgroundModes?: string[]; androidChannel?: string; androidChannelName?: string }} options
 */
function withBackgroundUpload(config, options = {}) {
  const iosBackgroundModes = options.iosBackgroundModes ?? DEFAULT_IOS_BACKGROUND_MODES;
  // androidChannel and androidChannelName are captured here for future
  // use if a plugin mod needs to inject channel metadata into resources.
  // Currently the channel is configured at runtime via RNBU's notification
  // options — no native resource injection is required.
  void (options.androidChannel ?? DEFAULT_ANDROID_CHANNEL);
  void (options.androidChannelName ?? DEFAULT_ANDROID_CHANNEL_NAME);

  // --- iOS ---
  config = withInfoPlist(config, (mod) => {
    const plist = mod.modResults;
    const existing = Array.isArray(plist.UIBackgroundModes) ? plist.UIBackgroundModes : [];
    const merged = Array.from(new Set([...existing, ...iosBackgroundModes]));
    plist.UIBackgroundModes = merged;
    return mod;
  });

  // --- Android ---
  config = withAndroidManifest(config, (mod) => {
    // ensurePermission mutates the manifest in place and returns a bool
    // (true if it added the permission). Do NOT assign its return to
    // mod.modResults — that would clobber the manifest with undefined,
    // breaking the next iteration with "Cannot read properties of
    // undefined (reading 'manifest')".
    for (const permission of ANDROID_PERMISSIONS) {
      AndroidConfig.Permissions.ensurePermission(mod.modResults, permission);
    }
    return mod;
  });

  return config;
}

module.exports = withBackgroundUpload;
