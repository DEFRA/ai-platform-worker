import {
  exampleApply,
  exampleCommand,
  exampleEvent,
  exampleReconcile
} from '../../test/fixtures/gitops-messages.js'
import {
  validateCommand,
  validateEvent
} from '#/contracts/message-validators.js'

describe('#message-validators', () => {
  describe('commands', () => {
    test('accepts a submit, a reconcile from each state and an apply', () => {
      expect(validateCommand(exampleCommand())).toEqual({
        valid: true,
        errors: []
      })
      expect(validateCommand(exampleReconcile('requested')).valid).toBe(true)
      expect(validateCommand(exampleReconcile('deploying')).valid).toBe(true)
      expect(validateCommand(exampleApply()).valid).toBe(true)
    })

    test('accepts a pin submit with its base and a first pin with none', () => {
      const pin = exampleCommand({
        team: 'platform',
        repository: 'DEFRA/ai-platform-deployments',
        path: 'environments/infradev/platform.json',
        expectedRevision: undefined,
        expectedBase: '0123456789abcdef0123456789abcdef01234567'
      })

      expect(validateCommand(pin).valid).toBe(true)
      expect(validateCommand({ ...pin, expectedBase: null }).valid).toBe(true)
    })

    test.each([
      ['an unknown field', { surprise: true }],
      ['a bad schema identifier', { schema: 'aip.gitops.command/2' }],
      ['a commandId that is not a UUIDv7', { commandId: 'abc' }],
      ['a requester that is a name', { requestedBy: 'Jo Bloggs' }],
      ['a write with no document', { document: undefined }],
      ['a submit with a state', { state: 'requested' }]
    ])('refuses %s, naming the path and not the data', (_name, change) => {
      const { valid, errors } = validateCommand(exampleCommand(change))

      expect(valid).toBe(false)
      expect(errors.length).toBeGreaterThan(0)
      expect(JSON.stringify(errors)).not.toContain('Jo Bloggs')
    })

    test('refuses a reconcile with no state', () => {
      expect(
        validateCommand(exampleReconcile('requested', { state: undefined }))
          .valid
      ).toBe(false)
    })
  })

  describe('events', () => {
    test.each([
      'requested',
      'checks-failed',
      'committed',
      'deploying',
      'deployed',
      'deploy-failed'
    ])('accepts a %s event', (status) => {
      expect(validateEvent(exampleEvent(status)).valid).toBe(true)
    })

    test('accepts a pause and a resume', () => {
      for (const status of ['paused', 'resumed']) {
        expect(
          validateEvent(
            exampleEvent(status, {
              action: 'pause',
              operationId: null,
              team: null,
              path: null
            })
          ).valid
        ).toBe(true)
      }
    })

    test.each([
      ['an extra field', { surprise: 1 }],
      ['a status the contract does not have', { status: 'merged' }],
      ['no event ID', { eventId: undefined }],
      ['a run URL on another host', { runUrl: 'https://example.com/runs/1' }],
      [
        'a retryable flag on a code that is never retryable',
        {
          status: 'checks-failed',
          failureReason: { code: 'x-y', message: 'm', retryable: true }
        }
      ]
    ])('refuses %s', (_name, change) => {
      const event = exampleEvent('requested', change)

      expect(validateEvent(event).valid).toBe(false)
    })
  })
})
