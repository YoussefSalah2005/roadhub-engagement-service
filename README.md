# roadhub-engagement-service: Engagement Service (S2)

RoadmapHub · Team 22 (Lab Group A-3) · Cloud Computing and Cloud Security (26CSCN29H)
**Owner:** Youssef Mohamed Salah (239650)

Users vote for feature requests (one effective vote per person per main request, even after duplicates are
merged), comment, and see "My votes". When an admin merges two requests, this service links the duplicate to
the main request (nothing is copied) and recounts the distinct voters; undo removes the link and recounts both.
When a request changes status or is merged, its voters get an e-mail (notification worker: EventBridge -> SQS ->
Lambda -> Resend, with retries, a dead-letter queue and an SNS alert).

RoadmapHub is four repositories: `roadhub-roadmap-service`, **engagement (this one)**, `roadhub-admin-service`,
and `roadhub-frontend` (website, gateway, whole-system tests, team docs).

## Architecture of this service

```
browser ──> gateway :8080 ──> engagement API (:3002, Express) ──> DynamoDB (6 tables)
                                   │  asks roadmap: "which request is the main one?"  (HTTP + service token)
                                   │  asks admin:   "is this account active?"         (HTTP + service token)
                                   ├─> EventBridge: VoteAdded, CommentAdded ... ──> audit rule ──> CloudWatch Logs
                                   └─> CloudWatch Logs: AUDIT and SECURITY_ALERT lines (metric filter + alarm -> SNS)

roadmap: FeatureStatusChanged ┐
admin:   FeatureMerged ───────┴─> EventBridge rule ──> SQS roadhub-notify-queue ──> Lambda roadhub-notify-worker
                                                            │ 3 failed tries                 │ names + e-mails from admin
                                                            v                                v
                                                  SQS roadhub-notify-dlq            Resend e-mail ──> DynamoDB log
                                                  + SNS alert roadhub-ops-alerts    (shown in GET /api/me/notifications)
```

## The AWS services at a glance

| # | Service | Name in this repo | What it does here | Script | Security habit |
|---|---|---|---|---|---|
| 1 | DynamoDB | 6 tables `roadhub-*` | votes (key featureId + userId: one row per person), comments, counts, merge links, notification log, handled messages (TTL) | `01-dynamodb.sh` | only this service touches them |
| 2 | Secrets Manager | `roadhub/resend` | Resend API key for the worker | `02-secrets-manager.sh` | key only in `infra/.env` (git-ignored) and the secret, never printed |
| 3 | SQS | `roadhub-notify-queue` + `roadhub-notify-dlq` | notification jobs; a job that fails 3 times moves to the dead-letter queue | `03-sqs.sh` | queue policy: only the notify rule may send |
| 4 | SNS | `roadhub-ops-alerts` -> `roadhub-ops-alerts-inbox` | alert when a job fails for good or an alarm fires | `04-sns.sh` | no e-mail addresses or message bodies in alerts |
| 5 | EventBridge | `roadhub-notify-rule`, `roadhub-engagement-audit-rule` | status changes + merges -> queue; engagement events -> CloudWatch Logs | `05-eventbridge.sh` | rules match by source and type only |
| 6 | IAM | `roadhub-engagement-service-role`, `roadhub-notify-worker-role` | the "badges" of the API and the worker | `06-iam.sh` | least privilege, exact ARNs, never `"Resource": "*"` |
| 7 | CloudWatch | `/aws/ecs/roadhub-engagement`, metric filter, 2 alarms | audit trail; alarm on the DLQ and on many security alerts | `07-cloudwatch.sh` | never log e-mails, comment text, tokens or keys |
| 8 | Lambda | `roadhub-notify-worker` | the notification worker, triggered by the queue (Lab 7) | `08-lambda.sh` | own role, only what the worker needs |
| 9 | ELB + ECS + Auto Scaling | `roadhub-engagement-tg`, `roadhub-engagement-service` | how it would run on real AWS: 1-4 tasks at 50% CPU | `09-ecs.sh` | **SIMULATED**: recorded on Floci, served by local Node.js (as in Lab 8) |
| + | Resend (external API) | `clients/resend.js` | sends the e-mails | | key from Secrets Manager, 5 s timeout, idempotency key |

Every script is in `infra/services/`, runs on its own, and is safe to run again (same layout as Lab 8).

## API
Public (through the gateway). Full details: `docs/contracts/public-api-contract.md`.

