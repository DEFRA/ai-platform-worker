---
description: 'Use when writing or updating Vitest test files (*.test.js) or test fakes in this repo: handlers, ports, adapters, the consumer and the plugin. Covers colocation, the in-memory fakes, the Octokit fake HTTP and the contract suites.'
applyTo: '**/*.test.js, test/**'
---

# Testing Conventions

- Colocate test files next to the file under test (`submit.js` + `submit.test.js`). Shared fakes and fixtures live in `test/fakes/` and `test/fixtures/`.
- Use Vitest globals directly (`describe`, `test`, `expect`, `vi`) with no import. Coverage thresholds are 95 on every metric: a new branch needs a test.
- **No database, no network.** GitHub is the in-memory `GitHubClient` fake (`test/fakes/in-memory-github-client.js`) for handler and reconciler tests, and a route table over a fake `fetch` (`test/fakes/fake-github-http.js`) under a real Octokit for the adapter and the App client. SQS is a fake `send` (`test/fakes/fake-sqs-queue.js` is an in-memory FIFO queue with a dead-letter queue, driven by the real `sqs-consumer`). Floci runs locally for a manual end-to-end check (README) and for the `*.floci.test.js` suite, which `npm test` skips unless `FLOCI_ENDPOINT` is set and the `floci` job of `check-pull-request.yml` runs against a Floci service container.
- **Contract suites.** The `GitHubClient` contract (`src/github/github-client-contract.js`) runs against the fake and the Octokit adapter; an adapter and its fake must both pass it. Contract suites are excluded from coverage and run through the adapters' tests.
- **Pure modules** (`status-mapper.js`, `resources-mapper.js`) are tested without I/O; assert every event the mapper builds against `validateEvent`.
- **Name tests by behaviour**; put the acceptance criterion in the `describe` name where one applies (for example `AC3: a duplicate command creates no second dispatch`).
- **Never weaken a test** to make it pass, and never assert on a secret, a document or a requester appearing in a log.
- On Windows `npm test` fails on the Unix env prefix: run `$env:TZ='UTC'; npx vitest run --coverage`. Run `npm run format` after creating files, because Prettier checks line endings.
