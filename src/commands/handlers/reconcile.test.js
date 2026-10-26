import {
  CDP_REQUEST_ID,
  OPERATION_ID,
  SHA,
  TEAM_PATH,
  TENANTS_REPO,
  TRACEPARENT,
  exampleReconcile
} from '../../../test/fixtures/gitops-messages.js'
import {
  mainCommit,
  workflowRun
} from '../../../test/fakes/in-memory-github-client.js'
import { createWorld } from '../../../test/fakes/world.js'
import { applyInputs } from '#/github/workflow-dispatcher.js'

const COMMIT_TIME = '2026-10-26T12:00:24Z'
const OPERATIONS = [{ sha: SHA, operationIds: [OPERATION_ID] }]
const SUBMIT_RUN_NAME =
  'submit write environments/infradev/alpha.json (op-7f3c9a1e)'

const requested = () =>
  exampleReconcile('requested', { createdAt: '2026-10-26T12:10:00Z' })
const committed = (state = 'committed') =>
  exampleReconcile(state, { createdAt: '2026-10-26T12:10:00Z' })

function submitRun(overrides = {}) {
  return workflowRun({
    id: 25000000001,
    name: SUBMIT_RUN_NAME,
    createdAt: '2026-10-26T12:00:05Z',
    ...overrides
  })
}

function applyRun(overrides = {}) {
  return workflowRun({
    id: 25000000010,
    name: 'apply infradev',
    headSha: SHA,
    createdAt: '2026-10-26T12:00:30Z',
    ...overrides
  })
}

function withCommit(world) {
  world.github.seedCommits(TENANTS_REPO, [
    mainCommit({ path: TEAM_PATH, sha: SHA, committedAt: COMMIT_TIME })
  ])
}

function context(world) {
  return { logger: world.logger }
}

