import { createAppliedReconciler } from '#/commands/handlers/reconcile-applied.js'
import { createRequestedReconciler } from '#/commands/handlers/reconcile-requested.js'

// A reconcile reads GitHub from this far back. An operation is reconciled
// ten minutes after it enters a state, but an engineer can ask again for an
// older one; operation IDs are unique, so the window only bounds the lookup.
export const DEFAULT_RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000

const NOTHING_TO_RECONCILE = 'nothing-to-reconcile'
const APPLIED_STATES = new Set(['committed', 'deploying'])

/**
 * The `reconcile` handler (plan 6.1; the plan 5 reconcile table): the
 * backend's sweeper asks the worker to find out what GitHub holds for an
 * overdue operation. For `requested` it reads the submit run and the commit;
 * for `committed` and `deploying` the apply runs and their reports. Every
 * other state has nothing on GitHub to find, so the command is acknowledged
 * and nothing is sent.
 * @param {object} deps
 * @param {import('#/github/github-client.js').GitHubClient} deps.github
 * @param {ReturnType<import('#/reconciler/run-reader.js').createRunReader>} deps.runReader
 * @param {ReturnType<import('#/reconciler/commit-finder.js').createCommitFinder>} deps.commitFinder
 * @param {ReturnType<import('#/github/workflow-dispatcher.js').createWorkflowDispatcher>} deps.dispatcher
 * @param {import('#/events/events-publisher.js').EventsPublisher} deps.events
 * @param {{counter: Function}} deps.metrics
 * @param {() => number} [deps.now]
 * @param {{reconcileLookbackMs?: number}} [deps.settings]
 * @returns {(command: object, context: {signal?: AbortSignal, logger?: import('pino').Logger}) => Promise<string>}
 */
export function createReconcileHandler({
  metrics,
  now = Date.now,
  settings = {},
  ...ports
}) {
  const deps = {
    ...ports,
    now,
    settings: {
      reconcileLookbackMs:
        settings.reconcileLookbackMs ?? DEFAULT_RECONCILE_LOOKBACK_MS
    }
  }
  const requested = createRequestedReconciler(deps)
  const applied = createAppliedReconciler(deps)

  function reconcileState(command, context) {
    if (command.state === 'requested') {
      return requested(command, context)
    }

    if (APPLIED_STATES.has(command.state)) {
      return applied(command, context)
    }

    return NOTHING_TO_RECONCILE
  }

  return async function handleReconcile(command, context) {
    const outcome = await reconcileState(command, context)

    await metrics.counter('reconciles', 1, { state: command.state, outcome })

    return outcome
  }
}
