import { createServer, type IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';

import qrcode from 'qrcode-terminal';

import { handler } from './index.js';

let requestCounter = 0;

const PORT = Number(process.env.PORT ?? 8080);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

const server = createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const event = {
      version: '2.0',
      routeKey: `${req.method} ${url.pathname}`,
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: normalizeHeaders(req.headers),
      requestContext: {
        requestId: `dev-${++requestCounter}`,
        http: {
          method: req.method ?? 'GET',
          path: url.pathname,
          protocol: 'HTTP/1.1',
          sourceIp: req.socket.remoteAddress ?? '127.0.0.1',
          userAgent: req.headers['user-agent'] ?? '',
        },
      },
      body,
      isBase64Encoded: false,
    } as unknown as Parameters<typeof handler>[0];

    const result = (await handler(event)) as {
      statusCode?: number;
      headers?: Record<string, string | number | boolean>;
      body?: string;
    };

    res.statusCode = result.statusCode ?? 200;
    for (const [k, v] of Object.entries(result.headers ?? {})) {
      res.setHeader(k, String(v));
    }
    res.end(result.body ?? '');
  } catch (err) {
    console.error('dev-server error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});

function lanIp(): string | undefined {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return undefined;
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp() ?? 'localhost';
  const apiUrl = `http://${ip}:${PORT}`;
  const token = process.env.BOOTSTRAP_TOKEN;
  const sep = '─'.repeat(60);
  console.log(`\n${sep}`);
  console.log(`  s3-backup dev server`);
  console.log(`  Listening on: ${apiUrl}`);
  console.log(`  Health check: curl ${apiUrl}/health`);
  console.log(`  Bucket:       ${process.env.BUCKET_NAME ?? '(not set)'}`);
  console.log(`  S3 endpoint:  ${process.env.S3_ENDPOINT_URL ?? '(real AWS)'}`);
  console.log(`  Auth token:   ${token ? '(set)' : '(NOT SET)'}`);
  console.log(`${sep}`);

  if (token) {
    console.log(`  Scan the QR below with the "Scan QR" button in Settings,`);
    console.log(`  or paste manually:`);
    console.log(`    API URL: ${apiUrl}`);
    console.log(`    Token:   (hidden — encoded in QR only)`);
    console.log(`${sep}\n`);
    qrcode.generate(JSON.stringify({ apiUrl, bootstrapToken: token }), { small: true }, (qr) => {
      console.log(qr);
    });
  } else {
    console.log(`  Set BOOTSTRAP_TOKEN in backend/.env to enable QR onboarding.`);
    console.log(`${sep}\n`);
  }
});
