import { SendMessageCommand } from '@aws-sdk/client-sqs'

import {
  assertPublishableEvent,
  eventGroupId
} from '#/events/events-publisher.js'

/**
 * Creates the SQS FIFO `EventsPublisher`. The event ID is the deduplication
 * ID, so a repeat inside SQS's five-minute window collapses, and the group is
 * the operation, so one operation's events stay in order. The AWS SDK's own
 * standard retry (three attempts, exponential backoff with jitter) covers a
 * transient failure; a failure after that propagates, the command is
 * redelivered, and the handler runs again. The send stops at the handler's
 * signal.
 * @param {object} deps
 * @param {import('@aws-sdk/client-sqs').SQSClient} deps.client
 * @param {string} deps.queueUrl
 * @returns {import('#/events/events-publisher.js').EventsPublisher}
 */
export function createSqsEventsPublisher({ client, queueUrl }) {
  return {
    async publish(event, { signal } = {}) {
      assertPublishableEvent(event)

      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(event),
          MessageGroupId: eventGroupId(event),
          MessageDeduplicationId: event.eventId
        }),
        { abortSignal: signal }
      )
    }
  }
}
