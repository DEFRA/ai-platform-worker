import { assertPublishableEvent } from '#/events/events-publisher.js'

/**
 * An in-memory `EventsPublisher`: it refuses an invalid event as the real one
 * does, records every event it accepts, and can fail the next publish.
 */
export function createInMemoryEventsPublisher() {
  const events = []
  let failure = null

  return {
    events,
    failNext(error) {
      failure = error
    },
    async publish(event, { signal } = {}) {
      signal?.throwIfAborted()
      assertPublishableEvent(event)

      if (failure) {
        const error = failure
        failure = null
        throw error
      }

      events.push(event)
    }
  }
}
