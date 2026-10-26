---
description: 'Use when changing the GitOps message contracts, the commands consumer, the handlers, the events publisher or the SQS client: the vendored command and event schemas, Ajv validation, deduplication IDs, FIFO message groups, dead letters and logging rules.'
applyTo: 'src/contracts/**, src/commands/**, src/events/**, src/sqs/**, src/reconciler/**'
---

# Message contracts

The worker and the backend talk through two FIFO queues, `aip-gitops-commands.fifo` (the backend sends, the worker consumes) and `aip-gitops-events.fifo` (the workflows and the worker's reconciler send, the backend consumes), using the `aip.gitops.command/1` and `aip.gitops.event/1` schemas. The design is [async-operations-plan.md](../../../ai-platform-discovery-docs/docs/async-operations-plan.md) section 5.

- **The schemas are vendored.** `src/contracts/aip-gitops/` is a copy of `ai-platform-infra/schemas/messages/` at the ref in its `VERSION` file. Change it only with `npm run contracts:sync -- {ref}`; `npm run contracts:check` fails on any difference. Never edit a schema in this repo.
- **Additive only.** A new optional field or status is allowed; renaming, removing or tightening one is not, because the backend, the worker and the workflows deploy on their own schedule.
- **Validate with Ajv** (`src/contracts/message-validators.js`): every command before it is handled, every event before it is sent. An event that fails validation is a bug and throws (nothing is sent).
- **A bad message dead-letters.** A message that is not JSON, not a valid command, or for a repository or path the worker is not for, is never acknowledged: it is redelivered and, after three receives, reaches the dead-letter queue, where the alarm and the README runbook deal with it. Never acknowledge a message you did not handle.
- **Deduplication.** `commandId` is the SQS deduplication ID of a command; the worker still deduplicates by finding the run it already dispatched (`submit`: the operation in the run name since the command; `apply`: the command ID in the run name). `eventId` (`{operationId or commitSha or environment}:{status}:{runId}:{runAttempt}`) is the deduplication ID of an event, so a reconciler event for a run the workflow already reported collapses.
- **Message groups.** An event's group is the operation ID, the commit SHA for `break-glass`, or the environment (`eventGroupId`). A command's group is `{environment}/{team}`, set by the backend.
- **The reconciler republishes, never invents.** It builds an event only from what GitHub holds (a run, a commit trailer, a run report), with `source: reconciler`, and republishes a failure the submit run recorded in its report with its own code and `retryable` flag; the backend alone decides what to resubmit.
- **Trace.** `traceparent` and `cdpRequestId` pass from the command to the dispatch inputs (`trace_parent`, `cdp_request_id`) and to every event.
- **People are identifiers only**: `requestedBy` is `entra:{oid}`, `app:{name}` or `github:{id}`. Never put a name or email in a message.
- **Never log a document or a token.** Log the operation ID, `commandId`, `eventId`, type, status and outcome; never the team file `document`, `requestedBy`, an installation token or a message body.
- **No backfill, no legacy.** Nothing is live; delete old fields and states rather than mapping them.
