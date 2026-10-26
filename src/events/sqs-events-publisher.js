import { SendMessageCommand } from '@aws-sdk/client-sqs'

import { retry } from '#/common/helpers/retry.js'
import {
  assertPublishableEvent,
  eventGroupId
} from '#/events/events-publisher.js'

/**
 * Creates the SQS FIFO `EventsPublisher`. The event ID is the deduplication
 * ID, so a repeat inside SQS's five-minute window collapses, and the group is
 * the operation, so one operation's events stay in order. A send is tried
 * again on a transient failure (a repeat is safe because of the deduplication
 * ID) and stops at the handler's signal.
 * @param {object} deps
 * @param {import('@aws-sdk/client-sqs').SQSClient} deps.client
 * @param {string} deps.queueUrl
 * @param {object} [deps.retryOptions]
 * @returns {import('#/events/events-publisher.js').EventsPublisher}
 */
export function createSqsEventsPublisher({
  client,
  queueUrl,
  retryOptions = {}
}) {
  return {
    async publish(event, { signal } = {}) {
      assertPublishableEvent(event)

      const message = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event),
        MessageGroupId: eventGroupId(event),
        MessageDeduplicationId: event.eventId
      })

      await retry(() => client.send(message, { abortSignal: signal }), {
        signal,
        ...retryOptions
      })
    }
  }
}
