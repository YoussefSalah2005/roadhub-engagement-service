// Notification worker, way 2: an AWS Lambda function (Lab 7) triggered by the SQS queue.
// Created by infra/services/08-lambda.sh:  handler = workers/lambda.handler
// (Way 1 is the Node.js process in workers/notificationWorker.js. Run ONE of them, not both.)
//
// The event source mapping polls roadhub-notify-queue and calls this handler with up to 5 messages.
// "Partial batch response": we return only the messages that failed; Lambda deletes the others.
// A failed message comes back after the queue's visibility timeout; after its 3rd try SQS moves it
// to roadhub-notify-dlq and runJob() publishes an alert on SNS roadhub-ops-alerts.
const { runJob } = require('./jobs');
const auditLog = require('../services/auditLog');

exports.handler = async (event) => {
  const batchItemFailures = [];
  for (const record of event.Records || []) {
    const receiveCount = Number((record.attributes || {}).ApproximateReceiveCount || 1);
    const result = await runJob({ messageId: record.messageId, body: record.body, receiveCount, runner: 'lambda' });
    if (!result.ok) batchItemFailures.push({ itemIdentifier: record.messageId });
  }
  await auditLog.flush(); // a Lambda is frozen after it returns: send the audit lines first
  return { batchItemFailures };
};
