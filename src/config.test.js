import { config } from '#/config.js'

describe('#config', () => {
  test('the GitOps settings default as the plan lists them (section 5)', () => {
    expect(config.get('gitops')).toEqual({
      commandsQueueUrl: null,
      eventsTopicArn: null,
      tenantsRepo: 'DEFRA/ai-platform-tenants',
      deploymentsRepo: 'DEFRA/ai-platform-deployments',
      awsSqsEndpoint: null,
      awsSnsEndpoint: null,
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

  test('the queue, topic, repository and timeout settings are read from the environment', async () => {
    vi.resetModules()
    vi.stubEnv('GITOPS_COMMANDS_QUEUE_URL', 'http://floci/commands.fifo')
    vi.stubEnv('GITOPS_EVENTS_TOPIC_ARN', 'arn:aws:sns:eu-west-2:0:events.fifo')
    vi.stubEnv('AWS_SNS_ENDPOINT', 'http://floci:4566')
    vi.stubEnv('GITOPS_TENANTS_REPO', 'ORG/tenants')
    vi.stubEnv('HANDLER_TIMEOUT_MS', '1000')
    vi.stubEnv('SQS_WAIT_TIME_SECONDS', '1')

    const { config: fresh } = await import('#/config.js')

    expect(fresh.get('gitops.commandsQueueUrl')).toBe(
      'http://floci/commands.fifo'
    )
    expect(fresh.get('gitops.eventsTopicArn')).toBe(
      'arn:aws:sns:eu-west-2:0:events.fifo'
    )
    expect(fresh.get('gitops.awsSnsEndpoint')).toBe('http://floci:4566')
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

  // The consumer asks for a 60 s visibility timeout on every message, so a
  // handler that may run that long could still be working when the message
  // reaches another worker, and FIFO exclusion would no longer hold.
  test.each(['120000', '60000'])(
    'refuses a handler timeout of %s ms, which the queue visibility timeout does not outlast',
    async (value) => {
      vi.resetModules()
      vi.stubEnv('HANDLER_TIMEOUT_MS', value)

      await expect(import('#/config.js')).rejects.toThrow(
        /handlerTimeoutMs.*below the queue visibility timeout of 60000 ms/
      )

      vi.unstubAllEnvs()
    }
  )

  test('accepts a handler timeout just under the visibility timeout, and the default', async () => {
    vi.resetModules()
    vi.stubEnv('HANDLER_TIMEOUT_MS', '59999')

    const { config: fresh } = await import('#/config.js')

    expect(fresh.get('gitops.handlerTimeoutMs')).toBe(59999)
    expect(config.get('gitops.handlerTimeoutMs')).toBe(30000)

    vi.unstubAllEnvs()
  })

  test('refuses a handler timeout that is not a whole number of ms', async () => {
    vi.resetModules()
    vi.stubEnv('HANDLER_TIMEOUT_MS', 'soon')

    await expect(import('#/config.js')).rejects.toThrow(/handlerTimeoutMs/)

    vi.unstubAllEnvs()
  })

  test('in production logs ECS JSON, redacts headers and still redacts documents and requesters', async () => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')

    const { config: fresh } = await import('#/config.js')

    expect(fresh.get('log.format')).toBe('ecs')
    expect(fresh.get('log.isEnabled')).toBe(true)
    expect(fresh.get('log.redact')).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers',
        'document',
        '*.requestedBy',
        '*.token'
      ])
    )

    vi.unstubAllEnvs()
  })

  test('in test logs nothing by default and pretty-prints when enabled', () => {
    expect(config.get('log.isEnabled')).toBe(false)
    expect(config.get('log.format')).toBe('pino-pretty')
    expect(config.get('log.redact')).toEqual(
      expect.arrayContaining(['req', 'res', 'document', 'requestedBy'])
    )
  })
})
