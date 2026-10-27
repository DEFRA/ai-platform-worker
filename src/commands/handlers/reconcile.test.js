import { Octokit } from 'octokit'

import {
  CDP_REQUEST_ID,
  OPERATION_ID,
  SHA,
  TEAM_PATH,
  TENANTS_REPO,
  TRACEPARENT,
  exampleReconcile
} from '../../../test/fixtures/gitops-messages.js'
import { createFakeGitHub } from '../../../test/fakes/fake-github-http.js'
import { createFakeMetrics } from '../../../test/fakes/fake-metrics.js'
import { createInMemoryEventsPublisher } from '../../../test/fakes/in-memory-events-publisher.js'
import {
  mainCommit,
  workflowRun
} from '../../../test/fakes/in-memory-github-client.js'
import { createWorld } from '../../../test/fakes/world.js'
import { createReconcileHandler } from '#/commands/handlers/reconcile.js'
import { CommitLookupIncompleteError } from '#/github/github-client.js'
import { createOctokitGitHubClient } from '#/github/octokit-github-client.js'
import {
  applyInputs,
  createWorkflowDispatcher
} from '#/github/workflow-dispatcher.js'
import { createCommitFinder } from '#/reconciler/commit-finder.js'
import { createRunReader } from '#/reconciler/run-reader.js'

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

    test('R2-F7: a commit with no submit run to name dispatches submit again, which reports the existing commit with a run', async () => {
      const world = createWorld()

      withCommit(world)

      await expect(world.reconcile(requested(), context(world))).resolves.toBe(
        'dispatched'
      )
      expect(world.events.events).toEqual([])
      expect(world.github.dispatches).toHaveLength(1)
      expect(world.github.dispatches[0]).toMatchObject({
        workflowId: 'submit.yml',
        inputs: { operation_id: OPERATION_ID }
      })
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

    describe('submittedAt: the time the operation was last submitted', () => {
      const SUBMITTED_AT = '2026-10-26T12:08:00Z'
      const handledRefusal = {
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

      function seedRefusedRun(world, runTimes) {
        world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
          submitRun({ conclusion: 'failure', ...runTimes })
        ])
        world.github.seedReport(
          TENANTS_REPO,
          25000000001,
          'infradev',
          handledRefusal
        )
      }

      test('a resubmission that never reached GitHub after a handled retryable refusal: dispatches submit again and publishes nothing stale', async () => {
        const world = createWorld()
        const command = { ...requested(), submittedAt: SUBMITTED_AT }

        seedRefusedRun(world, {
          createdAt: '2026-10-26T12:00:05Z',
          updatedAt: '2026-10-26T12:00:40Z'
        })

        await expect(world.reconcile(command, context(world))).resolves.toBe(
          'dispatched'
        )
        expect(world.events.events).toEqual([])
        expect(world.github.dispatches).toHaveLength(1)
        expect(world.github.dispatches[0]).toMatchObject({
          workflowId: 'submit.yml',
          inputs: { operation_id: OPERATION_ID }
        })
      })

      test('a refusal from a run that finished after submittedAt is still reported', async () => {
        const world = createWorld()
        const command = { ...requested(), submittedAt: SUBMITTED_AT }

        seedRefusedRun(world, {
          createdAt: '2026-10-26T12:08:10Z',
          updatedAt: '2026-10-26T12:08:50Z'
        })

        await expect(world.reconcile(command, context(world))).resolves.toBe(
          'checks-failed'
        )
        expect(world.events.events[0].failureReason.code).toBe('stale-revision')
        expect(world.github.dispatches).toEqual([])
      })

      test('a run that finished exactly at submittedAt can be the resubmission’s: the comparison allows no slack either way', async () => {
        const world = createWorld()
        const command = { ...requested(), submittedAt: SUBMITTED_AT }

        seedRefusedRun(world, {
          createdAt: '2026-10-26T12:07:00Z',
          updatedAt: SUBMITTED_AT
        })

        await expect(world.reconcile(command, context(world))).resolves.toBe(
          'checks-failed'
        )
      })

      test('a run still going is reported whenever it began', async () => {
        const world = createWorld()
        const command = { ...requested(), submittedAt: SUBMITTED_AT }

        world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
          submitRun({
            status: 'in_progress',
            conclusion: null,
            createdAt: '2026-10-26T12:00:05Z',
            updatedAt: '2026-10-26T12:00:05Z'
          })
        ])

        await expect(world.reconcile(command, context(world))).resolves.toBe(
          'requested'
        )
      })

      test('without submittedAt an earlier refusal is reported as before', async () => {
        const world = createWorld()

        seedRefusedRun(world, {
          createdAt: '2026-10-26T12:00:05Z',
          updatedAt: '2026-10-26T12:00:40Z'
        })

        await expect(
          world.reconcile(requested(), context(world))
        ).resolves.toBe('checks-failed')
        expect(world.github.dispatches).toEqual([])
      })
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

    test('a rerun does not republish the failure an earlier attempt recorded: the report is of attempt 1, the run is attempt 2', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ conclusion: 'failure', runAttempt: 2 })
      ])
      world.github.seedReport(TENANTS_REPO, 25000000001, 'infradev', {
        events: [
          {
            operationId: OPERATION_ID,
            status: 'checks-failed',
            runAttempt: 1,
            failureReason: {
              code: 'stale-revision',
              message: 'The file moved.',
              retryable: true
            }
          }
        ]
      })

      await world.reconcile(requested(), context(world))

      expect(world.events.events).toHaveLength(1)
      expect(world.events.events[0]).toMatchObject({
        status: 'checks-failed',
        runAttempt: 2,
        eventId: `${OPERATION_ID}:checks-failed:25000000001:2`,
        failureReason: { code: 'submit-failed', retryable: false }
      })
      expect(world.github.calls).toContainEqual(
        expect.objectContaining({ method: 'getRunReport', runAttempt: 2 })
      )
    })

    test('a rerun that succeeded does not publish the failure an earlier attempt recorded', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        submitRun({ runAttempt: 2 })
      ])
      world.github.seedReport(TENANTS_REPO, 25000000001, 'infradev', {
        events: [
          {
            operationId: OPERATION_ID,
            status: 'checks-failed',
            runAttempt: 1,
            failureReason: {
              code: 'paused',
              message: 'The environment is paused.',
              retryable: true
            }
          }
        ]
      })

      await expect(world.reconcile(requested(), context(world))).resolves.toBe(
        'dispatched'
      )
      expect(world.events.events).toEqual([])
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

    test('a rerun of an apply does not republish the failure an earlier attempt reported', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        applyRun({ conclusion: 'failure', runAttempt: 2 })
      ])
      world.github.seedReport(TENANTS_REPO, 25000000010, 'infradev', {
        outcome: 'failure',
        operations: OPERATIONS,
        events: [{ status: 'deploy-failed', runAttempt: 1 }]
      })

      await expect(world.reconcile(committed(), context(world))).resolves.toBe(
        'dispatched'
      )
      expect(world.events.events).toEqual([])
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

  describe('R2-F2: an apply run of another environment is not this operation’s apply', () => {
    const OTHER_ENV_RUN = applyRun({
      id: 2002,
      name: 'apply prod portal op-other-0001 0190-other',
      status: 'in_progress',
      conclusion: null,
      headSha: 'b'.repeat(40),
      createdAt: '2026-10-26T12:10:00Z'
    })
    const PUSH_RUN = applyRun({
      id: 2001,
      name: 'apply changed environments ',
      createdAt: '2026-10-26T12:01:00Z'
    })

    function seedProbe(world) {
      withCommit(world)
      world.github.seedAncestor(TENANTS_REPO, SHA, 'b'.repeat(40))
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        OTHER_ENV_RUN,
        PUSH_RUN
      ])
      world.github.seedJobs(TENANTS_REPO, 2001, ['apply / infradev'])
      world.github.seedReport(TENANTS_REPO, 2001, 'infradev', {
        outcome: 'success',
        appliedSha: SHA,
        operations: OPERATIONS
      })
    }

    test('a running apply for prod does not hide the infradev run that deployed the operation (the reviewer’s probe)', async () => {
      const world = createWorld()

      seedProbe(world)

      await expect(world.reconcile(committed(), context(world))).resolves.toBe(
        'deployed'
      )
      expect(world.events.events[0]).toMatchObject({
        status: 'deployed',
        runId: 2001,
        environment: 'infradev'
      })
    })

    test('an apply for another environment is never reported as deploying, and a fresh apply is dispatched', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedAncestor(TENANTS_REPO, SHA, 'b'.repeat(40))
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [OTHER_ENV_RUN])

      await expect(world.reconcile(committed(), context(world))).resolves.toBe(
        'dispatched'
      )
      expect(world.events.events).toEqual([])
    })

    test('a push apply that is running and has a job for the environment is this operation’s deploying', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        applyRun({
          id: 2003,
          name: 'apply changed environments ',
          status: 'in_progress',
          conclusion: null
        })
      ])
      world.github.seedJobs(TENANTS_REPO, 2003, [
        'apply / access',
        'apply / infradev'
      ])

      await world.reconcile(committed(), context(world))

      expect(world.events.events[0]).toMatchObject({
        status: 'deploying',
        runId: 2003
      })
    })

    test('a push apply with jobs for other environments only is not this operation’s', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        applyRun({
          id: 2004,
          name: 'apply changed environments ',
          status: 'in_progress',
          conclusion: null
        })
      ])
      world.github.seedJobs(TENANTS_REPO, 2004, ['apply / prod'])

      await expect(world.reconcile(committed(), context(world))).resolves.toBe(
        'dispatched'
      )
      expect(world.events.events).toEqual([])
    })

    test('a dispatched apply for the environment needs no job lookup', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        applyRun({
          name: 'apply infradev portal op-x cmd-1',
          status: 'queued',
          conclusion: null
        })
      ])

      await world.reconcile(committed(), context(world))

      expect(
        world.github.calls.filter((call) => call.method === 'listRunJobNames')
      ).toEqual([])
      expect(world.events.events[0].status).toBe('deploying')
    })

    test('an environment name that only starts like another is not a match (prod versus prod2)', async () => {
      const world = createWorld()

      withCommit(world)
      world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
        applyRun({
          name: 'apply infradev2 portal op-x cmd-1',
          status: 'queued',
          conclusion: null
        })
      ])

      await expect(world.reconcile(committed(), context(world))).resolves.toBe(
        'dispatched'
      )
    })
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

  describe('the commit lookup reads past a busy path, through the real Octokit client', () => {
    const COMMITS_ROUTE = 'GET /repos/{owner}/{repo}/commits'
    const RUNS_ROUTE =
      'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs'
    const DISPATCH_ROUTE =
      'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches'

    function newerChanges(count) {
      return Array.from({ length: count }, (_, index) => ({
        sha: String(index + 1).padStart(40, '0'),
        commit: {
          message: 'chore: another change',
          committer: { date: '2026-10-26T12:05:00Z' }
        }
      }))
    }

    const operationCommit = {
      sha: SHA,
      commit: {
        message: `Change alpha\n\nOperation-Id: ${OPERATION_ID}`,
        committer: { date: COMMIT_TIME }
      }
    }

    // GitHub as the reconcile reads it: one succeeded submit run, the
    // path's history in pages of 100, and a record of what was dispatched.
    function reconcilerOver(history) {
      const pages = []
      const dispatches = []
      const { fetch } = createFakeGitHub({
        [RUNS_ROUTE]: () => ({
          body: {
            workflow_runs: [
              {
                id: 25000000001,
                name: SUBMIT_RUN_NAME,
                display_title: SUBMIT_RUN_NAME,
                status: 'completed',
                conclusion: 'success',
                event: 'workflow_dispatch',
                head_sha: SHA,
                run_attempt: 1,
                created_at: '2026-10-26T12:00:05Z',
                updated_at: '2026-10-26T12:00:20Z',
                html_url: `https://github.com/${TENANTS_REPO}/actions/runs/25000000001`
              }
            ]
          }
        }),
        [COMMITS_ROUTE]: ({ query }) => {
          const page = Number(query.get('page'))

          pages.push(page)

          return { body: history.slice((page - 1) * 100, page * 100) }
        },
        [DISPATCH_ROUTE]: ({ body }) => {
          dispatches.push(body)

          return { body: { workflow_run_id: 1, html_url: 'https://x/1' } }
        }
      })
      const octokit = new Octokit({
        request: { fetch, retries: 0 },
        throttle: { enabled: false }
      })
      const github = createOctokitGitHubClient({
        clientFor: () => octokit,
        retryOptions: { sleep: async () => {}, random: () => 0 }
      })
      const events = createInMemoryEventsPublisher()
      const runReader = createRunReader({ github })
      const reconcile = createReconcileHandler({
        github,
        runReader,
        commitFinder: createCommitFinder({ github }),
        dispatcher: createWorkflowDispatcher({
          github,
          runReader,
          metrics: createFakeMetrics()
        }),
        events,
        metrics: createFakeMetrics(),
        now: () => Date.parse('2026-10-26T12:15:00Z')
      })

      return { reconcile, pages, dispatches, events }
    }

    test('recovers the operation commit that lies behind 100 newer changes to the path, and dispatches nothing', async () => {
      const { reconcile, pages, dispatches, events } = reconcilerOver([
        ...newerChanges(100),
        operationCommit
      ])

      await expect(reconcile(requested(), {})).resolves.toBe('committed')
      expect(pages).toEqual([1, 2])
      expect(dispatches).toEqual([])
      expect(events.events[0]).toMatchObject({ status: 'committed' })
    })

    test('fails closed when the history fills the page budget, and dispatches nothing', async () => {
      const { reconcile, pages, dispatches, events } = reconcilerOver([
        ...newerChanges(300),
        operationCommit
      ])

      await expect(reconcile(requested(), {})).rejects.toBeInstanceOf(
        CommitLookupIncompleteError
      )
      expect(pages).toEqual([1, 2, 3])
      expect(dispatches).toEqual([])
      expect(events.events).toEqual([])
    })
  })
})
