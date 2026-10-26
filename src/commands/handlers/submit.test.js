import { Octokit } from 'octokit'

import {
  CDP_REQUEST_ID,
  OPERATION_ID,
  TENANTS_REPO,
  TRACEPARENT,
  exampleCommand
} from '../../../test/fixtures/gitops-messages.js'
import { createFakeGitHub } from '../../../test/fakes/fake-github-http.js'
import { createFakeMetrics } from '../../../test/fakes/fake-metrics.js'
import { workflowRun } from '../../../test/fakes/in-memory-github-client.js'
import { createWorld } from '../../../test/fakes/world.js'
import { createSubmitHandler } from '#/commands/handlers/submit.js'
import { RunLookupIncompleteError } from '#/github/github-client.js'
import { createOctokitGitHubClient } from '#/github/octokit-github-client.js'
import { createWorkflowDispatcher } from '#/github/workflow-dispatcher.js'
import { createRunReader } from '#/reconciler/run-reader.js'

const COMMAND = exampleCommand({ createdAt: '2026-10-26T12:00:00Z' })
const SUBMIT_RUN_NAME =
  'submit write environments/infradev/alpha.json (op-7f3c9a1e)'

describe('#submit handler', () => {
  describe('AC3: a duplicate command creates no second dispatch', () => {
    test('dispatches submit.yml once for a new command', async () => {
      const world = createWorld()

      await expect(
        world.submit(COMMAND, { logger: world.logger })
      ).resolves.toBe('dispatched')
      expect(world.github.dispatches).toHaveLength(1)
      expect(world.github.dispatches[0]).toMatchObject({
        repository: TENANTS_REPO,
        workflowId: 'submit.yml',
        inputs: { operation_id: OPERATION_ID, action: 'write' }
      })
    })

    test('a redelivered command finds the run it started and dispatches nothing', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        workflowRun({
          id: 77,
          name: SUBMIT_RUN_NAME,
          createdAt: '2026-10-26T12:00:03Z'
        })
      ])

      await expect(
        world.submit(COMMAND, { logger: world.logger })
      ).resolves.toBe('duplicate')
      expect(world.github.dispatches).toEqual([])
      expect(world.logger.info).toHaveBeenCalledWith(
        { runId: 77 },
        expect.stringContaining('already exists')
      )
    })

    test('a run of an earlier attempt does not count: a resubmission, with its own command ID, is delivered', async () => {
      const world = createWorld()
      const resubmission = exampleCommand({
        attempt: 2,
        createdAt: '2026-10-26T12:00:40Z'
      })

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        workflowRun({
          id: 77,
          name: SUBMIT_RUN_NAME,
          createdAt: '2026-10-26T12:00:03Z'
        })
      ])

      await expect(world.submit(resubmission, {})).resolves.toBe('dispatched')
      expect(world.github.dispatches).toHaveLength(1)
    })

    // The run-name carries the operation, not the command, so a run is told
    // from an earlier attempt's by time: a retry is created only after the
    // earlier run's failure, so a run that ended before the command was
    // created cannot be the command's, however close their creation times.
    describe('a retry inside the time window of the earlier attempt', () => {
      const EARLIER_RUN = {
        id: 77,
        name: SUBMIT_RUN_NAME,
        createdAt: '2026-10-26T12:00:05Z'
      }
      const retry = () =>
        exampleCommand({ attempt: 2, createdAt: '2026-10-26T12:00:09Z' })

      test('dispatches when the earlier run, created inside the window, had already failed', async () => {
        const world = createWorld()

        world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
          workflowRun({
            ...EARLIER_RUN,
            conclusion: 'failure',
            updatedAt: '2026-10-26T12:00:08Z'
          })
        ])

        await expect(world.submit(retry(), {})).resolves.toBe('dispatched')
        expect(world.github.dispatches).toHaveLength(1)
      })

      test('dispatches when the earlier run succeeded before the retry was created', async () => {
        const world = createWorld()

        world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
          workflowRun({ ...EARLIER_RUN, updatedAt: '2026-10-26T12:00:08Z' })
        ])

        await expect(world.submit(retry(), {})).resolves.toBe('dispatched')
      })

      test('a redelivery of the same command, its run still in progress, dispatches nothing', async () => {
        const world = createWorld()

        world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
          workflowRun({
            ...EARLIER_RUN,
            status: 'in_progress',
            conclusion: null,
            updatedAt: '2026-10-26T12:00:06Z'
          })
        ])

        await expect(world.submit(retry(), {})).resolves.toBe('duplicate')
        expect(world.github.dispatches).toEqual([])
      })

      test('a redelivery of the same command, its run completed after it was created, dispatches nothing', async () => {
        const world = createWorld()

        world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
          workflowRun({
            ...EARLIER_RUN,
            conclusion: 'failure',
            updatedAt: '2026-10-26T12:00:12Z'
          })
        ])

        await expect(world.submit(retry(), {})).resolves.toBe('duplicate')
        expect(world.github.dispatches).toEqual([])
      })

      test('a run that completed at the very time the command was created belongs to the command', async () => {
        const world = createWorld()

        world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
          workflowRun({ ...EARLIER_RUN, updatedAt: '2026-10-26T12:00:09Z' })
        ])

        await expect(world.submit(retry(), {})).resolves.toBe('duplicate')
      })

      test('finds the run of the command among earlier ones', async () => {
        const world = createWorld()

        world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
          workflowRun({
            ...EARLIER_RUN,
            conclusion: 'failure',
            updatedAt: '2026-10-26T12:00:08Z'
          }),
          workflowRun({
            id: 78,
            name: SUBMIT_RUN_NAME,
            createdAt: '2026-10-26T12:00:11Z',
            status: 'queued',
            conclusion: null
          })
        ])

        await expect(
          world.submit(retry(), { logger: world.logger })
        ).resolves.toBe('duplicate')
        expect(world.logger.info).toHaveBeenCalledWith(
          { runId: 78 },
          expect.stringContaining('already exists')
        )
      })
    })

    test('a run for another operation does not count', async () => {
      const world = createWorld()

      world.github.seedRuns(TENANTS_REPO, 'submit.yml', [
        workflowRun({
          id: 9,
          name: 'submit write environments/infradev/beta.json (op-other-0001)',
          createdAt: '2026-10-26T12:00:03Z'
        })
      ])

      await expect(world.submit(COMMAND, {})).resolves.toBe('dispatched')
    })

    test('lets a GitHub failure through, so SQS redelivers the command', async () => {
      const world = createWorld()
      const error = new Error('GitHub is down')

      world.github.failNext('dispatchWorkflow', error)

      await expect(world.submit(COMMAND, {})).rejects.toBe(error)
    })

    // GitHub lists a workflow's runs a page of 100 at a time, newest first,
    // and the worker reads three pages. A command whose run lies behind 300
    // newer runs must not be taken for a new one.
    test('a redelivered command whose run is on page four dispatches nothing: an incomplete search is not absence', async () => {
      const dispatches = []
      const pages = []
      const run = (id, name) => ({
        id,
        name,
        display_title: name,
        status: 'completed',
        conclusion: 'success',
        event: 'workflow_dispatch',
        head_sha: 'a'.repeat(40),
        run_attempt: 1,
        created_at: '2026-10-26T12:00:05Z',
        html_url: `https://github.com/${TENANTS_REPO}/actions/runs/${id}`
      })
      const others = Array.from({ length: 300 }, (_, index) =>
        run(
          index + 1,
          `submit write environments/infradev/other-${index}.json (op-other-${index})`
        )
      )
      const existing = run(9999, SUBMIT_RUN_NAME)
      const history = [...others, existing]
      const { fetch } = createFakeGitHub({
        'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs': ({
          query
        }) => {
          const page = Number(query.get('page'))

          pages.push(page)

          return {
            body: {
              workflow_runs: history.slice((page - 1) * 100, page * 100)
            }
          }
        },
        'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches':
          ({ body }) => {
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
      const runReader = createRunReader({ github })
      const dispatcher = createWorkflowDispatcher({
        github,
        runReader,
        metrics: createFakeMetrics()
      })
      const submit = createSubmitHandler({ runReader, dispatcher })

      await expect(submit(COMMAND, {})).rejects.toBeInstanceOf(
        RunLookupIncompleteError
      )
      expect(pages).toEqual([1, 2, 3])
      expect(dispatches).toEqual([])
    })
  })

  describe('AC13: the trace travels to the workflow', () => {
    test('passes the traceparent and the CDP request ID as inputs', async () => {
      const world = createWorld()

      await world.submit(COMMAND, {})

      expect(world.github.dispatches[0].inputs).toMatchObject({
        trace_parent: TRACEPARENT,
        cdp_request_id: CDP_REQUEST_ID
      })
    })

    test('passes the handler signal to every GitHub call', async () => {
      const world = createWorld()
      const signal = new AbortController().signal

      await world.submit(COMMAND, { signal })

      expect(world.github.calls.map((call) => call.signal)).toEqual([
        signal,
        signal
      ])
    })
  })
})
