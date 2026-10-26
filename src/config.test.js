import { config } from '#/config.js'

describe('#config', () => {
  test('the GitOps settings default as the plan lists them (section 5)', () => {
    expect(config.get('gitops')).toEqual({
      commandsQueueUrl: null,
      eventsQueueUrl: null,
      tenantsRepo: 'DEFRA/ai-platform-tenants',
      deploymentsRepo: 'DEFRA/ai-platform-deployments',
      awsSqsEndpoint: null,
      awsRegion: 'eu-west-2',
      handlerTimeoutMs: 30000,
      sqsWaitTimeSeconds: 20,
      shutdownWaitMs: 20000
    })
  })

  test('the GitHub App credentials are unset by default and never printed', () => {
    expect(config.get('github')).toEqual({
      appId: null,
      installationId: null,
      privateKey: null
    })
    expect(JSON.stringify(config.toString())).not.toMatch(/BEGIN/)
  })

  test('the queue, repository and timeout settings are read from the environment', async () => {
    vi.resetModules()
    vi.stubEnv('GITOPS_COMMANDS_QUEUE_URL', 'http://floci/commands.fifo')
    vi.stubEnv('GITOPS_EVENTS_QUEUE_URL', 'http://floci/events.fifo')
    vi.stubEnv('GITOPS_TENANTS_REPO', 'ORG/tenants')
    vi.stubEnv('HANDLER_TIMEOUT_MS', '1000')
    vi.stubEnv('SQS_WAIT_TIME_SECONDS', '1')

    const { config: fresh } = await import('#/config.js')

    expect(fresh.get('gitops.commandsQueueUrl')).toBe(
      'http://floci/commands.fifo'
    )
    expect(fresh.get('gitops.eventsQueueUrl')).toBe('http://floci/events.fifo')
    expect(fresh.get('gitops.tenantsRepo')).toBe('ORG/tenants')
    expect(fresh.get('gitops.handlerTimeoutMs')).toBe(1000)
    expect(fresh.get('gitops.sqsWaitTimeSeconds')).toBe(1)

    vi.unstubAllEnvs()
  })

  test('refuses a repository that is not owner/name', async () => {
    vi.resetModules()
    vi.stubEnv('GITOPS_TENANTS_REPO', 'not-a-repository')

    await expect(import('#/config.js')).rejects.toThrow(/tenantsRepo/)

    vi.unstubAllEnvs()
  })
})
