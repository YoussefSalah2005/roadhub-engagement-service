// Engagement Service (S2) tested ON ITS OWN: the real service process with its real DynamoDB tables (Floci),
// a FAKE Roadmap Service (which requests exist, and which one is the main request after a merge)
// and a FAKE Administration Service (is this account still active?).
// Run: npm test   (needs Floci on localhost:4566 and "npm run setup:tables" once)
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const { requireTables } = require('./helpers/aws');
const { loadKeys, userToken, serviceToken } = require('./helpers/keys');
const { startFake } = require('./helpers/fake-service');
const { startService } = require('./helpers/service');
const { api } = require('./helpers/api');
const { spawnSync } = require('child_process');
const path = require('path');
const {
  CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, GetLogEventsCommand, DeleteLogGroupCommand
} = require('@aws-sdk/client-cloudwatch-logs');

// The audit trail of this test run goes to its own log group (deleted at the end).
const AUDIT_GROUP = `/aws/ecs/roadhub-engagement-test-${randomUUID().slice(0, 8)}`;
const logs = new CloudWatchLogsClient({});

const accounts = new Map();  // fake admin: account state by user id
const features = new Map();  // fake roadmap: request id -> { canonicalId, title, status }
const BROKEN = randomUUID(); // a request id for which the fake roadmap service fails (HTTP 500)
let keys; let roadmap; let admin; let svc; let call;
const u = {};
const f = {};

function person(name, role = 'user') {
  const id = randomUUID();
  accounts.set(id, { userId: id, role, accountStatus: 'active', tokenVersion: 0 });
  return { id, name, token: userToken(keys, { id, name }) };
}
function feature(title) {
  const id = randomUUID();
  features.set(id, { canonicalId: id, title, status: 'under_review' });
  return id;
}
const vote = (who, id, method = 'POST') => call(method, `/api/features/${id}/votes`, { token: who.token });
const comment = (who, id, body) => call('POST', `/api/features/${id}/comments`, { token: who.token, body: { body } });
// An internal call as the Administration Service makes it during a merge.
const mergeStep = (action, body, scope = 'engagement:merge') => call('POST', `/internal/engagement/merges/${action}`, {
  body, headers: { 'X-Service-Token': serviceToken(keys, { from: 'admin', to: 'engagement', scope }), 'Idempotency-Key': body.mergeId }
});

test.before(async () => {
  await requireTables(['roadhub-votes', 'roadhub-comments', 'roadhub-engagement-counts', 'roadhub-engagement-links', 'roadhub-notifications']);
  keys = await loadKeys();
  await logs.send(new CreateLogGroupCommand({ logGroupName: AUDIT_GROUP }));
  await logs.send(new CreateLogStreamCommand({ logGroupName: AUDIT_GROUP, logStreamName: 'app-audit-stream' }));
  roadmap = await startFake('roadmap', keys.internalKey, [
    { method: 'GET', path: /^\/internal\/features\/_ping$/, reply: () => ({ body: { service: 'roadmap' } }) },
    {
      method: 'GET',
      path: /^\/internal\/features\/([^/]+)\/resolve$/,
      reply: ({ params: [id] }) => {
        if (id === BROKEN) return { status: 500, body: { error: { code: 'BOOM', message: 'roadmap service is broken' } } };
        const x = features.get(id);
        if (!x) return { status: 404, body: { error: { code: 'FEATURE_NOT_FOUND', message: 'This feature request does not exist.' } } };
        const main = features.get(x.canonicalId);
        return { body: { featureId: id, canonicalId: x.canonicalId, exists: true, status: main.status, title: main.title, merged: x.canonicalId !== id, locked: false } };
      }
    },
    {
      method: 'POST',
      path: /^\/internal\/features\/resolve-batch$/,
      reply: ({ body }) => ({
        body: {
          items: body.ids.filter((id) => features.has(id)).map((id) => {
            const main = features.get(features.get(id).canonicalId);
            return { featureId: id, canonicalId: features.get(id).canonicalId, title: main.title, status: main.status, categoryName: 'User interface and design', merged: features.get(id).canonicalId !== id };
          })
        }
      })
    }
  ]);
  admin = await startFake('admin', keys.internalKey, [
    { method: 'GET', path: /^\/internal\/identity\/_ping$/, reply: () => ({ body: { service: 'admin' } }) },
    {
      method: 'GET',
      path: /^\/internal\/identity\/users\/([^/]+)\/status$/,
      reply: ({ params: [id] }) => (accounts.has(id)
        ? { body: accounts.get(id) }
        : { status: 404, body: { error: { code: 'USER_NOT_FOUND', message: 'Account not found.' } } })
    }
  ]);
  svc = await startService({
    port: 4520,
    env: {
      ROADMAP_URL: roadmap.url, ADMIN_URL: admin.url, USER_STATUS_CACHE_MS: '0', TURNSTILE_ENABLED: 'false', RATE_LIMITS: 'off', EVENTS: 'off',
      INSTANCE_ID: 'engagement-test-1', AUDIT_LOG_GROUP: AUDIT_GROUP, AUDIT_LOG_STREAM: 'app-audit-stream'
    }
  });
  call = api(svc.url);
  for (const name of ['Alice', 'Bob', 'Carol', 'Dave', 'Erin']) u[name] = person(name);
  u.admin = person('Product Admin', 'admin');
  f.A = feature('Dark mode for the dashboard');
  f.B = feature('Dashboard dark mode');
});
test.after(async () => {
  await logs.send(new DeleteLogGroupCommand({ logGroupName: AUDIT_GROUP })).catch(() => {});
  if (svc) await svc.stop();
  if (roadmap) await roadmap.stop();
  if (admin) await admin.stop();
});

