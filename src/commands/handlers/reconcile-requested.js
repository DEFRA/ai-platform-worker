import {
  checksFailedEvent,
  committedEvent,
  recordedFailureOf,
  requestedEvent,
  runPhase
} from '#/reconciler/status-mapper.js'
import { canBeRunSubmittedAt } from '#/reconciler/run-timing.js'

async function publish({ events }, event, signal) {
  await events.publish(event, { signal })
}

async function reportOf({ github }, command, run, signal) {
  return github.getRunReport({
    repository: command.repository,
    runId: run.id,
    runAttempt: run.runAttempt,
    environment: command.environment,
    signal
  })
}

// A commit names the operation: publish `committed` with the run that made it
// (the newest that succeeded). Without any submit run, submit is dispatched
// again to report the commit with a run; that is the outcome, `dispatched`.
async function reportCommit(
  deps,
  { command, runs, commit, signal, stamp, logger }
) {
  const run =
    runs.find((candidate) => runPhase(candidate) === 'succeeded') ?? runs[0]

  if (!run) {
    logger?.warn(
      { commitSha: commit.sha },
      'A commit names the operation but no submit run does, so submit was dispatched again to report it with a run'
    )
    await deps.dispatcher.dispatchSubmit(command, { signal })

    return 'dispatched'
  }

  await publish(
    deps,
    committedEvent({ command, run, commit, now: stamp }),
    signal
  )

  return 'committed'
}

// No commit: the newest submit run says. Null when it says nothing to report
// (no run, or one that ended without a failure), so the caller dispatches.
async function reportLatestRun(deps, { command, runs, signal, stamp }) {
  const [latest] = runs
  const phase = latest ? runPhase(latest) : null

  if (phase === 'active') {
    await publish(
      deps,
      requestedEvent({ command, run: latest, now: stamp }),
      signal
    )

    return 'requested'
  }

  if (phase !== 'failed' && phase !== 'succeeded') {
    return null
  }

  const report = await reportOf(deps, command, latest, signal)

  if (phase === 'failed' || recordedFailureOf(report, command.operationId)) {
    await publish(
      deps,
      checksFailedEvent({ command, run: latest, report, now: stamp }),
      signal
    )

    return 'checks-failed'
  }

  return null
}

// A resubmission that never reached GitHub leaves only the earlier attempt's
// runs, whose refusals the backend has already handled (their event IDs repeat,
// so it would drop them and the operation would time out). The command's
// `submittedAt`, when it carries one, rules those runs out; without it every
// run counts, as before.
function runsOfSubmission(runs, { submittedAt }) {
  return submittedAt
    ? runs.filter((run) => canBeRunSubmittedAt(run, submittedAt))
    : runs
}

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
 *
 * Runs that ended before the command's `submittedAt` belong to an earlier
 * submission and are ignored.
 * @param {object} deps
 * @returns {(command: object, context: {signal?: AbortSignal, logger?: import('pino').Logger}) => Promise<string>}
 */
export function createRequestedReconciler(deps) {
  const { runReader, commitFinder, dispatcher, now, settings } = deps

  return async function reconcileRequested(command, { signal, logger }) {
    const since = new Date(now() - settings.reconcileLookbackMs).toISOString()
    const found = await runReader.findSubmitRuns({
      repository: command.repository,
      operationId: command.operationId,
      createdFrom: since,
      signal
    })
    const runs = runsOfSubmission(found, command)
    const commit = await commitFinder.find({
      repository: command.repository,
      path: command.path,
      operationId: command.operationId,
      since,
      signal
    })
    const facts = { command, runs, signal, stamp: new Date(now()) }
    const outcome = commit
      ? await reportCommit(deps, { ...facts, commit, logger })
      : await reportLatestRun(deps, facts)

    if (outcome) {
      return outcome
    }

    await dispatcher.dispatchSubmit(command, { signal })

    return 'dispatched'
  }
}
