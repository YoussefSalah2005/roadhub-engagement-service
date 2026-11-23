# roadhub-engagement-service: Engagement Service (S2)

RoadmapHub · Team 22 (Lab Group A-3) · Cloud Computing and Cloud Security (26CSCN29H)
**Owner:** Youssef Mohamed Salah (239650)

Users vote for feature requests (one effective vote per person per main request, even after duplicates are
merged), comment and see "My votes". During a merge this service links the duplicate to the main request
(nothing is copied) and recounts the distinct voters; undo removes the link and recounts both requests.
The notification worker (SQS, Resend e-mails, dead-letter queue) belongs here as well.

RoadmapHub is four repositories: `roadhub-roadmap-service`, **engagement (this one)**, `roadhub-admin-service`,
and `roadhub-frontend` (website, gateway, whole-system tests, team docs).

## API
Public (browsers reach it through the gateway on :8080). Full details: `docs/contracts/public-api-contract.md`.

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

Internal (other services only, `X-Service-Token`). Details: `docs/contracts/internal-api-contract.md`.

| Path | Scope | Caller |
|---|---|---|
| POST `/internal/engagement/merges/{prepare,complete,abort,undo}` | `engagement:merge` | admin |

This service calls: roadmap `resolve` / `resolve-batch` (`features:read`) to find the main request, and admin
`users/:id/status` (`identity:read`); the notification worker will call admin `users/contacts` (`identity:contacts`).

## Data and AWS
- DynamoDB tables (only this service uses them): `roadhub-votes` (key featureId + userId, so one row per person),
  `roadhub-comments`, `roadhub-engagement-counts`, `roadhub-engagement-links` (merge links),
  `roadhub-notifications`, `roadhub-processed-messages` (TTL; SQS messages already handled).
- Secrets Manager: owns `roadhub/resend`; reads `roadhub/jwt-public`, `roadhub/internal`, `roadhub/turnstile` (made by the admin-service repo).
- SQS + DLQ, SNS, EventBridge rule: planned (Phase 11), see `docs/service-boundaries.md` in roadhub-frontend.

## Run it (Windows: Git Bash)
Needs Node.js 20+, Docker Desktop and the AWS CLI.
```bash
npm install
docker compose -f infra/floci/docker-compose.yml up -d   # Floci (same file in every repo: one Floci per PC)
bash infra/scripts/create-tables.sh                      # this service's 6 tables
cp infra/.env.example infra/.env                         # put your Resend key here (never commit it)
bash infra/scripts/create-secrets.sh                     # stores it in Secrets Manager as roadhub/resend
cp .env.example .env                                     # ports and the other services' URLs (no secrets)
npm start                                                # http://localhost:3002/health
```
To serve real users it also needs the login/internal keys (run `bash infra/scripts/create-secrets.sh` in the
admin-service repo) and running roadmap and admin services. For the whole system, use `roadhub-frontend`.

## Tests
```bash
npm test
```
Starts this service as its own process with its real tables, plus a **fake roadmap service** and a **fake admin
service**, so it needs only Floci and the tables. Covers: service tokens and request ids sent to the other
services, one vote per person (also 5 clicks at once), admins cannot vote, unknown request → 404, removing a
vote, comment rules (owner edit, extra fields refused, team reply, admin delete), My votes, suspended accounts,
failing closed (503) when roadmap is down, and the merge steps: distinct voters, merged discussion, one
effective vote across main + duplicate, idempotent repeat, and an exact undo.

## Folders
`routes/` → `controllers/` → `services/` (business rules) → `repositories/` (DynamoDB). `middleware/auth.js` checks
logins, `clients/` calls the other services, `workers/` will hold the SQS notification worker, `shared/` is the
common kit (identical in the three service repos, see `shared/README.md`), `infra/` holds the Floci scripts.
