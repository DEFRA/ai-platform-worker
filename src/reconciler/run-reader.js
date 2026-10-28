import {
  APPLY_WORKFLOW,
  RunLookupIncompleteError,
  SUBMIT_WORKFLOW
} from '#/github/github-client.js'

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

// One run at a time, in order, until enough are found: each check costs GitHub
// calls, so the runs are not checked together.
async function collectContaining(runs, contains, found = []) {
  if (runs.length === 0 || found.length >= MAX_APPLY_RUNS) {
    return found
  }

  const [run, ...rest] = runs

  return collectContaining(
    rest,
    contains,
    (await contains(run)) ? [...found, run] : found
  )
}

// A dispatched apply names its environment. A push apply covers every
// environment that changed, so its jobs say which: a reusable workflow's
// job reads `{caller job} / {job}`, and the matrix job is the environment.
async function appliesTo(github, { repository, environment, run, signal }) {
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

async function containsCommit(github, params) {
  const { repository, commit, run, signal } = params

  if (!(await appliesTo(github, params))) {
    return false
  }

  if (run.headSha === commit.sha) {
    return true
  }

  return github.isAncestor({
    repository,
    ancestor: commit.sha,
    descendant: run.headSha,
    signal
  })
}

async function findSubmitRuns(
  github,
  { repository, operationId, createdFrom, signal }
) {
  const runs = await github.listWorkflowRuns({
    repository,
    workflowId: SUBMIT_WORKFLOW,
    createdFrom,
    signal
  })

  // `submit.yml`'s run-name ends with `({operationId})`.
  return runs.filter((run) => run.name.includes(`(${operationId})`))
}

async function findDispatchedApply(
  github,
  { repository, commandId, createdFrom, signal }
) {
  const runs = await github.listWorkflowRuns({
    repository,
    workflowId: APPLY_WORKFLOW,
    createdFrom,
    signal
  })

  return runs.find((run) => run.name.includes(commandId))
}

async function findAppliesContaining(github, params) {
  const { repository, environment, commit, signal } = params
  const runs = await github.listWorkflowRuns({
    repository,
    workflowId: APPLY_WORKFLOW,
    createdFrom: commit.committedAt,
    signal
  })
  const containing = await collectContaining(
    runs.slice(0, MAX_APPLY_RUNS_INSPECTED),
    (run) =>
      containsCommit(github, { repository, environment, commit, run, signal })
  )

  // Runs left unread may be the environment's own: their absence from the
  // answer is not evidence that there is no apply, so the caller must not
  // dispatch one. Enough found is complete, for the newest decide.
  if (
    containing.length < MAX_APPLY_RUNS &&
    runs.length > MAX_APPLY_RUNS_INSPECTED
  ) {
    throw new RunLookupIncompleteError({
      repository,
      workflowId: APPLY_WORKFLOW,
      budget: `the ${MAX_APPLY_RUNS_INSPECTED} newest runs read`
    })
  }

  return containing
}

/**
 * Reads the runs a reconcile and a dispatch look for (plan 6.1). Pure
 * selection over the GitHub port: which run is this operation's submit, which
 * apply is this command's, which applies contain a commit.
 * @param {{github: import('#/github/github-client.js').GitHubClient}} deps
 */
export function createRunReader({ github }) {
  return {
    /**
     * The submit runs of an operation created from the time, newest first.
     * @param {{repository: string, operationId: string, createdFrom: string, signal?: AbortSignal}} params
     * @returns {Promise<import('#/github/github-client.js').WorkflowRun[]>}
     */
    findSubmitRuns: (params) => findSubmitRuns(github, params),

    /**
     * The apply run a command already dispatched, found by its command ID in
     * the run name (the dispatch's `reason`), or undefined.
     * @param {{repository: string, commandId: string, createdFrom: string, signal?: AbortSignal}} params
     * @returns {Promise<import('#/github/github-client.js').WorkflowRun|undefined>}
     */
    findDispatchedApply: (params) => findDispatchedApply(github, params),

    /**
     * The latest apply runs of one environment that contain a commit (their
     * head is the commit or a descendant), newest first. A run created before
     * the commit cannot contain it, so the search starts at the commit's
     * time. An apply of another environment is never returned: its progress
     * says nothing about this operation. Throws `RunLookupIncompleteError`
     * when more runs lie beyond the ones inspected and too few were found, as
     * a missing run must not be read as the absence of an apply.
     * @param {{repository: string, environment: string, commit: {sha: string, committedAt: string}, signal?: AbortSignal}} params
     * @returns {Promise<import('#/github/github-client.js').WorkflowRun[]>}
     */
    findAppliesContaining: (params) => findAppliesContaining(github, params)
  }
}
