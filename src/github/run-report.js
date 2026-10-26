const FIRST_ATTEMPT = 1

/**
 * Which attempt of its run a report belongs to. A rerun keeps its run ID, and
 * the workflows upload `run-report-{environment}.json` under a fixed name that
 * cannot be overwritten, so the report an earlier attempt uploaded is still on
 * the run when a later attempt is read. Every event the run reported is kept
 * in the report with the `runAttempt` that sent it, which is the evidence.
 *
 * A report that names no attempt is shown to be the first attempt's only: the
 * first attempt is the only one that could have uploaded it first. For a
 * rerun it cannot be shown to belong to it, so it is not used.
 * @param {object|null} report
 * @param {number} runAttempt - the attempt of the run being read
 * @returns {object|null} the report, or null when it is not the attempt's
 */
export function reportOfAttempt(report, runAttempt) {
  if (!report) {
    return null
  }

  const attempts = (report.events ?? [])
    .map((event) => event.runAttempt)
    .filter(Number.isInteger)

  const belongs =
    attempts.length === 0
      ? runAttempt === FIRST_ATTEMPT
      : attempts.every((attempt) => attempt === runAttempt)

  return belongs ? report : null
}
