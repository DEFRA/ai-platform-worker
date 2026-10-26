---
description: 'Use whenever you finish a change to the GitOps worker that moves a plan phase: reminds you to update the shared implemented-features list and the discovery site build state.'
applyTo: 'src/**'
---

# Keep the implemented-features list current

The B28 entry of [ai-platform-frontend/docs/plans/implemented/implemented-features.md](../../../ai-platform-frontend/docs/plans/implemented/implemented-features.md) is the one cross-repo list of what has been built, written for new joiners as a short index that links to the plan and the READMEs. After the end-to-end check of B28 (plan section 11), AIP Docs updates it; until then this repo adds nothing there.

When a change here moves what the worker does (a new command type, a reconcile row, a configuration variable), update in the same pull request:

- the README ("Configuration", "Reconcile", "Runbooks") and this repo's instructions;
- the plan, only through a docs pull request in `ai-platform-discovery-docs` that records the decision first.

Built state goes in `ai-platform-discovery-docs` `src/content/build-stories.md#status` as a separate, doc-only pull request following that repo's `.github/copilot-instructions.md`. Keep it minimal and factual; say "in an open pull request" for anything not merged or released, and never claim it is deployed unless it is. If nothing needs changing, say "build status checked, no change".
