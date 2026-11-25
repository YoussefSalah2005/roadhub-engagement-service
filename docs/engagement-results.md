# Engagement Service (S2): results and evidence

Student: Youssef Mohamed Salah   Student ID: 239650   Repository: roadhub-engagement-service

Fill this in as you go (same idea as Lab 8's `docs/lab-08-results.md`). Every row needs a screenshot or the
pasted command output. Write only what you really ran and saw.

## Part 1: AWS resources (check script)

Run with the service started (`npm start`) and a worker running (the Lambda from `08-lambda.sh`, or `npm run worker`):

```
bash infra/check-engagement.sh
```

Paste the whole output here:

```
(paste here)
```

## Part 2: AWS services used by this service

| # | AWS service | Resource | What it does in the Engagement Service | Script | Evidence (screenshot / command) | Status |
|---|---|---|---|---|---|---|
| 1 | DynamoDB | 6 roadhub-* tables | votes (one row per person), comments, counts, merge links, notification log, handled messages (TTL) | 01-dynamodb.sh | | |
| 2 | Secrets Manager | roadhub/resend | Resend API key, read by the worker only (never in code or Git) | 02-secrets-manager.sh | | |
| 3 | SQS | roadhub-notify-queue + roadhub-notify-dlq | notification jobs; after 3 failed tries a job moves to the dead-letter queue | 03-sqs.sh | | |
| 4 | SNS | roadhub-ops-alerts -> roadhub-ops-alerts-inbox | alert when a job fails for good, and when a CloudWatch alarm fires | 04-sns.sh | | |
| 5 | EventBridge | roadhub-notify-rule, roadhub-engagement-audit-rule | status changes + merges -> notify queue; engagement events -> CloudWatch Logs | 05-eventbridge.sh | | |
| 6 | IAM | roadhub-engagement-service-role, roadhub-notify-worker-role | least privilege: own tables, queue, topic, bus, logs, 4 secrets; no "*" | 06-iam.sh | | |
| 7 | CloudWatch | /aws/ecs/roadhub-engagement, metric filter, 2 alarms | AUDIT + SECURITY_ALERT lines; alarm on the DLQ and on many security alerts | 07-cloudwatch.sh | | |
| 8 | Lambda | roadhub-notify-worker | the notification worker, triggered by the queue | 08-lambda.sh | | |
| 9 | ELB + ECS + Auto Scaling | roadhub-engagement-tg, roadhub-engagement-service, 1-4 tasks | how the service would run on real AWS (recorded only on Floci) | 09-ecs.sh | | SIMULATED |

## Part 3: The notification worker (Lambda, Lab 7 style saved events)

```
source infra/services/_lib.sh
awsl lambda invoke --function-name roadhub-notify-worker --payload file://events/1-status-changed.json --cli-binary-format raw-in-base64-out infra/.out/result.json && cat infra/.out/result.json
```

| Event file | Expected (events/README.md) | What you got |
|---|---|---|
| 1-status-changed.json (first time) | `{"batchItemFailures":[]}`, processedBy = lambda | |
| 1-status-changed.json (second time) | `[]` again, log says duplicate | |
| 2-unknown-event.json | `[]`, ignored | |
| 3-broken-message.json | `[{"itemIdentifier":"saved-msg-0003"}]` | |

Logs of the function: `awsl logs tail /aws/lambda/roadhub-notify-worker --since 30m --format short`

## Part 4: k6 (Lab 8 Runs A, B, C, through the gateway)

In roadhub-frontend: `export RATE_LIMITS=off TURNSTILE_ENABLED=false`, then start the system. In this repo:
`k6 run k6/engagement-load-test.js`

| Value from the k6 summary | Run A: 1 copy | Run B: 3 copies |
|---|---|---|
| http_req_duration p(95) | | |
| vote_duration p(95) | | |
| http_req_failed (rate) | | |
| http_reqs (per second) | | |
| served_by_engagement_* lines | | |
| Thresholds passed? | | |

Run C: during Run B, `kill $(cat .run/engagement-1.pid)` in roadhub-frontend. http_req_failed at the end: ____.
Which copies answered after the kill: ____.

In 3 to 5 sentences: did 3 copies beat 1? Why or why not on one laptop?

>

## Part 5: Security tests

Start the whole system (roadhub-frontend), WITHOUT `RATE_LIMITS=off`, then make a test account (Git Bash):

```
API=http://localhost:8080
login() { curl -s -X POST $API/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"name\":\"$1\",\"email\":\"$1.$RANDOM@example.com\",\"password\":\"Correct-horse-42\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
A=$(login alice); B=$(login bob)
F=$(curl -s -X POST $API/api/features -H "Authorization: Bearer $A" -H 'Content-Type: application/json' \
  -d '{"title":"Security test request","description":"Request used for the security tests.","categoryId":"security"}' | sed -n 's/.*"featureId":"\([^"]*\)".*/\1/p')
```

| Test | Command | Expected | What you saw | Pass? |
|---|---|---|---|---|
| S1 security headers | `curl -sI http://localhost:3002/health \| grep -iE "x-content\|x-frame\|content-security\|x-instance"` | nosniff, DENY, CSP, instance id | | |
| S2 vote without login | `curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/api/features/$F/votes` | 401 | | |
| S3 one vote per person | `for i in 1 2; do curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/api/features/$F/votes -H "Authorization: Bearer $B"; done` | 201 then 409 | | |
| S4 script in a comment | `curl -s -X POST $API/api/features/$F/comments -H "Authorization: Bearer $B" -H 'Content-Type: application/json' -d '{"body":"<script>alert(1)</script>hi"}'` | 201, body is just "hi" | | |
| S5 comment too long (1001) | `L=$(printf 'a%.0s' $(seq 1 1001)); curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/api/features/$F/comments -H "Authorization: Bearer $B" -H 'Content-Type: application/json' -d "{\"body\":\"$L\"}"` | 400 | | |
| S6 extra field (mass assignment) | `... -d '{"body":"hi","userId":"someone-else"}'` | 400 | | |
| S7 edit someone else's comment (IDOR) | Bob's comment id from S4 in `C`, then `curl -s -X PATCH $API/api/comments/$C -H "Authorization: Bearer $A" -H 'Content-Type: application/json' -d '{"body":"changed"}'` | 403 NOT_OWNER | | |
| S8 too many comments | `for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/api/features/$F/comments -H "Authorization: Bearer $A" -H 'Content-Type: application/json' -d '{"body":"spam"}'; done \| sort \| uniq -c` | 10 x 201, then 429 | | |
| S9 internal route, forged token | `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/internal/engagement/_ping -H 'X-Service-Token: forged'` | 401 | | |
| S10 audit trail | `source infra/services/_lib.sh; awsl logs get-log-events --log-group-name /aws/ecs/roadhub-engagement --log-stream-name app-audit-stream --limit 15 --query "events[].message" --output text` | AUDIT VOTE_ADDED, AUDIT COMMENT_ADDED, SECURITY_ALERT lines, no e-mail | | |
| S11 failed job -> DLQ + alert | `Q=$(awsl sqs get-queue-url --queue-name roadhub-notify-queue --query QueueUrl --output text); awsl sqs send-message --queue-url $Q --message-body "not json"`, wait about 3 minutes, then `bash infra/check-engagement.sh` (DLQ count) and read the inbox: `awsl sqs receive-message --queue-url $(awsl sqs get-queue-url --queue-name roadhub-ops-alerts-inbox --query QueueUrl --output text)` | 1 job in roadhub-notify-dlq, an alert "notification job failed" in the inbox | | |

## Reflection

1. Trace one vote through the architecture in your own words (browser -> gateway -> engagement -> roadmap -> DynamoDB -> EventBridge -> CloudWatch).
2. Why can a vote never be counted twice, even with 5 clicks at the same moment, or after two requests are merged?
3. SQS, SNS and EventBridge: which one does what in this service, and why not just one of them?
4. Name two things that are only recorded on Floci but would really act on real AWS.
