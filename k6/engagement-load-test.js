import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Engagement load test (same shape as Lab 8's k6/social-load-test.js).
//
// It runs against the WHOLE system through the gateway on :8080, because a vote needs a login
// (admin service) and a request to vote on (roadmap service). In roadhub-frontend:
//
//   export RATE_LIMITS=off TURNSTILE_ENABLED=false      # BEFORE starting: k6 comes from one IP
//   Run A (1 copy of each service):   bash scripts/start-all.sh
//   Run B (3 copies of each service): REPLICAS=3 bash scripts/start-all.sh
//   then, in this repo:               k6 run k6/engagement-load-test.js
//   Run C (failover): during Run B, in roadhub-frontend:  kill $(cat .run/engagement-1.pid)
//
// The gateway adds X-Served-By: engagement@<port> (which copy answered). The summary shows one
// counter per engagement copy (served_by_engagement_3002, _3012, _3022).
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const USERS = Number(__ENV.USERS || 20);
const PASSWORD = 'Correct-horse-42';

const servedBy = {};
for (const port of [3002, 3012, 3022, 3032]) servedBy[port] = new Counter(`served_by_engagement_${port}`);
const rateLimited429 = new Counter('rate_limited_429');
const voteLatency = new Trend('vote_duration');
const readCommentsLatency = new Trend('read_comments_duration');
// 409 (already voted) and 404 are normal answers in this test, not failures.
const normal = http.expectedStatuses({ min: 200, max: 299 }, 404, 409);

export const options = {
  stages: [
    { duration: '30s', target: 20 },  // ramp-up
    { duration: '1m', target: 20 },   // sustained load
    { duration: '20s', target: 100 }, // spike
    { duration: '30s', target: 100 }, // sustained spike
    { duration: '20s', target: 0 },   // ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.05'],
  },
};

// One author creates a request; USERS people register so the virtual users can vote and comment.
export function setup() {
  const json = { headers: { 'Content-Type': 'application/json' } };
  const register = (name) => {
    const email = `k6.${name}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
    const res = http.post(`${BASE_URL}/api/auth/register`, JSON.stringify({ name, email, password: PASSWORD }), json);
    if (res.status !== 201) throw new Error(`setup: register ${name} failed (${res.status}): ${res.body}`);
    return res.json('token');
  };
  const author = register('k6-author');
  const feature = http.post(`${BASE_URL}/api/features`,
    JSON.stringify({ title: 'k6 load test request', description: 'Created by the k6 engagement load test.', categoryId: 'performance' }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${author}` } });
  if (feature.status !== 201) throw new Error(`setup: create request failed (${feature.status}): ${feature.body}`);
  const tokens = [];
  for (let i = 0; i < USERS; i += 1) tokens.push(register(`k6-user-${i}`));
  return { featureId: feature.json('feature.featureId'), tokens };
}

function note(res) {
  if (res.status === 429) rateLimited429.add(1);
  const match = String(res.headers['X-Served-By'] || '').match(/^engagement@(\d+)$/); // e.g. engagement@3012
  if (match && servedBy[Number(match[1])]) servedBy[Number(match[1])].add(1);
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const params = (name) => ({
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    tags: { name }, responseCallback: normal,
  });
  const base = `${BASE_URL}/api/features/${data.featureId}`;
  const roll = Math.random();

  if (roll < 0.5) {            // 50% read the discussion
    const res = http.get(`${base}/comments`, { tags: { name: 'read_comments' } });
    readCommentsLatency.add(res.timings.duration);
    note(res);
    check(res, { 'read comments: 200': (r) => r.status === 200 });
  } else if (roll < 0.7) {     // 20% look at the vote count
    const res = http.get(`${base}/votes`, params('vote_summary'));
    note(res);
    check(res, { 'vote summary: 200': (r) => r.status === 200 });
  } else if (roll < 0.85) {    // 15% vote, or take the vote back if already voted
    let res = http.post(`${base}/votes`, null, params('vote'));
    if (res.status === 409) res = http.del(`${base}/votes`, null, params('remove_vote'));
    voteLatency.add(res.timings.duration);
    note(res);
    check(res, { 'vote or remove vote: 200/201': (r) => r.status === 200 || r.status === 201 });
  } else if (roll < 0.95) {    // 10% comment
    const res = http.post(`${base}/comments`, JSON.stringify({ body: `comment from VU ${__VU} iteration ${__ITER}` }), params('add_comment'));
    note(res);
    check(res, { 'add comment: 201': (r) => r.status === 201 });
  } else {                     // 5% open "My votes"
    const res = http.get(`${BASE_URL}/api/me/votes`, params('my_votes'));
    note(res);
    check(res, { 'my votes: 200': (r) => r.status === 200 });
  }
  sleep(Math.random() + 0.5);  // 0.5-1.5 s think time
}