test('runs as its own process; reaches roadmap and admin over HTTP with service tokens', async () => {
  roadmap.clear();
  const r = await call('GET', '/api/engagement/dependencies', { headers: { 'X-Request-Id': 'trace-engagement-0001' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.dependencies, { roadmap: 'up', admin: 'up' });
  const ping = roadmap.callsTo(/_ping$/)[0];
  assert.equal(ping.token.iss, 'engagement');
  assert.deepEqual(ping.token.scope, ['features:read']);
  assert.equal(ping.requestId, 'trace-engagement-0001', 'the same request id travels to the other service');
});

test('vote: one vote per person, admins cannot vote, unknown request -> 404', async () => {
  const first = await vote(u.Bob, f.A);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.voteCount, 1);
  const again = await vote(u.Bob, f.A);
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'ALREADY_VOTED');
  assert.equal((await vote(u.admin, f.A)).status, 403);
  assert.equal((await vote({}, f.A)).status, 401);
  assert.equal((await vote(u.Bob, randomUUID())).status, 404, 'the roadmap service says it does not exist');
  assert.equal((await call('POST', '/api/features/not-a-uuid/votes', { token: u.Bob.token })).status, 400);
});

test('five clicks at the same moment by one person store exactly one vote', async () => {
  const burst = await Promise.all([1, 2, 3, 4, 5].map(() => vote(u.Carol, f.A)));
  assert.equal(burst.filter((r) => r.status === 201).length, 1, burst.map((r) => r.status).join(','));
  const summary = await call('GET', `/api/features/${f.A}/votes`, { token: u.Carol.token });
  assert.deepEqual([summary.data.voteCount, summary.data.hasVoted], [2, true]);
  const visitor = await call('GET', `/api/features/${f.A}/votes`);
  assert.deepEqual([visitor.status, visitor.data.hasVoted], [200, false]);
});

test('remove vote: only my own vote, count goes down', async () => {
  assert.equal((await vote(u.Erin, f.A)).status, 201);
  const removed = await vote(u.Erin, f.A, 'DELETE');
  assert.equal(removed.status, 200);
  assert.deepEqual([removed.data.voteCount, removed.data.hasVoted], [2, false]);
  assert.equal((await vote(u.Erin, f.A, 'DELETE')).status, 404, 'nothing left to remove');
});

