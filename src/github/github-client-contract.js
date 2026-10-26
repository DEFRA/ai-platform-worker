import {
  mainCommit,
  workflowRun
} from '../../test/fakes/in-memory-github-client.js'

const REPO = 'DEFRA/ai-platform-tenants'
const OTHER_REPO = 'DEFRA/ai-platform-deployments'
const PATH = 'environments/infradev/alpha.json'

// The contract every `GitHubClient` must meet, run against the in-memory fake
// and the Octokit adapter. A harness gives the client and a way to seed what
// GitHub would hold and to read what was dispatched:
// `{client, seedRuns, seedCommits, seedReport, seedAncestor, dispatches}`.
// Not application code: it is exercised through the adapters' test files.

/**
 * @param {string} name
 * @param {() => object} createHarness
 */
export function describeGitHubClientContract(name, createHarness) {
  describe(`GitHubClient contract: ${name}`, () => {
    let harness

    beforeEach(() => {
      harness = createHarness()
    })

    describe('dispatchWorkflow', () => {
      test('dispatches the workflow with its inputs and returns the run it created', async () => {
        const inputs = { environment: 'infradev', operation_id: 'op-7f3c9a1e' }

        const run = await harness.client.dispatchWorkflow({
          repository: REPO,
          workflowId: 'submit.yml',
          inputs
        })

        expect(run.runId).toEqual(expect.any(Number))
        expect(run.runUrl).toBe(
          `https://github.com/${REPO}/actions/runs/${run.runId}`
        )
        expect(harness.dispatches()).toEqual([
          { repository: REPO, workflowId: 'submit.yml', inputs }
        ])
      })

      test('stops when the signal has aborted, dispatching nothing', async () => {
        await expect(
          harness.client.dispatchWorkflow({
            repository: REPO,
            workflowId: 'submit.yml',
            inputs: {},
            signal: AbortSignal.abort(new Error('deadline'))
          })
        ).rejects.toThrow('deadline')
        expect(harness.dispatches()).toEqual([])
      })
    })

    describe('listWorkflowRuns', () => {
      test('lists the runs created from the time, newest first', async () => {
        harness.seedRuns(REPO, 'submit.yml', [
          workflowRun({ id: 1, createdAt: '2026-10-26T11:00:00Z' }),
          workflowRun({ id: 2, createdAt: '2026-10-26T12:00:00Z' }),
          workflowRun({
            id: 3,
            createdAt: '2026-10-26T12:30:00Z',
            status: 'in_progress',
            conclusion: null,
            runAttempt: 2
          })
        ])

        const runs = await harness.client.listWorkflowRuns({
          repository: REPO,
          workflowId: 'submit.yml',
          createdFrom: '2026-10-26T12:00:00Z'
        })

        expect(runs.map((run) => run.id)).toEqual([3, 2])
        expect(runs[0]).toEqual(
          workflowRun({
            id: 3,
            createdAt: '2026-10-26T12:30:00Z',
            status: 'in_progress',
            conclusion: null,
            runAttempt: 2
          })
        )
      })

      test('lists nothing for a workflow with no runs, or another repository', async () => {
        harness.seedRuns(OTHER_REPO, 'submit.yml', [workflowRun({ id: 1 })])

        await expect(
          harness.client.listWorkflowRuns({
            repository: REPO,
            workflowId: 'submit.yml',
            createdFrom: '2026-10-26T00:00:00Z'
          })
        ).resolves.toEqual([])
      })
    })

    describe('getRunReport', () => {
      test('returns the parsed run report of the run', async () => {
        const report = { outcome: 'success', operations: [] }

        harness.seedReport(REPO, 42, 'infradev', report)

        await expect(
          harness.client.getRunReport({
            repository: REPO,
            runId: 42,
            environment: 'infradev'
          })
        ).resolves.toEqual(report)
      })

      test('returns null when the run has no report', async () => {
        await expect(
          harness.client.getRunReport({
            repository: REPO,
            runId: 43,
            environment: 'infradev'
          })
        ).resolves.toBeNull()
      })

      test('returns null when the report has expired', async () => {
        harness.seedReport(REPO, 44, 'infradev', null)

        await expect(
          harness.client.getRunReport({
            repository: REPO,
            runId: 44,
            environment: 'infradev'
          })
        ).resolves.toBeNull()
      })
    })

    describe('listCommits', () => {
      test('lists the commits on main for the path since the time, newest first', async () => {
        harness.seedCommits(REPO, [
          mainCommit({
            path: PATH,
            sha: 'a'.repeat(40),
            committedAt: '2026-10-26T12:05:00Z'
          }),
          mainCommit({
            path: PATH,
            sha: 'b'.repeat(40),
            committedAt: '2026-10-26T12:20:00Z'
          }),
          mainCommit({
            path: PATH,
            sha: 'c'.repeat(40),
            committedAt: '2026-10-26T10:00:00Z'
          }),
          mainCommit({
            path: 'environments/infradev/beta.json',
            sha: 'd'.repeat(40)
          })
        ])

        const commits = await harness.client.listCommits({
          repository: REPO,
          path: PATH,
          since: '2026-10-26T12:00:00Z'
        })

        expect(commits.map((commit) => commit.sha)).toEqual([
          'b'.repeat(40),
          'a'.repeat(40)
        ])
        expect(commits[0]).toEqual({
          sha: 'b'.repeat(40),
          message: expect.stringContaining('Operation-Id: op-7f3c9a1e'),
          committedAt: '2026-10-26T12:20:00Z'
        })
      })
    })

    describe('listRunJobNames', () => {
      test('lists the names of the jobs of a run', async () => {
        harness.seedJobs(REPO, 42, [
          'apply / infradev',
          'apply / pause infradev'
        ])

        await expect(
          harness.client.listRunJobNames({ repository: REPO, runId: 42 })
        ).resolves.toEqual(['apply / infradev', 'apply / pause infradev'])
      })

      test('lists nothing for a run with no jobs', async () => {
        await expect(
          harness.client.listRunJobNames({ repository: REPO, runId: 43 })
        ).resolves.toEqual([])
      })
    })

    describe('isAncestor', () => {
      test('is true for the same commit and for a descendant', async () => {
        harness.seedAncestor(REPO, 'a'.repeat(40), 'b'.repeat(40))

        await expect(
          harness.client.isAncestor({
            repository: REPO,
            ancestor: 'a'.repeat(40),
            descendant: 'a'.repeat(40)
          })
        ).resolves.toBe(true)
        await expect(
          harness.client.isAncestor({
            repository: REPO,
            ancestor: 'a'.repeat(40),
            descendant: 'b'.repeat(40)
          })
        ).resolves.toBe(true)
      })

      test('is false for a commit that is not an ancestor', async () => {
        await expect(
          harness.client.isAncestor({
            repository: REPO,
            ancestor: 'c'.repeat(40),
            descendant: 'b'.repeat(40)
          })
        ).resolves.toBe(false)
      })
    })
  })
}
