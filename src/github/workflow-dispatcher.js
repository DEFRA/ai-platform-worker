import { APPLY_WORKFLOW, SUBMIT_WORKFLOW } from '#/github/github-client.js'

const CLOCK_SKEW_MS = 5000

/**
 * A pin is the file `environments/{env}/platform.json` of a state repository;
 * the command's team is then `platform` or `tenants`.
 * @param {{team: string|null}} command
 * @returns {boolean}
 */
function isPin({ team }) {
  return team === 'platform' || team === 'tenants'
}

/**
 * The `submit.yml` inputs for a command (plan 5, interfaces). The worker
 * passes `action`, `document`, `expected_revision` and `expected_base`; a team
 * file names its revision and no base, a pin its base (`0` for a new file, as
 * the workflow requires) and no revision. The traceparent and CDP request ID
 * travel as inputs, so they reach the commit trailers and the events.
 * @param {object} command
 * @returns {Record<string, string>}
 */
export function submitInputs(command) {
  const pin = isPin(command)

  return {
    action: command.action,
    environment: command.environment,
    path: command.path,
    document: command.document ?? '',
    operation_id: command.operationId,
    expected_revision: pin ? '0' : String(command.expectedRevision ?? 0),
    expected_base: pin ? (command.expectedBase ?? '0') : '',
    requested_by: command.requestedBy,
    trace_parent: command.traceparent ?? '',
    cdp_request_id: command.cdpRequestId ?? ''
  }
}

/**
 * The `apply.yml` inputs for a command. The reason names the command, so a
 * redelivered command finds the run it already started by its run name
 * (`apply {environment} {reason}`); the operation, when there is one, is
 * there for a person reading the run list.
 * @param {{environment: string, operationId: string|null, commandId: string}} command
 * @returns {{environment: string, reason: string}}
 */
export function applyInputs({ environment, operationId, commandId }) {
  return {
    environment,
    reason: `portal ${operationId ?? 'no-operation'} ${commandId}`
  }
}

/**
 * The time from which a command's own runs can exist: when it was created,
 * less a little for the two clocks (the backend's and GitHub's) to differ.
 * @param {{createdAt: string}} command
 * @returns {string} ISO 8601
 */
export function createdFromOf({ createdAt }) {
  return new Date(Date.parse(createdAt) - CLOCK_SKEW_MS).toISOString()
}

/**
 * Dispatches `submit.yml` and `apply.yml` on a state repository (plan 6.1:
 * `github/workflow-dispatcher.js`). The one place that turns a command into a
 * workflow dispatch, and the one that times it.
 * @param {object} deps
 * @param {import('#/github/github-client.js').GitHubClient} deps.github
 * @param {ReturnType<import('#/reconciler/run-reader.js').createRunReader>} deps.runReader
 * @param {{millis: (name: string, value: number, dimensions?: object) => Promise<void>}} deps.metrics
 * @param {() => number} [deps.now]
 */
export function createWorkflowDispatcher({
  github,
  runReader,
  metrics,
  now = Date.now
}) {
  async function dispatch(workflowId, command, inputs, signal) {
    const started = now()

    try {
      return await github.dispatchWorkflow({
        repository: command.repository,
        workflowId,
        inputs,
        signal
      })
    } finally {
      await metrics.millis('dispatchDuration', now() - started, {
        workflow: workflowId
      })
    }
  }

  return {
    /**
     * Dispatches `submit.yml` for a command (or a reconcile from `requested`,
     * which carries the same payload). Nothing is looked for first: callers
     * decide whether a run exists.
     * @returns {Promise<{runId: number|null, runUrl: string|null}>}
     */
    dispatchSubmit(command, { signal } = {}) {
      return dispatch(SUBMIT_WORKFLOW, command, submitInputs(command), signal)
    },

    /**
     * Dispatches `apply.yml` once per command: a redelivered command, or one
     * dispatched and then lost to a timeout, finds its run by name and
     * dispatches nothing.
     * @returns {Promise<{dispatched: boolean}>}
     */
    async dispatchApply(command, { signal } = {}) {
      const existing = await runReader.findDispatchedApply({
        repository: command.repository,
        commandId: command.commandId,
        createdFrom: createdFromOf(command),
        signal
      })

      if (existing) {
        return { dispatched: false }
      }

      await dispatch(APPLY_WORKFLOW, command, applyInputs(command), signal)

      return { dispatched: true }
    }
  }
}
