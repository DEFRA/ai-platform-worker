# Project Guidelines

**ai-platform-worker** is the AI Platform GitOps worker (the `ai-platform-gitops-worker` service of plan section 7): a Core Delivery Platform (CDP) Node.js backend with **no database and no public ingress**. It consumes GitOps commands from its own SQS queue, publishes reconciler events to its own SNS topic, dispatches `submit.yml` and `apply.yml` on the state repositories, and reconciles overdue operations by reading GitHub. The design is [async-operations-plan.md](../../ai-platform-discovery-docs/docs/async-operations-plan.md) (D09, revised 25 October 2026): contracts section 5, modules section 6.1, standards section 7, quality bar section 8.

The worker never decides, commits or watches runs on a timer. The backend owns the rules and the only database; the workflows commit and apply; the worker dispatches and reports what GitHub holds.

## Architecture

- **Layers** (plan 6.1), one module per role behind a small port, ports passed by factory:
  - `src/commands/` is the inbound adapter (`commands-consumer.js`: schema check, handler map by `type`) and the handlers (`handlers/submit.js`, `apply.js`, `reconcile.js`)
  - `src/github/` is the `GitHubClient` port (`github-client.js`), its Octokit adapter (`octokit-github-client.js`), the down-scoped App client (`github-app-client.js`) and the workflow dispatcher
  - `src/reconciler/` is GitHub facts to an event: `run-reader.js`, `commit-finder.js`, `status-mapper.js` and `resources-mapper.js` (the last two are pure)
  - `src/events/` is the `EventsPublisher` port and its SNS FIFO adapter
  - `src/contracts/` holds the vendored message schemas and the Ajv validators
  - `src/worker-runtime.js` is the one composition root; `src/plugins/gitops-worker.js` runs it inside Hapi; `/health` is the only route
- **Handlers return an outcome string and throw on failure.** A throw leaves the message on the queue, SQS redelivers it, and after three receives it reaches the dead-letter queue (AC8).
- **Idempotent by finding first.** `submit` looks for a run with `({operationId})` in its name created since the command before it dispatches; `apply` finds its run by the command ID in the run name. A redelivered command dispatches nothing (AC3).
- **Every outbound call takes the handler's `AbortSignal`** (`HANDLER_TIMEOUT_MS`, 30 s); GitHub reads retry transient errors with backoff and jitter (`src/common/helpers/retry.js`), SQS sends use the AWS SDK's standard retry, and a dispatch is never retried inside a handler.

## Build and Test

- **Install**: `npm ci` (Node.js 24 required, see `.nvmrc`)
- **Run locally**: `docker compose up floci -d`, set the queue URLs and the App credentials (README, "Run locally"), then `npm run dev`
- **Tests**: `npm test` (Vitest with coverage; thresholds 95 on lines, functions, branches and statements). On Windows `npm test` fails on the Unix env prefix: use `$env:TZ='UTC'; npx vitest run --coverage`.
- **Lint and format**: `npm run lint` (neostandard), `npm run format` then `npm run format:check`
- **Contracts**: `npm run contracts:check` fails when `src/contracts/aip-gitops/` differs from `ai-platform-infra` at the ref in `VERSION`; `npm run contracts:sync -- {ref}` updates it
- **Security**: `npm run security-audit` blocks on critical findings; a pull request lists any high finding with its disposition
- **Pre-commit hook**: `npm run git:pre-commit-hook` runs the audit, format check, lint and tests

## Conventions

- **JSDoc**: every exported function has JSDoc.
- **ES modules, named exports, function declarations**; `#/` imports map to `src/`.
- **Pure where possible**: `status-mapper.js` and `resources-mapper.js` do no I/O and are tested on their own.
- **Contracts have one source**: `ai-platform-infra/schemas/messages/`, vendored byte for byte. Never edit a schema here. See [message-contracts.instructions.md](instructions/message-contracts.instructions.md).
- **Sensitive data**: log IDs only (`commandId`, `operationId`, `type`, state, outcome, run ID); never a team file `document`, a requester (`requestedBy`), a token, a private key or a message body. The logger redacts those paths as a second line of defence.
- **Least privilege**: the App token is minted per repository with `actions: write`, `contents: read`, `metadata: read` only; the client refuses every request except a read and a workflow dispatch.
- **Configuration** is read through the `convict` module, `lowerCamelCase` keys, `UPPER_SNAKE_CASE` variables; the plan 5 "Configuration" table is the list.

