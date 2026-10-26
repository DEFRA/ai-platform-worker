import { Octokit } from 'octokit'

import { createFakeGitHub } from '../../test/fakes/fake-github-http.js'
import { createOctokitGitHubClient } from '#/github/octokit-github-client.js'
import { describeGitHubClientContract } from '#/github/github-client-contract.js'

const API = 'https://api.github.com'
const NO_WAIT = { sleep: async () => {}, random: () => 0 }

function restRun(run) {
  return {
    id: run.id,
    name: run.name,
    display_title: run.name,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    head_sha: run.headSha,
    run_attempt: run.runAttempt,
    created_at: run.createdAt,
    html_url: run.htmlUrl
  }
}

// api.github.com as the contract's harness sees it: seeded with what GitHub
// would hold, and recording what was dispatched.
function createHarness() {
  const state = {
    runs: new Map(),
    commits: new Map(),
    reports: new Map(),
    ancestry: new Set(),
    jobs: new Map(),
    dispatches: []
  }
  let nextRunId = 7001
  const { fetch, requests } = createFakeGitHub({
    'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches': ({
      params,
      body
    }) => {
      const runId = nextRunId
      nextRunId += 1

      state.dispatches.push({
        repository: `${params.owner}/${params.repo}`,
        workflowId: params.workflow_id,
        inputs: body.inputs
      })

      return {
        body: {
          workflow_run_id: runId,
          run_url: `${API}/repos/${params.owner}/${params.repo}/actions/runs/${runId}`,
          html_url: `https://github.com/${params.owner}/${params.repo}/actions/runs/${runId}`
        }
      }
    },
    'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs': ({
      params,
      query
    }) => {
      const from = Date.parse(query.get('created').replace('>=', ''))
      const runs = (
        state.runs.get(
          `${params.owner}/${params.repo}:${params.workflow_id}`
        ) ?? []
      ).filter((run) => Date.parse(run.createdAt) >= from)

      return {
        body: {
          workflow_runs: query.get('page') === '1' ? runs.map(restRun) : []
        }
      }
    },
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts': ({
      params
    }) => {
      const key = `${params.owner}/${params.repo}:${params.run_id}`
      const found = [...state.reports.keys()].filter((candidate) =>
        candidate.startsWith(key)
      )

      return {
        body: {
          artifacts: found.map((candidate) => ({
            name: `run-report-${candidate.split(':').at(-1)}.json`,
            expired: state.reports.get(candidate) === null,
            archive_download_url: `${API}/repos/${params.owner}/${params.repo}/actions/artifacts/${params.run_id}/zip`
          }))
        }
      }
    },
    'GET /repos/{owner}/{repo}/actions/artifacts/{id}/zip': ({ params }) => {
      const key = `${params.owner}/${params.repo}:${params.id}`
      const [found] = [...state.reports.entries()].filter(([candidate]) =>
        candidate.startsWith(key)
      )

      return { body: found?.[1] }
    },
    'GET /repos/{owner}/{repo}/commits': ({ params, query }) => {
      const since = Date.parse(query.get('since'))

      return {
        body: (state.commits.get(`${params.owner}/${params.repo}`) ?? [])
          .filter(
            (commit) =>
              commit.path === query.get('path') &&
              Date.parse(commit.committedAt) >= since
          )
          .toSorted(
            (a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt)
          )
          .map((commit) => ({
            sha: commit.sha,
            commit: {
              message: commit.message,
              committer: { date: commit.committedAt }
            }
          }))
      }
    },
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs': ({ params }) => ({
      body: {
        jobs: (
          state.jobs.get(`${params.owner}/${params.repo}:${params.run_id}`) ??
          []
        ).map((name) => ({ name }))
      }
    }),
    'GET /repos/{owner}/{repo}/compare/{basehead}': ({ params }) => {
      const [ancestor, descendant] = params.basehead.split('...')
      const repository = `${params.owner}/${params.repo}`

      if (ancestor === descendant) {
        return { body: { status: 'identical' } }
      }

      return {
        body: {
          status: state.ancestry.has(`${repository}:${ancestor}:${descendant}`)
            ? 'ahead'
            : 'diverged'
        }
      }
    }
  })
  const octokit = new Octokit({
    request: { fetch, retries: 0 },
    throttle: { enabled: false }
  })
  const client = createOctokitGitHubClient({
    clientFor: () => octokit,
    retryOptions: NO_WAIT
  })

  return {
    client,
    requests,
    state,
    seedRuns: (repository, workflowId, runs) =>
      state.runs.set(`${repository}:${workflowId}`, runs),
    seedCommits: (repository, commits) =>
      state.commits.set(repository, commits),
    seedReport: (repository, runId, environment, report) =>
      state.reports.set(`${repository}:${runId}:${environment}`, report),
    seedAncestor: (repository, ancestor, descendant) =>
      state.ancestry.add(`${repository}:${ancestor}:${descendant}`),
    seedJobs: (repository, runId, names) =>
      state.jobs.set(`${repository}:${runId}`, names),
    dispatches: () => state.dispatches
  }
}