test('comments: owner edits only, no extra fields, admin reply is marked, admin may delete', async () => {
  const bobC = await comment(u.Bob, f.A, 'Yes please, my eyes hurt at night');
  assert.equal(bobC.status, 201);
  const id = bobC.data.comment.commentId;
  const alice = await call('PATCH', `/api/comments/${id}`, { token: u.Alice.token, body: { body: 'Alice edits Bob' } });
  assert.equal(alice.status, 403);
  assert.equal(alice.data.error.code, 'NOT_OWNER');
  const edit = await call('PATCH', `/api/comments/${id}`, { token: u.Bob.token, body: { body: 'Yes please (edited)' } });
  assert.deepEqual([edit.status, edit.data.comment.edited], [200, true]);
  assert.equal((await call('POST', `/api/features/${f.A}/comments`, { token: u.Bob.token, body: { body: 'x', userId: u.Alice.id } })).status, 400);
  assert.equal((await comment(u.Bob, f.A, '')).status, 400);
  const team = await comment(u.admin, f.A, 'Thanks, we are looking at it');
  assert.equal(team.data.comment.isTeamReply, true);
  const spam = await comment(u.Carol, f.A, 'to be removed');
  const sid = spam.data.comment.commentId;
  assert.equal((await call('DELETE', `/api/comments/${sid}`, { token: u.Alice.token })).status, 403);
  assert.equal((await call('DELETE', `/api/comments/${sid}`, { token: u.admin.token })).status, 204);
  const list = await call('GET', `/api/features/${f.A}/comments`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.comments.map((c) => c.body).sort(), ['Thanks, we are looking at it', 'Yes please (edited)']);
});

test('My votes lists only my own requests; login required', async () => {
  assert.equal((await vote(u.Bob, f.B)).status, 201);
  const mine = await call('GET', '/api/me/votes', { token: u.Bob.token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.votes.map((v) => v.featureId).sort(), [f.A, f.B].sort());
  assert.equal((await call('GET', '/api/me/votes')).status, 401);
});

test('a suspended user can read but not vote or comment', async () => {
  const account = accounts.get(u.Erin.id);
  account.accountStatus = 'suspended';
  account.suspendedUntil = new Date(Date.now() + 86400000).toISOString();
  const r = await vote(u.Erin, f.B);
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'ACCOUNT_SUSPENDED');
  assert.equal((await comment(u.Erin, f.B, 'hello')).status, 403);
  assert.equal((await call('GET', '/api/me/votes', { token: u.Erin.token })).status, 200);
  account.accountStatus = 'active';
});

test('fails closed: if the Roadmap Service cannot answer, the vote is refused (503)', async () => {
  features.set(BROKEN, { canonicalId: BROKEN, title: 'x', status: 'under_review' });
  assert.equal((await vote(u.Alice, BROKEN)).status, 503);
});

test('merge (called by admin): distinct voters, merged discussion, one effective vote, idempotent', async () => {
  // A: Bob, Carol.  B: Bob, Dave.  After merging B into A: Bob, Carol, Dave = 3 (Bob counted once).
  assert.equal((await vote(u.Dave, f.B)).status, 201);
  assert.equal((await comment(u.Dave, f.B, 'Same idea here')).status, 201);
  f.mergeId = randomUUID();
  const body = { mergeId: f.mergeId, sourceId: f.B, targetId: f.A };
  assert.equal((await mergeStep('prepare', body, 'features:read')).status, 403, 'wrong scope');
  const prep = await mergeStep('prepare', body);
  assert.equal(prep.status, 200);
  assert.deepEqual(
    [prep.data.sourceVoters, prep.data.targetVoters, prep.data.sharedVoters, prep.data.votesAfterMerge, prep.data.sourceComments],
    [2, 2, 1, 3, 1]
  );
  const done = await mergeStep('complete', body);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.voteCount, 3);
  const repeat = await mergeStep('complete', body);
  assert.deepEqual([repeat.status, repeat.data.voteCount], [200, 3], 'same Idempotency-Key: same answer, nothing applied twice');
  assert.equal((await mergeStep('complete', { ...body, mergeId: randomUUID() })).status, 409, 'B is already merged by another merge');

  features.get(f.B).canonicalId = f.A; // the roadmap service now says: B is a duplicate of A
  assert.equal((await call('GET', `/api/features/${f.A}/votes`)).data.voteCount, 3);
  const discussion = await call('GET', `/api/features/${f.A}/comments`);
  assert.ok(discussion.data.comments.some((c) => c.fromMergedRequest && c.body === 'Same idea here'));
  assert.equal((await vote(u.Dave, f.B)).status, 409, 'Dave already counts through B');
  assert.equal((await vote(u.Dave, f.A)).status, 409, 'and cannot vote again on A');
  const erin = await vote(u.Erin, f.B);
  assert.equal(erin.status, 201);
  assert.equal(erin.data.featureId, f.A, 'a vote on the duplicate URL counts for the main request');
  assert.equal(erin.data.voteCount, 4);
});

