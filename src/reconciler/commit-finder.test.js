import {
  OPERATION_ID,
  SHA,
  TEAM_PATH,
  TENANTS_REPO
} from '../../test/fixtures/gitops-messages.js'
import {
  createInMemoryGitHubClient,
  mainCommit
} from '../../test/fakes/in-memory-github-client.js'
import { createCommitFinder } from '#/reconciler/commit-finder.js'

const SINCE = '2026-10-26T12:00:00Z'

function setup(commits) {
  const github = createInMemoryGitHubClient()

  github.seedCommits(TENANTS_REPO, commits)

  return { github, finder: createCommitFinder({ github }) }
}

const find = (finder, extra = {}) =>
  finder.find({
    repository: TENANTS_REPO,
    path: TEAM_PATH,
    operationId: OPERATION_ID,
    since: SINCE,
    ...extra
  })

describe('#commit-finder', () => {
  test('finds the commit on main whose Operation-Id trailer names the operation', async () => {
    const { finder } = setup([
      mainCommit({
        path: TEAM_PATH,
        sha: 'a'.repeat(40),
        message: 'Other\n\nOperation-Id: op-other-1'
      }),
      mainCommit({
        path: TEAM_PATH,
        sha: SHA,
        committedAt: '2026-10-26T12:00:24Z'
      })
    ])

    await expect(find(finder)).resolves.toEqual({
      sha: SHA,
      committedAt: '2026-10-26T12:00:24Z'
    })
  })

  test('asks GitHub for the file path since the time, with the signal', async () => {
    const { finder, github } = setup([])
    const signal = new AbortController().signal

    await find(finder, { signal })

    expect(github.calls).toEqual([
      {
        method: 'listCommits',
        repository: TENANTS_REPO,
        path: TEAM_PATH,
        since: SINCE,
        signal
      }
    ])
  })

  test('finds nothing when no commit names the operation', async () => {
    const { finder } = setup([
      mainCommit({ path: TEAM_PATH, message: 'Operation-Id: op-other-1' })
    ])

    await expect(find(finder)).resolves.toBeNull()
  })

  test('does not match an operation ID that only contains the one asked for', async () => {
    const { finder } = setup([
      mainCommit({
        path: TEAM_PATH,
        message: 'x\n\nOperation-Id: op-7f3c9a1e-extra'
      }),
      mainCommit({
        path: TEAM_PATH,
        message: 'Mentions Operation-Id: op-7f3c9a1e in prose'
      })
    ])

    await expect(find(finder)).resolves.toBeNull()
  })

  test('matches the trailer in any case, and among several trailers', async () => {
    const { finder } = setup([
      mainCommit({
        path: TEAM_PATH,
        sha: 'b'.repeat(40),
        message:
          'Change\n\noperation-id: op-first-0001\nOperation-Id:   op-7f3c9a1e  \nRequested-By: app:x'
      })
    ])

    await expect(find(finder)).resolves.toMatchObject({ sha: 'b'.repeat(40) })
  })

  test('takes the newest commit when two name the operation', async () => {
    const { finder } = setup([
      mainCommit({
        path: TEAM_PATH,
        sha: 'a'.repeat(40),
        committedAt: '2026-10-26T12:01:00Z'
      }),
      mainCommit({
        path: TEAM_PATH,
        sha: 'b'.repeat(40),
        committedAt: '2026-10-26T12:30:00Z'
      })
    ])

    await expect(find(finder)).resolves.toMatchObject({ sha: 'b'.repeat(40) })
  })
})
