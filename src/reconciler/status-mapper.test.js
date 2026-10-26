import {
  OPERATION_ID,
  SHA,
  exampleReconcile
} from '../../test/fixtures/gitops-messages.js'
import { workflowRun } from '../../test/fakes/in-memory-github-client.js'
import { validateEvent } from '#/contracts/message-validators.js'
import {
  applyVerdict,
  checksFailedEvent,
  committedEvent,
  deployFailedEvent,
  deployedEvent,
  deployingEvent,
  requestedEvent,
  runPhase
} from '#/reconciler/status-mapper.js'

const NOW = new Date('2026-10-26T12:10:30Z')
const COMMIT = { sha: SHA, committedAt: '2026-10-26T12:00:24Z' }
const REQUESTED = exampleReconcile('requested')
const COMMITTED = exampleReconcile('committed')

function facts(extra = {}) {
  return {
    command: REQUESTED,
    run: workflowRun({ id: 25000000001 }),
    commit: COMMIT,
    now: NOW,
    ...extra
  }
}

function expectValid(event) {
  expect(validateEvent(event)).toEqual({ valid: true, errors: [] })
}

describe('#status-mapper', () => {
  describe('runPhase', () => {
    test.each([
      [{ status: 'queued', conclusion: null }, 'active'],
      [{ status: 'in_progress', conclusion: null }, 'active'],
      [{ status: 'completed', conclusion: 'success' }, 'succeeded'],
      [{ status: 'completed', conclusion: 'failure' }, 'failed'],
      [{ status: 'completed', conclusion: 'timed_out' }, 'failed'],
      [{ status: 'completed', conclusion: 'startup_failure' }, 'failed'],
      [{ status: 'completed', conclusion: 'action_required' }, 'failed'],
      [{ status: 'completed', conclusion: 'cancelled' }, 'unusable'],
      [{ status: 'completed', conclusion: 'skipped' }, 'unusable'],
      [{ status: 'completed', conclusion: 'neutral' }, 'unusable']
    ])('%j is %s', (run, expected) => {
      expect(runPhase(run)).toBe(expected)
    })
  })

  describe('applyVerdict', () => {
    const operations = [{ sha: SHA, operationIds: [OPERATION_ID] }]

    test.each([
      ['no report', null, 'unlisted'],
      [
        'a report that does not name it',
        { operations: [], outcome: 'success' },
        'unlisted'
      ],
      ['a report with no operations', { outcome: 'success' }, 'unlisted'],
      ['a success', { operations, outcome: 'success' }, 'deployed'],
      ['a pause', { operations, outcome: 'paused' }, 'paused'],
      ['a superseded run', { operations, outcome: 'superseded' }, 'unusable'],
      [
        'a pending first report',
        { operations, outcome: 'pending' },
        'unusable'
      ],
      ['a cancelled run', { operations, outcome: 'cancelled' }, 'unusable'],
      ['a failure', { operations, outcome: 'failure' }, 'failed'],
      ['an outcome nobody named', { operations, outcome: 'exploded' }, 'failed']
    ])('%s is %s', (_name, report, expected) => {
      expect(applyVerdict(report, OPERATION_ID)).toBe(expected)
    })
  })

  describe('events', () => {
    test('requested carries the target and audit fields of the command and the run', () => {
      const event = requestedEvent(facts())

      expectValid(event)
      expect(event).toMatchObject({
        eventId: `${OPERATION_ID}:requested:25000000001:1`,
        status: 'requested',
        source: 'reconciler',
        action: 'write',
        operationId: OPERATION_ID,
        requestedBy: REQUESTED.requestedBy,
        traceparent: REQUESTED.traceparent,
        cdpRequestId: REQUESTED.cdpRequestId,
        runUrl:
          'https://github.com/DEFRA/ai-platform-tenants/actions/runs/25000000001',
        timestamp: '2026-10-26T12:10:30.000Z'
      })
    })

    test('committed adds the commit', () => {
      const event = committedEvent(facts())

      expectValid(event)
      expect(event).toMatchObject({
        commitSha: SHA,
        committedAt: COMMIT.committedAt,
        eventId: `${OPERATION_ID}:committed:25000000001:1`
      })
    })

    test('deploying is an apply event: no action on the command, so `apply`', () => {
      const event = deployingEvent(facts({ command: COMMITTED }))

      expectValid(event)
      expect(event.action).toBe('apply')
      expect(event.status).toBe('deploying')
    })

    test('deployed carries the applied SHA and the resources, empty for a removal', () => {
      const report = {
        appliedSha: 'f'.repeat(40),
        outputs: {
          teams: {
            value: {
              alpha: {
                project: {
                  id: '/subscriptions/s/projects/p',
                  name: 'aip-alpha'
                }
              }
            }
          }
        }
      }
      const event = deployedEvent(facts({ command: COMMITTED, report }))

      expectValid(event)
      expect(event.appliedSha).toBe('f'.repeat(40))
      expect(event.resources).toEqual([
        {
          type: 'azapi_resource.foundry_project',
          name: 'aip-alpha',
          id: '/subscriptions/s/projects/p'
        }
      ])
      expect(
        deployedEvent(
          facts({ command: COMMITTED, report: { appliedSha: SHA } })
        ).resources
      ).toEqual([])
    })

    test('deployed falls back to the run head when the report has no applied SHA', () => {
      const event = deployedEvent(
        facts({
          command: COMMITTED,
          report: {},
          run: workflowRun({ id: 7, headSha: 'e'.repeat(40) })
        })
      )

      expectValid(event)
      expect(event.appliedSha).toBe('e'.repeat(40))
    })

    test('deploy-failed names the failing teams and attributes only when the report does', () => {
      const attributable = deployFailedEvent(
        facts({
          command: COMMITTED,
          report: {
            outcome: 'failure',
            failingTeams: ['alpha'],
            unattributedFailure: false
          }
        })
      )
      const unattributed = deployFailedEvent(
        facts({
          command: COMMITTED,
          report: {
            outcome: 'failure',
            failingTeams: [],
            unattributedFailure: true
          }
        })
      )

      expectValid(attributable)
      expectValid(unattributed)
      expect(attributable).toMatchObject({
        failingTeams: ['alpha'],
        attributable: true,
        failureReason: { code: 'apply-failed', retryable: false }
      })
      expect(unattributed).toMatchObject({
        failingTeams: [],
        attributable: false
      })
    })

    test('deploy-failed with no failing-team fields in the report is not attributable', () => {
      const event = deployFailedEvent(
        facts({ command: COMMITTED, report: { outcome: 'failure' } })
      )

      expectValid(event)
      expect(event).toMatchObject({ failingTeams: [], attributable: false })
    })

    test('a paused outcome is the retryable refusal and names no team', () => {
      const event = deployFailedEvent(
        facts({
          command: COMMITTED,
          report: { outcome: 'paused', failingTeams: ['alpha'] }
        })
      )

      expectValid(event)
      expect(event).toMatchObject({
        failureReason: { code: 'paused', retryable: true },
        failingTeams: [],
        attributable: false
      })
    })

    test('checks-failed republishes the reason the run recorded, retryable or not', () => {
      const retryable = checksFailedEvent(
        facts({
          report: {
            events: [
              {
                operationId: OPERATION_ID,
                status: 'checks-failed',
                failureReason: {
                  code: 'stale-revision',
                  message: 'The file moved.',
                  retryable: true
                }
              }
            ]
          }
        })
      )

      expectValid(retryable)
      expect(retryable.failureReason).toEqual({
        code: 'stale-revision',
        message: 'The file moved.',
        retryable: true
      })
    })

    test('checks-failed ignores a recorded reason for another operation or status', () => {
      const event = checksFailedEvent(
        facts({
          run: workflowRun({ id: 3, conclusion: 'failure' }),
          report: {
            events: [
              {
                operationId: 'op-other',
                status: 'checks-failed',
                failureReason: { code: 'x-y', message: 'm', retryable: false }
              },
              { operationId: OPERATION_ID, status: 'requested' }
            ]
          }
        })
      )

      expectValid(event)
      expect(event.failureReason).toEqual({
        code: 'submit-failed',
        message: 'The submit run ended with failure; the run has the details.',
        retryable: false
      })
    })

    test('checks-failed with no report still says why, never retryable', () => {
      const event = checksFailedEvent(
        facts({
          run: workflowRun({ id: 3, conclusion: 'timed_out' }),
          report: null
        })
      )

      expectValid(event)
      expect(event.failureReason.retryable).toBe(false)
      expect(event.failureReason.message).toContain('timed_out')
    })

    test('truncates a long recorded message to the contract limit', () => {
      const event = checksFailedEvent(
        facts({
          report: {
            events: [
              {
                operationId: OPERATION_ID,
                status: 'checks-failed',
                failureReason: {
                  code: 'validation-failed',
                  message: 'x'.repeat(5000),
                  retryable: false
                }
              }
            ]
          }
        })
      )

      expectValid(event)
      expect(event.failureReason.message).toHaveLength(1000)
    })
  })
})
