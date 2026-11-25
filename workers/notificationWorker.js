// Notification worker, way 1: a Node.js process that polls the queue.   npm run worker
// (Way 2 is the Lambda function in workers/lambda.js. Run ONE of them, not both.)
// It reads jobs from SQS roadhub-notify-queue (filled by EventBridge rule roadhub-notify-rule)
// and e-mails the people concerned through Resend (services/notificationService.js).
//
// Retries and dead-letter queue:
//   - a job that fails is NOT deleted: SQS gives it back later (we wait 10 s, then 20 s)
//   - after the 3rd failed try, an alert goes to SNS roadhub-ops-alerts and SQS moves the
//     message to roadhub-notify-dlq (redrive policy maxReceiveCount = 3) so it can be inspected
require('dotenv').config({ quiet: true });
const {
  SQSClient, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, GetQueueUrlCommand
} = require('@aws-sdk/client-sqs');
const { logger } = require('../shared');
const config = require('../config');
const { runJob } = require('./jobs');
const auditLog = require('../services/auditLog');

const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const runner = `worker-${process.pid}`;
let queueUrl = config.notifyQueueUrl;

async function getQueueUrl() {
  if (!queueUrl) {
    queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: config.notifyQueueName }))).QueueUrl;
  }
  return queueUrl;
}

async function handleMessage(message) {
  const url = await getQueueUrl();
  const receiveCount = Number((message.Attributes || {}).ApproximateReceiveCount || 1);
  const result = await runJob({ messageId: message.MessageId, body: message.Body, receiveCount, runner });
  if (result.ok) {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
    return result.outcome;
  }
  // Failed: last try -> visible again at once (the next receive moves it to the DLQ);
  // otherwise wait a little longer before each new try (10 s, 20 s).
  const delay = result.final ? 0 : config.worker.retryDelaySeconds * receiveCount;
  await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay })).catch(() => {});
  return 'failed';
}

// One long-poll: receive up to 5 jobs and handle them one by one. Returns how many were received.
async function pollOnce() {
  const out = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: await getQueueUrl(),
    MaxNumberOfMessages: config.worker.batchSize,
    WaitTimeSeconds: config.worker.waitSeconds,
    AttributeNames: ['ApproximateReceiveCount'],
    MessageSystemAttributeNames: ['ApproximateReceiveCount']
  }));
  const messages = out.Messages || [];
  for (const message of messages) await handleMessage(message);
  return messages.length;
}

async function main() {
  logger.setServiceName('engagement-worker');
  let running = true;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { running = false; logger.info('WORKER_STOPPING', { signal }); });
  }
  logger.info('WORKER_STARTED', { queue: config.notifyQueueName, runner });
  while (running) {
    try {
      await pollOnce();
    } catch (e) {
      logger.error('WORKER_POLL_FAILED', { reason: e.name }); // e.g. Floci not running: wait and try again
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await auditLog.flush();
  process.exit(0);
}

if (require.main === module) main();

module.exports = { pollOnce, handleMessage };
