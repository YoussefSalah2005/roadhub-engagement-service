// Notification rules (business logic of the notification worker; no SQS code here).
//
// Which events send e-mails (they arrive through EventBridge rule roadhub-notify-rule):
//   roadhub.roadmap / FeatureStatusChanged -> everyone who voted for the request (and its merged
//                                             duplicates) + its author: "your request moved to Planned"
//   roadhub.admin   / FeatureMerged        -> everyone who voted for the duplicate + its author:
//                                             "your request was merged into ..."
// Safety rules:
//   - each event is handled once (roadhub-processed-messages), even if SQS delivers it twice
//   - each person gets at most one e-mail per event (roadhub-notifications, key eventId#userId)
//   - the admin who caused the event is not e-mailed; banned users are skipped by the admin service
const repos = require('../repositories');
const config = require('../config');
const adminClient = require('../clients/admin');
const resend = require('../clients/resend');

const STATUS_LABELS = { under_review: 'Under Review', planned: 'Planned', in_progress: 'In Progress', shipped: 'Shipped' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (text, max = 120) => String(text || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function votersOfGroup(featureId) {
  const members = await repos.groups.members(featureId); // the request + duplicates merged into it
  const lists = await Promise.all(members.map((id) => repos.votes.votersOf(id)));
  return lists.flat();
}

function footer() {
  return `\n\nSee the roadmap: ${config.websiteUrl}\n\nYou get this e-mail because you voted for or suggested this request on RoadmapHub.`;
}

// One "plan" per event type: who gets an e-mail and what it says.
const PLANS = {
  'roadhub.roadmap:FeatureStatusChanged': async (d) => {
    if (!d.featureId || !STATUS_LABELS[d.newStatus]) throw new JobError('BAD_EVENT', 'FeatureStatusChanged without featureId/newStatus');
    const title = oneLine(d.title);
    const from = STATUS_LABELS[d.oldStatus] || d.oldStatus;
    const to = STATUS_LABELS[d.newStatus];
    return {
      featureId: d.featureId,
      recipientIds: [...(await votersOfGroup(d.featureId)), d.authorId],
      actorId: d.actorId,
      message: (contact) => ({
        subject: `RoadmapHub: "${title}" is now ${to}`,
        text: `Hello ${contact.name},\n\nThe feature request "${title}" moved from ${from} to ${to}.${footer()}`
      })
    };
  },
  'roadhub.admin:FeatureMerged': async (d) => {
    if (!d.sourceId || !d.targetId) throw new JobError('BAD_EVENT', 'FeatureMerged without sourceId/targetId');
    const source = oneLine(d.sourceTitle);
    const target = oneLine(d.targetTitle);
    return {
      featureId: d.sourceId,
      recipientIds: [...(await repos.votes.votersOf(d.sourceId)), d.sourceAuthorId],
      actorId: d.actorId,
      message: (contact) => ({
        subject: `RoadmapHub: "${source}" was merged into "${target}"`,
        text: `Hello ${contact.name},\n\nThe feature request "${source}" was found to be a duplicate and merged into "${target}". `
          + `Your vote and comments now count for "${target}", and you can follow it there.${footer()}`
      })
    };
  }
};

function eventKey(event) {
  return `${event.source}:${event['detail-type']}`;
}

// Handles one EventBridge event. Returns a summary, or throws when the job must be tried again.
// processedBy: which consumer runs it ("lambda" or "worker-<pid>"), stored with the result.
async function processEvent(event, { processedBy = 'unknown' } = {}) {
  const detail = event && event.detail;
  const eventId = detail && (detail.eventId || event.id);
  if (!eventId) throw new JobError('BAD_EVENT', 'The message is not an EventBridge event.');
  const plan = PLANS[eventKey(event)];
  if (!plan) return { outcome: 'ignored', eventId }; // not an e-mail event: nothing to do
  if (await repos.notifications.wasProcessed(eventId)) return { outcome: 'duplicate', eventId };

  const { featureId, recipientIds, actorId, message } = await plan(detail);
  const ids = [...new Set(recipientIds.filter((id) => id && id !== actorId))];
  const people = ids.length ? await adminClient.contacts(ids, detail.requestId) : [];
  const counts = { sent: 0, skipped: 0, failed: 0, alreadyDone: 0 };

  for (const person of people) {
    const claim = await repos.notifications.claim({ eventId, recipientId: person.userId, eventType: event['detail-type'], featureId });
    if (!claim.claimed) { counts.alreadyDone += 1; continue; } // sent in an earlier try
    const mail = message(person);
    const to = config.emailRedirectTo || person.email;
    const result = await resend.sendEmail({ to, subject: mail.subject, text: mail.text, idempotencyKey: claim.notificationId });
    await repos.notifications.finish(claim.notificationId, result);
    counts[result.status] += 1;
    if (config.worker.sendIntervalMs) await sleep(config.worker.sendIntervalMs);
  }

  if (counts.failed) {
    // Try the whole event again later; people already e-mailed are skipped next time (claim).
    throw new JobError('EMAIL_FAILED', `${counts.failed} e-mail(s) could not be sent.`);
  }
  await repos.notifications.markProcessed(eventId, processedBy);
  return { outcome: 'done', eventId, recipients: people.length, ...counts };
}

module.exports = { processEvent, PLANS, JobError };
