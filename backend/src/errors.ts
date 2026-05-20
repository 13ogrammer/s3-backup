export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class TooLargeError extends Error {
  readonly code = 'folder-too-large' as const;
  constructor(
    public readonly fileCount: number,
    public readonly limit: number,
    public readonly truncated: boolean,
  ) {
    super('folder-too-large');
    this.name = 'TooLargeError';
  }
}

/** Sentinel thrown by a handler that wants to respond with HTTP 202. */
export class Accepted202 {
  constructor(public readonly body: unknown) {}
}
