import {
  CDP_REQUEST_ID,
  OPERATION_ID,
  TENANTS_REPO,
  TRACEPARENT,
  exampleCommand
} from '../../../test/fixtures/gitops-messages.js'
import { workflowRun } from '../../../test/fakes/in-memory-github-client.js'
import { createWorld } from '../../../test/fakes/world.js'

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
