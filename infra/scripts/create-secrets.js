// Called by create-secrets.sh. Uses the AWS SDK so the API key never passes through the shell.
// Creates the secret the Engagement Service owns:
//   roadhub/resend   Resend API key + sender, used by the notification worker to send e-mails
// The login and service keys (roadhub/jwt-public, roadhub/internal) come from the admin-service repo.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const {
  SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand, DescribeSecretCommand
} = require(path.join(ROOT, 'node_modules', '@aws-sdk', 'client-secrets-manager'));

const client = new SecretsManagerClient({});
const say = (msg) => console.log(`  \x1b[32mOK\x1b[0m    ${msg}`);

async function exists(name) {
  try { await client.send(new DescribeSecretCommand({ SecretId: name })); return true; } catch { return false; }
}

async function main() {
  const name = 'roadhub/resend';
  const value = JSON.stringify({
    RESEND_API_KEY: process.env.RESEND_API_KEY || 'not-set',
    RESEND_FROM: process.env.RESEND_FROM || 'RoadmapHub <onboarding@resend.dev>'
  });
  if (await exists(name)) {
    await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    say(`${name} updated`);
  } else {
    await client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
    say(`${name} created`);
  }
  if (!process.env.RESEND_API_KEY) console.log('  ...   RESEND_API_KEY not set in infra/.env: emails will be recorded as "skipped".');
  for (const shared of ['roadhub/jwt-public', 'roadhub/internal']) {
    if (!(await exists(shared))) console.log(`  ...   ${shared} is missing: run create-secrets.sh in the admin-service repo.`);
  }
}

main().catch((e) => { console.error(`  FAIL  secrets: ${e.name}: ${e.message}`); process.exit(1); });
