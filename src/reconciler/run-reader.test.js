import {
  OPERATION_ID,
  SHA,
  TENANTS_REPO
} from '../../test/fixtures/gitops-messages.js'
import {
  createInMemoryGitHubClient,
  workflowRun
} from '../../test/fakes/in-memory-github-client.js'
import { createRunReader } from '#/reconciler/run-reader.js'

const FROM = '2026-10-26T12:00:00Z'
const COMMIT = { sha: SHA, committedAt: '2026-10-26T12:00:24Z' }

function setup() {
  const github = createInMemoryGitHubClient()

  return { github, reader: createRunReader({ github }) }
}

describe('#run-reader', () => {
  describe('findSubmitRuns', () => {
    test('keeps the submit runs whose name carries the operation ID, newest first', async () => {
      const { github, reader } = setup()

      github.seedRuns(TENANTS_REPO, 'submit.yml', [
        workflowRun({ id: 1, createdAt: '2026-10-26T12:01:00Z' }),
        workflowRun({
          id: 2,
          name: 'submit write environments/infradev/beta.json (op-other-0001)',
          createdAt: '2026-10-26T12:02:00Z'
        }),
        workflowRun({
          id: 3,
          name: `submit write environments/infradev/alpha.json (${OPERATION_ID}-2)`,
          createdAt: '2026-10-26T12:03:00Z'
        }),
        workflowRun({ id: 4, createdAt: '2026-10-26T12:04:00Z' })
      ])

      const runs = await reader.findSubmitRuns({
        repository: TENANTS_REPO,
        operationId: OPERATION_ID,
        createdFrom: FROM
      })

      expect(runs.map((run) => run.id)).toEqual([4, 1])
    })

    test('asks for the submit workflow from the time, with the signal', async () => {
      const { github, reader } = setup()
      const signal = new AbortController().signal

      await reader.findSubmitRuns({
        repository: TENANTS_REPO,
        operationId: OPERATION_ID,
        createdFrom: FROM,
        signal
      })

      expect(github.calls).toEqual([
        {
          method: 'listWorkflowRuns',
          repository: TENANTS_REPO,
          workflowId: 'submit.yml',
          createdFrom: FROM,
          signal
        }
      ])
    })
  })

  describe('findDispatchedApply', () => {
    const COMMAND_ID = '0198a1b2-c3d4-7e5f-8a6b-000000000042'

    test('finds the apply run whose name carries the command ID', async () => {
      const { github, reader } = setup()

      github.seedRuns(TENANTS_REPO, 'apply.yml', [
        workflowRun({ id: 1, name: 'apply infradev portal other-command' }),
        workflowRun({
          id: 2,
          name: `apply infradev portal ${OPERATION_ID} ${COMMAND_ID}`
        })
      ])

      const run = await reader.findDispatchedApply({
        repository: TENANTS_REPO,
        commandId: COMMAND_ID,
        createdFrom: FROM
      })

      expect(run.id).toBe(2)
    })

    test('finds nothing when no apply carries it', async () => {
      const { reader } = setup()

      await expect(
        reader.findDispatchedApply({
          repository: TENANTS_REPO,
          commandId: COMMAND_ID,
          createdFrom: FROM
        })
      ).resolves.toBeUndefined()
    })
  })

  describe('findAppliesContaining', () => {
    test('keeps the runs whose head is the commit or a descendant, newest first', async () => {
      const { github, reader } = setup()
      const later = 'b'.repeat(40)
      const unrelated = 'c'.repeat(40)

      github.seedAncestor(TENANTS_REPO, SHA, later)
      github.seedRuns(TENANTS_REPO, 'apply.yml', [
        workflowRun({
          name: 'apply infradev',
          id: 1,
          headSha: SHA,
          createdAt: '2026-10-26T12:00:30Z'
        }),
        workflowRun({
          name: 'apply infradev',
          id: 2,
          headSha: unrelated,
          createdAt: '2026-10-26T12:10:00Z'
        }),
        workflowRun({
          name: 'apply infradev',
          id: 3,
          headSha: later,
          createdAt: '2026-10-26T12:20:00Z'
        }),
        workflowRun({
          name: 'apply infradev',
          id: 4,
          headSha: SHA,
          createdAt: '2026-10-26T11:00:00Z'
        })
      ])

      const runs = await reader.findAppliesContaining({
        repository: TENANTS_REPO,
        environment: 'infradev',
        commit: COMMIT
      })

      expect(runs.map((run) => run.id)).toEqual([3, 1])
    })

    test('does not ask GitHub about a run whose head is the commit itself', async () => {
      const { github, reader } = setup()

      github.seedRuns(TENANTS_REPO, 'apply.yml', [
        workflowRun({
          name: 'apply infradev',
          id: 1,
          headSha: SHA,
          createdAt: '2026-10-26T12:00:30Z'
        })
      ])

      await reader.findAppliesContaining({
        repository: TENANTS_REPO,
        environment: 'infradev',
        commit: COMMIT
      })

      expect(github.calls.map((call) => call.method)).toEqual([
        'listWorkflowRuns'
      ])
    })

    test('looks at no more than the ten newest runs', async () => {
      const { github, reader } = setup()

      github.seedRuns(
        TENANTS_REPO,
        'apply.yml',
        Array.from({ length: 15 }, (_, index) =>
          workflowRun({
            name: 'apply infradev',
            id: index + 1,
            headSha: SHA,
            createdAt: `2026-10-26T12:${String(index + 10).padStart(2, '0')}:00Z`
          })
        )
      )

      const runs = await reader.findAppliesContaining({
        repository: TENANTS_REPO,
        environment: 'infradev',
        commit: COMMIT
      })

      expect(runs).toHaveLength(10)
      expect(runs[0].id).toBe(15)
    })
  })
})