| Method | Path | Who |
|---|---|---|
| GET | `/api/features/:id/votes` | visitor (shows `hasVoted` when logged in) |
| POST, DELETE | `/api/features/:id/votes` | user |
| GET | `/api/features/:id/comments` | visitor |
| POST | `/api/features/:id/comments` | logged in (an admin's comment is marked as a team reply) |
| PATCH | `/api/comments/:id` | comment owner |
| DELETE | `/api/comments/:id` | comment owner or admin |
| GET | `/api/me/votes`, `/api/me/notifications` | logged in |
| GET | `/api/engagement/dependencies` | diagnostic: can it reach roadmap and admin? |

Internal (other services only, `X-Service-Token`): POST `/internal/engagement/merges/{prepare,complete,abort,undo}`
(scope `engagement:merge`, caller: admin). This service calls roadmap `resolve` / `resolve-batch` (`features:read`) and
admin `users/:id/status` (`identity:read`) and `users/contacts` (`identity:contacts`, worker only).

## Run it (Windows: Git Bash)
Needs Node.js 20+, Docker Desktop and the AWS CLI. Floci must mount the Docker socket for Lambda (as in Lab 7).

```bash
npm install
npm run selfcheck                  # the logic, without Floci (Lab 8 --selfcheck)
cp infra/.env.example infra/.env   # put your Resend key in it (never commit it, never paste it in chat)
bash infra/run-floci.sh            # starts Floci (or your existing "floci" container) + builds all 9 services
cp .env.example .env               # ports and the other services' URLs (no secrets)
npm start                          # http://localhost:3002/health
bash infra/check-engagement.sh     # PASS / FAIL / NOT TESTED / SIMULATED for every resource and workflow
```

One script per service if you want to build or repair just one: `bash infra/services/03-sqs.sh`.
In a new Git Bash window, `source infra/services/_lib.sh` gives you `awsl` (aws pointed at Floci).

**Notification worker:** use ONE of the two ways, not both.
- Lambda (default after `run-floci.sh`): Floci runs `workers/lambda.js` when a job arrives. Test it with the saved
  events in `events/` (see `events/README.md`). After changing worker code: `bash infra/services/08-lambda.sh`.
- Process: `npm run worker` in a second window (same code, `workers/notificationWorker.js`). Switch the Lambda
  trigger off first: `awsl lambda update-event-source-mapping --no-enabled --uuid $(awsl lambda list-event-source-mappings --function-name roadhub-notify-worker --query 'EventSourceMappings[0].UUID' --output text)`

Real e-mails need the admin service running (it gives the names and addresses) and a Resend key. Resend's test
sender only delivers to your own Resend account address: set `EMAIL_REDIRECT_TO` in `.env` for the demo, then run
`08-lambda.sh` again. The whole system (all 3 services + gateway + website) runs from `roadhub-frontend`.

## Tests

```bash
npm test             # 21 tests, needs Floci + the tables (npm run setup:tables)
npm run selfcheck    # 7 checks, no Floci needed
```

- `tests/engagement.test.js`: this service as its own process with its real tables, a fake roadmap and a fake admin
  service: service tokens and request ids, one vote per person (also 5 clicks at once), admins cannot vote, unknown
  request -> 404, remove vote, comment rules (owner edit, extra fields refused, team reply, admin delete), My votes,
  suspended accounts, fail closed (503) when roadmap is down, merge (distinct voters, merged discussion, one
  effective vote, idempotent) and exact undo, internal tokens, instance badge, `<script>` removed from comments,
  the CloudWatch audit trail (AUDIT + SECURITY_ALERT lines, no e-mails), and the self-check.
- `tests/worker.test.js`: real EventBridge, SQS and SNS (its own `roadhub-test-...` resources, deleted after), a fake
  admin service and a fake Resend: event -> rule -> queue -> one e-mail per voter and author; the same message twice ->
  one e-mail; unknown events removed; provider down -> 3 tries, SNS alert, dead-letter queue; and the Lambda handler:
  e-mails sent, a repeat handled once, only the failed message reported.
- `k6/engagement-load-test.js`: Lab 8 Runs A/B/C through the gateway (see the top of the file).
- `docs/engagement-results.md`: the evidence sheet (check output, k6 numbers, security tests S1-S11).

## Folders
`routes/` -> `controllers/` -> `services/` (business rules) -> `repositories/` (DynamoDB). `middleware/auth.js` checks
logins, `clients/` calls the other services and Resend, `workers/` holds the notification worker (process + Lambda),
`services/auditLog.js` the CloudWatch audit trail, `shared/` the common kit (identical in the three service repos,
see `shared/README.md`), `infra/` the Floci scripts, `events/` saved Lambda test events, `scripts/` the self-check
and the Lambda zip builder.
