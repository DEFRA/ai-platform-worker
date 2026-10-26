import { createFakeGitHub } from '../../test/fakes/fake-github-http.js'
import {
  GITHUB_API_VERSION,
  WORKER_PERMISSIONS,
  createGithubAppClient,
  credentialsFromConfig,
  toPemPrivateKey
} from '#/github/github-app-client.js'

const CREDENTIALS = {
  appId: '12345',
  installationId: '67890',
  privateKey: 'pem-text'
}
const DISPATCH =
  'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches'

function setup({ onRateLimit, routes = {} } = {}) {
  const github = createFakeGitHub({
    'GET /repos/{owner}/{repo}/commits': () => ({
      body: [],
      headers: { 'x-ratelimit-remaining': '4321' }
    }),
    [DISPATCH]: () => ({ status: 204 }),
    'PUT /repos/{owner}/{repo}/contents/{path}': () => ({ body: {} }),
    ...routes
  })
  const tokens = []
  const createAuth = vi.fn().mockReturnValue(async (request) => {
    tokens.push(request)

    return { token: 'installation-token' }
  })
  const client = createGithubAppClient(
    { repositoryNames: ['ai-platform-tenants'] },
    {
      credentials: CREDENTIALS,
      createAuth,
      fetch: github.fetch,
      onRateLimit
    }
  )

  return { client, github, tokens, createAuth }
}

describe('#github-app-client', () => {
  describe('scope', () => {
    test('needs explicit repositories and permissions', () => {
      const deps = { credentials: CREDENTIALS }

      expect(() => createGithubAppClient({}, deps)).toThrow(
        /explicit repositoryNames and permissions/
      )
      expect(() =>
        createGithubAppClient({ repositoryNames: [] }, deps)
      ).toThrow(/explicit repositoryNames/)
      expect(() =>
        createGithubAppClient({ repositoryNames: ['x'], permissions: {} }, deps)
      ).toThrow(/explicit repositoryNames/)
      expect(() => createGithubAppClient(undefined, deps)).toThrow(
        /explicit repositoryNames/
      )
    })

    test.each([
      ['an administration permission', { administration: 'read' }],
      ['contents write', { contents: 'write' }],
      ['metadata write', { metadata: 'write' }],
      ['pull requests', { pull_requests: 'read' }],
      ['an unknown level', { actions: 'admin' }]
    ])('refuses %s', (_name, permissions) => {
      expect(() =>
        createGithubAppClient(
          { repositoryNames: ['x'], permissions },
          { credentials: CREDENTIALS }
        )
      ).toThrow(/may only request actions: write, contents: read/)
    })

    test('the default permissions are exactly the worker allow-list', () => {
      expect(WORKER_PERMISSIONS).toEqual({
        actions: 'write',
        contents: 'read',
        metadata: 'read'
      })
      expect(Object.isFrozen(WORKER_PERMISSIONS)).toBe(true)
    })

    test('refuses to start without the App credentials, naming the settings and not their values', () => {
      expect(() =>
        createGithubAppClient(
          { repositoryNames: ['x'] },
          { credentials: { ...CREDENTIALS, privateKey: null } }
        )
      ).toThrow(
        'GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY must all be set'
      )
    })
  })

  describe('requests', () => {
    test('mints an installation token down-scoped to the repository and the allow-listed permissions', async () => {
      const { client, github, tokens } = setup()

      await client.request('GET /repos/{owner}/{repo}/commits', {
        owner: 'DEFRA',
        repo: 'ai-platform-tenants'
      })

      expect(tokens).toEqual([
        {
          type: 'installation',
          repositoryNames: ['ai-platform-tenants'],
          permissions: WORKER_PERMISSIONS
        }
      ])
      expect(github.requests[0].headers.authorization).toBe(
        'token installation-token'
      )
      expect(github.requests[0].headers['x-github-api-version']).toBe(
        GITHUB_API_VERSION
      )
    })

    test('creates the App auth with the credentials', () => {
      const { createAuth } = setup()

      expect(createAuth).toHaveBeenCalledWith(
        expect.objectContaining(CREDENTIALS)
      )
    })

    test('allows a workflow dispatch, the one write', async () => {
      const { client } = setup()

      const response = await client.request(DISPATCH, {
        owner: 'DEFRA',
        repo: 'ai-platform-tenants',
        workflow_id: 'submit.yml',
        ref: 'main'
      })

      expect(response.status).toBe(204)
    })

    test.each([
      [
        'a contents write',
        'PUT /repos/{owner}/{repo}/contents/{path}',
        { path: 'x.json', message: 'm', content: 'e30=' }
      ],
      [
        'a branch delete',
        'DELETE /repos/{owner}/{repo}/git/refs/{ref}',
        { ref: 'heads/main' }
      ],
      [
        'a dispatch of another kind',
        'POST /repos/{owner}/{repo}/dispatches',
        { event_type: 'x' }
      ]
    ])('refuses %s before it mints a token', async (_name, route, params) => {
      const { client, github, tokens } = setup()

      await expect(
        client.request(route, {
          owner: 'DEFRA',
          repo: 'ai-platform-tenants',
          ...params
        })
      ).rejects.toMatchObject({ code: 'github-write-refused' })
      expect(tokens).toEqual([])
      expect(github.requests).toEqual([])
    })

    test('reports the rate limit that remains after each request', async () => {
      const onRateLimit = vi.fn()
      const { client } = setup({ onRateLimit })

      await client.request('GET /repos/{owner}/{repo}/commits', {
        owner: 'DEFRA',
        repo: 'ai-platform-tenants'
      })
      await client.request(DISPATCH, {
        owner: 'DEFRA',
        repo: 'ai-platform-tenants',
        workflow_id: 'submit.yml',
        ref: 'main'
      })

      expect(onRateLimit).toHaveBeenCalledTimes(1)
      expect(onRateLimit).toHaveBeenCalledWith(4321)
    })

    test('does not wait between writes (the throttling plugin is off)', async () => {
      const { client } = setup()
      const started = Date.now()
      const dispatch = () =>
        client.request(DISPATCH, {
          owner: 'DEFRA',
          repo: 'ai-platform-tenants',
          workflow_id: 'submit.yml',
          ref: 'main'
        })

      await dispatch()
      await dispatch()

      expect(Date.now() - started).toBeLessThan(900)
    })
  })

  describe('credentials', () => {
    test('decodes the base64 private key a CDP secret holds', () => {
      expect(
        toPemPrivateKey(Buffer.from('line1\nline2').toString('base64'))
      ).toBe('line1\nline2')
      expect(toPemPrivateKey(null)).toBeNull()
    })

    test('reads them from configuration, decoding the key', () => {
      expect(credentialsFromConfig()).toEqual({
        appId: null,
        installationId: null,
        privateKey: null
      })
    })
  })
})
