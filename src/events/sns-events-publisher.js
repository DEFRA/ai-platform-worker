import { PublishCommand } from '@aws-sdk/client-sns'

import {
  assertPublishableEvent,
  eventGroupId
} from '#/events/events-publisher.js'

/**
 * Creates the SNS FIFO `EventsPublisher`. The worker owns the topic; CDP
 * subscribes the backend's events queue to it with raw delivery, so the queue
 * body is the event itself. The event ID is the deduplication ID, so a repeat
 * inside SNS's five-minute window collapses, and the group is the operation,
 * so one operation's events stay in order. The AWS SDK's own standard retry
 * (three attempts, exponential backoff with jitter) covers a transient
 * failure; a failure after that propagates, the command is redelivered, and
 * the handler runs again. The publish stops at the handler's signal.
 * @param {object} deps
 * @param {import('@aws-sdk/client-sns').SNSClient} deps.client
 * @param {string} deps.topicArn
 * @returns {import('#/events/events-publisher.js').EventsPublisher}
 */
export function createSnsEventsPublisher({ client, topicArn }) {
  return {
    async publish(event, { signal } = {}) {
      assertPublishableEvent(event)

      await client.send(
        new PublishCommand({
          TopicArn: topicArn,
          Message: JSON.stringify(event),
          MessageGroupId: eventGroupId(event),
          MessageDeduplicationId: event.eventId
        }),
        { abortSignal: signal }
      )
    }
  }
}
