import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { MoveJobMessage } from './types.js';

// DEV EMULATION NOTE: When FOLDER_MOVE_QUEUE_URL starts with "local://",
// messages are dispatched via setImmediate to the worker module in-process.
// This skips SQS visibility timeouts, redrive, and real AWS SQS error
// semantics. Use only for the local dev server (npm run dev).

const QUEUE_URL = process.env.FOLDER_MOVE_QUEUE_URL ?? '';

let _sqsClient: SQSClient | undefined;
function sqsClient(): SQSClient {
  if (!_sqsClient) {
    _sqsClient = new SQSClient({});
  }
  return _sqsClient;
}

export async function enqueueMoveJob(msg: MoveJobMessage): Promise<void> {
  if (QUEUE_URL.startsWith('local://')) {
    // In-process emulation for dev. Import worker lazily to avoid circular
    // deps if worker.ts ever imports from sqs.ts.
    const body = JSON.stringify(msg);
    setImmediate(() => {
      import('./worker.js')
        .then(({ processJob }) => processJob(msg))
        .catch((err) => console.error('[sqs-local] worker error', err));
    });
    console.log('[sqs-local] enqueued job', msg.jobId, 'body=', body.length, 'bytes');
    return;
  }

  if (!QUEUE_URL) {
    throw new Error('FOLDER_MOVE_QUEUE_URL is not set');
  }

  await sqsClient().send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(msg),
    }),
  );
}
