import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const isDev = process.env.APP_VARIANT === 'development';
  return {
    ...config,
    name: isDev ? 'S3 Backup (Dev)' : (config.name ?? 'S3 Backup'),
    ios: {
      ...config.ios,
      bundleIdentifier: isDev
        ? `${config.ios?.bundleIdentifier}.dev`
        : config.ios?.bundleIdentifier,
    },
    android: {
      ...config.android,
      package: isDev
        ? `${config.android?.package}.dev`
        : config.android?.package,
    },
  } as ExpoConfig;
};
