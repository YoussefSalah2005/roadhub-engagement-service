#!/usr/bin/env bash
# Creates the Engagement Service's own DynamoDB tables (owner: Youssef). Safe to run again.
# Only this service reads or writes these tables; the others ask over HTTP (/internal/engagement/*).
source "$(dirname "$0")/../lib.sh"
step "DynamoDB tables: engagement-service"

# Key (featureId, userId): the same person can never have two vote rows on one request.
make_table "$PREFIX-votes" \
  --attribute-definitions AttributeName=featureId,AttributeType=S AttributeName=userId,AttributeType=S AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=featureId,KeyType=HASH AttributeName=userId,KeyType=RANGE \
  --global-secondary-indexes "[$(gsi user-index userId createdAt)]"
make_table "$PREFIX-comments" \
  --attribute-definitions AttributeName=commentId,AttributeType=S AttributeName=featureId,AttributeType=S AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=commentId,KeyType=HASH \
  --global-secondary-indexes "[$(gsi feature-index featureId createdAt)]"
make_table "$PREFIX-engagement-counts" \
  --attribute-definitions AttributeName=featureId,AttributeType=S \
  --key-schema AttributeName=featureId,KeyType=HASH
# Merge links: duplicate -> canonical request (logical merge, nothing is copied)
make_table "$PREFIX-engagement-links" \
  --attribute-definitions AttributeName=featureId,AttributeType=S AttributeName=canonicalId,AttributeType=S \
  --key-schema AttributeName=featureId,KeyType=HASH \
  --global-secondary-indexes "[$(gsi canonical-index canonicalId)]"
make_table "$PREFIX-notifications" \
  --attribute-definitions AttributeName=notificationId,AttributeType=S AttributeName=recipientId,AttributeType=S AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=notificationId,KeyType=HASH \
  --global-secondary-indexes "[$(gsi recipient-index recipientId createdAt)]"
# Queue messages already handled (SQS can deliver a message more than once)
make_table "$PREFIX-processed-messages" \
  --attribute-definitions AttributeName=messageId,AttributeType=S \
  --key-schema AttributeName=messageId,KeyType=HASH

step "Extra settings"
awsl dynamodb update-time-to-live --table-name "$PREFIX-processed-messages" \
  --time-to-live-specification Enabled=true,AttributeName=expiresAt >/dev/null 2>&1 \
  && ok "TTL on $PREFIX-processed-messages (old message ids expire)" || info "TTL not supported here"
point_in_time_recovery "$PREFIX-votes"
point_in_time_recovery "$PREFIX-comments"
