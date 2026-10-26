import { Octokit } from 'octokit'
import { createAppAuth } from '@octokit/auth-app'

import { config } from '#/config.js'
import { APPLY_WORKFLOW, SUBMIT_WORKFLOW } from '#/github/github-client.js'

/**
 * GitHub's REST API version, pinned on every request so a change of GitHub's
 * default can never alter a response shape; in this version the workflow
 * dispatch endpoint returns the run it created.
 */
export const GITHUB_API_VERSION = '2026-03-10'

/**
 * The only GitHub App permissions the worker may ever request (plan 6.3):
 * `actions: write` to dispatch (it implies read for runs and artifacts),
 * `contents: read` for commits, `metadata: read`. Any other permission, or a
 * higher level, is refused.
 */
export const WORKER_PERMISSIONS = Object.freeze({
  actions: 'write',
  contents: 'read',
  metadata: 'read'
})

const ALLOWED_LEVELS = {
  actions: new Set(['read', 'write']),
  contents: new Set(['read']),
  metadata: new Set(['read'])
}
const READ_METHODS = new Set(['GET', 'HEAD'])
// The worker's one write: starting a workflow. Nothing else may change state.
const ALLOWED_WRITE_ROUTES = new Set([
  'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches'
])
const ALLOWED_WORKFLOWS = new Set([SUBMIT_WORKFLOW, APPLY_WORKFLOW])

function assertScope(repositoryNames, permissions) {
  if (
    !Array.isArray(repositoryNames) ||
    repositoryNames.length === 0 ||
    !permissions ||
    Object.keys(permissions).length === 0
  ) {
    throw new Error(
      'A GitHub client needs explicit repositoryNames and permissions'
    )
  }

  for (const [name, level] of Object.entries(permissions)) {
    if (!ALLOWED_LEVELS[name]?.has(level)) {
      throw new Error(
        `The worker may only request ${Object.entries(WORKER_PERMISSIONS)
          .map(([permission, max]) => `${permission}: ${max}`)
          .join(', ')} or lower; refused ${name}: ${level}`
      )
    }
  }
}

/**
 * CDP's secret store rejects values containing real newlines, so the private
 * key is stored base64-encoded as a single line; @octokit/auth-app needs the
 * multi-line PEM to sign its JWT.
 * @param {string | null} base64PrivateKey
 * @returns {string | null}
 */
export function toPemPrivateKey(base64PrivateKey) {
  return base64PrivateKey
    ? Buffer.from(base64PrivateKey, 'base64').toString('utf8')
    : null
}

/**
 * The App credentials from configuration.
 * @returns {{appId: string|null, installationId: string|null, privateKey: string|null}}
 */
export function credentialsFromConfig() {
  return {
    appId: config.get('github.appId'),
    installationId: config.get('github.installationId'),
    privateKey: toPemPrivateKey(config.get('github.privateKey'))
  }
}

// An installation token lasts an hour; like the auth library's own cache, keep
// it a minute short of that. The auth is built per request (so each token
// exchange can carry that request's signal), so the cache outlives it.
const TOKEN_CACHE_TTL_MS = 59 * 60 * 1000

function createTokenCache(now = Date.now) {
  const entries = new Map()

  return {
    get(key) {
      const entry = entries.get(key)

      if (entry && entry.expiresAt <= now()) {
        entries.delete(key)
        return undefined
      }

      return entry?.value
    },
    set(key, value) {
      entries.set(key, { value, expiresAt: now() + TOKEN_CACHE_TTL_MS })
    }
  }
}

// Every caller owns its resilience (the adapter retries reads, the handler
// owns the dispatch), so Octokit's bundled retry and throttling plugins, which
// would sleep inside a request for minutes, are both off.
function createBaseOctokit({ auth, fetch } = {}) {
  const octokit = new Octokit({
    auth,
    request: { retries: 0, ...(fetch ? { fetch } : {}) },
    throttle: { enabled: false }
  })

  octokit.hook.before('request', (options) => {
    options.headers['x-github-api-version'] = GITHUB_API_VERSION
  })

  return octokit
}

