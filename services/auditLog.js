// Audit trail in CloudWatch Logs (the Lab 8 idea): every write and every blocked request becomes one
// line in log group /aws/ecs/roadhub-engagement, stream app-audit-stream:
//   AUDIT VOTE_ADDED {"featureId":"...","userId":"...","instanceId":"engagement-1234"}
//   SECURITY_ALERT {"type":"AUTH_FAILED","path":"/api/features/.../votes","code":"UNAUTHENTICATED",...}
// - AUDIT lines come from audit() below; SECURITY_ALERT lines are the logger's security events
//   (401, 403, rate limit, bad service token) that the shared kit already writes.
// - Lines are sent in small batches in the background, so a slow CloudWatch never slows a request.
// - Never put e-mail addresses, comment text, passwords, tokens or keys in a line.
const { CloudWatchLogsClient, PutLogEventsCommand, CreateLogStreamCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { logger } = require('../shared');
const config = require('../config');

const MAX_QUEUE = 1000; // if CloudWatch is down for long, keep only the newest lines (memory stays small)
const queue = [];
let client = null;
let timer = null;
let sending = null;
let lastWarning = 0;

function warn(reason) {
  // Written straight to stderr: going through the logger would send this line to CloudWatch again.
  if (Date.now() - lastWarning < 60000) return;
  lastWarning = Date.now();
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'WARN', event: 'AUDIT_LOG_UNAVAILABLE', reason })}\n`);
}

function enqueue(message) {
  if (!config.audit.enabled) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ timestamp: Date.now(), message });
  if (!timer) {
    timer = setTimeout(() => { flush().catch(() => {}); }, 1000);
    if (timer.unref) timer.unref();
  }
}

async function send(batch) {
  if (!client) client = new CloudWatchLogsClient({});
  await client.send(new PutLogEventsCommand({
    logGroupName: config.audit.logGroup, logStreamName: config.audit.logStream, logEvents: batch
  }));
}

// Sends everything waiting. The Lambda worker calls this before it returns (a frozen Lambda sends nothing).
async function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (sending) await sending;
  sending = (async () => {
    while (queue.length) {
      const batch = queue.splice(0, 100);
      try {
        await send(batch);
      } catch (e) {
        if (e.name === 'ResourceNotFoundException') {
          // The stream is missing (the group is made by infra/services/07-cloudwatch.sh): make it once.
          try {
            await client.send(new CreateLogStreamCommand({ logGroupName: config.audit.logGroup, logStreamName: config.audit.logStream }));
            await send(batch);
            continue;
          } catch (e2) {
            warn(e2.name);
          }
        } else {
          warn(e.name);
        }
        return; // drop this batch: logging must never break the service
      }
    }
  })();
  try { await sending; } finally { sending = null; }
}

// Business event worth keeping: votes, comments, merge steps, notification jobs.
function audit(action, detail = {}) {
  logger.info('AUDIT', { action, instanceId: config.instanceId, ...detail });
}

// The logger calls this for every line it writes: forward only AUDIT and SECURITY lines.
logger.addSink((text, line) => {
  if (line.event === 'AUDIT') {
    const { time, level, service, event, action, ...detail } = line;
    enqueue(`AUDIT ${action} ${JSON.stringify(detail)}`);
  } else if (line.level === 'SECURITY') {
    const { time, level, service, event, ...detail } = line;
    enqueue(`SECURITY_ALERT ${JSON.stringify({ type: event, instanceId: config.instanceId, ...detail })}`);
  }
});

module.exports = { audit, flush };
