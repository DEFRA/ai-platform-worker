import { createInMemoryGitHubClient } from '../../test/fakes/in-memory-github-client.js'
import { describeGitHubClientContract } from '#/github/github-client-contract.js'

describeGitHubClientContract('in-memory fake', () => {
  const client = createInMemoryGitHubClient()

  return {
    client,
    seedRuns: client.seedRuns,
    seedCommits: client.seedCommits,
    seedReport: client.seedReport,
    seedAncestor: client.seedAncestor,
    dispatches: () => client.dispatches
  }
})

describe('#in-memory GitHub client', () => {
  test('records every call and can fail the next one of a kind', async () => {
    const client = createInMemoryGitHubClient()
    const error = new Error('down')

    client.failNext('listCommits', error)

    await expect(
      client.listCommits({
        repository: 'a/b',
        path: 'p',
        since: '2026-10-26T00:00:00Z'
      })
    ).rejects.toBe(error)
    await expect(
      client.listCommits({
        repository: 'a/b',
        path: 'p',
        since: '2026-10-26T00:00:00Z'
      })
    ).resolves.toEqual([])
    expect(client.calls.map((call) => call.method)).toEqual([
      'listCommits',
      'listCommits'
    ])
  })
})
