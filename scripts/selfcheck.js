// Self-check (the Lab 8 idea "node server.js --selfcheck"): tests the pure logic of the service
// WITHOUT Floci, a network or a database, before we add any cloud.
//   npm run selfcheck        (or: node server.js --selfcheck)
// Last line when everything is fine:  [selfcheck] all assertions passed
const assert = require('assert');

process.env.AUDIT_LOGS = 'off'; // nothing is sent anywhere during the self-check
// Hide the service's own JSON log lines, so only PASS / FAIL lines are printed.
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => (String(chunk).startsWith('{"time"') ? true : realWrite(chunk, ...rest));

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const { cleanText } = require('../services/textRules');
check('comment cleaning removes <script> blocks (Lab 8 test S5)', () => {
  assert.strictEqual(cleanText('<script>alert(1)</script>hi'), 'hi');
  assert.strictEqual(cleanText('<SCRIPT src=x>evil()</SCRIPT>ok'), 'ok');
  assert.strictEqual(cleanText('unclosed <script>alert(1)'), 'unclosed');
});
check('comment cleaning strips other HTML but keeps normal text', () => {
  assert.strictEqual(cleanText('<b>Dark</b> mode <img src=x onerror=alert(1)>please'), 'Dark mode please');
  assert.strictEqual(cleanText('2 < 3 and 5 > 4'), '2 < 3 and 5 > 4');
  assert.strictEqual(cleanText('   Yes please!  '), 'Yes please!');
  assert.strictEqual(cleanText('<script>x</script>'), '', 'only HTML -> empty (the service answers 400)');
});

const { createRateLimiter } = require('../shared/rate-limit');
check('rate limiter: 3 per window, the 4th and 5th get 429 (Lab 8 test S2)', () => {
  const limiter = createRateLimiter({ name: 'selfcheck', windowMs: 60000, max: 3 });
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const req = { ip: '203.0.113.7', originalUrl: '/api/test', id: `r${i}` };
    const res = { set() {} };
    limiter(req, res, (err) => statuses.push(err ? err.status : 200));
  }
  assert.deepStrictEqual(statuses, [200, 200, 200, 429, 429]);
});

const { PLANS } = require('../services/notificationService');
check('only status changes and merges send e-mails', () => {
  assert.deepStrictEqual(Object.keys(PLANS).sort(), ['roadhub.admin:FeatureMerged', 'roadhub.roadmap:FeatureStatusChanged']);
});

const config = require('../config');
check('worker retries 3 times, the same number as the queue redrive policy', () => {
  assert.strictEqual(config.worker.maxReceives, 3);
});

const { logger } = require('../shared');
check('audit lines carry no e-mail address or comment text', () => {
  let captured = '';
  logger.addSink((text, line) => { if (line.event === 'AUDIT') captured = text; });
  require('../services/auditLog').audit('VOTE_ADDED', { featureId: 'f-1', userId: 'u-1' });
  assert.ok(captured.includes('"action":"VOTE_ADDED"'));
  assert.ok(!captured.includes('@'), 'no e-mail address');
});

const { handler } = require('../workers/lambda');
check('Lambda handler: an empty batch reports no failed messages', async () => {
  assert.deepStrictEqual(await handler({ Records: [] }), { batchItemFailures: [] });
});

async function run() {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
  }
  console.log(failed ? `[selfcheck] ${failed} check(s) failed` : '[selfcheck] all assertions passed');
  process.exit(failed ? 1 : 0);
}

module.exports = { run };
if (require.main === module) run();
