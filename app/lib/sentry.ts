import * as Sentry from '@sentry/react-native';

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

export function captureApiError(err: unknown): void {
  if (!process.env.EXPO_PUBLIC_SENTRY_DSN) return;
  Sentry.captureException(err);
}
