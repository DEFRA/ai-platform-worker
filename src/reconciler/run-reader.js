import { APPLY_WORKFLOW, SUBMIT_WORKFLOW } from '#/github/github-client.js'

// How many apply runs of the environment that contain a commit are kept,
// newest first, and how many runs are inspected to find them: an operation's
// apply is among the latest, and a reconcile must not spend the rate budget on
// a busy repository.
const MAX_APPLY_RUNS = 10
const MAX_APPLY_RUNS_INSPECTED = 30
// `apply.yml`'s run-name is `apply {environment} {reason}` when dispatched and
// `apply changed environments` when a push starts it.
const APPLY_RUN_NAME = /^apply (\S+)/
const PUSH_RUN_NAME = 'apply changed environments'

/**
 * Reads the runs a reconcile and a dispatch look for (plan 6.1). Pure
 * selection over the GitHub port: which run is this operation's submit, which
 * apply is this command's, which applies contain a commit.
 * @param {{github: import('#/github/github-client.js').GitHubClient}} deps
 */
export function createRunReader({ github }) {
  // A dispatched apply names its environment. A push apply covers every
  // environment that changed, so its jobs say which: a reusable workflow's
  // job reads `{caller job} / {job}`, and the matrix job is the environment.
  async function appliesTo({ repository, environment, run, signal }) {
    const named = APPLY_RUN_NAME.exec(run.name)

    if (named && !run.name.startsWith(PUSH_RUN_NAME)) {
      return named[1] === environment
    }

    const jobs = await github.listRunJobNames({
      repository,
      runId: run.id,
      signal
    })

    return jobs.some((job) => job.split(' / ').includes(environment))
  }

  async function submitRunsOf({
    repository,
    operationId,
    createdFrom,
    signal
  }) {
    const runs = await github.listWorkflowRuns({
      repository,
      workflowId: SUBMIT_WORKFLOW,
      createdFrom,
      signal
    })

    // `submit.yml`'s run-name ends with `({operationId})`.
    return runs.filter((run) => run.name.includes(`(${operationId})`))
  }

  return {
    /**
     * The submit runs of an operation created from the time, newest first.
     * @param {{repository: string, operationId: string, createdFrom: string, signal?: AbortSignal}} params
     * @returns {Promise<import('#/github/github-client.js').WorkflowRun[]>}
     */
    findSubmitRuns: submitRunsOf,

    /**
     * The apply run a command already dispatched, found by its command ID in
     * the run name (the dispatch's `reason`), or undefined.
     * @param {{repository: string, commandId: string, createdFrom: string, signal?: AbortSignal}} params
     * @returns {Promise<import('#/github/github-client.js').WorkflowRun|undefined>}
     */
    async findDispatchedApply({ repository, commandId, createdFrom, signal }) {
      const runs = await github.listWorkflowRuns({
        repository,
        workflowId: APPLY_WORKFLOW,
        createdFrom,
        signal
      })

      return runs.find((run) => run.name.includes(commandId))
    },

    /**
     * The latest apply runs of one environment that contain a commit (their
     * head is the commit or a descendant), newest first. A run created before
     * the commit cannot contain it, so the search starts at the commit's
     * time. An apply of another environment is never returned: its progress
     * says nothing about this operation.
     * @param {{repository: string, environment: string, commit: {sha: string, committedAt: string}, signal?: AbortSignal}} params
     * @returns {Promise<import('#/github/github-client.js').WorkflowRun[]>}
     */
    async findAppliesContaining({ repository, environment, commit, signal }) {
      const runs = await github.listWorkflowRuns({
        repository,
        workflowId: APPLY_WORKFLOW,
        createdFrom: commit.committedAt,
        signal
      })
      const containing = []

      for (const run of runs.slice(0, MAX_APPLY_RUNS_INSPECTED)) {
        if (containing.length >= MAX_APPLY_RUNS) {
          break
        }

        if (!(await appliesTo({ repository, environment, run, signal }))) {
          continue
        }

        const contains =
          run.headSha === commit.sha ||
          (await github.isAncestor({
            repository,
            ancestor: commit.sha,
            descendant: run.headSha,
            signal
          }))

        if (contains) {
          containing.push(run)
        }
      }

      return containing
    }
  }
}
