// Test helper: builds a PRIVATE copy of the messaging resources for one test run (its own bus, rule,
// queues and topic, named roadhub-test-...), so tests never touch the real roadhub-notify-queue.
// The real resources are made by infra/services/03-sqs.sh, 04-sns.sh and 05-eventbridge.sh with the
// same settings (redrive after 3 tries, rule pattern), and checked by infra/check-engagement.sh.
const { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
const { SNSClient, CreateTopicCommand } = require('@aws-sdk/client-sns');
const { EventBridgeClient, CreateEventBusCommand, PutRuleCommand, PutTargetsCommand } = require('@aws-sdk/client-eventbridge');

const NAMES = {
  bus: 'roadhub-events',
  rule: 'roadhub-notify-rule',
  queue: 'roadhub-notify-queue',
  dlq: 'roadhub-notify-dlq',
  topic: 'roadhub-ops-alerts'
};
// Only these events cause e-mails (the worker ignores anything else).
const NOTIFY_PATTERN = {
  source: ['roadhub.roadmap', 'roadhub.admin'],
  'detail-type': ['FeatureStatusChanged', 'FeatureMerged']
};

async function queueArn(sqs, url) {
  const out = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  return out.Attributes.QueueArn;
}

async function createMessaging({ names = NAMES, visibilityTimeout = 30, maxReceiveCount = 3, say = () => {} } = {}) {
  const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
  const sns = new SNSClient({});
  const events = new EventBridgeClient({});

  try {
    await events.send(new CreateEventBusCommand({ Name: names.bus }));
    say(`EventBridge bus ${names.bus} created`);
  } catch (e) {
    if (e.name !== 'ResourceAlreadyExistsException') throw e;
    say(`EventBridge bus ${names.bus} (already exists)`);
  }

  const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: names.dlq }))).QueueUrl;
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl: dlqUrl, Attributes: { MessageRetentionPeriod: '1209600' } })); // 14 days
  const dlqArn = await queueArn(sqs, dlqUrl);
  say(`SQS dead-letter queue ${names.dlq}`);

  const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: names.queue }))).QueueUrl;
  const arn = await queueArn(sqs, queueUrl);

  const topicArn = (await sns.send(new CreateTopicCommand({ Name: names.topic }))).TopicArn;
  say(`SNS topic ${names.topic}`);

  const ruleArn = (await events.send(new PutRuleCommand({
    Name: names.rule, EventBusName: names.bus, State: 'ENABLED',
    Description: 'Status changes and merges -> notification e-mails (engagement worker)',
    EventPattern: JSON.stringify(NOTIFY_PATTERN)
  }))).RuleArn;

  await sqs.send(new SetQueueAttributesCommand({
    QueueUrl: queueUrl,
    Attributes: {
      VisibilityTimeout: String(visibilityTimeout),
      ReceiveMessageWaitTimeSeconds: '10',
      MessageRetentionPeriod: '345600', // 4 days
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
      // Only this EventBridge rule may put messages into the queue.
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Sid: 'AllowNotifyRule', Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' },
          Action: 'sqs:SendMessage', Resource: arn, Condition: { ArnEquals: { 'aws:SourceArn': ruleArn } }
        }]
      })
    }
  }));
  say(`SQS queue ${names.queue} (after ${maxReceiveCount} failed tries -> ${names.dlq})`);

  await events.send(new PutTargetsCommand({
    Rule: names.rule, EventBusName: names.bus, Targets: [{ Id: 'notify-queue', Arn: arn }]
  }));
  say(`EventBridge rule ${names.rule} -> ${names.queue}`);

  return { queueUrl, queueArn: arn, dlqUrl, dlqArn, topicArn, ruleArn };
}

module.exports = { createMessaging, NAMES, NOTIFY_PATTERN };
