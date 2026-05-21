import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { MoveJobMessage } from './types.js';

// In production the SDK resolves AWS endpoints + creds from the environment.
// In local dev we override the endpoint via AWS_SQS_ENDPOINT_URL (e.g.
// http://localhost:9324 for ElasticMQ) and pass through whatever creds are
// already in the environment for MinIO; ElasticMQ doesn't validate them.

let _sqsClient: SQSClient | undefined;
export function sqsClient(): SQSClient {
  if (!_sqsClient) {
    const endpoint = process.env.AWS_SQS_ENDPOINT_URL || undefined;
    _sqsClient = new SQSClient({
      endpoint,
      region: process.env.AWS_REGION,
      credentials: endpoint
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
          }
        : undefined,
    });
  }
  return _sqsClient;
}

function getQueueUrl(): string {
  const url = process.env.FOLDER_MOVE_QUEUE_URL;
  if (!url) throw new Error('FOLDER_MOVE_QUEUE_URL is not set');
  return url;
}

export async function enqueueMoveJob(msg: MoveJobMessage): Promise<void> {
  await sqsClient().send(
    new SendMessageCommand({
      QueueUrl: getQueueUrl(),
      MessageBody: JSON.stringify(msg),
    }),
  );
}
