import {
  DEPLOYMENTS_REPO,
  TENANTS_REPO
} from '../test/fixtures/gitops-messages.js'
import { createFakeLogger } from '../test/fakes/fake-logger.js'
import { createFakeMetrics } from '../test/fakes/fake-metrics.js'
import { createWorkerRuntime } from '#/worker-runtime.js'

const SETTINGS = {
  commandsQueueUrl: 'http://floci:4566/000000000000/aip-gitops-commands.fifo',
  eventsQueueUrl: 'http://floci:4566/000000000000/aip-gitops-events.fifo',
  tenantsRepo: TENANTS_REPO,
  deploymentsRepo: DEPLOYMENTS_REPO,
  awsSqsEndpoint: 'http://floci:4566',
  awsRegion: 'eu-west-2',
  handlerTimeoutMs: 30000,
  sqsWaitTimeSeconds: 20,
  shutdownWaitMs: 20000
}

function build(settings = SETTINGS) {
  const logger = createFakeLogger()
  const metrics = createFakeMetrics()
  const consumer = { start: vi.fn(), stop: vi.fn(), isRunning: false }
  const createConsumer = vi.fn().mockReturnValue(consumer)
  const sqs = { send: vi.fn() }
  const createClient = vi.fn().mockReturnValue(sqs)
  const createAppClient = vi.fn().mockReturnValue({ request: vi.fn() })
  const runtime = createWorkerRuntime(
    { logger, metrics },
    { settings, createClient, createAppClient, createConsumer }
  )

  return {
    runtime,
    consumer,
    createConsumer,
    createClient,
    createAppClient,
    metrics,
    logger,
    sqs
  }
}

describe('#worker-runtime', () => {
  test('returns the commands consumer', () => {
    const { runtime, consumer } = build()

    expect(runtime).toBe(consumer)
  })

  test('consumes the commands queue with the settings', () => {
    const { createConsumer, sqs, logger } = build()

    expect(createConsumer).toHaveBeenCalledWith(
      expect.objectContaining({
        queueUrl: SETTINGS.commandsQueueUrl,
        sqs,
        logger,
        settings: {
          waitTimeSeconds: 20,
          handlerTimeoutMs: 30000,
          shutdownWaitMs: 20000
        }
      })
    )
  })

  test('has one handler per command type and acts only on the two state repositories', () => {
    const { createConsumer } = build()
    const { handling } = createConsumer.mock.calls[0][0]

    expect(Object.keys(handling.handlers).sort()).toEqual([
      'apply',
      'reconcile',
      'submit'
    ])
    expect(handling.allowedRepositories).toEqual(
      new Set([TENANTS_REPO, DEPLOYMENTS_REPO])
    )
    expect(handling.handlerTimeoutMs).toBe(30000)
  })

  test('creates the SQS client for the local endpoint and region', () => {
    const { createClient } = build()

    expect(createClient).toHaveBeenCalledWith({
      endpoint: 'http://floci:4566',
      region: 'eu-west-2'
    })
  })

  test('uses no endpoint override on CDP', () => {
    const { createClient } = build({ ...SETTINGS, awsSqsEndpoint: null })

    expect(createClient).toHaveBeenCalledWith({
      endpoint: undefined,
      region: 'eu-west-2'
    })
  })

  test('mints one token per state repository, scoped to that repository alone', () => {
    const { createAppClient } = build()

    expect(createAppClient.mock.calls.map(([scope]) => scope)).toEqual([
      { repositoryNames: ['ai-platform-tenants'] },
      { repositoryNames: ['ai-platform-deployments'] }
    ])
  })

  test('reports the GitHub rate limit that remains as a gauge', () => {
    const { createAppClient, metrics } = build()

    createAppClient.mock.calls[0][1].onRateLimit(4200)

    expect(metrics.gauge).toHaveBeenCalledWith('githubRateRemaining', 4200)
  })

  test.each([
    ['no commands queue', { commandsQueueUrl: null }],
    ['no events queue', { eventsQueueUrl: null }]
  ])('fails at once with %s', (_name, change) => {
    expect(() => build({ ...SETTINGS, ...change })).toThrow(
      'GITOPS_COMMANDS_QUEUE_URL and GITOPS_EVENTS_QUEUE_URL must both be set'
    )
  })

  test('fails at once when the GitHub App credentials are missing', () => {
    const logger = createFakeLogger()

    expect(() =>
      createWorkerRuntime(
        { logger, metrics: createFakeMetrics() },
        {
          settings: SETTINGS,
          createClient: vi.fn().mockReturnValue({}),
          createConsumer: vi.fn()
        }
      )
    ).toThrow(/GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID/)
  })

  test('reads its settings from configuration by default', () => {
    expect(() =>
      createWorkerRuntime(
        { logger: createFakeLogger(), metrics: createFakeMetrics() },
        {
          createClient: vi.fn(),
          createAppClient: vi.fn(),
          createConsumer: vi.fn()
        }
      )
    ).toThrow('GITOPS_COMMANDS_QUEUE_URL')
  })
})
