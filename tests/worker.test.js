// Notification worker (S2) tested with REAL EventBridge, SQS and SNS in Floci and the real votes table.
// Way 1: the worker runs as its OWN process (npm run worker). Way 2: the Lambda handler
// (workers/lambda.js) is called with SQS events, exactly as the Lambda trigger calls it. Two fakes stand in for things
// outside this service: the Administration Service (names + e-mails) and the Resend API (so no real
// e-mails are sent and a broken provider can be simulated).
// The test makes its own bus, rule, queues and topic (names with "roadhub-test-...") and deletes them
// at the end, so it never touches the real roadhub-notify-queue.
// Run: npm test   (needs Floci and "npm run setup:tables" once)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { AWS_ENV, requireTables, getOrCreateSecret } = require('./helpers/aws');
const { loadKeys } = require('./helpers/keys');
const { startFake } = require('./helpers/fake-service');
const {
  SQSClient, ReceiveMessageCommand, SendMessageCommand, CreateQueueCommand, DeleteQueueCommand,
  GetQueueAttributesCommand, SetQueueAttributesCommand
} = require('@aws-sdk/client-sqs');
const { SNSClient, SubscribeCommand, DeleteTopicCommand } = require('@aws-sdk/client-sns');
const {
  EventBridgeClient, PutEventsCommand, RemoveTargetsCommand, DeleteRuleCommand, DeleteEventBusCommand
} = require('@aws-sdk/client-eventbridge');
const { createMessaging } = require('./helpers/messaging');

const RUN = randomUUID().slice(0, 8);
const NAMES = {
  bus: `roadhub-test-events-${RUN}`, rule: `roadhub-test-notify-rule-${RUN}`, queue: `roadhub-test-notify-queue-${RUN}`,
  dlq: `roadhub-test-notify-dlq-${RUN}`, topic: `roadhub-test-ops-alerts-${RUN}`
};
const WATCH_QUEUE = `roadhub-test-alerts-watch-${RUN}`; // subscribed to the test topic, to see the SNS alerts
const FAKE_KEY = 'fake-resend-key-for-tests';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The Lambda handler runs in this process and logs JSON lines: hide them so the test output stays readable.
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => (String(chunk).startsWith('{"time"') ? true : realWrite(chunk, ...rest));

const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const sns = new SNSClient({});
const events = new EventBridgeClient({});
const people = new Map();    // the fake admin service's accounts
const emails = [];           // every e-mail the fake Resend API received
const resendMode = { value: 'ok' };
let infra; let watchUrl; let admin; let resend; let worker; let repos;
const workerLogs = [];

function person(name) {
  const p = { userId: randomUUID(), name, email: `${name.toLowerCase()}.${RUN}@example.com` };
  people.set(p.userId, p);
  return p;
}
const mailsFor = (eventId) => emails.filter((m) => m.idempotencyKey.startsWith(`${eventId}#`));

