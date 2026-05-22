// Type shim for react-native-background-upload (RNBU) v6.6.0.
// RNBU ships no bundled TypeScript types. This declaration covers only
// the surface used by upload.ts (startUpload + event listeners).
// Remove this file once RNBU ships first-party types or a @types package
// becomes available.
declare module 'react-native-background-upload' {
  export type RNBUUploadType = 'raw' | 'multipart';

  export type RNBUNotificationOptions = {
    enabled?: boolean;
    autoClear?: boolean;
    notificationChannel?: string;
    onProgressTitle?: string;
    onProgressMessage?: string;
    onCompleteTitle?: string;
    onCompleteMessage?: string;
    onErrorTitle?: string;
    onErrorMessage?: string;
    onCancelledTitle?: string;
    onCancelledMessage?: string;
    enableRingTone?: boolean;
  };

  export type RNBUOptions = {
    url: string;
    path: string;
    method?: 'PUT' | 'POST' | 'PATCH';
    type?: RNBUUploadType;
    headers?: Record<string, string>;
    customUploadId?: string;
    notification?: RNBUNotificationOptions;
  };

  export type RNBUProgressEvent = { id: string; progress: number };
  export type RNBUCompletedEvent = {
    id: string;
    responseCode: number;
    responseBody: string;
    responseHeaders: Record<string, string>;
  };
  export type RNBUErrorEvent = { id: string; error: string };
  export type RNBUCancelledEvent = { id: string };

  export type RNBUEventType = 'progress' | 'completed' | 'error' | 'cancelled';

  export type RNBUSubscription = { remove: () => void };

  const BackgroundUpload: {
    startUpload(options: RNBUOptions): Promise<string>;
    addListener(
      event: 'progress',
      callback: (data: RNBUProgressEvent) => void,
    ): RNBUSubscription;
    addListener(
      event: 'completed',
      callback: (data: RNBUCompletedEvent) => void,
    ): RNBUSubscription;
    addListener(
      event: 'error',
      callback: (data: RNBUErrorEvent) => void,
    ): RNBUSubscription;
    addListener(
      event: 'cancelled',
      callback: (data: RNBUCancelledEvent) => void,
    ): RNBUSubscription;
  };

  export default BackgroundUpload;
}
