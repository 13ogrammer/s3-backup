import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { sqsClient } from './sqs.js';
import { processJob } from './worker.js';
import { processTranscodeJob } from './handlers/transcodeWorker.js';
import type { MoveJobMessage, TranscodeJobMessage } from './types.js';

const MOVE_QUEUE_NAME = 'folder-move-queue';
const MOVE_DLQ_NAME = 'folder-move-dlq';
const TRANSCODE_QUEUE_NAME = 'video-transcode-queue';
const TRANSCODE_DLQ_NAME = 'video-transcode-dlq';

// Mirrors the production SAM template: 950s visibility, single delivery
// attempt before redrive to DLQ. Keeps local behaviour faithful to prod.
const VISIBILITY_TIMEOUT_SECONDS = 950;
const MAX_RECEIVE_COUNT = 1;
const LONG_POLL_SECONDS = 20;

async function createQueuePair(
  mainName: string,
  dlqName: string,
): Promise<{ mainUrl: string; dlqUrl: string }> {
  const sqs = sqsClient();

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: dlqName }));
  const dlqUrl = dlq.QueueUrl;
  if (!dlqUrl) throw new Error(`ElasticMQ did not return a URL for DLQ: ${dlqName}`);

  const dlqAttrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = dlqAttrs.Attributes?.QueueArn;
  if (!dlqArn) throw new Error(`ElasticMQ did not return ARN for DLQ: ${dlqName}`);

  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: mainName,
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
  if (!mainUrl) throw new Error(`ElasticMQ did not return a URL for queue: ${mainName}`);

  return { mainUrl, dlqUrl };
}

export async function ensureQueues(): Promise<{
  folderMove: { mainUrl: string; dlqUrl: string };
  videoTranscode: { mainUrl: string; dlqUrl: string };
}> {
  const [folderMove, videoTranscode] = await Promise.all([
    createQueuePair(MOVE_QUEUE_NAME, MOVE_DLQ_NAME),
    createQueuePair(TRANSCODE_QUEUE_NAME, TRANSCODE_DLQ_NAME),
  ]);
  return { folderMove, videoTranscode };
}

export type PollerConfig = {
  queueUrl: string;
  label: string;
  dispatch: (body: string) => Promise<void>;
};

export function startPoller(config: PollerConfig): void {
  const { queueUrl, label, dispatch } = config;
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
        console.error(`[${label}] receive failed, retrying in 2s`, err);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      for (const m of messages) {
        if (!m.Body || !m.ReceiptHandle) continue;

        try {
          await dispatch(m.Body);
        } catch (err) {
          // Match production's maxReceiveCount=1 semantics: any throw goes to
          // DLQ on next visibility timeout. Leaving the message undeleted is
          // sufficient; the local DLQ exists for visibility.
          console.error(`[${label}] dispatch threw, leaving for redrive`, err);
          continue;
        }

        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }),
        );
      }
    }
    console.log(`[${label}] stopped`);
  })();
}

export function startFolderMovePoller(queueUrl: string): void {
  startPoller({
    queueUrl,
    label: 'folder-move-poller',
    dispatch: async (body) => {
      const msg = JSON.parse(body) as MoveJobMessage;
      await processJob(msg);
    },
  });
}

export function startTranscodePoller(queueUrl: string): void {
  startPoller({
    queueUrl,
    label: 'transcode-poller',
    dispatch: async (body) => {
      const msg = JSON.parse(body) as TranscodeJobMessage;
      await processTranscodeJob(msg);
    },
  });
}
