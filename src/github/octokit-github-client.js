import { retry } from '#/common/helpers/retry.js'
import { MAIN, RunLookupIncompleteError } from '#/github/github-client.js'
import { reportOfAttempt } from '#/github/run-report.js'

const PER_PAGE = 100
// A day of runs of one workflow is well under this; the cap only bounds the
// worst case so one reconcile cannot spend the rate budget.
const MAX_PAGES = 3
const NOT_FOUND = 404
const DESCENDANT_STATUSES = new Set(['ahead', 'identical'])
const ROUTES = {
  runs: 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
  artifacts: 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts',
  commits: 'GET /repos/{owner}/{repo}/commits',
  compare: 'GET /repos/{owner}/{repo}/compare/{basehead}',
  jobs: 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
  dispatch:
    'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches'
}

function parseRepository(repository) {
  const [owner, repo] = repository.split('/')

  return { owner, repo }
}

// The run report is uploaded unzipped (`archive: false`), so the download is
// the JSON file itself, whatever content type the storage host labels it.
function parseReport(data) {
  if (typeof data === 'string') {
    return JSON.parse(data)
  }

  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return JSON.parse(Buffer.from(data).toString('utf8'))
  }

  return data
}

function toRun(run) {
  return {
    id: run.id,
    name: run.display_title ?? run.name,
    status: run.status,
    conclusion: run.conclusion ?? null,
    event: run.event,
    headSha: run.head_sha,
    runAttempt: run.run_attempt ?? 1,
    createdAt: run.created_at,
    htmlUrl: run.html_url
  }
}

/**
 * The `GitHubClient` port over Octokit (plan 6.1). Every read goes through
 * `retry` (a server error or dropped connection is tried again with jittered
 * backoff); the dispatch is never retried inside a handler, because a lost
 * response must not become a second run: SQS redelivers the command and the
 * handler looks for the run first. Each call carries the handler's signal.
 * @param {object} deps
 * @param {(repository: string) => import('octokit').Octokit} deps.clientFor - a client down-scoped to the one repository
 * @param {object} [deps.retryOptions] - passed to `retry`
 * @returns {import('#/github/github-client.js').GitHubClient}
 */
export function createOctokitGitHubClient({ clientFor, retryOptions = {} }) {
  function send(repository, route, params, signal) {
    return clientFor(repository).request(route, {
      ...parseRepository(repository),
      ...params,
      request: { signal }
    })
  }

  function read(repository, route, params, signal) {
    return retry(() => send(repository, route, params, signal), {
      signal,
      ...retryOptions
    })
  }

  async function listRunPage(params, page) {
    const { repository, workflowId, createdFrom, signal } = params
    const { data } = await read(
      repository,
      ROUTES.runs,
      {
        workflow_id: workflowId,
        branch: MAIN,
        created: `>=${createdFrom}`,
        per_page: PER_PAGE,
        page
      },
      signal
    )

    return data.workflow_runs
  }

  return {
    async dispatchWorkflow({ repository, workflowId, inputs, signal }) {
      const { data } = await send(
        repository,
        ROUTES.dispatch,
        {
          workflow_id: workflowId,
          ref: MAIN,
          inputs,
          return_run_details: true
        },
        signal
      )

      return {
        runId: data?.workflow_run_id ?? null,
        runUrl: data?.html_url ?? null
      }
    },

    async listWorkflowRuns(params) {
      const runs = []

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = await listRunPage(params, page)

        runs.push(...batch)

        if (batch.length < PER_PAGE) {
          return runs
            .map(toRun)
            .toSorted(
              (a, b) =>
                Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id
            )
        }
      }

      throw new RunLookupIncompleteError({
        repository: params.repository,
        workflowId: params.workflowId,
        pages: MAX_PAGES
      })
    },

    async getRunReport({ repository, runId, runAttempt, environment, signal }) {
      const name = `run-report-${environment}.json`
      const { data } = await read(
        repository,
        ROUTES.artifacts,
        { run_id: runId, name },
        signal
      ).catch((error) => {
        if (error.status === NOT_FOUND) {
          return { data: {} }
        }

        throw error
      })
      const artifact = (data.artifacts ?? []).find(
        (candidate) => candidate.name === name && !candidate.expired
      )

      if (!artifact) {
        return null
      }

      const { data: file } = await retry(
        () =>
          clientFor(repository).request({
            method: 'GET',
            url: artifact.archive_download_url,
            request: { signal }
          }),
        { signal, ...retryOptions }
      )

      return reportOfAttempt(parseReport(file), runAttempt)
    },

    async listCommits({ repository, path, since, signal }) {
      const { data } = await read(
        repository,
        ROUTES.commits,
        { sha: MAIN, path, since, per_page: PER_PAGE },
        signal
      )

      return data.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
        committedAt: commit.commit.committer.date
      }))
    },

    async listRunJobNames({ repository, runId, signal }) {
      const { data } = await read(
        repository,
        ROUTES.jobs,
        { run_id: runId, per_page: PER_PAGE },
        signal
      )

      return data.jobs.map((job) => job.name)
    },

    async isAncestor({ repository, ancestor, descendant, signal }) {
      try {
        const { data } = await read(
          repository,
          ROUTES.compare,
          { basehead: `${ancestor}...${descendant}`, per_page: 1 },
          signal
        )

        return DESCENDANT_STATUSES.has(data.status)
      } catch (error) {
        if (error.status === NOT_FOUND) {
          return false
        }

        throw error
      }
    }
  }
}