test('undo (called by admin): votes and comments return to their own request, nothing lost or doubled', async () => {
  const body = { mergeId: f.mergeId, sourceId: f.B, targetId: f.A };
  const undo = await mergeStep('undo', body);
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal(undo.data.target.voteCount, 3, 'A: Bob, Carol, Erin');
  assert.equal(undo.data.source.voteCount, 2, 'B: Bob, Dave');
  features.get(f.B).canonicalId = f.B;
  const bComments = await call('GET', `/api/features/${f.B}/comments`);
  assert.deepEqual(bComments.data.comments.map((c) => c.body), ['Same idea here']);
  assert.equal((await mergeStep('undo', body)).status, 200, 'undo again is safe (idempotent)');
});

test('internal routes need a valid service token', async () => {
  assert.equal((await call('GET', '/internal/engagement/_ping')).status, 401);
  const forged = jwt.sign({ typ: 'service', scope: ['engagement:merge'] }, 'not-the-real-key-not-the-real-key!!', { algorithm: 'HS256', issuer: 'admin', audience: 'engagement', expiresIn: 60 });
  assert.equal((await call('GET', '/internal/engagement/_ping', { headers: { 'X-Service-Token': forged } })).status, 401);
  assert.equal((await call('GET', '/internal/engagement/_ping', { headers: { 'X-Service-Token': u.admin.token } })).status, 401, 'a user login is not a service token');
});

test('every answer says which copy of the service answered (Lab 8 instance badge)', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.data.instanceId, 'engagement-test-1');
  const res = await fetch(`${svc.url}/api/features/${f.A}/votes`);
  assert.equal(res.headers.get('x-instance-id'), 'engagement-test-1');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('comments are cleaned before saving: <script> removed (Lab 8 test S5), only-HTML refused', async () => {
  const r = await comment(u.Carol, f.A, '<script>alert(1)</script>Nice idea');
  assert.equal(r.status, 201);
  assert.equal(r.data.comment.body, 'Nice idea');
  const onlyHtml = await comment(u.Carol, f.A, '<script>alert(1)</script>');
  assert.equal(onlyHtml.status, 400);
  const edit = await call('PATCH', `/api/comments/${r.data.comment.commentId}`, { token: u.Carol.token, body: { body: '<b>Very</b> nice <img src=x onerror=alert(1)>idea' } });
  assert.equal(edit.data.comment.body, 'Very nice idea');
});

test('audit trail in CloudWatch Logs: AUDIT lines for writes, SECURITY_ALERT lines for blocked requests', async () => {
  // Lines are sent in the background every second: read until the newest ones have arrived (max 15 s).
  let lines = [];
  for (let i = 0; i < 30; i += 1) {
    const out = await logs.send(new GetLogEventsCommand({ logGroupName: AUDIT_GROUP, logStreamName: 'app-audit-stream', startFromHead: true }));
    lines = (out.events || []).map((e) => e.message);
    if (lines.some((l) => l.includes('INTERNAL_AUTH_INVALID')) && lines.filter((l) => l.startsWith('AUDIT COMMENT_EDITED ')).length >= 2) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const action of ['VOTE_ADDED', 'VOTE_REMOVED', 'COMMENT_ADDED', 'COMMENT_EDITED', 'COMMENT_REMOVED_BY_ADMIN', 'MERGE_LINKED', 'MERGE_UNDONE']) {
    assert.ok(lines.some((l) => l.startsWith(`AUDIT ${action} `)), `AUDIT ${action} is in the log`);
  }
  const alerts = lines.filter((l) => l.startsWith('SECURITY_ALERT ')).map((l) => JSON.parse(l.slice('SECURITY_ALERT '.length)));
  assert.ok(alerts.some((a) => a.type === 'AUTH_FAILED'), 'a vote without login was recorded');
  assert.ok(alerts.some((a) => a.type === 'ACCESS_DENIED' && a.code === 'NOT_OWNER'), 'editing someone else\'s comment was recorded');
  assert.ok(alerts.some((a) => a.type === 'INTERNAL_AUTH_INVALID'), 'a forged service token was recorded');
  assert.ok(lines.every((l) => !l.includes('@')), 'no e-mail address in the audit trail');
  assert.ok(lines.every((l) => !l.includes('Nice idea')), 'no comment text in the audit trail');
});

test('self-check passes without Floci (node server.js --selfcheck)', () => {
  const out = spawnSync(process.execPath, ['server.js', '--selfcheck'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(out.stdout.includes('[selfcheck] all assertions passed'));
});