describeGitHubClientContract('Octokit adapter', createHarness)

function clientOver(routes, retryOptions = NO_WAIT) {
  const { fetch, requests } = createFakeGitHub(routes)
  const octokit = new Octokit({
    request: { fetch, retries: 0 },
    throttle: { enabled: false }
  })

  return {
    client: createOctokitGitHubClient({
      clientFor: () => octokit,
      retryOptions
    }),
    requests
  }
}

const RUNS_ROUTE =
  'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs'
const PARAMS = {
  repository: 'DEFRA/ai-platform-tenants',
  workflowId: 'submit.yml',
  createdFrom: '2026-10-26T12:00:00Z'
}

describe('#octokit-github-client', () => {
  test('dispatches on main and asks GitHub for the run details', async () => {
    const { client, requests } = clientOver({
      'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches':
        () => ({
          body: {
            workflow_run_id: 5,
            html_url: 'https://github.com/o/r/actions/runs/5'
          }
        })
    })
    const signal = new AbortController().signal

    await client.dispatchWorkflow({
      repository: 'DEFRA/ai-platform-tenants',
      workflowId: 'apply.yml',
      inputs: { environment: 'infradev' },
      signal
    })

    expect(requests[0].path).toBe(
      '/repos/DEFRA/ai-platform-tenants/actions/workflows/apply.yml/dispatches'
    )
    expect(requests[0].body).toEqual({
      ref: 'main',
      inputs: { environment: 'infradev' },
      return_run_details: true
    })
    expect(requests[0].signal).toBeDefined()
  })

  test('returns no run when GitHub answers 204 without details', async () => {
    const { client } = clientOver({
      'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches':
        () => ({ status: 204 })
    })

    await expect(
      client.dispatchWorkflow({ ...PARAMS, inputs: {} })
    ).resolves.toEqual({ runId: null, runUrl: null })
  })

  test('never retries a dispatch, so a lost response cannot start a second run', async () => {
    let calls = 0
    const { client } = clientOver({
      'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches':
        () => {
          calls += 1

          return { status: 502, body: { message: 'Bad Gateway' } }
        }
    })

    await expect(
      client.dispatchWorkflow({ ...PARAMS, inputs: {} })
    ).rejects.toMatchObject({ status: 502 })
    expect(calls).toBe(1)
  })

  test('retries a read that fails with a server error, then succeeds', async () => {
    let calls = 0
    const { client } = clientOver({
      [RUNS_ROUTE]: () => {
        calls += 1

        return calls === 1
          ? { status: 502, body: { message: 'Bad Gateway' } }
          : { body: { workflow_runs: [] } }
      }
    })

    await expect(client.listWorkflowRuns(PARAMS)).resolves.toEqual([])
    expect(calls).toBe(2)
  })

  test('does not retry a read GitHub refuses', async () => {
    let calls = 0
    const { client } = clientOver({
      [RUNS_ROUTE]: () => {
        calls += 1

        return { status: 403, body: { message: 'rate limited' } }
      }
    })

    await expect(client.listWorkflowRuns(PARAMS)).rejects.toMatchObject({
      status: 403
    })
    expect(calls).toBe(1)
  })

  test('reads up to three pages of runs and no more', async () => {
    const pages = []
    const full = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: 'submit',
      status: 'completed',
      conclusion: 'success',
      event: 'workflow_dispatch',
      head_sha: 'a'.repeat(40),
      created_at: '2026-10-26T12:00:00Z',
      html_url: 'https://github.com/o/r/actions/runs/1'
    }))
    const { client } = clientOver({
      [RUNS_ROUTE]: ({ query }) => {
        pages.push(query.get('page'))

        return { body: { workflow_runs: full } }
      }
    })

    const runs = await client.listWorkflowRuns(PARAMS)

    expect(pages).toEqual(['1', '2', '3'])
    expect(runs).toHaveLength(300)
    expect(runs[0].runAttempt).toBe(1)
  })

  test('asks only for runs on main from the time', async () => {
    const { client, requests } = clientOver({
      [RUNS_ROUTE]: () => ({ body: { workflow_runs: [] } })
    })

    await client.listWorkflowRuns(PARAMS)

    expect(requests[0].query.get('branch')).toBe('main')
    expect(requests[0].query.get('created')).toBe('>=2026-10-26T12:00:00Z')
  })

  test('reads a run report served as bytes, whatever its content type', async () => {
    const report = { outcome: 'success' }
    const { client } = clientOver({
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts': () => ({
        body: {
          artifacts: [
            {
              name: 'run-report-infradev.json',
              expired: false,
              archive_download_url: `${API}/repos/o/r/actions/artifacts/1/zip`
            }
          ]
        }
      }),
      'GET /repos/{owner}/{repo}/actions/artifacts/{id}/zip': () => ({
        body: report,
        headers: { 'content-type': 'application/octet-stream' }
      })
    })

    await expect(
      client.getRunReport({
        repository: 'DEFRA/ai-platform-tenants',
        runId: 9,
        environment: 'infradev'
      })
    ).resolves.toEqual(report)
  })

  test('reads a run report served as text', async () => {
    const { client } = clientOver({
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts': () => ({
        body: {
          artifacts: [
            {
              name: 'run-report-infradev.json',
              expired: false,
              archive_download_url: `${API}/repos/o/r/actions/artifacts/1/zip`
            }
          ]
        }
      }),
      'GET /repos/{owner}/{repo}/actions/artifacts/{id}/zip': () => ({
        body: JSON.stringify({ outcome: 'failure' }),
        headers: { 'content-type': 'text/plain' }
      })
    })

    await expect(
      client.getRunReport({
        repository: 'DEFRA/ai-platform-tenants',
        runId: 9,
        environment: 'infradev'
      })
    ).resolves.toEqual({ outcome: 'failure' })
  })

  test('reads no report for a run GitHub no longer has', async () => {
    const { client } = clientOver({})

    await expect(
      client.getRunReport({
        repository: 'DEFRA/ai-platform-tenants',
        runId: 9,
        environment: 'infradev'
      })
    ).resolves.toBeNull()
  })

  test('lets any other error from a report read through', async () => {
    const { client } = clientOver({
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts': () => ({
        status: 403,
        body: { message: 'forbidden' }
      })
    })

    await expect(
      client.getRunReport({
        repository: 'DEFRA/ai-platform-tenants',
        runId: 9,
        environment: 'infradev'
      })
    ).rejects.toMatchObject({ status: 403 })
  })

  test('is not an ancestor when GitHub does not know the commit, and surfaces other errors', async () => {
    const { client } = clientOver({})
    const params = {
      repository: 'DEFRA/ai-platform-tenants',
      ancestor: 'a'.repeat(40),
      descendant: 'b'.repeat(40)
    }

    await expect(client.isAncestor(params)).resolves.toBe(false)

    const failing = clientOver({
      'GET /repos/{owner}/{repo}/compare/{basehead}': () => ({
        status: 403,
        body: { message: 'forbidden' }
      })
    })

    await expect(failing.client.isAncestor(params)).rejects.toMatchObject({
      status: 403
    })
  })
})
