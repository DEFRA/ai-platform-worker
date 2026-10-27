import { retry } from '#/common/helpers/retry.js'
import {
  CommitLookupIncompleteError,
  MAIN,
  RunLookupIncompleteError
} from '#/github/github-client.js'
import { reportOfAttempt } from '#/github/run-report.js'

const PER_PAGE = 100
// A day of runs of one workflow, or of commits to one path, is well under
// this; the cap only bounds the worst case so one reconcile cannot spend the
// rate budget.
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
    updatedAt: run.updated_at ?? run.created_at,
    htmlUrl: run.html_url
  }
}

function toCommit(commit) {
  return {
    sha: commit.sha,
    message: commit.commit.message,
    committedAt: commit.commit.committer.date
  }
}

function newestFirst(a, b) {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id
}

// Pages are read until one is short; a full page at the budget means more
// may lie beyond it, so the caller gets the error, not a partial list.
async function readAllPages(readPage, incomplete, page = 1, items = []) {
  if (page > MAX_PAGES) {
    throw incomplete()
  }

  const batch = await readPage(page)
  const all = [...items, ...batch]

  return batch.length < PER_PAGE
    ? all
    : readAllPages(readPage, incomplete, page + 1, all)
}

// Every read goes through `retry`; a request that must not be repeated (the
// dispatch) goes through `send` alone. Each call carries the handler's signal.
function createTransport(clientFor, retryOptions) {
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

  function download(repository, url, signal) {
    return retry(
      () =>
        clientFor(repository).request({
          method: 'GET',
          url,
          request: { signal }
        }),
      { signal, ...retryOptions }
    )
  }

  return { send, read, download }
}

async function listRunPage({ read }, params, page) {
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

async function listCommitPage({ read }, params, page) {
  const { repository, path, since, signal } = params
  const { data } = await read(
    repository,
    ROUTES.commits,
    { sha: MAIN, path, since, per_page: PER_PAGE, page },
    signal
  )

  return data
}

async function findReportArtifact({ read }, params, name) {
  const { repository, runId, signal } = params
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

  return (data.artifacts ?? []).find(
    (candidate) => candidate.name === name && !candidate.expired
  )
}

function createRunMethods(transport) {
  const { send, read, download } = transport

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
      const runs = await readAllPages(
        (page) => listRunPage(transport, params, page),
        () =>
          new RunLookupIncompleteError({
            repository: params.repository,
            workflowId: params.workflowId,
            pages: MAX_PAGES
          })
      )

      return runs.map(toRun).toSorted(newestFirst)
    },

    async getRunReport(params) {
      const { repository, runAttempt, environment, signal } = params
      const artifact = await findReportArtifact(
        transport,
        params,
        `run-report-${environment}.json`
      )

      if (!artifact) {
        return null
      }

      const { data: file } = await download(
        repository,
        artifact.archive_download_url,
        signal
      )

      return reportOfAttempt(parseReport(file), runAttempt)
    },

    async listRunJobNames({ repository, runId, signal }) {
      const { data } = await read(
        repository,
        ROUTES.jobs,
        { run_id: runId, per_page: PER_PAGE },
        signal
      )

      return data.jobs.map((job) => job.name)
    }
  }
}

function createCommitMethods(transport) {
  return {
    async listCommits(params) {
      const commits = await readAllPages(
        (page) => listCommitPage(transport, params, page),
        () =>
          new CommitLookupIncompleteError({
            repository: params.repository,
            path: params.path,
            pages: MAX_PAGES
          })
      )

      return commits.map(toCommit)
    },

    async isAncestor({ repository, ancestor, descendant, signal }) {
      try {
        const { data } = await transport.read(
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
  const transport = createTransport(clientFor, retryOptions)

  return {
    ...createRunMethods(transport),
    ...createCommitMethods(transport)
  }
}
