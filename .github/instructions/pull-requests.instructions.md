---
description: 'Use when preparing, opening or reviewing a pull request in this repo: what to run first, what a reviewer (human or Copilot) checks, and how to request Copilot review. Complements copilot-instructions.md, which is longer than Copilot code review reads.'
applyTo: '**'
---

# Pull requests and review

## Before opening

- Branch `<type>/<description>` from current `main`; conventional commits. The first commit and the description cite "D09, revised 25 October 2026" and the decision history entries `#25-october-2026-asynchronous-gitops-operations-scope-and-build-plan` and `#26-october-2026-asynchronous-gitops-operations-build-simplified`, name the plan section built, and say why in one line (plan section 0).
- Run `npm run format`, then `npm run format:check`, `npm run lint`, `npm run contracts:check` and the tests (`$env:TZ='UTC'; npx vitest run --coverage` on Windows); all pass. Never `--no-verify`.
- Behaviour change means a test change; a bug fix means a regression test that fails without the fix.
- List any `npm audit --audit-level=high` finding in the description with its disposition; critical findings block.
- Build to the current design only: no legacy paths or backwards-compatible fallbacks.

## What review checks (Copilot included)

- **The worker never decides, commits or watches runs on a timer.** Handlers dispatch, find or report; rules stay in the backend.
- **Idempotency.** A redelivered command dispatches nothing; a dispatch is never retried inside a handler.
- **Contracts.** Messages validate against the vendored schemas before they are handled or sent; the schemas are unchanged here; `contracts:check` passes.
- **Secrets and PII.** No document, requester, token or message body in a log line, a test or a thrown message. IDs only.
- **Least privilege.** The App token stays `actions: write`, `contents: read`, `metadata: read`, one repository; the client refuses every write but a dispatch.
- **Timeouts.** Every outbound call takes the handler's `AbortSignal`.
- **Errors.** A failure throws so SQS redelivers; nothing is swallowed to make a test pass.
- **Style.** ES modules with named exports, function declarations, JSDoc on exports, exact-pinned dependencies, no lodash, moment or axios.
- **Tests** are colocated as `<name>.test.js`; coverage stays at or above 95.

## Requesting review

1. Open the PR (draft while checks fail) and describe what changed, why, and how it was verified; call out breaking changes.
2. **Request Copilot review**: `gh pr edit <n> --add-reviewer "@copilot"`.
3. When Copilot's review lands, fix every comment or reply with the reason it does not apply, push, then resolve each thread (GraphQL `resolveReviewThread`). Re-request Copilot after a substantial push and repeat until nothing is unresolved.
4. Then request a human reviewer. Copilot is advisory and never replaces the required approval; the ruleset needs one approving review, resolved threads and approval of the last push. A second human reviewer is required at G1 (plan section 11).
5. Do not merge your own PR.
