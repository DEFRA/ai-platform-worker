/**
 * Whether a submit run can be the one a command is waiting for, given when
 * the command's submission was queued. The run-name carries the operation, not
 * the submission, so a resubmission is told from an earlier attempt's run by
 * time. A retry is created only after the earlier run's failure, and commands
 * are FIFO per team, so a run that had completed before the submission was
 * queued cannot be its own, even when it was created inside a lookback that
 * allows for clock skew. A run still going, or completed at or after that
 * time, can be. The comparison is exact: skew is allowed for only when looking
 * for a run created, not when ruling one out.
 * @param {import('#/github/github-client.js').WorkflowRun} run
 * @param {string} submittedAt - ISO 8601
 * @returns {boolean}
 */
export function canBeRunSubmittedAt(run, submittedAt) {
  return (
    run.status !== 'completed' ||
    Date.parse(run.updatedAt) >= Date.parse(submittedAt)
  )
}
