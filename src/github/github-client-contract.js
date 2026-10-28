import {
  mainCommit,
  workflowRun
} from '../../test/fakes/in-memory-github-client.js'

const REPO = 'DEFRA/ai-platform-tenants'
const OTHER_REPO = 'DEFRA/ai-platform-deployments'
const PATH = 'environments/infradev/alpha.json'
const WORKFLOW = 'submit.yml'
const ENVIRONMENT = 'infradev'
const CHECKS_FAILED = 'checks-failed'
const NOON = '2026-10-26T12:00:00Z'
const SHA_LENGTH = 40

const RUN_ID = 42
const RUN_ID_WITHOUT_JOBS = 43
const RUN_ID_WITHOUT_REPORT = 43
const RUN_ID_EXPIRED_REPORT = 44
const RUN_ID_OF_ATTEMPT = 45
const RUN_ID_EARLIER_ATTEMPT = 46
const RUN_ID_MIXED_ATTEMPTS = 47
const RUN_ID_UNNAMED_ATTEMPT_RERUN = 48
const RUN_ID_UNNAMED_ATTEMPT_FIRST = 49

const FIRST_ATTEMPT = 1
const RERUN_ATTEMPT = 2
const THIRD_RUN_ID = 3

/**
 * @param {string} character
 * @returns {string} a commit SHA made of the one character
 */
function sha(character) {
  return character.repeat(SHA_LENGTH)
}

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
    const context = {}

    beforeEach(() => {
      context.harness = createHarness()
    })

    describeDispatchWorkflow(context)
    describeListWorkflowRuns(context)
    describeGetRunReport(context)
    describeGetRunReportAttempts(context)
    describeListCommits(context)
    describeListRunJobNames(context)
    describeIsAncestor(context)
  })
}

/**
 * @param {{harness: object}} context
 * @param {number} runId
 * @param {number} runAttempt
 * @returns {Promise<object|null>} the report the client reads for the run
 */
function readReport({ harness }, runId, runAttempt) {
  return harness.client.getRunReport({
    repository: REPO,
    runId,
    runAttempt,
    environment: ENVIRONMENT
  })
}

function describeDispatchWorkflow(context) {
  describe('dispatchWorkflow', () => {
    test('dispatches the workflow with its inputs and returns the run it created', async () => {
      const { harness } = context
      const inputs = { environment: ENVIRONMENT, operation_id: 'op-7f3c9a1e' }

      const run = await harness.client.dispatchWorkflow({
        repository: REPO,
        workflowId: WORKFLOW,
        inputs
      })

      expect(run.runId).toEqual(expect.any(Number))
      expect(run.runUrl).toBe(
        `https://github.com/${REPO}/actions/runs/${run.runId}`
      )
      expect(harness.dispatches()).toEqual([
        { repository: REPO, workflowId: WORKFLOW, inputs }
      ])
    })

    test('stops when the signal has aborted, dispatching nothing', async () => {
      const { harness } = context

      await expect(
        harness.client.dispatchWorkflow({
          repository: REPO,
          workflowId: WORKFLOW,
          inputs: {},
          signal: AbortSignal.abort(new Error('deadline'))
        })
      ).rejects.toThrow('deadline')
      expect(harness.dispatches()).toEqual([])
    })
  })
}

function describeListWorkflowRuns(context) {
  describe('listWorkflowRuns', () => {
    const inProgressRun = () =>
      workflowRun({
        id: THIRD_RUN_ID,
        createdAt: '2026-10-26T12:30:00Z',
        status: 'in_progress',
        conclusion: null,
        runAttempt: RERUN_ATTEMPT
      })

    test('lists the runs created from the time, newest first', async () => {
      const { harness } = context

      harness.seedRuns(REPO, WORKFLOW, [
        workflowRun({ id: 1, createdAt: '2026-10-26T11:00:00Z' }),
        workflowRun({ id: 2, createdAt: NOON }),
        inProgressRun()
      ])

      const runs = await harness.client.listWorkflowRuns({
        repository: REPO,
        workflowId: WORKFLOW,
        createdFrom: NOON
      })

      expect(runs.map((run) => run.id)).toEqual([THIRD_RUN_ID, 2])
      expect(runs[0]).toEqual(inProgressRun())
    })

    test('lists nothing for a workflow with no runs, or another repository', async () => {
      const { harness } = context

      harness.seedRuns(OTHER_REPO, WORKFLOW, [workflowRun({ id: 1 })])

      await expect(
        harness.client.listWorkflowRuns({
          repository: REPO,
          workflowId: WORKFLOW,
          createdFrom: '2026-10-26T00:00:00Z'
        })
      ).resolves.toEqual([])
    })
  })
}

function describeGetRunReport(context) {
  describe('getRunReport', () => {
    test('returns the parsed run report of the run', async () => {
      const report = { outcome: 'success', operations: [] }

      context.harness.seedReport(REPO, RUN_ID, ENVIRONMENT, report)

      await expect(readReport(context, RUN_ID, FIRST_ATTEMPT)).resolves.toEqual(
        report
      )
    })

    test('returns null when the run has no report', async () => {
      await expect(
        readReport(context, RUN_ID_WITHOUT_REPORT, FIRST_ATTEMPT)
      ).resolves.toBeNull()
    })

    test('returns null when the report has expired', async () => {
      context.harness.seedReport(REPO, RUN_ID_EXPIRED_REPORT, ENVIRONMENT, null)

      await expect(
        readReport(context, RUN_ID_EXPIRED_REPORT, FIRST_ATTEMPT)
      ).resolves.toBeNull()
    })
  })
}

