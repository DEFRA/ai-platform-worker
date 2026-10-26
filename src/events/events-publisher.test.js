import {
  assertPublishableEvent,
  eventGroupId
} from '#/events/events-publisher.js'
import { exampleEvent, SHA } from '../../test/fixtures/gitops-messages.js'

describe('#events-publisher', () => {
  describe('assertPublishableEvent', () => {
    test('accepts a valid event', () => {
      expect(() =>
        assertPublishableEvent(exampleEvent('requested'))
      ).not.toThrow()
    })

    test('refuses an invalid event naming the failing paths and never the data', () => {
      const event = exampleEvent('requested', {
        requestedBy: 'Jo Bloggs',
        surprise: true
      })

      let thrown

      try {
        assertPublishableEvent(event)
      } catch (error) {
        thrown = error
      }

      expect(thrown.code).toBe('invalid-event')
      expect(thrown.message).toMatch(/^Refusing to publish an invalid event: /)
      expect(thrown.message).not.toContain('Jo Bloggs')
    })
  })

  describe('eventGroupId', () => {
    test('is the operation ID for an event with an operation', () => {
      expect(eventGroupId(exampleEvent('committed'))).toBe('op-7f3c9a1e')
    })

    test('is the commit SHA for a break-glass event', () => {
      expect(
        eventGroupId({
          operationId: null,
          action: 'break-glass',
          commitSha: SHA,
          environment: 'infradev'
        })
      ).toBe(SHA)
    })

    test('is the environment for an event with no operation', () => {
      expect(
        eventGroupId({
          operationId: null,
          action: 'pause',
          environment: 'infradev'
        })
      ).toBe('infradev')
    })
  })
})
