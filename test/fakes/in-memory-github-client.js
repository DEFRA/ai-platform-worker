import { reportOfAttempt } from '#/github/run-report.js'

const DEFAULT_RUN = {
  id: 1001,
  name: 'submit write environments/infradev/alpha.json (op-7f3c9a1e)',
  status: 'completed',
  conclusion: 'success',
  event: 'workflow_dispatch',
  headSha: 'a'.repeat(40),
  runAttempt: 1,
  createdAt: '2026-10-26T12:00:05Z'
}

/**
 * A workflow run in the port's shape; `overrides` replace any field.
 * @param {object} [overrides]
 * @param {string} [repository]
 * @returns {import('#/github/github-client.js').WorkflowRun}
 */
export function workflowRun(
  overrides = {},
  repository = 'DEFRA/ai-platform-tenants'
) {
  const id = overrides.id ?? DEFAULT_RUN.id

  return {
    ...DEFAULT_RUN,
    // Without a say, a run was last updated when it was created.
    updatedAt: overrides.createdAt ?? DEFAULT_RUN.createdAt,
    htmlUrl: `https://github.com/${repository}/actions/runs/${id}`,
    ...overrides
  }
}

/**
 * A commit on main in the port's shape; `overrides` replace any field.
 * @param {object} [overrides]
 */
export function mainCommit(overrides = {}) {
  return {
    sha: '0123456789abcdef0123456789abcdef01234567',
    message:
      'Change alpha\n\nOperation-Id: op-7f3c9a1e\nRequested-By: entra:00000000-0000-0000-0000-000000000001',
    committedAt: '2026-10-26T12:00:24Z',
    ...overrides
  }
}

function aborted(signal) {
  signal?.throwIfAborted()
}

/**
 * An in-memory `GitHubClient`: seeded with runs, commits, reports and
 * ancestry, recording every dispatch, and failing on demand. It must pass the
 * same contract suite as the Octokit adapter.
 * @param {object} [options]
 * @param {number} [options.firstRunId] - the ID of the first dispatched run
 */
export function createInMemoryGitHubClient({ firstRunId = 9001 } = {}) {
  const runs = new Map()
  const commits = new Map()
  const reports = new Map()
  const ancestry = new Set()
  const jobs = new Map()
  const dispatches = []
  const calls = []
  const failures = new Map()
  let nextRunId = firstRunId

  function record(method, params) {
    calls.push({ method, ...params })
    aborted(params.signal)

    const failure = failures.get(method)

    if (failure) {
      failures.delete(method)
      throw failure
    }
  }

  return {
    // Seeding.
    seedRuns(repository, workflowId, list) {
      runs.set(`${repository}:${workflowId}`, list)
    },
    seedCommits(repository, list) {
      commits.set(repository, list)
    },
    seedReport(repository, runId, environment, report) {
      reports.set(`${repository}:${runId}:${environment}`, report)
    },
    seedAncestor(repository, ancestor, descendant) {
      ancestry.add(`${repository}:${ancestor}:${descendant}`)
    },
    seedJobs(repository, runId, names) {
      jobs.set(`${repository}:${runId}`, names)
    },
    failNext(method, error) {
      failures.set(method, error)
    },
    // Observation.
    dispatches,
    calls,
    // The port.
    async dispatchWorkflow(params) {
      record('dispatchWorkflow', params)
      const { repository, workflowId, inputs } = params
      const runId = nextRunId
      nextRunId += 1

      dispatches.push({ repository, workflowId, inputs })

      return {
        runId,
        runUrl: `https://github.com/${repository}/actions/runs/${runId}`
      }
    },
    async listWorkflowRuns(params) {
      record('listWorkflowRuns', params)
      const { repository, workflowId, createdFrom } = params

      return (runs.get(`${repository}:${workflowId}`) ?? [])
        .filter((run) => Date.parse(run.createdAt) >= Date.parse(createdFrom))
        .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    },
    async getRunReport(params) {
      record('getRunReport', params)
      const { repository, runId, runAttempt, environment } = params

      return reportOfAttempt(
        reports.get(`${repository}:${runId}:${environment}`) ?? null,
        runAttempt
      )
    },
    async listCommits(params) {
      record('listCommits', params)
      const { repository, path, since } = params

      return (commits.get(repository) ?? [])
        .filter(
          (commit) =>
            (commit.path === undefined || commit.path === path) &&
            Date.parse(commit.committedAt) >= Date.parse(since)
        )
        .toSorted(
          (a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt)
        )
        .map(({ sha, message, committedAt }) => ({ sha, message, committedAt }))
    },
    async listRunJobNames(params) {
      record('listRunJobNames', params)

      return jobs.get(`${params.repository}:${params.runId}`) ?? []
    },
    async isAncestor(params) {
      record('isAncestor', params)
      const { repository, ancestor, descendant } = params

      return (
        ancestor === descendant ||
        ancestry.has(`${repository}:${ancestor}:${descendant}`)
      )
    }
  }
}
