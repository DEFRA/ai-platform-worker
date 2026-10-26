import {
  DEPLOYMENTS_REPO,
  OPERATION_ID,
  PIN_PATH,
  TENANTS_REPO,
  TRACEPARENT,
  CDP_REQUEST_ID,
  exampleApply,
  exampleCommand,
  exampleReconcile
} from '../../test/fixtures/gitops-messages.js'
import {
  createInMemoryGitHubClient,
  workflowRun
} from '../../test/fakes/in-memory-github-client.js'
import { createFakeMetrics } from '../../test/fakes/fake-metrics.js'
import { createRunReader } from '#/reconciler/run-reader.js'
import {
  applyInputs,
  createWorkflowDispatcher,
  createdFromOf,
  submitInputs
} from '#/github/workflow-dispatcher.js'

describe('#workflow-dispatcher', () => {
  describe('submitInputs', () => {
    test('maps a team file write to the submit.yml inputs, with its revision and no base', () => {
      const command = exampleCommand()

      expect(submitInputs(command)).toEqual({
        action: 'write',
        environment: 'infradev',
        path: 'environments/infradev/alpha.json',
        document: command.document,
        operation_id: OPERATION_ID,
        expected_revision: '3',
        expected_base: '',
        requested_by: command.requestedBy,
        trace_parent: TRACEPARENT,
        cdp_request_id: CDP_REQUEST_ID
      })
    })

    test('maps a removal with an empty document', () => {
      expect(
        submitInputs(exampleCommand({ action: 'remove', document: '' }))
      ).toMatchObject({ action: 'remove', document: '' })
      expect(
        submitInputs(exampleCommand({ action: 'remove', document: undefined }))
          .document
      ).toBe('')
    })

    test('maps a revision of a new team file to 0', () => {
      expect(
        submitInputs(exampleCommand({ expectedRevision: undefined }))
          .expected_revision
      ).toBe('0')
    })

    test.each(['platform', 'tenants'])(
      'maps a pin (team %s) to its base and no revision',
      (team) => {
        const base = 'f'.repeat(40)
        const inputs = submitInputs(
          exampleCommand({
            team,
            repository: DEPLOYMENTS_REPO,
            path: PIN_PATH,
            expectedRevision: undefined,
            expectedBase: base
          })
        )

        expect(inputs).toMatchObject({
          expected_base: base,
          expected_revision: '0'
        })
      }
    )

    test('maps the first pin, which has no blob, to the 0 the workflow requires', () => {
      expect(
        submitInputs(
          exampleCommand({
            team: 'platform',
            path: PIN_PATH,
            expectedRevision: undefined,
            expectedBase: null
          })
        ).expected_base
      ).toBe('0')
    })

    test('maps a missing traceparent and CDP request ID to empty inputs', () => {
      expect(
        submitInputs(exampleCommand({ traceparent: null, cdpRequestId: null }))
      ).toMatchObject({ trace_parent: '', cdp_request_id: '' })
    })

    test('carries a reconcile from requested the same way as a submit', () => {
      expect(submitInputs(exampleReconcile('requested'))).toMatchObject({
        action: 'write',
        expected_revision: '3',
        operation_id: OPERATION_ID
      })
    })
  })

  describe('applyInputs', () => {
    test('names the environment and the command in the reason', () => {
      expect(
        applyInputs({
          environment: 'infradev',
          operationId: OPERATION_ID,
          commandId: 'cmd-1'
        })
      ).toEqual({
        environment: 'infradev',
        reason: `portal ${OPERATION_ID} cmd-1`
      })
    })

    test('names an apply that is for no operation', () => {
      expect(
        applyInputs({
          environment: 'infradev',
          operationId: null,
          commandId: 'cmd-2'
        }).reason
      ).toBe('portal no-operation cmd-2')
    })
  })

  describe('createdFromOf', () => {
    test('is the command time less five seconds for clock difference', () => {
      expect(createdFromOf({ createdAt: '2026-10-26T12:00:10Z' })).toBe(
        '2026-10-26T12:00:05.000Z'
      )
    })
  })

  describe('dispatcher', () => {
    function setup() {
      const github = createInMemoryGitHubClient()
      const metrics = createFakeMetrics()
      let clock = 1000
      const dispatcher = createWorkflowDispatcher({
        github,
        runReader: createRunReader({ github }),
        metrics,
        now: () => {
          clock += 40

          return clock
        }
      })

      return { github, metrics, dispatcher }
    }

    test('dispatches submit.yml on the command repository and times it', async () => {
      const { github, metrics, dispatcher } = setup()
      const command = exampleCommand()
      const signal = new AbortController().signal

      const run = await dispatcher.dispatchSubmit(command, { signal })

      expect(run.runId).toBe(9001)
      expect(github.dispatches).toEqual([
        {
          repository: TENANTS_REPO,
          workflowId: 'submit.yml',
          inputs: submitInputs(command)
        }
      ])
      expect(github.calls[0].signal).toBe(signal)
      expect(metrics.millis).toHaveBeenCalledWith('dispatchDuration', 40, {
        workflow: 'submit.yml'
      })
    })

    test('times a dispatch that fails, and lets the failure through', async () => {
      const { github, metrics, dispatcher } = setup()
      const error = new Error('GitHub is down')

      github.failNext('dispatchWorkflow', error)

      await expect(dispatcher.dispatchSubmit(exampleCommand())).rejects.toBe(
        error
      )
      expect(metrics.millis).toHaveBeenCalledTimes(1)
    })

    test('dispatches apply.yml once for a command', async () => {
      const { github, dispatcher } = setup()
      const command = exampleApply()

      await expect(dispatcher.dispatchApply(command)).resolves.toEqual({
        dispatched: true
      })
      expect(github.dispatches).toEqual([
        {
          repository: TENANTS_REPO,
          workflowId: 'apply.yml',
          inputs: applyInputs(command)
        }
      ])
    })

    test('dispatches nothing when the run for the command is already there', async () => {
      const { github, dispatcher } = setup()
      const command = exampleApply()

      github.seedRuns(TENANTS_REPO, 'apply.yml', [
        workflowRun({
          id: 5,
          name: `apply infradev ${applyInputs(command).reason}`,
          createdAt: '2026-10-26T14:00:01Z'
        })
      ])

      await expect(dispatcher.dispatchApply(command)).resolves.toEqual({
        dispatched: false
      })
      expect(github.dispatches).toEqual([])
    })

    test('looks for an existing apply run only from the command time', async () => {
      const { github, dispatcher } = setup()
      const command = exampleApply()

      github.seedRuns(TENANTS_REPO, 'apply.yml', [
        workflowRun({
          id: 5,
          name: `apply infradev ${applyInputs(command).reason}`,
          createdAt: '2026-10-26T13:00:00Z'
        })
      ])

      await expect(dispatcher.dispatchApply(command)).resolves.toEqual({
        dispatched: true
      })
    })
  })
})
