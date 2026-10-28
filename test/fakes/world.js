import { createInMemoryGitHubClient } from './in-memory-github-client.js'
import { createInMemoryEventsPublisher } from './in-memory-events-publisher.js'
import { createFakeMetrics } from './fake-metrics.js'
import { createApplyHandler } from '#/commands/handlers/apply.js'
import { createReconcileHandler } from '#/commands/handlers/reconcile.js'
import { createSubmitHandler } from '#/commands/handlers/submit.js'
import { createWorkflowDispatcher } from '#/github/workflow-dispatcher.js'
import { createCommitFinder } from '#/reconciler/commit-finder.js'
import { createRunReader } from '#/reconciler/run-reader.js'

/**
 * A worker's collaborators over in-memory ports and a fixed clock, wired as
 * the composition root wires them, for handler tests.
 * @param {{nowIso?: string}} [options]
 */
export function createWorld({ nowIso = '2026-10-26T12:15:00Z' } = {}) {
  const github = createInMemoryGitHubClient()
  const events = createInMemoryEventsPublisher()
  const metrics = createFakeMetrics()
  const now = () => Date.parse(nowIso)
  const runReader = createRunReader({ github })
  const commitFinder = createCommitFinder({ github })
  const dispatcher = createWorkflowDispatcher({
    github,
    runReader,
    metrics,
    now
  })
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }

  return {
    github,
    events,
    metrics,
    logger,
    now,
    runReader,
    commitFinder,
    dispatcher,
    submit: createSubmitHandler({ runReader, dispatcher }),
    apply: createApplyHandler({ dispatcher }),
    reconcile: createReconcileHandler({
      github,
      runReader,
      commitFinder,
      dispatcher,
      events,
      metrics,
      now
    })
  }
}