## Engineering standards (AICE)

Follow the AICE JavaScript skills in `.github/skills/`: [javascript-style-guide](skills/javascript-style-guide/SKILL.md), [javascript-testing-standards](skills/javascript-testing-standards/SKILL.md) and [javascript-review-standards](skills/javascript-review-standards/SKILL.md). Where a general habit conflicts with them, they win; flag a conflict with Defra standards.

## Code Quality and Design Principles

- Apply SOLID pragmatically; keep modules small, one role each, and DRY: one schema source, one state table.
- Prefer small pure functions; no premature abstraction; no commented-out code.
- Handle errors at the edge (the consumer) and let handlers throw; never swallow an error to make a test pass.
- Node practice: exact dependency versions, `npm ci`, structured logs, central error handling, graceful shutdown, a timeout on every outbound call, exit on an unhandled rejection.

## Naming conventions

- **Directories and JS files**: `kebab-case`; **tests**: `<name>.test.js` beside the file under test; shared fakes and fixtures in `test/`.
- **Commit messages**: conventional (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`); the first commit of a pull request cites "D09, revised 25 October 2026" and the decision history entries `#25-october-2026-asynchronous-gitops-operations-scope-and-build-plan` and `#26-october-2026-asynchronous-gitops-operations-build-simplified` (plan section 0).

## Branching and version control

- `main` is always shippable. Work on `<type>/<brief-description>` branches (`feature/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`) and open a pull request; one approving review is required.

## Quality gates

CI (`.github/workflows/check-pull-request.yml`) runs `npm run security-audit`, `npm ci`, `npm run format:check`, `npm run lint`, `npm run contracts:check`, `npm test` (95 coverage on every metric), a Docker image build and SonarCloud. SonarCloud new-code coverage must be at least 95, duplication at most 3 and no new issues. CodeQL runs from the repository's default setup.

## Allowed / discouraged dependencies

- Hapi (health only), `sqs-consumer` 15, `@aws-sdk/client-sqs` for the commands queue and `@aws-sdk/client-sns` for the events topic, `octokit` and `@octokit/auth-app` for GitHub, `ajv` and `ajv-formats` for the contracts, `convict`, `pino`.
- Native `fetch`; no `axios` or `request`. No `lodash`, `moment`, TypeScript (vanilla JS with JSDoc) or ORM. No database: if a change seems to need state, it belongs in the backend.
- Exact versions only (`.npmrc`: `save-exact`, `ignore-scripts`, `min-release-age=7`). New dependencies must be widely used, maintained and compatible with Node 24.

## Security

- Follow OWASP Secure Coding Practices. Never log PII, secrets or documents (see Conventions).
- The worker acts only on the two state repositories in `GITOPS_TENANTS_REPO` and `GITOPS_DEPLOYMENTS_REPO`, and a command's path must sit under its own environment; anything else is refused (and dead-lettered).
- Outbound traffic goes through the CDP proxy; the GitHub API and artifact hosts are allowed in `cdp-tenant-config`. Secrets live in the CDP Portal.
- Only use approved MCP servers ([Defra MCP guidance](https://defra.github.io/defra-ai-sdlc/pages/appendix/defra-mcp-guidance/)).

## Documentation

- JSDoc on exports; keep the README (runbooks, configuration) current when behaviour or configuration changes.
- Keep every `.md` file short, accurate and consolidated; link to the plan instead of copying it. Document breaking changes in pull request descriptions.
- After a plan phase lands, follow [implemented-features.instructions.md](instructions/implemented-features.instructions.md).

## How Copilot should respond

- Follow conventions already in the codebase; check the closest handler, port or adapter first and keep diffs minimal.
- The site is not live: build to the current design only. Never add legacy support or old-and-new code paths; remove superseded code outright. Ask if unsure.
- Always include or update tests for changed behaviour; a bug fix ships with a regression test that fails without it.
- Before every commit or pull request run `npm run format`, then confirm `npm run format:check`, `npm run lint`, `npm run contracts:check` and `npm test` pass. Never skip the hook with `--no-verify`.
- After opening a pull request follow [pull-requests.instructions.md](instructions/pull-requests.instructions.md).
- If a request conflicts with these instructions, would use a discouraged library, skip tests, hardcode a secret or break a quality gate, flag it explicitly and do not proceed silently.

## Licence

OGL-UK-3.0, as `LICENCE`.
