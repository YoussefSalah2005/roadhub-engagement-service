# Saved test events for the Lambda worker (Lab 7 style)

Each file is one call from the SQS trigger, holding one message. Send it to the function with:

```bash
source infra/services/_lib.sh
awsl lambda invoke --function-name roadhub-notify-worker --payload file://events/1-status-changed.json \
  --cli-binary-format raw-in-base64-out infra/.out/result.json && cat infra/.out/result.json
```

| File | What it is | Expected answer |
|---|---|---|
| `1-status-changed.json` | a FeatureStatusChanged event for a request with no voters and no author | `{"batchItemFailures":[]}`, and the event id appears in `roadhub-processed-messages` with `processedBy = lambda`. Send it a second time: still `[]`, and the log says `duplicate` (handled once only). |
| `2-unknown-event.json` | an event the worker does not handle (VoteAdded) | `{"batchItemFailures":[]}`: removed without any e-mail (`ignored`) |
| `3-broken-message.json` | a message that is not JSON | `{"batchItemFailures":[{"itemIdentifier":"saved-msg-0003"}]}`: reported as failed, so SQS would retry it and then move it to the dead-letter queue |
