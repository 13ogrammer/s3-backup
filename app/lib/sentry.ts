import * as Sentry from '@sentry/react-native';

import { ApiError } from './api';

export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
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
