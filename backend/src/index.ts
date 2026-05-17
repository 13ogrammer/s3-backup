import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { isAuthorized } from './auth.js';
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

type Route = (body: any) => Promise<unknown>;

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
};

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '') || '/';

  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true });
  }

  const authHeader =
    event.headers['authorization'] ?? event.headers['Authorization'];
  if (!isAuthorized(authHeader)) {
    return json(401, { error: 'unauthorized' });
  }

  const route = routes[`${method} ${path}`];
  if (!route) return json(404, { error: 'not found', path, method });

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  try {
    const result = await route(body);
    return json(200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'internal error';
    const status = isClientError(message) ? 400 : 500;
    if (status === 500) console.error(err);
    return json(status, { error: message });
  }
};

function isClientError(message: string): boolean {
  return (
    message.startsWith('key ') ||
    message.startsWith('prefix ') ||
    message.includes(' must ') ||
    message.includes('required') ||
    message.includes('cannot move')
  );
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
