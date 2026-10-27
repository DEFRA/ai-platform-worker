# ai-platform-worker

The AI Platform **GitOps worker** (the `ai-platform-gitops-worker` service of the plan): a Core Delivery Platform (CDP) Node.js backend with no database and no public ingress. It takes GitOps commands from an SQS FIFO queue, dispatches the `submit.yml` and `apply.yml` workflows of the state repositories, and, when the backend asks, finds out what GitHub holds for an overdue operation and reports it as an event.

It never decides, commits or watches runs on a timer: the backend owns the rules and the only database, and the workflows commit and apply. The design is [async-operations-plan.md](../ai-platform-discovery-docs/docs/async-operations-plan.md) (B28, D09 revised 25 October 2026); contracts are section 5, modules 6.1, standards 7, runbooks 13.

- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Run locally](#run-locally)
- [Observability](#observability)
- [Runbooks](#runbooks)
- [Development](#development)
- [Licence](#licence)

## How it works

```text
backend ──topic aip_gitops_commands──▶ queue aip_gitops_commands_worker ──▶ worker ──workflow_dispatch──▶ submit.yml / apply.yml
                                                                              │
worker (reconcile only) ──topic aip_gitops_events_worker──▶ queue aip_gitops_events ──▶ backend
workflows ─────────────────(federated identity, sqs:SendMessage)──▶ queue aip_gitops_events ──▶ backend
```

CDP lets one service operate on a queue, so each direction is a topic its producer owns and a queue its consumer owns, subscribed by CDP with raw delivery (the queue body is the message, with no SNS envelope). The backend owns the commands topic and the events queue; the worker owns the commands queue and the events topic; the workflows are external and send to the backend's events queue through a federated identity.

| Command     | The worker                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit`    | Looks for a submit run with `({operationId})` in its name created since the command; if there is none, dispatches `submit.yml` on `main` with `action`, `document`, `expected_revision` or `expected_base`, `operation_id`, `requested_by`, `trace_parent` and `cdp_request_id` |
| `apply`     | Dispatches `apply.yml` for the environment once per command (its run name carries the command ID)                                                                                                                                                                               |
| `reconcile` | Reads GitHub and reports, per the table below                                                                                                                                                                                                                                   |

Messages are `aip.gitops.command/1` and `aip.gitops.event/1`, vendored from `ai-platform-infra` (`npm run contracts:sync -- {ref}`, `npm run contracts:check`). Commands are consumed with `sqs-consumer` 15 (`batchSize: 1`, long polling 20 s, visibility 60 s above the 30 s handler timeout). FIFO locks each message group (`{environment}/{team}`) while a message is in flight, so one instance is safe and more are too.

**Duplicates.** A redelivered or duplicated command dispatches nothing: `submit` and `apply` find the run they already started. A resubmission, retry, reconcile or resume has its own `commandId`, so SQS delivers it, and its newer `createdAt` keeps an earlier attempt's run from counting.

**How `submit` tells its own run from an earlier attempt's.** The `submit.yml` run-name is `submit {action} {path} ({operation_id})` (plan PR-9: unchanged), so it names the operation and not the command. A run counts as the command's if its name has the operation, it was created from the command's `createdAt` less 5 s (the two clocks), and it is not a run that had completed before the command was created. That last rule is a heuristic, and it is sound because a retry is created only after the earlier run's failure, and commands are FIFO per team (`{environment}/{team}` message group), so a run that ended before a command existed cannot be that command's even when it was created inside the 5 s allowance. The completion time is the run's `updated_at`, compared exactly (no allowance); a run still going, or completed at or after the command's creation, still counts. Exact identity would need `command_id` in the callers' run-name, which is a plan change and was deliberately not made.

**The run lookup fails closed.** It reads up to three pages of 100 runs; if the last is full, runs may lie beyond it, so it throws `RunLookupIncompleteError` and the command is redelivered rather than dispatched on an incomplete search. A report read for a run is used only if its events belong to the run's attempt (a rerun keeps its run ID and the report artifact cannot be overwritten).

**Failures.** A handler error, an invalid message, or a command for a repository or path the worker is not for is never acknowledged: it is redelivered and, after three receives, reaches the dead-letter queue (see [Dead letters](#dead-letters-platform-team)).

### Reconcile

The backend's sweeper sends `reconcile` for an operation past its deadline (`requested` 10 min, `committed` 30 min, `deploying` 45 min); the worker reads GitHub and publishes an event with `source: reconciler`. The event ID matches the one the workflow would have sent, so a repeat collapses.

| State                    | The worker finds                                                                                          | It does                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `requested`              | A commit on `main` with the `Operation-Id` trailer                                                        | Publishes `committed` (with the submit run that made it)                                                         |
| `requested`              | A submit run, queued or running                                                                           | Publishes `requested` with the run                                                                               |
| `requested`              | A submit run that ended with a failure, or recorded a refusal in its run report (retryable ones included) | Publishes `checks-failed` with the recorded reason; the backend alone resubmits                                  |
| `requested`              | No run and no commit, or a run that was cancelled or did nothing                                          | Dispatches `submit` again from the command's payload (idempotent: the workflow reports an existing commit first) |
| `committed`, `deploying` | An apply run containing the commit, queued or running                                                     | Publishes `deploying`                                                                                            |
| `committed`, `deploying` | An apply run whose report lists the operation                                                             | Publishes `deployed` (outcome `success`) or `deploy-failed` (otherwise; `paused` is the retryable refusal)       |
| `committed`, `deploying` | No run, or one cancelled, superseded or without a report                                                  | Dispatches a fresh apply for the environment                                                                     |
| Any other state          | Nothing on GitHub to find                                                                                 | Acknowledges and sends nothing                                                                                   |

Choices the plan does not spell out, recorded here: the newest run decides; a reconcile reads at most five apply reports; a failed run with no recorded reason is reported as `submit-failed`, never retryable; a reconcile from `committed` or `deploying` carries no `action`, so its events say `apply`; `resources[]` in a reconciled `deployed` event is flattened from the report's `outputs.teams.value[team]` (project, deployments, API, Entra application and service principal).

### Shared fixture

The worker and the workflows (`ai-platform-workflows` `src/resources.js`) each flatten a run report's `outputs.teams.value[team]` into the event's `resources[]`, and the first `deployed` event to arrive decides what the backend stores. `test/fixtures/team-resources-cases.json` holds the cases both copies must produce the same `resources[]` for; `src/reconciler/resources-mapper.shared.test.js` (`R3-F3`) asserts them here. The workflows repository must carry an identical copy of the file (sha256 `EFBFAAE66DB9B55B0539F70CA57534A0A6E2446CF66DF12BAEA015EC233D6600`) and run the same cases against its mapper; change the file in both together, and when infra's `modules/team` `resources` output changes.

## Configuration

Read through `convict` (`src/config.js`, `src/config-gitops.js`, `src/config-github.js`). Secrets and CDP configuration live in the CDP Portal and `cdp-app-config`; a change applies on redeploy.

| Variable                                      | Default                         | Meaning                                                                                                              |
| --------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GITOPS_COMMANDS_QUEUE_URL`                   | none, required                  | `aip_gitops_commands_worker.fifo`, the worker's own queue, consumed                                                  |
| `GITOPS_EVENTS_TOPIC_ARN`                     | none, required                  | `aip_gitops_events_worker.fifo`, the worker's own topic, published to by the reconciler                              |
| `GITOPS_TENANTS_REPO`                         | `DEFRA/ai-platform-tenants`     | State repository for team files                                                                                      |
| `GITOPS_DEPLOYMENTS_REPO`                     | `DEFRA/ai-platform-deployments` | State repository for pins                                                                                            |
| `HANDLER_TIMEOUT_MS`                          | `30000`                         | One command, and every outbound call it makes; a value at or above the 60 s visibility timeout is refused at startup |
| `SQS_WAIT_TIME_SECONDS`                       | `20`                            | Long polling                                                                                                         |
| `GITOPS_SHUTDOWN_WAIT_MS`                     | `20000`                         | How long a stopping worker waits for the command in flight                                                           |
| `AWS_SQS_ENDPOINT`, `AWS_SNS_ENDPOINT`        | unset                           | Local only (Floci)                                                                                                   |
| `AWS_REGION`                                  | `eu-west-2`                     |                                                                                                                      |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` | none, required                  | The `ai-platform-orchestrator` App                                                                                   |
| `GITHUB_APP_PRIVATE_KEY`                      | none, required                  | CDP secret, base64 on one line                                                                                       |

The worker refuses to start without the commands queue URL, the events topic ARN and the three App settings. Its installation tokens are minted per repository with `actions: write`, `contents: read` and `metadata: read` only, and the client refuses every request except a read and a workflow dispatch. Outbound HTTP goes through the CDP proxy (Node 24 reads `HTTPS_PROXY`); the GitHub API and artifact hosts are allowed in `cdp-tenant-config`.

## Run locally

For testing only; CDP environments run the deployed service.

```bash
docker compose up floci -d          # both FIFO topics, both queues and their dead-letter queues, subscribed with raw delivery
```

Floci is pinned to `floci/floci:2.3.0-compat` by digest in `compose.yml` and in the `floci` CI job, so the local run and CI use the same emulator; change both together. The `-compat` image has the `aws` CLI the queue script calls. The new image has not been started here (no Docker daemon): the script and the init directory path are unverified against it.

Then, with the App credentials in your shell (never in a file in this repository):

```bash
export AWS_SQS_ENDPOINT=http://localhost:4566 AWS_SNS_ENDPOINT=http://localhost:4566
export GITOPS_COMMANDS_QUEUE_URL=http://localhost:4566/000000000000/aip_gitops_commands_worker.fifo
export GITOPS_EVENTS_TOPIC_ARN=arn:aws:sns:eu-west-2:000000000000:aip_gitops_events_worker.fifo
export GITHUB_APP_ID=... GITHUB_APP_INSTALLATION_ID=... GITHUB_APP_PRIVATE_KEY=...
npm run dev
```

`GET http://localhost:3001/health` is `200` while the consumer runs and `503` once it has stopped. The backend's local run (`TENANT_ORCHESTRATOR=sqs` with its commands topic ARN and events queue URL) sends it commands. The topics, queues and subscriptions are created by `compose/floci/start.d/20-gitops-queues.sh` (the same CDP creates: all FIFO, no content-based deduplication, queues with 60 s visibility and dead-letter after 3 receives, raw delivery). Automated unit tests never use the network: GitHub, SQS and SNS are faked (see [testing.instructions.md](.github/instructions/testing.instructions.md)). Two separate suites run against Floci: `src/commands/commands-consumer.floci.test.js` proves the FIFO behaviour `sqs-consumer` does not test (order in a message group, deduplication, the dead-letter queue after three receives), and `src/events/sns-events-publisher.floci.test.js` proves an event reaches the subscribed queue as the same JSON, with no SNS envelope, and a repeated event ID collapses. It is skipped unless `FLOCI_ENDPOINT` is set, so `npm test` skips it cleanly; the `floci` job of `check-pull-request.yml` runs them on every pull request against a Floci service container, and a developer with Docker can run them:

```bash
FLOCI_ENDPOINT=http://localhost:4566 npx vitest run src/commands/commands-consumer.floci.test.js src/events/sns-events-publisher.floci.test.js
```

## Observability

| Signal                         | Detail                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs                           | ECS JSON through `hapi-pino`. IDs only: `commandId`, `operationId`, `type`, `environment`, `traceparent`, `trace.id` (the CDP request ID), outcome. Never a `document`, `requestedBy`, token or message body; those paths are redacted |
| Metrics (`@defra/cdp-metrics`) | `commandsHandled` (type, outcome), `dispatchDuration` (workflow), `reconciles` (state, outcome), `githubRateRemaining`                                                                                                                 |
| Trace                          | `traceparent` and `cdpRequestId` go to the dispatch inputs and every event                                                                                                                                                             |
| Health                         | `/health`, tied to the consumer                                                                                                                                                                                                        |
| Shutdown                       | `hapi-pulse` on SIGTERM; `onPreStop` aborts the long poll and waits up to 20 s for the command in flight                                                                                                                               |

## Runbooks

### Dead letters (platform team)

A command reaches the dead-letter queue after three failed receives: the handler threw (GitHub or SQS was down for longer than the retries), the message was not a valid command, or it named a repository or path the worker is not for. The alarm names the queue.

1. The alarm names the DLQ. The worker owns and can redrive `aip_gitops_commands_worker-deadletter.fifo`; `aip_gitops_events-deadletter.fifo` belongs to `ai-platform-backend-api`, so only that service can redrive it (CDP's `-deadletter` suffix; confirm the exact names in the CDP Portal when the queues are created).
2. View the message in the CDP or AWS console (viewing hides it for the visibility timeout and does not affect the source queue's order); note `operationId` and `type` (commands) or `status` (events). Find the worker's log lines by `commandId` or `operationId` for the reason. If the operation has moved past it, delete the message.
3. Fix the cause, then move it back: console "Start DLQ redrive", or `aws sqs start-message-move-task --source-arn {dlq-arn}` from the CDP Terminal. Deduplication by command and event ID makes a repeat safe, and the worker dispatches nothing for a run it already started. A message that is not a valid command, or is for the wrong repository, will fail again: delete it and fix the sender.
4. Confirm the operation moves; record the incident.

### Pause (`aice-platform-admins`)

The worker takes no part: the workflows read `AIP_PAUSED` themselves. Set `AIP_PAUSED` to `true` on `{env}-events` in both state repositories and run `pause.yml`; fix by hand (hand runs and engineers' re-runs show as external operations); set it to `false` and run `pause.yml`. A missed step is caught at the held deadline (plan section 5, Pause).

### A worker that will not start

The error names the missing setting (queue URLs or App credentials). `/health` stays `503` until the consumer runs. After a fix in `cdp-app-config` or the CDP Portal, redeploy.

## Development

```bash
npm ci
npm run format && npm run lint && npm run contracts:check
npm test                                      # on Windows: $env:TZ='UTC'; npx vitest run --coverage
```

Coverage thresholds are 95 on lines, functions, branches and statements. `npm run security-audit` blocks on critical findings. Conventions, architecture and review rules are in [.github/copilot-instructions.md](.github/copilot-instructions.md); message rules in [message-contracts.instructions.md](.github/instructions/message-contracts.instructions.md). On Windows, `.gitattributes` keeps files LF so `format:check` matches CI.

Docker: `docker build --no-cache --tag ai-platform-worker .`. `actionlint` older than May 2026 flags `concurrency.queue: max` in `publish.yml` and `publish-hotfix.yml`; GitHub supports it (changelog 7 May 2026), so that finding is a tool false positive until `actionlint` adds the key. Dependabot (`.github/dependabot.yml`) waits seven days after a release. SonarCloud settings are in [sonar-project.properties](./sonar-project.properties).

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government license v3

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence. It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
