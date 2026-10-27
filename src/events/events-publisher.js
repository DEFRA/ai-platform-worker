import { validateEvent } from '#/contracts/message-validators.js'

/**
 * The port for handing an event to the backend. The adapter publishes to the
 * worker's SNS topic `aip_gitops_events_worker.fifo`, which CDP delivers to the
 * queue the backend consumes. An event is an `aip.gitops.event/1` message.
 * `publish` resolves once the topic has accepted it, rejects when it could
 * not be sent, and refuses (rejects without sending) an event that fails the
 * schema, so a bug can never put a bad message on the queue.
 *
 * @typedef {object} EventsPublisher
 * @property {(event: object, options?: {signal?: AbortSignal}) => Promise<void>} publish
 */

/**
 * Throws, before anything is sent, when an event fails the
 * `aip.gitops.event/1` schema. The error names the failing paths only, never
 * the event, which carries a requester.
 * @param {unknown} event
 */
export function assertPublishableEvent(event) {
  const { valid, errors } = validateEvent(event)

  if (!valid) {
    const error = new Error(
      `Refusing to publish an invalid event: ${errors.join('; ')}`
    )
    error.code = 'invalid-event'
    throw error
  }
}

/**
 * The FIFO message group of an event (plan 5): the operation ID, the commit
 * SHA for `break-glass`, or the environment for `pause` and a run with no
 * operation. Events of one operation stay in order; operations run in
 * parallel.
 * @param {{operationId: string|null, action: string, commitSha?: string, environment: string}} event
 * @returns {string}
 */
export function eventGroupId({ operationId, action, commitSha, environment }) {
  if (operationId) {
    return operationId
  }

  return action === 'break-glass' ? commitSha : environment
}
