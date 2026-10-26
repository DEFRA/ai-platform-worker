/**
 * The GitHub port of the worker (plan 6.1, 8): the few calls the handlers and
 * the reconciler make, in the worker's own terms. The Octokit adapter
 * implements it for real; `test/fakes/in-memory-github-client.js` implements
 * it for tests; `github-client-contract.js` holds the shared contract suite
 * both must pass.
 *
 * Every call takes the handler's `signal`, so each one stops at the handler
 * timeout (plan 7, Timeouts). Repositories are `owner/name`.
 *
 * @typedef {object} WorkflowRun
 * @property {number} id
 * @property {string} name - the run's name (`run-name`), which holds the operation ID
 * @property {string} status - `queued`, `in_progress` or `completed`
 * @property {string|null} conclusion - `success`, `failure`, `cancelled`, ... once completed
 * @property {string} event
 * @property {string} headSha
 * @property {number} runAttempt
 * @property {string} createdAt - ISO 8601
 * @property {string} htmlUrl
 *
 * @typedef {object} MainCommit
 * @property {string} sha
 * @property {string} message
 * @property {string} committedAt - ISO 8601
 *
 * @typedef {object} GitHubClient
 * @property {(params: {repository: string, workflowId: string, inputs: Record<string, string>, signal?: AbortSignal}) => Promise<{runId: number|null, runUrl: string|null}>} dispatchWorkflow
 *   dispatches the workflow on `main`; asks GitHub for the run it created
 * @property {(params: {repository: string, workflowId: string, createdFrom: string, signal?: AbortSignal}) => Promise<WorkflowRun[]>} listWorkflowRuns
 *   the workflow's runs on `main` created at or after `createdFrom`, newest first
 * @property {(params: {repository: string, runId: number, environment: string, signal?: AbortSignal}) => Promise<object|null>} getRunReport
 *   the parsed `run-report-{environment}.json` artifact, or null when the run has no unexpired one
 * @property {(params: {repository: string, path: string, since: string, signal?: AbortSignal}) => Promise<MainCommit[]>} listCommits
 *   the commits on `main` that touched `path` since the time, newest first
 * @property {(params: {repository: string, ancestor: string, descendant: string, signal?: AbortSignal}) => Promise<boolean>} isAncestor
 *   whether `ancestor` is `descendant` or an ancestor of it
 */

/** The workflow the worker dispatches to commit a change. */
export const SUBMIT_WORKFLOW = 'submit.yml'

/** The workflow the worker dispatches to apply a state. */
export const APPLY_WORKFLOW = 'apply.yml'

/** The only branch the worker dispatches on and reads. */
export const MAIN = 'main'

export {}
