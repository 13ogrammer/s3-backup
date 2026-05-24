import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

import { ApiError } from './api';

// __DEV__ catches Metro / dev-client (local dev server). For installed
// builds, Updates.channel reflects the EAS channel baked in at build
// time ('development' | 'preview' | 'production'); null on Expo Go.
function resolveEnvironment(): string {
  if (__DEV__) return 'dev';
  return Updates.channel ?? 'unknown';
}

export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: resolveEnvironment(),
    release: Constants.expoConfig?.version,
    enableAutoSessionTracking: true,
    tracesSampleRate: 0,
  });
}

export function addBreadcrumb(b: {
  category: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}): void {
  if (!process.env.EXPO_PUBLIC_SENTRY_DSN) return;
  Sentry.addBreadcrumb(b);
}

export function addUploadBreadcrumb(
  message: string,
  data?: Record<string, unknown>,
  level: 'info' | 'warning' | 'error' = 'info',
): void {
  if (!process.env.EXPO_PUBLIC_SENTRY_DSN) return;
  Sentry.addBreadcrumb({ category: 'upload', message, level, data });
}

export function captureApiError(err: unknown): void {
  if (!process.env.EXPO_PUBLIC_SENTRY_DSN) return;
  if (err instanceof ApiError && err.requestId) {
    // Use withScope so the tag doesn't bleed into unrelated events.
    Sentry.withScope((scope) => {
      scope.setTag('backend_request_id', err.requestId!);
      Sentry.captureException(err);
    });
  } else {
    Sentry.captureException(err);
  }
}

export function captureException(
  err: unknown,
  opts?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (!process.env.EXPO_PUBLIC_SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (opts?.tags) {
      for (const [k, v] of Object.entries(opts.tags)) scope.setTag(k, v);
    }
    if (opts?.extra) {
      for (const [k, v] of Object.entries(opts.extra)) scope.setExtra(k, v);
    }
    Sentry.captureException(err);
  });
}
