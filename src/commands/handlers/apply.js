/**
 * The `apply` handler (plan 6.1): dispatches `apply.yml` for the environment
 * once per command. The apply is idempotent and the workflow serialises it
 * per environment, so the only duplicate to prevent is the same command
 * dispatched twice, which the dispatcher does by the run name (AC3).
 * @param {object} deps
 * @param {ReturnType<import('#/github/workflow-dispatcher.js').createWorkflowDispatcher>} deps.dispatcher
 * @returns {(command: object, context: {signal?: AbortSignal, logger?: import('pino').Logger}) => Promise<'dispatched'|'duplicate'>}
 */
export function createApplyHandler({ dispatcher }) {
  return async function handleApply(command, { signal, logger }) {
    const { dispatched } = await dispatcher.dispatchApply(command, { signal })

    if (!dispatched) {
      logger?.info(
        'The apply run for this command already exists, so nothing was dispatched'
      )
    }

    return dispatched ? 'dispatched' : 'duplicate'
  }
}