async function waitUntil(check, what, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${what}\nworker log:\n${workerLogs.slice(-15).join('\n')}`);
}

async function queueIsEmpty(url) {
  const out = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
  }));
  return Number(out.Attributes.ApproximateNumberOfMessages) === 0 && Number(out.Attributes.ApproximateNumberOfMessagesNotVisible) === 0;
}

// The fake Resend API: checks the key and records each e-mail (POST /emails).
function startFakeResend() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method !== 'POST' || req.url !== '/emails') return send(404, { message: 'not found' });
      if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) return send(401, { message: 'invalid key' });
      const body = JSON.parse(raw);
      emails.push({ to: body.to[0], subject: body.subject, text: body.text, idempotencyKey: req.headers['idempotency-key'], mode: resendMode.value });
      if (resendMode.value === 'fail') return send(500, { message: 'provider down' });
      return send(200, { id: `fake-${emails.length}` });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); })
  })));
}

function startWorker(env) {
  const child = spawn(process.execPath, [path.join('workers', 'notificationWorker.js')], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, ...AWS_ENV, NODE_ENV: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const collect = (chunk) => chunk.toString().split('\n').filter(Boolean).forEach((l) => workerLogs.push(l));
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return child;
}

const statusChanged = (detail) => ({ Source: 'roadhub.roadmap', DetailType: 'FeatureStatusChanged', Detail: JSON.stringify(detail), EventBusName: NAMES.bus });

test.before(async () => {
  await requireTables(['roadhub-votes', 'roadhub-engagement-links', 'roadhub-notifications', 'roadhub-processed-messages']);
  const keys = await loadKeys();
  await getOrCreateSecret('roadhub-test/resend', () => ({ RESEND_API_KEY: FAKE_KEY, RESEND_FROM: 'RoadmapHub Test <test@example.com>' }));
  infra = await createMessaging({ names: NAMES, visibilityTimeout: 5 });

  watchUrl = (await sqs.send(new CreateQueueCommand({ QueueName: WATCH_QUEUE }))).QueueUrl;
  const watchArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: watchUrl, AttributeNames: ['QueueArn'] }))).Attributes.QueueArn;
  await sqs.send(new SetQueueAttributesCommand({
    QueueUrl: watchUrl,
    Attributes: { Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: watchArn }] }) }
  }));
  await sns.send(new SubscribeCommand({ TopicArn: infra.topicArn, Protocol: 'sqs', Endpoint: watchArn }));

  admin = await startFake('admin', keys.internalKey, [{
    method: 'POST',
    path: /^\/internal\/identity\/users\/contacts$/,
    reply: ({ body }) => ({ body: { items: body.userIds.filter((id) => people.has(id)).map((id) => people.get(id)) } })
  }]);
  resend = await startFakeResend();
  // The Lambda handler runs inside this test process: give it the same settings as the worker process.
  Object.assign(process.env, {
    ADMIN_URL: admin.url, OPS_TOPIC_ARN: infra.topicArn, OPS_TOPIC_NAME: NAMES.topic,
    RESEND_SECRET_NAME: 'roadhub-test/resend', RESEND_API_URL: resend.url, EMAIL_SEND_INTERVAL_MS: '0',
    EMAIL_REDIRECT_TO: '', WEBSITE_URL: 'http://localhost:8080', AUDIT_LOGS: 'off', EVENTS: 'off'
  });
  repos = require('../repositories');
  worker = startWorker({
    NOTIFY_QUEUE_URL: infra.queueUrl, OPS_TOPIC_ARN: infra.topicArn, OPS_TOPIC_NAME: NAMES.topic,
    RESEND_SECRET_NAME: 'roadhub-test/resend', RESEND_API_URL: resend.url, ADMIN_URL: admin.url,
    WORKER_WAIT_SECONDS: '1', WORKER_RETRY_DELAY_SECONDS: '1', EMAIL_SEND_INTERVAL_MS: '0', EVENTS: 'off',
    EMAIL_REDIRECT_TO: '', WEBSITE_URL: 'http://localhost:8080', AUDIT_LOGS: 'off'
  });
  await waitUntil(() => workerLogs.some((l) => l.includes('WORKER_STARTED')), 'the worker to start', 15000);
});

test.after(async () => {
  if (worker) worker.kill('SIGTERM');
  if (admin) await admin.stop();
  if (resend) await resend.stop();
  const quiet = (p) => p.catch(() => {});
  await quiet(events.send(new RemoveTargetsCommand({ Rule: NAMES.rule, EventBusName: NAMES.bus, Ids: ['notify-queue'] })));
  await quiet(events.send(new DeleteRuleCommand({ Name: NAMES.rule, EventBusName: NAMES.bus })));
  await quiet(events.send(new DeleteEventBusCommand({ Name: NAMES.bus })));
  for (const url of [infra && infra.queueUrl, infra && infra.dlqUrl, watchUrl].filter(Boolean)) {
    await quiet(sqs.send(new DeleteQueueCommand({ QueueUrl: url })));
  }
  if (infra) await quiet(sns.send(new DeleteTopicCommand({ TopicArn: infra.topicArn })));
});

test('status change: EventBridge rule -> SQS -> worker -> one e-mail to each voter and the author', async () => {
  const [alice, bob, carol, boss] = ['Alice', 'Bob', 'Carol', 'Boss'].map(person);
  const featureId = randomUUID();
  await repos.votes.addVote(featureId, bob.userId);
  await repos.votes.addVote(featureId, carol.userId);
  const eventId = randomUUID();
  const put = await events.send(new PutEventsCommand({
    Entries: [statusChanged({ eventId, featureId, title: 'Dark mode for the dashboard', oldStatus: 'under_review', newStatus: 'planned', authorId: alice.userId, actorId: boss.userId, requestId: 'trace-worker-0001' })]
  }));
  assert.equal(put.FailedEntryCount || 0, 0);

  await waitUntil(() => mailsFor(eventId).length === 3, '3 e-mails');
  const mails = mailsFor(eventId);
  assert.deepEqual(mails.map((m) => m.to).sort(), [alice.email, bob.email, carol.email].sort(), 'voters + author, not the admin who changed it');
  assert.ok(mails.every((m) => m.subject === 'RoadmapHub: "Dark mode for the dashboard" is now Planned'));
  assert.ok(mails.find((m) => m.to === bob.email).text.includes('Hello Bob'));

  const contactsCall = admin.callsTo(/contacts$/).at(-1);
  assert.equal(contactsCall.token.iss, 'engagement');
  assert.deepEqual(contactsCall.token.scope, ['identity:contacts']);
  assert.equal(contactsCall.requestId, 'trace-worker-0001', 'the original request id reaches the admin service');

  const bobLog = await repos.notifications.listForUser(bob.userId);
  assert.deepEqual([bobLog[0].eventId, bobLog[0].status], [eventId, 'sent'], 'shown in /api/me/notifications');
  await waitUntil(() => queueIsEmpty(infra.queueUrl), 'the job to be deleted from the queue');
});

test('the same event delivered twice: each person still gets exactly one e-mail', async () => {
  const [dave, erin, boss] = ['Dave', 'Erin', 'Boss'].map(person);
  const sourceId = randomUUID();
  await repos.votes.addVote(sourceId, erin.userId);
  const eventId = randomUUID();
  // An EventBridge event exactly as the rule delivers it, sent twice (SQS may deliver a message more than once).
  const body = JSON.stringify({
    version: '0', id: randomUUID(), 'detail-type': 'FeatureMerged', source: 'roadhub.admin', time: new Date().toISOString(),
    detail: { eventId, mergeId: randomUUID(), sourceId, targetId: randomUUID(), sourceTitle: 'Dashboard dark mode', targetTitle: 'Dark mode for the dashboard', sourceAuthorId: dave.userId, actorId: boss.userId }
  });
  await sqs.send(new SendMessageCommand({ QueueUrl: infra.queueUrl, MessageBody: body }));
  await sqs.send(new SendMessageCommand({ QueueUrl: infra.queueUrl, MessageBody: body }));
  await waitUntil(() => workerLogs.filter((l) => l.includes(eventId) && l.includes('"event":"NOTIFICATION_JOB_DONE"')).length === 2, 'both copies handled');
  const mails = mailsFor(eventId);
  assert.deepEqual(mails.map((m) => m.to).sort(), [dave.email, erin.email].sort());
  assert.ok(mails[0].subject.includes('was merged into "Dark mode for the dashboard"'));
  assert.ok(workerLogs.some((l) => l.includes(eventId) && l.includes('"outcome":"duplicate"')), 'the second copy is recognised');
});

test('an event the worker does not handle is removed without any e-mail', async () => {
  const before = emails.length;
  const id = randomUUID();
  await sqs.send(new SendMessageCommand({
    QueueUrl: infra.queueUrl,
    MessageBody: JSON.stringify({ id, source: 'roadhub.engagement', 'detail-type': 'VoteAdded', detail: { eventId: id, featureId: randomUUID() } })
  }));
  await waitUntil(() => workerLogs.some((l) => l.includes(id) && l.includes('"outcome":"ignored"')), 'the event to be ignored');
  assert.equal(emails.length, before);
});

test('e-mail provider down: 3 tries with a growing delay, then an SNS alert and the dead-letter queue', async () => {
  resendMode.value = 'fail';
  const [frank, boss] = ['Frank', 'Boss'].map(person);
  const featureId = randomUUID();
  await repos.votes.addVote(featureId, frank.userId);
  const eventId = randomUUID();
  await events.send(new PutEventsCommand({
    Entries: [statusChanged({ eventId, featureId, title: 'Export to CSV', oldStatus: 'planned', newStatus: 'in_progress', authorId: frank.userId, actorId: boss.userId })]
  }));

  const dead = await waitUntil(async () => {
    const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: infra.dlqUrl, WaitTimeSeconds: 1, MaxNumberOfMessages: 10 }));
    return (out.Messages || []).find((m) => JSON.parse(m.Body).detail.eventId === eventId);
  }, 'the job in the dead-letter queue', 45000);
  resendMode.value = 'ok';
  assert.ok(dead, 'the failed job is kept in the dead-letter queue for inspection');
  assert.equal(mailsFor(eventId).length, 3, 'tried 3 times');
  const fails = workerLogs.filter((l) => l.includes(eventId) && l.includes('"event":"NOTIFICATION_JOB_FAILED"')).map((l) => JSON.parse(l).receiveCount);
  assert.deepEqual(fails, [1, 2, 3]);

  const alert = await waitUntil(async () => {
    const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: watchUrl, WaitTimeSeconds: 1, MaxNumberOfMessages: 10 }));
    return (out.Messages || []).map((m) => JSON.parse(m.Body)).find((n) => n.Message && n.Message.includes(eventId));
  }, 'the SNS alert');
  assert.equal(alert.Subject, 'RoadmapHub: notification job failed');
  const info = JSON.parse(alert.Message);
  assert.deepEqual([info.code, info.receiveCount], ['EMAIL_FAILED', 3]);
  assert.ok(!alert.Message.includes('@'), 'no e-mail address in the alert');

  const log = await repos.notifications.listForUser(frank.userId);
  assert.deepEqual([log[0].status, log[0].attempts, log[0].errorCode], ['failed', 3, 'RESEND_500']);
});

// ---- Way 2: the same jobs through the Lambda handler (workers/lambda.js) ----
const sqsRecord = (event, receiveCount = 1) => ({
  messageId: randomUUID(), body: JSON.stringify(event), attributes: { ApproximateReceiveCount: String(receiveCount) }
});
const statusEvent = (detail) => ({ version: '0', id: randomUUID(), 'detail-type': 'FeatureStatusChanged', source: 'roadhub.roadmap', detail });

test('Lambda way: the handler e-mails the voters, reports no failed message, and handles a repeat once', async () => {
  const { handler } = require('../workers/lambda');
  const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const [gina, boss] = ['Gina', 'Boss'].map(person);
  const featureId = randomUUID();
  await repos.votes.addVote(featureId, gina.userId);
  const eventId = randomUUID();
  const record = sqsRecord(statusEvent({ eventId, featureId, title: 'Mobile app', oldStatus: 'in_progress', newStatus: 'shipped', actorId: boss.userId }));

  assert.deepEqual(await handler({ Records: [record] }), { batchItemFailures: [] });
  assert.deepEqual(mailsFor(eventId).map((m) => m.to), [gina.email]);
  assert.equal(mailsFor(eventId)[0].subject, 'RoadmapHub: "Mobile app" is now Shipped');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const done = await db.send(new GetCommand({ TableName: 'roadhub-processed-messages', Key: { messageId: eventId } }));
  assert.equal(done.Item.processedBy, 'lambda', 'the result records which consumer did the job');

  assert.deepEqual(await handler({ Records: [record] }), { batchItemFailures: [] }, 'SQS delivered it twice');
  assert.equal(mailsFor(eventId).length, 1, 'still one e-mail');
});

test('Lambda way: only the failed message is reported; on its 3rd try an SNS alert is published', async () => {
  const { handler } = require('../workers/lambda');
  const [hana, boss] = ['Hana', 'Boss'].map(person);
  const featureId = randomUUID();
  await repos.votes.addVote(featureId, hana.userId);
  const eventId = randomUUID();
  const bad = sqsRecord(statusEvent({ eventId, featureId, title: 'Offline mode', oldStatus: 'planned', newStatus: 'in_progress', actorId: boss.userId }), 3);
  const fine = sqsRecord({ id: randomUUID(), 'detail-type': 'VoteAdded', source: 'roadhub.engagement', detail: { eventId: randomUUID() } });
  resendMode.value = 'fail';
  const out = await handler({ Records: [bad, fine] });
  resendMode.value = 'ok';
  assert.deepEqual(out, { batchItemFailures: [{ itemIdentifier: bad.messageId }] }, 'the good message is not retried');

  const alert = await waitUntil(async () => {
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: watchUrl, WaitTimeSeconds: 1, MaxNumberOfMessages: 10 }));
    return (res.Messages || []).map((m) => JSON.parse(m.Body)).find((n) => n.Message && n.Message.includes(eventId));
  }, 'the SNS alert from the Lambda way');
  const info = JSON.parse(alert.Message);
  assert.deepEqual([info.runner, info.receiveCount, info.code], ['lambda', 3, 'EMAIL_FAILED']);
});
