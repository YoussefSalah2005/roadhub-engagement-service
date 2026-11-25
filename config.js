// Settings of the Engagement Service. Every value can be changed with an environment variable (.env).
const region = process.env.AWS_REGION || 'us-east-1';
const accountId = process.env.AWS_ACCOUNT_ID || '000000000000'; // Floci's account id

module.exports = {
  // Which copy of the service answered (Lab 8: shown in /health and the X-Instance-Id header)
  instanceId: process.env.INSTANCE_ID || `engagement-${process.pid}`,

  tables: {
    votes: process.env.VOTES_TABLE || 'roadhub-votes',
    comments: process.env.COMMENTS_TABLE || 'roadhub-comments',
    counts: process.env.COUNTS_TABLE || 'roadhub-engagement-counts',
    links: process.env.LINKS_TABLE || 'roadhub-engagement-links',
    notifications: process.env.NOTIFICATIONS_TABLE || 'roadhub-notifications',
    processed: process.env.PROCESSED_TABLE || 'roadhub-processed-messages'
  },
  websiteUrl: process.env.WEBSITE_URL || 'http://localhost:8080',

  // ---- CloudWatch Logs audit trail (Lab 8): AUDIT and SECURITY_ALERT lines ----
  audit: {
    enabled: process.env.AUDIT_LOGS !== 'off',
    logGroup: process.env.AUDIT_LOG_GROUP || '/aws/ecs/roadhub-engagement',
    logStream: process.env.AUDIT_LOG_STREAM || 'app-audit-stream'
  },

  // ---- Notification worker (EventBridge -> SQS -> worker or Lambda -> Resend) ----
  notifyQueueName: process.env.NOTIFY_QUEUE_NAME || 'roadhub-notify-queue',
  notifyQueueUrl: process.env.NOTIFY_QUEUE_URL || '',       // optional; otherwise looked up by name
  opsTopicName: process.env.OPS_TOPIC_NAME || 'roadhub-ops-alerts',
  opsTopicArn: process.env.OPS_TOPIC_ARN || `arn:aws:sns:${region}:${accountId}:${process.env.OPS_TOPIC_NAME || 'roadhub-ops-alerts'}`,
  resendSecretName: process.env.RESEND_SECRET_NAME || 'roadhub/resend',
  resendApiUrl: process.env.RESEND_API_URL || 'https://api.resend.com',
  // Resend's test sender only delivers to the account owner's address. For a demo without a
  // verified domain, set EMAIL_REDIRECT_TO to that address: every e-mail then goes there.
  emailRedirectTo: process.env.EMAIL_REDIRECT_TO || '',
  worker: {
    maxReceives: 3,                                                    // must equal maxReceiveCount of the queue's redrive policy
    waitSeconds: Number(process.env.WORKER_WAIT_SECONDS || 10),        // SQS long polling
    retryDelaySeconds: Number(process.env.WORKER_RETRY_DELAY_SECONDS || 10), // 1st retry after 10 s, 2nd after 20 s
    batchSize: 5,
    sendIntervalMs: Number(process.env.EMAIL_SEND_INTERVAL_MS ?? 600)  // stay under the e-mail provider's rate limit
  },
  contactsBatchSize: 50 // the admin service answers at most 50 contacts per call
};