// A rerun keeps its run ID and the workflows' artifact name has no overwrite,
// so the report an earlier attempt uploaded is still on the run. Its events say
// which attempt wrote it.
function describeGetRunReportAttempts(context) {
  describe('getRunReport across attempts', () => {
    test('returns the report whose events belong to the attempt asked for', async () => {
      const report = {
        events: [{ status: CHECKS_FAILED, runAttempt: RERUN_ATTEMPT }]
      }

      context.harness.seedReport(REPO, RUN_ID_OF_ATTEMPT, ENVIRONMENT, report)

      await expect(
        readReport(context, RUN_ID_OF_ATTEMPT, RERUN_ATTEMPT)
      ).resolves.toEqual(report)
    })

    test('returns null for a report an earlier attempt of the run uploaded', async () => {
      context.harness.seedReport(REPO, RUN_ID_EARLIER_ATTEMPT, ENVIRONMENT, {
        events: [{ status: CHECKS_FAILED, runAttempt: FIRST_ATTEMPT }]
      })

      await expect(
        readReport(context, RUN_ID_EARLIER_ATTEMPT, RERUN_ATTEMPT)
      ).resolves.toBeNull()
    })

    test('returns null for a report that is not wholly of the attempt asked for', async () => {
      context.harness.seedReport(REPO, RUN_ID_MIXED_ATTEMPTS, ENVIRONMENT, {
        events: [
          { status: 'requested', runAttempt: RERUN_ATTEMPT },
          { status: CHECKS_FAILED, runAttempt: FIRST_ATTEMPT }
        ]
      })

      await expect(
        readReport(context, RUN_ID_MIXED_ATTEMPTS, RERUN_ATTEMPT)
      ).resolves.toBeNull()
    })

    test('returns null for a report that names no attempt when the run is a rerun, as it cannot be shown to belong to it', async () => {
      context.harness.seedReport(
        REPO,
        RUN_ID_UNNAMED_ATTEMPT_RERUN,
        ENVIRONMENT,
        { outcome: 'failure' }
      )

      await expect(
        readReport(context, RUN_ID_UNNAMED_ATTEMPT_RERUN, RERUN_ATTEMPT)
      ).resolves.toBeNull()
    })

    test('returns a report that names no attempt for the first attempt, the only one that could have uploaded it', async () => {
      const report = { outcome: 'failure' }

      context.harness.seedReport(
        REPO,
        RUN_ID_UNNAMED_ATTEMPT_FIRST,
        ENVIRONMENT,
        report
      )

      await expect(
        readReport(context, RUN_ID_UNNAMED_ATTEMPT_FIRST, FIRST_ATTEMPT)
      ).resolves.toEqual(report)
    })
  })
}

function describeListCommits(context) {
  describe('listCommits', () => {
    test('lists the commits on main for the path since the time, newest first', async () => {
      const { harness } = context

      harness.seedCommits(REPO, [
        mainCommit({
          path: PATH,
          sha: sha('a'),
          committedAt: '2026-10-26T12:05:00Z'
        }),
        mainCommit({
          path: PATH,
          sha: sha('b'),
          committedAt: '2026-10-26T12:20:00Z'
        }),
        mainCommit({
          path: PATH,
          sha: sha('c'),
          committedAt: '2026-10-26T10:00:00Z'
        }),
        mainCommit({
          path: 'environments/infradev/beta.json',
          sha: sha('d')
        })
      ])

      const commits = await harness.client.listCommits({
        repository: REPO,
        path: PATH,
        since: NOON
      })

      expect(commits.map((commit) => commit.sha)).toEqual([sha('b'), sha('a')])
      expect(commits[0]).toEqual({
        sha: sha('b'),
        message: expect.stringContaining('Operation-Id: op-7f3c9a1e'),
        committedAt: '2026-10-26T12:20:00Z'
      })
    })
  })
}

function describeListRunJobNames(context) {
  describe('listRunJobNames', () => {
    test('lists the names of the jobs of a run', async () => {
      const jobNames = ['apply / infradev', 'apply / pause infradev']

      context.harness.seedJobs(REPO, RUN_ID, jobNames)

      await expect(
        context.harness.client.listRunJobNames({
          repository: REPO,
          runId: RUN_ID
        })
      ).resolves.toEqual(jobNames)
    })

    test('lists nothing for a run with no jobs', async () => {
      await expect(
        context.harness.client.listRunJobNames({
          repository: REPO,
          runId: RUN_ID_WITHOUT_JOBS
        })
      ).resolves.toEqual([])
    })
  })
}

function describeIsAncestor(context) {
  describe('isAncestor', () => {
    const isAncestor = (ancestor, descendant) =>
      context.harness.client.isAncestor({
        repository: REPO,
        ancestor,
        descendant
      })

    test('is true for the same commit and for a descendant', async () => {
      context.harness.seedAncestor(REPO, sha('a'), sha('b'))

      await expect(isAncestor(sha('a'), sha('a'))).resolves.toBe(true)
      await expect(isAncestor(sha('a'), sha('b'))).resolves.toBe(true)
    })

    test('is false for a commit that is not an ancestor', async () => {
      await expect(isAncestor(sha('c'), sha('b'))).resolves.toBe(false)
    })
  })
}
