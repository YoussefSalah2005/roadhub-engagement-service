// Questions the Engagement Service asks the Administration Service (over HTTP, service token).
const services = require('./services');
const config = require('../config');

// Names and e-mail addresses of users, for notification e-mails (scope identity:contacts).
// The admin service skips banned accounts and answers at most 50 users per call.
async function contacts(userIds, requestId) {
  const all = [];
  for (let i = 0; i < userIds.length; i += config.contactsBatchSize) {
    const out = await services.callOk('admin', {
      method: 'POST', path: '/internal/identity/users/contacts', scope: 'identity:contacts', requestId,
      body: { userIds: userIds.slice(i, i + config.contactsBatchSize) }
    });
    all.push(...out.items);
  }
  return all;
}

module.exports = { contacts };
