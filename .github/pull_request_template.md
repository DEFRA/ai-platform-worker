## What and why

<!-- Name the section of docs/async-operations-plan.md this builds (in ai-platform-discovery-docs) and say why in one line. -->

<!-- Cite "D09, revised 25 October 2026" and the decision history entries
#25-october-2026-asynchronous-gitops-operations-scope-and-build-plan and
#26-october-2026-asynchronous-gitops-operations-build-simplified (plan section 0, the pull request rule). -->

## Evidence

- [ ] `npm run format`, `npm run format:check`, `npm run lint`, `npm run contracts:check` and `npm test` pass; coverage stays at or above 95
- [ ] New or changed behaviour has tests; a bug fix has a regression test
- [ ] No secret, requester, document or token in code, logs or tests
- [ ] A change to a message shape is a change to `ai-platform-infra` `schemas/messages/` first, then `npm run contracts:sync`
- [ ] `npm audit --audit-level=high` findings listed here with their disposition
- [ ] Breaking change called out

## Review

- [ ] Copilot review requested (`gh pr edit <n> --add-reviewer "@copilot"`), every comment fixed or answered, every thread resolved
- [ ] Human reviewer requested
