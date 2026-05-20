import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { isAuthorized } from './auth.js';
import { Accepted202, ConflictError, TooLargeError } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { list } from './handlers/list.js';
import { signUpload } from './handlers/signUpload.js';
import { signDownload } from './handlers/signDownload.js';
import { del } from './handlers/del.js';
import { exists } from './handlers/exists.js';
import { move } from './handlers/move.js';
import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  signPart,
} from './handlers/multipart.js';
import { restore } from './handlers/restore.js';
import { getDerivedUrl } from './handlers/getDerivedUrl.js';
import { folderPreview } from './handlers/folderPreview.js';
import { stats } from './handlers/stats.js';
import { head } from './handlers/head.js';
import { getMoveJob, cancelMoveJob, JobNotFoundError, InvalidJobIdError } from './handlers/moveJob.js';

export type RequestContext = {
  requestId: string;
  route: string;
  log: Logger;
};

type Route = (body: any, ctx: RequestContext) => Promise<unknown>;

const routes: Record<string, Route> = {
  'POST /list': list,
  'POST /sign-upload': signUpload,
  'POST /sign-download': signDownload,
  'POST /delete': del,
  'POST /exists': exists,
  'POST /move': move,
  'POST /restore': restore,
  'POST /get-derived-url': getDerivedUrl,
  'POST /folder-preview': folderPreview,
  'POST /multipart/create': createMultipart,
  'POST /multipart/sign-part': signPart,
  'POST /multipart/complete': completeMultipart,
  'POST /multipart/abort': abortMultipart,
  'POST /stats': stats,
  'POST /head': head,
  'POST /move-job': getMoveJob,
  'POST /move-job-cancel': cancelMoveJob,
};

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '') || '/';
  const requestId = event.requestContext.requestId ?? 'unknown';
  const route = `${method} ${path}`;

  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true }, requestId);
  }

  const authHeader =
    event.headers['authorization'] ?? event.headers['Authorization'];
  if (!isAuthorized(authHeader)) {
    return json(401, { error: 'unauthorized' }, requestId);
  }

  const routeHandler = routes[route];
  if (!routeHandler) return json(404, { error: 'not found', path, method }, requestId);

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid JSON body' }, requestId);
  }

  const log = createLogger({ requestId, route });
  const ctx: RequestContext = { requestId, route, log };

  try {
    const result = await withTiming(ctx, () => routeHandler(body, ctx));
    return json(200, result, requestId);
  } catch (err) {
    if (err instanceof Accepted202) {
      return json(202, err.body, requestId);
    }
    if (err instanceof ConflictError) {
      return json(409, { error: err.message }, requestId);
    }
    if (err instanceof TooLargeError) {
      return json(422, {
        error: 'folder-too-large',
        code: 'folder-too-large',
        fileCount: err.fileCount,
        limit: err.limit,
        truncated: err.truncated,
      }, requestId);
    }
    if (err instanceof InvalidJobIdError) {
      return json(400, { error: err.message }, requestId);
    }
    if (err instanceof JobNotFoundError) {
      return json(404, { error: 'job not found' }, requestId);
    }
    const message = err instanceof Error ? err.message : 'internal error';
    const status = isClientError(message) ? 400 : 500;
    return json(status, { error: message }, requestId);
  }
};

async function withTiming<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    ctx.log.info('request complete', { durationMs, status: 200 });
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    ctx.log.error('request failed', { durationMs, err: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

function isClientError(message: string): boolean {
  return (
    message.startsWith('key ') ||
    message.startsWith('prefix ') ||
    message.includes(' must ') ||
    message.includes('required') ||
    message.includes('cannot move')
  );
}

function json(statusCode: number, body: unknown, requestId?: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
    body: JSON.stringify(body),
  };
}
