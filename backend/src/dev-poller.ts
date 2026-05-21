import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { sqsClient } from './sqs.js';
import { processJob } from './worker.js';
import type { MoveJobMessage } from './types.js';

const MAIN_QUEUE_NAME = 'folder-move-queue';
const DLQ_QUEUE_NAME = 'folder-move-dlq';

// Mirrors the production SAM template: 950s visibility, single delivery
// attempt before redrive to DLQ. Keeps local behaviour faithful to prod.
const VISIBILITY_TIMEOUT_SECONDS = 950;
const MAX_RECEIVE_COUNT = 1;
const LONG_POLL_SECONDS = 20;

export async function ensureQueues(): Promise<{ mainUrl: string; dlqUrl: string }> {
  const sqs = sqsClient();

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: DLQ_QUEUE_NAME }));
  const dlqUrl = dlq.QueueUrl;
  if (!dlqUrl) throw new Error('ElasticMQ did not return a DLQ URL');

  const dlqAttrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = dlqAttrs.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('ElasticMQ did not return a DLQ ARN');

  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: MAIN_QUEUE_NAME,
      Attributes: {
        VisibilityTimeout: String(VISIBILITY_TIMEOUT_SECONDS),
        RedrivePolicy: JSON.stringify({
          maxReceiveCount: MAX_RECEIVE_COUNT,
          deadLetterTargetArn: dlqArn,
        }),
      },
    }),
  );
  const mainUrl = main.QueueUrl;
  if (!mainUrl) throw new Error('ElasticMQ did not return a main queue URL');

  return { mainUrl, dlqUrl };
}

export function startPoller(queueUrl: string): void {
  const sqs = sqsClient();
  let stopped = false;

  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  (async () => {
    while (!stopped) {
      let messages: Message[] = [];
      try {
        const res = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: LONG_POLL_SECONDS,
          }),
        );
        messages = res.Messages ?? [];
      } catch (err) {
        console.error('[sqs-poller] receive failed, retrying in 2s', err);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      for (const m of messages) {
        if (!m.Body || !m.ReceiptHandle) continue;
        let msg: MoveJobMessage;
        try {
          msg = JSON.parse(m.Body) as MoveJobMessage;
        } catch (err) {
          console.error('[sqs-poller] bad message body, deleting', err);
          await sqs.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }),
          );
          continue;
        }

        try {
          await processJob(msg);
        } catch (err) {
          // Match production's maxReceiveCount=1 semantics: any throw goes to
          // DLQ on next visibility timeout. Leaving the message undeleted is
          // sufficient for that; the local DLQ exists for visibility.
          console.error('[sqs-poller] processJob threw, leaving for redrive', err);
          continue;
        }

        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }),
        );
      }
    }
    console.log('[sqs-poller] stopped');
  })();
}
