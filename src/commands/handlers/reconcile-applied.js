import {
  applyVerdict,
  deployFailedEvent,
  deployedEvent,
  deployingEvent,
  runPhase
} from '#/reconciler/status-mapper.js'

// How many completed apply runs' reports are read: the operation's apply is
// among the latest, and a reconcile must not spend the rate budget.
const MAX_REPORT_READS = 5

async function freshApply({ dispatcher }, command, signal, outcome) {
  await dispatcher.dispatchApply(command, { signal })

  return outcome
}

async function publishFromReport(
  { events, now },
  { command, run, commit, report, signal }
) {
  const verdict = applyVerdict(report, command.operationId)

  if (verdict === 'unlisted' || verdict === 'unusable') {
    return null
  }

  const facts = { command, run, commit, report, now: new Date(now()) }

  if (verdict === 'deployed') {
    await events.publish(deployedEvent(facts), { signal })

    return 'deployed'
  }

  await events.publish(deployFailedEvent(facts), { signal })

  return 'deploy-failed'
}

async function reportOfRun({ github }, command, run, signal) {
  return github.getRunReport({
    repository: command.repository,
    runId: run.id,
    runAttempt: run.runAttempt,
    environment: command.environment,
    signal
  })
}

// The runs newest first: an active run is the answer, a completed one answers
// through its report, and the rest are passed over. Null when none answers.
async function reconcileRuns(deps, { command, runs, commit, signal }) {
  let reportsRead = 0

  for (const run of runs) {
    const phase = runPhase(run)

    if (phase === 'active') {
      await deps.events.publish(
        deployingEvent({ command, run, commit, now: new Date(deps.now()) }),
        { signal }
      )

      return 'deploying'
    }

    if (phase === 'unusable' || reportsRead >= MAX_REPORT_READS) {
      continue
    }

    reportsRead += 1

    const report = await reportOfRun(deps, command, run, signal)
    const outcome = await publishFromReport(deps, {
      command,
      run,
      commit,
      report,
      signal
    })

    if (outcome) {
      return outcome
    }
  }

  return null
}

/**
 * Reconcile a command whose operation is `committed` or `deploying` (plan 5,
 * reconcile table). The commit is found by its trailer; the apply runs that
 * contain it are read newest first:
 *
 * - a run queued or running: publish `deploying` with it;
 * - a completed run whose report lists the operation: publish `deployed`
 *   (outcome `success`) or `deploy-failed` (otherwise, `paused` retryable),
 *   from the report;
 * - no run, or runs cancelled, superseded or without a report: dispatch a
 *   fresh apply for the environment (once per command).
 * @param {object} deps
 * @returns {(command: object, context: {signal?: AbortSignal, logger?: import('pino').Logger}) => Promise<string>}
 */
export function createAppliedReconciler(deps) {
  const { runReader, commitFinder, now, settings } = deps

  return async function reconcileApplied(command, { signal, logger }) {
    const commit = await commitFinder.find({
      repository: command.repository,
      path: command.path,
      operationId: command.operationId,
      since: new Date(now() - settings.reconcileLookbackMs).toISOString(),
      signal
    })

    if (!commit) {
      logger?.warn(
        'No commit names the operation, so a fresh apply was dispatched without an event'
      )

      return freshApply(deps, command, signal, 'dispatched-without-commit')
    }

    const runs = await runReader.findAppliesContaining({
      repository: command.repository,
      environment: command.environment,
      commit,
      signal
    })
    const outcome = await reconcileRuns(deps, {
      command,
      runs,
      commit,
      signal
    })

    return outcome ?? freshApply(deps, command, signal, 'dispatched')
  }
}
