import { resourcesOf } from '#/reconciler/resources-mapper.js'

// Pure: what GitHub holds (a run, a commit, a run report) becomes the
// `aip.gitops.event/1` the workflows would have sent (plan 5, "Deadlines,
// reconcile and verification"). No I/O, so every rule is tested on its own.

const SOURCE = 'reconciler'
// A run that ended badly: the submit or apply did not do its job.
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'startup_failure',
  'action_required'
])
// A report that says the apply did not run for this operation: a newer run
// took over, or the run is only the first, pending report.
const UNUSABLE_OUTCOMES = new Set([
  'superseded',
  'cancelled',
  'skipped',
  'pending'
])
const PAUSED_OUTCOME = 'paused'
const SUCCESS_OUTCOME = 'success'
const MAX_MESSAGE = 1000

/**
 * How a run stands: `active` (queued or running), `succeeded`, `failed`, or
 * `unusable` (cancelled, skipped or otherwise ended with nothing to report).
 * @param {import('#/github/github-client.js').WorkflowRun} run
 * @returns {'active'|'succeeded'|'failed'|'unusable'}
 */
export function runPhase(run) {
  if (run.status !== 'completed') {
    return 'active'
  }

  if (run.conclusion === 'success') {
    return 'succeeded'
  }

  return FAILED_CONCLUSIONS.has(run.conclusion) ? 'failed' : 'unusable'
}

/**
 * What an apply run's report says about one operation: `unlisted` (the report
 * is missing or does not name it), `deployed`, `paused`, `unusable` (the run
 * was superseded or never finished) or `failed`.
 * @param {object|null} report
 * @param {string} operationId
 * @returns {'unlisted'|'deployed'|'paused'|'unusable'|'failed'}
 */
export function applyVerdict(report, operationId) {
  const listed = (report?.operations ?? []).some((commit) =>
    commit.operationIds?.includes(operationId)
  )

  if (!listed) {
    return 'unlisted'
  }

  if (report.outcome === SUCCESS_OUTCOME) {
    return 'deployed'
  }

  if (report.outcome === PAUSED_OUTCOME) {
    return 'paused'
  }

  return UNUSABLE_OUTCOMES.has(report.outcome) ? 'unusable' : 'failed'
}

// The event as it is for every status: the target and audit fields come from
// the command, the run from GitHub. `action` is the command's when it has one;
// a reconcile from `committed` or `deploying` carries none, and an event for
// an apply run is an `apply` event.
function baseEvent(command, status, run, now) {
  return {
    schema: 'aip.gitops.event/1',
    eventId: `${command.operationId}:${status}:${run.id}:${run.runAttempt}`,
    environment: command.environment,
    team: command.team,
    path: command.path,
    action: command.action ?? 'apply',
    status,
    timestamp: now.toISOString(),
    source: SOURCE,
    requestedBy: command.requestedBy,
    repository: command.repository,
    traceparent: command.traceparent,
    cdpRequestId: command.cdpRequestId,
    operationId: command.operationId,
    runId: run.id,
    runAttempt: run.runAttempt,
    runUrl: run.htmlUrl
  }
}

/**
 * `requested`: the submit run exists and is queued or running.
 * @param {{command: object, run: object, now: Date}} facts
 */
export function requestedEvent({ command, run, now }) {
  return baseEvent(command, 'requested', run, now)
}

/**
 * `committed`: the commit with the operation's trailer is on main; the run is
 * the submit run that made it.
 * @param {{command: object, run: object, commit: {sha: string, committedAt: string}, now: Date}} facts
 */
export function committedEvent({ command, run, commit, now }) {
  return {
    ...baseEvent(command, 'committed', run, now),
    commitSha: commit.sha,
    committedAt: commit.committedAt
  }
}

/**
 * `deploying`: an apply run containing the commit is queued or running.
 * @param {{command: object, run: object, commit: {sha: string, committedAt: string}, now: Date}} facts
 */
export function deployingEvent({ command, run, commit, now }) {
  return {
    ...baseEvent(command, 'deploying', run, now),
    commitSha: commit.sha,
    committedAt: commit.committedAt
  }
}

/**
 * `deployed`: the apply run's report lists the operation and its outcome is
 * `success`. `appliedSha` is the report's, else the run's own head.
 * @param {{command: object, run: object, commit: {sha: string, committedAt: string}, report: object, now: Date}} facts
 */
export function deployedEvent({ command, run, commit, report, now }) {
  return {
    ...baseEvent(command, 'deployed', run, now),
    commitSha: commit.sha,
    committedAt: commit.committedAt,
    appliedSha: report.appliedSha ?? run.headSha,
    resources: resourcesOf(report, command.team)
  }
}

/**
 * `deploy-failed`: the report lists the operation and its outcome is not
 * `success`. A `paused` outcome is the retryable refusal; any other failure
 * is attributable only when the report names this operation's team as failing
 * and says the failure was not unattributed, as the workflows decide.
 * @param {{command: object, run: object, commit: {sha: string, committedAt: string}, report: object, now: Date}} facts
 */
export function deployFailedEvent({ command, run, commit, report, now }) {
  const paused = report.outcome === PAUSED_OUTCOME
  const failingTeams = paused ? [] : (report.failingTeams ?? [])

  return {
    ...baseEvent(command, 'deploy-failed', run, now),
    commitSha: commit.sha,
    committedAt: commit.committedAt,
    failureReason: paused
      ? {
          code: 'paused',
          message: 'The environment is paused; the apply ran nothing.',
          retryable: true
        }
      : {
          code: 'apply-failed',
          message: 'The apply failed; the run has the details.',
          retryable: false
        },
    failingTeams,
    attributable:
      !paused &&
      failingTeams.includes(command.team) &&
      report.unattributedFailure === false
  }
}

// The reason a submit run recorded with its own `checks-failed` event, if the
// run report kept one for this operation.
export function recordedFailureOf(report, operationId) {
  return (report?.events ?? []).find(
    (event) =>
      event.operationId === operationId && event.status === 'checks-failed'
  )?.failureReason
}

/**
 * `checks-failed`: the submit run ended badly. The reason is the one the run
 * recorded in its report (so a retryable refusal such as `stale-revision`
 * keeps its code and the backend alone decides what to resubmit); without
 * one, a plain non-retryable failure that names the conclusion.
 * @param {{command: object, run: object, report: object|null, now: Date}} facts
 */
export function checksFailedEvent({ command, run, report, now }) {
  const recorded = recordedFailureOf(report, command.operationId)

  return {
    ...baseEvent(command, 'checks-failed', run, now),
    failureReason: recorded
      ? {
          code: recorded.code,
          message: String(recorded.message).slice(0, MAX_MESSAGE),
          retryable: recorded.retryable
        }
      : {
          code: 'submit-failed',
          message: `The submit run ended with ${run.conclusion}; the run has the details.`,
          retryable: false
        }
  }
}
