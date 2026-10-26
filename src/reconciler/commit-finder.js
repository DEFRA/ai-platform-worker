// Finds the commit a submit made, by the `Operation-Id` trailer the workflow
// writes (`Operation-Id`, `Requested-By` and `Traceparent`; plan 5, Commit).
// The same pattern infra `checks/src/git.js` parses.

const OPERATION_ID_LINE = /^Operation-Id:[ \t]*(\S+)[ \t]*$/gim

function operationIdsIn(message) {
  return [...message.matchAll(OPERATION_ID_LINE)].map(([, id]) => id)
}

/**
 * @param {{github: import('#/github/github-client.js').GitHubClient}} deps
 */
export function createCommitFinder({ github }) {
  return {
    /**
     * The newest commit on main that touched `path` since `since` and names
     * the operation in its trailer, or null. Reading by path keeps it to the
     * one file's history, so a busy repository costs one call.
     * @param {{repository: string, path: string, operationId: string, since: string, signal?: AbortSignal}} params
     * @returns {Promise<{sha: string, committedAt: string}|null>}
     */
    async find({ repository, path, operationId, since, signal }) {
      const commits = await github.listCommits({
        repository,
        path,
        since,
        signal
      })
      const found = commits.find((commit) =>
        operationIdsIn(commit.message).includes(operationId)
      )

      return found ? { sha: found.sha, committedAt: found.committedAt } : null
    }
  }
}