// Refuses any request that is not a read or the one allow-listed dispatch,
// whatever token the client holds. Octokit runs the hook registered last
// first, so this is registered after the authentication hook and refuses
// before a token is minted.
function refuseUnlistedWrites(octokit) {
  octokit.hook.before('request', (options) => {
    const route = `${options.method} ${options.url}`

    // The one write is a dispatch of `submit.yml` or `apply.yml`: the App is
    // exempt from the workflows' admin check, so the worker must never start
    // `pause.yml`, `reconcile-all.yml` or any other workflow.
    if (
      !READ_METHODS.has(options.method) &&
      !(
        ALLOWED_WRITE_ROUTES.has(route) &&
        ALLOWED_WORKFLOWS.has(options.workflow_id)
      )
    ) {
      const error = new Error(
        `The worker's GitHub client may only read and dispatch ${[...ALLOWED_WORKFLOWS].join(' and ')}; refused ${route}`
      )
      error.code = 'github-write-refused'
      throw error
    }
  })

  return octokit
}

function reportRateLimit(octokit, onRateLimit) {
  octokit.hook.after('request', (response) => {
    const remaining = Number(response.headers?.['x-ratelimit-remaining'])

    if (!Number.isNaN(remaining)) {
      onRateLimit(remaining)
    }
  })
}

/**
 * Creates an Octokit client for one repository, authenticated as the GitHub
 * App installation with a token down-scoped to `repositoryNames` and
 * `permissions` (plan 6.3). Tokens are minted lazily on the first request and
 * cached by the auth library until shortly before they expire. Any request
 * other than a read or a workflow dispatch is refused.
 * @param {object} scope
 * @param {string[]} scope.repositoryNames
 * @param {Record<string, 'read'|'write'>} [scope.permissions]
 * @param {object} [deps]
 * @param {ReturnType<typeof credentialsFromConfig>} [deps.credentials]
 * @param {typeof createAppAuth} [deps.createAuth]
 * @param {typeof fetch} [deps.fetch]
 * @param {(remaining: number) => void} [deps.onRateLimit]
 * @returns {Octokit}
 */
export function createGithubAppClient(
  { repositoryNames, permissions = WORKER_PERMISSIONS } = {},
  {
    credentials = credentialsFromConfig(),
    createAuth = createAppAuth,
    fetch,
    onRateLimit
  } = {}
) {
  assertScope(repositoryNames, permissions)

  const { appId, installationId, privateKey } = credentials

  if (!appId || !installationId || !privateKey) {
    throw new Error(
      'GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY must all be set'
    )
  }

  // The App's own requests (the JWT-signed token exchange) go through a
  // separate client so they never re-enter the hook below.
  const appRequest = createBaseOctokit({ fetch }).request
  const tokenCache = createTokenCache()
  const octokit = createBaseOctokit({ fetch })

  octokit.hook.before('request', async (options) => {
    const signal = options.request?.signal

    // A request the handler has already abandoned must not mint a token.
    signal?.throwIfAborted()

    try {
      // The exchange is bound to this request's own signal (never shared with
      // another request's), so a stalled exchange stops with the handler. The
      // tokens are cached across requests by the cache all the auths share.
      const appAuth = createAuth({
        appId,
        privateKey,
        installationId,
        cache: tokenCache,
        request: signal
          ? appRequest.defaults({ request: { signal } })
          : appRequest
      })
      const { token } = await appAuth({
        type: 'installation',
        repositoryNames,
        permissions
      })

      options.headers.authorization = `token ${token}`
    } catch (error) {
      // Octokit wraps an aborted exchange as a 500; the handler's abort reason
      // is what the caller needs (and what the retry helper never retries).
      throw signal?.aborted ? signal.reason : error
    }
  })

  if (onRateLimit) {
    reportRateLimit(octokit, onRateLimit)
  }

  return refuseUnlistedWrites(octokit)
}