describe('#reconcile handler', () => {
  describe('AC9: a `requested` operation is reconciled once by the plan 5 table', () => {
    test('a submit run queued or running: publishes requested with the run', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ status: 'in_progress', conclusion: null })
      ])

      await expect(world.reconcile(requested(), context(world))).resolves.toBe(
        'requested'
      )
      expect(world.events.events).toHaveLength(1)
      expect(world.events.events[0]).toMatchObject({
        status: 'requested',
        source: 'reconciler',
        runId: 25000000001,
        eventId: `${OPERATION_ID}:requested:25000000001:1`
      })
      expect(world.github.dispatches).toEqual([])
    })

    test('a commit on main with the Operation-Id trailer: publishes committed, with the run that made it', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [submitRun()])

      await expect(world.reconcile(requested(), context(world))).resolves.toBe(
        'committed'
      )
      expect(world.events.events).toHaveLength(1)
      expect(world.events.events[0]).toMatchObject({
        status: 'committed',
        commitSha: SHA,
        committedAt: COMMIT_TIME,
        runId: 25000000001
      })
    })

    test('a commit outranks a submit run that is still finishing', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ status: 'in_progress', conclusion: null })
      ])

      await world.reconcile(requested(), context(world))

      expect(world.events.events[0].status).toBe('committed')
    })

    test('a commit with no submit run to name: acknowledged, nothing published, a warning', async () => {
      const world = createWorld()

      withCommit(world)

      await expect(world.reconcile(requested(), context(world))).resolves.toBe(
        'unresolved'
      )
      expect(world.events.events).toEqual([])
      expect(world.logger.warn).toHaveBeenCalledTimes(1)
    })

    test('a run that ended with checks failed: publishes checks-failed with the reason it recorded', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ conclusion: 'failure' })
      ])
      world.github.seedReport(TENANTS_REPO, 25000000001, 'infradev', {
        events: [
          {
            operationId: OPERATION_ID,
            status: 'checks-failed',
            failureReason: {
              code: 'validation-failed',
              message: 'The file failed validation',
              retryable: false
            }
          }
        ]
      })

      await expect(world.reconcile(requested(), context(world))).resolves.toBe(
        'checks-failed'
      )
      expect(world.events.events[0]).toMatchObject({
        status: 'checks-failed',
        failureReason: { code: 'validation-failed', retryable: false }
      })
    })

    test('a run that ended with a retryable refusal: publishes it from the run and never resubmits', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ conclusion: 'failure' })
      ])
      world.github.seedReport(TENANTS_REPO, 25000000001, 'infradev', {
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
      })

      await world.reconcile(requested(), context(world))

      expect(world.events.events[0].failureReason).toEqual({
        code: 'stale-revision',
        message: 'The file moved.',
        retryable: true
      })
      expect(world.github.dispatches).toEqual([])
    })

    test('a run that ended successfully but recorded a refusal: publishes the refusal', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [submitRun()])
      world.github.seedReport(TENANTS_REPO, 25000000001, 'infradev', {
        events: [
          {
            operationId: OPERATION_ID,
            status: 'checks-failed',
            failureReason: {
              code: 'paused',
              message: 'The environment is paused.',
              retryable: true
            }
          }
        ]
      })

      await expect(world.reconcile(requested(), context(world))).resolves.toBe(
        'checks-failed'
      )
      expect(world.events.events[0].failureReason.code).toBe('paused')
    })

    test('a failed run with no report: publishes a plain failure naming the conclusion', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ conclusion: 'startup_failure' })
      ])

      await world.reconcile(requested(), context(world))

      expect(world.events.events[0].failureReason).toMatchObject({
        code: 'submit-failed',
        retryable: false,
        message: expect.stringContaining('startup_failure')
      })
    })

    test('no run and no commit: dispatches submit again from the command payload', async () => {
      const world = createWorld()
      const command = requested()

      await expect(world.reconcile(command, context(world))).resolves.toBe(
        'dispatched'
      )
      expect(world.github.dispatches).toHaveLength(1)
      expect(world.github.dispatches[0]).toMatchObject({
        repository: TENANTS_REPO,
        workflowId: 'submit.yml',
        inputs: {
          action: 'write',
          document: command.document,
          expected_revision: '3',
          operation_id: OPERATION_ID
        }
      })
      expect(world.events.events).toEqual([])
    })

    test('a cancelled run that did nothing: dispatches submit again', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ conclusion: 'cancelled' })
      ])

      await expect(world.reconcile(requested(), context(world))).resolves.toBe(
        'dispatched'
      )
      expect(world.github.dispatches).toHaveLength(1)
    })

    test('a successful run with nothing recorded and no commit: dispatches submit again', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [submitRun()])
      world.github.seedReport(TENANTS_REPO, 25000000001, 'infradev', {
        events: []
      })

      await expect(world.reconcile(requested(), context(world))).resolves.toBe(
        'dispatched'
      )
    })

    test('reads the newest run when there are several', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({
          id: 1,
          conclusion: 'failure',
          createdAt: '2026-10-26T11:00:00Z'
        }),
        submitRun({
          id: 2,
          status: 'in_progress',
          conclusion: null,
          createdAt: '2026-10-26T12:00:05Z'
        })
      ])

      await world.reconcile(requested(), context(world))

      expect(world.events.events[0]).toMatchObject({
        status: 'requested',
        runId: 2
      })
    })

    test('looks back a day, no further', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({
          createdAt: '2026-10-25T12:00:00Z',
          status: 'in_progress',
          conclusion: null
        })
      ])

      await world.reconcile(requested(), context(world))

      expect(world.events.events).toEqual([])
      expect(world.github.dispatches).toHaveLength(1)
    })
  })

  describe('AC9: a `committed` or `deploying` operation is reconciled once by the plan 5 table', () => {
    test.each(['committed', 'deploying'])(
      'an apply run containing the commit, running (from %s): publishes deploying',
      async (state) => {
        const world = createWorld()

        withCommit(world)
        world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
          applyRun({ status: 'in_progress', conclusion: null })
        ])

        await expect(
          world.reconcile(committed(state), context(world))
        ).resolves.toBe('deploying')
        expect(world.events.events[0]).toMatchObject({
          status: 'deploying',
          action: 'apply',
          runId: 25000000010,
          commitSha: SHA,
          committedAt: COMMIT_TIME
        })
      }
    )

    test('an apply run whose report lists the operation with outcome success: publishes deployed', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [applyRun()])
      world.github.seedReport(TENANTS_REPO, 25000000010, 'infradev', {
        outcome: 'success',
        appliedSha: SHA,
        operations: OPERATIONS,
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
      })

      await expect(world.reconcile(committed(), context(world))).resolves.toBe(
        'deployed'
      )
      expect(world.events.events[0]).toMatchObject({
        status: 'deployed',
        appliedSha: SHA,
        resources: [
          { type: 'azapi_resource.foundry_project', name: 'aip-alpha' }
        ]
      })
    })

    test('a report with a failing outcome: publishes deploy-failed, attributable when the report says so', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        applyRun({ conclusion: 'failure' })
      ])
      world.github.seedReport(TENANTS_REPO, 25000000010, 'infradev', {
        outcome: 'failure',
        operations: OPERATIONS,
        failingTeams: ['alpha'],
        unattributedFailure: false
      })

      await expect(world.reconcile(committed(), context(world))).resolves.toBe(
        'deploy-failed'
      )
      expect(world.events.events[0]).toMatchObject({
        status: 'deploy-failed',
        failingTeams: ['alpha'],
        attributable: true,
        failureReason: { retryable: false }
      })
    })

    test('a report with the paused outcome: publishes the retryable paused refusal', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [applyRun()])
      world.github.seedReport(TENANTS_REPO, 25000000010, 'infradev', {
        outcome: 'paused',
        operations: OPERATIONS
      })

      await world.reconcile(committed(), context(world))

      expect(world.events.events[0].failureReason).toMatchObject({
        code: 'paused',
        retryable: true
      })
    })

    test.each([
      [
        'a superseded run',
        applyRun(),
        { outcome: 'superseded', operations: OPERATIONS }
      ],
      ['a run with no report', applyRun(), null],
      [
        'a report that does not name the operation',
        applyRun(),
        { outcome: 'success', operations: [] }
      ],
      ['a cancelled run', applyRun({ conclusion: 'cancelled' }), null]
    ])(
      '%s: dispatches a fresh apply and publishes nothing',
      async (_name, run, report) => {
        const world = createWorld()
        const command = committed()

        withCommit(world)
        world.github.seedRuns(TENANTS_REPO, 'apply.yml', [run])

        if (report) {
          world.github.seedReport(TENANTS_REPO, run.id, 'infradev', report)
        }

        await expect(world.reconcile(command, context(world))).resolves.toBe(
          'dispatched'
        )
        expect(world.events.events).toEqual([])
        expect(world.github.dispatches).toEqual([
          {
            repository: TENANTS_REPO,
            workflowId: 'apply.yml',
            inputs: applyInputs(command)
          }
        ])
      }
    )

    test('does not read the report of a cancelled run', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        applyRun({ conclusion: 'cancelled' })
      ])

      await world.reconcile(committed(), context(world))

      expect(
        world.github.calls.filter((call) => call.method === 'getRunReport')
      ).toEqual([])
    })

    test('no apply run at all: dispatches a fresh apply', async () => {
      const world = createWorld()
      const command = committed()

      withCommit(world)

      await world.reconcile(command, context(world))

      expect(world.github.dispatches).toHaveLength(1)
    })

    test('a fresh apply is dispatched once for a command: its run, already on GitHub, is found instead', async () => {
      const command = committed()
      const second = createWorld()

      withCommit(second)
      second.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        workflowRun({
          id: 99,
          name: `apply infradev ${applyInputs(command).reason}`,
          headSha: 'e'.repeat(40),
          status: 'queued',
          conclusion: null,
          createdAt: '2026-10-26T12:10:30Z'
        })
      ])
      second.github.seedAncestor(TENANTS_REPO, SHA, 'e'.repeat(40))

      await expect(second.reconcile(command, context(second))).resolves.toBe(
        'deploying'
      )
      expect(second.github.dispatches).toEqual([])
    })

    test('the newest run decides: a newer apply still running beats an older one that failed', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        applyRun({
          id: 1,
          conclusion: 'failure',
          createdAt: '2026-10-26T12:01:00Z'
        }),
        applyRun({
          id: 2,
          status: 'in_progress',
          conclusion: null,
          createdAt: '2026-10-26T12:09:00Z'
        })
      ])
      world.github.seedReport(TENANTS_REPO, 1, 'infradev', {
        outcome: 'failure',
        operations: OPERATIONS
      })

      await world.reconcile(committed(), context(world))

      expect(world.events.events[0]).toMatchObject({
        status: 'deploying',
        runId: 2
      })
    })

    test('walks back past a newer run whose report does not name the operation', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        applyRun({ id: 1, createdAt: '2026-10-26T12:01:00Z' }),
        applyRun({ id: 2, createdAt: '2026-10-26T12:09:00Z' })
      ])
      world.github.seedReport(TENANTS_REPO, 1, 'infradev', {
        outcome: 'success',
        appliedSha: SHA,
        operations: OPERATIONS
      })
      world.github.seedReport(TENANTS_REPO, 2, 'infradev', {
        outcome: 'success',
        operations: []
      })

      await world.reconcile(committed(), context(world))

      expect(world.events.events[0]).toMatchObject({
        status: 'deployed',
        runId: 1
      })
    })

    test('reads at most five reports', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(
        TENANTS_REPO,
        'apply.yml',
        Array.from({ length: 8 }, (_, index) =>
          applyRun({
            id: index + 1,
            createdAt: `2026-10-26T12:0${index + 1}:00Z`
          })
        )
      )

      await world.reconcile(committed(), context(world))

      expect(
        world.github.calls.filter((call) => call.method === 'getRunReport')
      ).toHaveLength(5)
    })

    test('no commit names the operation: dispatches a fresh apply, publishes nothing and warns', async () => {
      const world = createWorld()

      await expect(world.reconcile(committed(), context(world))).resolves.toBe(
        'dispatched-without-commit'
      )
      expect(world.events.events).toEqual([])
      expect(world.github.dispatches).toHaveLength(1)
      expect(world.logger.warn).toHaveBeenCalledTimes(1)
    })

    test('works without a logger', async () => {
      const world = createWorld()

      await expect(world.reconcile(committed(), {})).resolves.toBe(
        'dispatched-without-commit'
      )
      await expect(world.reconcile(requested(), {})).resolves.toBe('dispatched')
    })
  })

  describe('every other state', () => {
    test.each([
      'queued',
      'deployed',
      'verified',
      'active',
      'removed',
      'checks-failed',
      'deploy-failed',
      'timed-out'
    ])(
      '%s has nothing on GitHub to find: acknowledged, nothing sent',
      async (state) => {
        const world = createWorld()

        await expect(
          world.reconcile(
            exampleReconcile(state, { createdAt: '2026-10-26T12:10:00Z' }),
            context(world)
          )
        ).resolves.toBe('nothing-to-reconcile')
        expect(world.events.events).toEqual([])
        expect(world.github.calls).toEqual([])
      }
    )
  })

  describe('metrics, trace and safety', () => {
    test('counts each reconcile by state and outcome', async () => {
      const world = createWorld()

      await world.reconcile(requested(), context(world))

      expect(world.metrics.counter).toHaveBeenCalledWith('reconciles', 1, {
        state: 'requested',
        outcome: 'dispatched'
      })
    })

    test('AC13: every event carries the command traceparent and CDP request ID', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ status: 'queued', conclusion: null })
      ])

      await world.reconcile(requested(), context(world))

      expect(world.events.events[0]).toMatchObject({
        traceparent: TRACEPARENT,
        cdpRequestId: CDP_REQUEST_ID
      })
    })

    test('AC13: the dispatch from a reconcile carries them too', async () => {
      const world = createWorld()

      await world.reconcile(requested(), context(world))

      expect(world.github.dispatches[0].inputs).toMatchObject({
        trace_parent: TRACEPARENT,
        cdp_request_id: CDP_REQUEST_ID
      })
    })

    test('passes the signal to every GitHub call and to the publish', async () => {
      const world = createWorld()
      const signal = new AbortController().signal

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ status: 'queued', conclusion: null })
      ])

      await world.reconcile(requested(), { signal })

      expect(world.github.calls.every((call) => call.signal === signal)).toBe(
        true
      )
    })

    test('lets a failed publish through, so SQS redelivers the command', async () => {
      const world = createWorld()
      const error = new Error('SQS is down')

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ status: 'queued', conclusion: null })
      ])
      world.events.failNext(error)

      await expect(world.reconcile(requested(), {})).rejects.toBe(error)
    })
  })
})
