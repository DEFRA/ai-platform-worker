// A route table over a fake `fetch`: each route is `METHOD /path` with `{name}`
// placeholders and a handler that returns `{status?, body?, headers?}`. Used to
// stand in for api.github.com under a real Octokit, so no test touches the
// network. Requests are recorded for assertions.

function patternOf(path) {
  const escaped = path
    .replace(/[.+?^$()|[\]\\]/g, '\\$&')
    .replace(/\{(\w+)\}/g, '(?<$1>[^/?]+)')

  return new RegExp(`^${escaped}$`)
}

/**
 * @param {Record<string, (request: {params: Record<string,string>, query: URLSearchParams, body: any, headers: Record<string,string>}) => object>} routes
 * @returns {{fetch: typeof fetch, requests: Array<{method: string, path: string, query: URLSearchParams, body: any, headers: Record<string,string>, signal?: AbortSignal}>}}
 */
export function createFakeGitHub(routes) {
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(' ')

    return { method, matcher: patternOf(path), handler }
  })
  const requests = []

  async function fetchFake(input, init = {}) {
    init.signal?.throwIfAborted()

    const request = typeof input === 'string' ? { url: input } : input
    const url = new URL(request.url)
    const method = (init.method ?? request.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    )
    const body = init.body ? JSON.parse(init.body) : undefined

    requests.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
      headers,
      signal: init.signal
    })

    for (const { method: wanted, matcher, handler } of compiled) {
      const match = wanted === method && matcher.exec(url.pathname)

      if (match) {
        const {
          status = 200,
          body: payload,
          headers: extra = {}
        } = handler({
          params: match.groups ?? {},
          query: url.searchParams,
          body,
          headers
        })

        return new Response(
          typeof payload === 'string' || payload === undefined
            ? (payload ?? null)
            : JSON.stringify(payload),
          {
            status,
            headers: { 'content-type': 'application/json', ...extra }
          }
        )
      }
    }

    return new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    })
  }

  return { fetch: fetchFake, requests }
}
