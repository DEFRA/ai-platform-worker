import { exampleEvent } from '../../test/fixtures/gitops-messages.js'

// The contract every `EventsPublisher` must meet, run against the in-memory
// fake and the SQS adapter. A harness gives `{publisher, published}`, where
// `published()` returns the events that reached the queue.
// Not application code: it is exercised through the adapters' test files.

/**
 * @param {string} name
 * @param {() => {publisher: import('#/events/events-publisher.js').EventsPublisher, published: () => object[]}} createHarness
 */
export function describeEventsPublisherContract(name, createHarness) {
  describe(`EventsPublisher contract: ${name}`, () => {
    let harness

    beforeEach(() => {
      harness = createHarness()
    })

    test('accepts a valid event and puts it on the queue unchanged', async () => {
      const event = exampleEvent('committed', { source: 'reconciler' })

      await harness.publisher.publish(event)

      expect(harness.published()).toEqual([event])
    })

    test('refuses an event that fails the schema and puts nothing on the queue', async () => {
      await expect(
        harness.publisher.publish(exampleEvent('requested', { surprise: true }))
      ).rejects.toMatchObject({ code: 'invalid-event' })
      expect(harness.published()).toEqual([])
    })

    test('stops when the signal has aborted, publishing nothing', async () => {
      await expect(
        harness.publisher.publish(exampleEvent('requested'), {
          signal: AbortSignal.abort(new Error('deadline'))
        })
      ).rejects.toThrow('deadline')
      expect(harness.published()).toEqual([])
    })
  })
}
