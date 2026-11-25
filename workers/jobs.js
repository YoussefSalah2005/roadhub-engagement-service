// One notification job = one SQS message holding one EventBridge event.
// Used by BOTH ways of running the worker (Lab 7 idea: one code, two places):
//   workers/notificationWorker.js  a Node.js process that polls the queue   (npm run worker)
//   workers/lambda.js              an AWS Lambda function triggered by the queue (infra/services/08-lambda.sh)
// The rules (who gets an e-mail, never twice) live in services/notificationService.js.
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { logger } = require('../shared');
const config = require('../config');
const notifications = require('../services/notificationService');
const { audit } = require('../services/auditLog');

let sns = null;

// Operations alert on SNS roadhub-ops-alerts: no e-mail addresses or message bodies,
// only what is needed to find the job in the dead-letter queue.
async function alertOps(info) {
  try {
    if (!sns) sns = new SNSClient({});
    await sns.send(new PublishCommand({
      TopicArn: config.opsTopicArn,
      Subject: 'RoadmapHub: notification job failed',
      Message: JSON.stringify({ service: 'engagement-worker', problem: 'NOTIFICATION_JOB_FAILED_PERMANENTLY', deadLetterQueue: 'roadhub-notify-dlq', ...info })
    }));
    logger.warn('OPS_ALERT_PUBLISHED', { topic: config.opsTopicName, ...info });
  } catch (e) {
    logger.error('OPS_ALERT_FAILED', { reason: e.name, ...info });
  }
}

// Runs one job. Never throws: the answer says whether the message may be deleted.
//   { ok: true,  outcome }           done / duplicate / ignored  -> delete the message
//   { ok: false, final }             failed -> SQS gives it back; final = this was the last try
async function runJob({ messageId, body, receiveCount, runner }) {
  let event = null;
  try {
    event = JSON.parse(body);
    const result = await notifications.processEvent(event, { processedBy: runner });
    logger.info('NOTIFICATION_JOB_DONE', { messageId, eventType: event['detail-type'], receiveCount, runner, ...result });
    if (result.outcome === 'done') {
      audit('NOTIFICATION_JOB_DONE', { eventId: result.eventId, eventType: event['detail-type'], runner, recipients: result.recipients, sent: result.sent, skipped: result.skipped });
    }
    return { ok: true, outcome: result.outcome };
  } catch (err) {
    const final = receiveCount >= config.worker.maxReceives;
    const info = {
      messageId, eventId: event && event.detail && event.detail.eventId,
      eventType: event && event['detail-type'], receiveCount, runner, code: err.code || err.name
    };
    logger.warn('NOTIFICATION_JOB_FAILED', info);
    audit('NOTIFICATION_JOB_FAILED', { ...info, final });
    // After the last try SQS moves the message to roadhub-notify-dlq (redrive policy maxReceiveCount = 3)
    if (final) await alertOps(info);
    return { ok: false, final };
  }
}

module.exports = { runJob, alertOps };
