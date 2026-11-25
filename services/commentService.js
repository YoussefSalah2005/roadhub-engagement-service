// Function 2: comments. Comments are stored on the request they were written on; the comment list
// of a main request also shows the comments of the duplicates merged into it.
const { http, events } = require('../shared');
const repos = require('../repositories');
const roadmap = require('../clients/roadmap');
const countsService = require('./countsService');
const { audit } = require('./auditLog');
const { cleanText } = require('./textRules');

const { errors } = http;

// Lab 8 sanitising layer: tags are removed before saving. A comment that was only HTML is refused.
function cleanBody(body) {
  const clean = cleanText(body);
  if (!clean) throw errors.badRequest('The comment has no text left after removing HTML.', { field: 'body' });
  return clean;
}

function publicComment(c, canonicalId) {
  return {
    commentId: c.commentId, featureId: c.featureId, userId: c.userId, authorName: c.authorName, body: c.body,
    isTeamReply: Boolean(c.isTeamReply), edited: Boolean(c.edited), createdAt: c.createdAt, updatedAt: c.updatedAt,
    fromMergedRequest: c.featureId !== canonicalId
  };
}

async function list(featureId, requestId) {
  const feature = await roadmap.resolve(featureId, requestId);
  const group = await repos.groups.members(feature.canonicalId);
  const lists = await Promise.all(group.map((id) => repos.comments.listByFeature(id)));
  const all = lists.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { featureId: feature.canonicalId, count: all.length, comments: all.map((c) => publicComment(c, feature.canonicalId)) };
}

async function add(user, featureId, rawBody, requestId) {
  const body = cleanBody(rawBody);
  const feature = await roadmap.resolve(featureId, requestId);
  const comment = await repos.comments.add({
    featureId: feature.canonicalId, canonicalId: feature.canonicalId, userId: user.id, authorName: user.name, body,
    isTeamReply: user.role === 'admin' // an admin's comment is shown as "Product team"
  });
  audit('COMMENT_ADDED', { requestId, featureId: feature.canonicalId, commentId: comment.commentId, userId: user.id, teamReply: comment.isTeamReply });
  await events.publish('engagement', 'CommentAdded', { featureId: feature.canonicalId, commentId: comment.commentId, userId: user.id }, { requestId });
  await countsService.announce(feature.canonicalId, requestId);
  return publicComment(comment, feature.canonicalId);
}

async function edit(user, commentId, rawBody, requestId) {
  const body = cleanBody(rawBody);
  const updated = await repos.comments.editOwn(commentId, user.id, body);
  if (!updated) {
    const existing = await repos.comments.get(commentId);
    if (!existing) throw errors.notFound('COMMENT_NOT_FOUND', 'This comment does not exist.');
    throw errors.forbidden('NOT_OWNER', 'You can only edit your own comments.'); // IDOR blocked
  }
  audit('COMMENT_EDITED', { requestId, commentId, featureId: updated.featureId, userId: user.id });
  return publicComment(updated, await repos.groups.canonicalOf(updated.featureId));
}

async function remove(user, commentId, requestId) {
  const comment = await repos.comments.get(commentId);
  if (!comment) throw errors.notFound('COMMENT_NOT_FOUND', 'This comment does not exist.');
  const isOwner = comment.userId === user.id;
  if (!isOwner && user.role !== 'admin') throw errors.forbidden('NOT_OWNER', 'You can only delete your own comments.');
  const canonicalId = await repos.groups.canonicalOf(comment.featureId);
  await repos.comments.remove(comment, canonicalId);
  audit(isOwner ? 'COMMENT_DELETED' : 'COMMENT_REMOVED_BY_ADMIN', { requestId, commentId, featureId: canonicalId, userId: comment.userId, actorId: user.id });
  await events.publish('engagement', isOwner ? 'CommentDeleted' : 'CommentRemovedByAdmin', {
    featureId: canonicalId, commentId, userId: comment.userId, actorId: user.id
  }, { requestId });
  await countsService.announce(canonicalId, requestId);
}

module.exports = { list, add, edit, remove };
