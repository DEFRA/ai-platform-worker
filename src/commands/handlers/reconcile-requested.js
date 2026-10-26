import {
  checksFailedEvent,
  committedEvent,
  recordedFailureOf,
  requestedEvent,
  runPhase
} from '#/reconciler/status-mapper.js'

/**
 * Reconcile a command whose operation is `requested` (plan 5, reconcile
 * table). The worker has no database, so it reads what GitHub holds and
 * reports it; the backend alone decides what to do with the answer.
 *
 * - a commit on main with the operation's trailer: publish `committed`;
 * - the newest submit run queued or running: publish `requested` with it;
 * - the newest run ended with a failure, or recorded a refusal (a retryable
 *   one included, which the backend alone resubmits): publish
 *   `checks-failed` from the run;
 * - no run, or one that ended with nothing to report: dispatch `submit`
 *   again from the command's payload (idempotent: it reports an existing
 *   commit first).
 * @param {object} deps
 * @returns {(command: object, context: {signal?: AbortSignal, logger?: import('pino').Logger}) => Promise<string>}
 */
export function createRequestedReconciler({
  github,
  runReader,
  commitFinder,
  dispatcher,
  events,
  now,
  settings
}) {
  async function publish(event, signal) {
    await events.publish(event, { signal })
  }

  async function reportOf(command, run, signal) {
    return github.getRunReport({
      repository: command.repository,
      runId: run.id,
      environment: command.environment,
      signal
    })
  }

  return async function reconcileRequested(command, { signal, logger }) {
    const since = new Date(now() - settings.reconcileLookbackMs).toISOString()
    const runs = await runReader.findSubmitRuns({
      repository: command.repository,
      operationId: command.operationId,
      createdFrom: since,
      signal
    })
    const commit = await commitFinder.find({
      repository: command.repository,
      path: command.path,
      operationId: command.operationId,
      since,
      signal
    })
    const stamp = new Date(now())

    if (commit) {
      // The run that made the commit: the newest that succeeded.
      const run =
        runs.find((candidate) => runPhase(candidate) === 'succeeded') ?? runs[0]

      if (!run) {
        logger?.warn(
          { commitSha: commit.sha },
          'A commit names the operation but no submit run does, so nothing could be reported'
        )

        return 'unresolved'
      }

      await publish(
        committedEvent({ command, run, commit, now: stamp }),
        signal
      )

      return 'committed'
    }

    const [latest] = runs

    if (latest && runPhase(latest) === 'active') {
      await publish(
        requestedEvent({ command, run: latest, now: stamp }),
        signal
      )

      return 'requested'
    }

    if (latest && ['failed', 'succeeded'].includes(runPhase(latest))) {
      const report = await reportOf(command, latest, signal)

      if (
        runPhase(latest) === 'failed' ||
        recordedFailureOf(report, command.operationId)
      ) {
        await publish(
          checksFailedEvent({ command, run: latest, report, now: stamp }),
          signal
        )

        return 'checks-failed'
      }
    }

    await dispatcher.dispatchSubmit(command, { signal })

    return 'dispatched'
  }
}
