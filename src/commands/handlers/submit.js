import { createdFromOf } from '#/github/workflow-dispatcher.js'

/**
 * Whether a submit run of the command's operation can be the command's own.
 * The run-name carries the operation, not the command, so a resubmission is
 * told from an earlier attempt's run by time. A retry is created only after
 * the earlier run's failure, and commands are FIFO per team, so a run that
 * had completed before the command was created cannot be the command's, even
 * when its creation time falls inside the lookback that allows for clock
 * skew. A run still going, or completed at or after the command's creation,
 * can be. The comparison is exact: skew is allowed for only when looking for
 * a run created, not when ruling one out.
 * @param {import('#/github/github-client.js').WorkflowRun} run
 * @param {{createdAt: string}} command
 * @returns {boolean}
 */
function canBeRunOf(run, command) {
  return (
    run.status !== 'completed' ||
    Date.parse(run.updatedAt) >= Date.parse(command.createdAt)
  )
}

/**
 * The `submit` handler (plan 6.1): looks for a submit run with
 * `({operationId})` in its name created since the command (less a little
 * clock skew) that is not one the earlier attempt ended before the command
 * existed, and only if there is none dispatches `submit.yml` (asking GitHub
 * for the run it creates). A redelivered command, one whose dispatch was made
 * but not acknowledged, or a second copy therefore dispatches nothing (AC3).
 * A resubmission has a newer `createdAt`, so an earlier attempt's run does not
 * count.
 * @param {object} deps
 * @param {ReturnType<import('#/reconciler/run-reader.js').createRunReader>} deps.runReader
 * @param {ReturnType<import('#/github/workflow-dispatcher.js').createWorkflowDispatcher>} deps.dispatcher
 * @returns {(command: object, context: {signal?: AbortSignal, logger?: import('pino').Logger}) => Promise<'dispatched'|'duplicate'>}
 */
export function createSubmitHandler({ runReader, dispatcher }) {
  return async function handleSubmit(command, { signal, logger }) {
    const runs = await runReader.findSubmitRuns({
      repository: command.repository,
      operationId: command.operationId,
      createdFrom: createdFromOf(command),
      signal
    })
    const existing = runs.find((run) => canBeRunOf(run, command))

    if (existing) {
      logger?.info(
        { runId: existing.id },
        'The submit run for this command already exists, so nothing was dispatched'
      )

      return 'duplicate'
    }

    await dispatcher.dispatchSubmit(command, { signal })

    return 'dispatched'
  }
}
