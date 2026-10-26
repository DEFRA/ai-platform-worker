import { createdFromOf } from '#/github/workflow-dispatcher.js'

/**
 * The `submit` handler (plan 6.1): looks for a submit run with
 * `({operationId})` in its name created since the command, and only if there
 * is none dispatches `submit.yml` (asking GitHub for the run it creates). A
 * redelivered command, one whose dispatch was made but not acknowledged, or a
 * second copy therefore dispatches nothing (AC3). A resubmission has a newer
 * `createdAt`, so an earlier attempt's run does not count.
 * @param {object} deps
 * @param {ReturnType<import('#/reconciler/run-reader.js').createRunReader>} deps.runReader
 * @param {ReturnType<import('#/github/workflow-dispatcher.js').createWorkflowDispatcher>} deps.dispatcher
 * @returns {(command: object, context: {signal?: AbortSignal, logger?: import('pino').Logger}) => Promise<'dispatched'|'duplicate'>}
 */
export function createSubmitHandler({ runReader, dispatcher }) {
  return async function handleSubmit(command, { signal, logger }) {
    const [existing] = await runReader.findSubmitRuns({
      repository: command.repository,
      operationId: command.operationId,
      createdFrom: createdFromOf(command),
      signal
    })

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
