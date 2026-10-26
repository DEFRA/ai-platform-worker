import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand
} from '@aws-sdk/client-sqs'
import { randomUUID } from 'node:crypto'

import { exampleCommand } from '../../test/fixtures/gitops-messages.js'
import { createFakeLogger } from '../../test/fakes/fake-logger.js'
import { createFakeMetrics } from '../../test/fakes/fake-metrics.js'
import { createCommandsConsumer } from '#/commands/commands-consumer.js'
import { createSqsClient } from '#/sqs/sqs-client.js'

// Proves the FIFO behaviour `sqs-consumer` does not test (plan DD14): order in
// a message group, deduplication by ID, redelivery and the dead-letter queue
// after three receives. It needs Floci, so it runs only when FLOCI_ENDPOINT is
// set (README, "Run locally"): `npm test` skips it, and the `floci` job of
// check-pull-request.yml runs it against a Floci service container.
const endpoint = process.env.FLOCI_ENDPOINT
const ALLOWED = new Set(['DEFRA/ai-platform-tenants'])
const VISIBILITY_TIMEOUT_SECONDS = 1

describe.skipIf(!endpoint)('commands consumer on Floci (FIFO)', () => {
  const sqs = createSqsClient({ endpoint })
  let queueUrl
  let deadLetterUrl
  let consumer

  async function createFifo(name, attributes = {}) {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          ...attributes
        }
      })
    )

    return QueueUrl
  }

  async function arnOf(url) {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['QueueArn']
      })
    )

    return Attributes.QueueArn
  }

  function send(command) {
    return sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(command),
        MessageGroupId: `${command.environment}/${command.team}`,
        MessageDeduplicationId: command.commandId
      })
    )
  }

  function start(handler) {
    consumer = createCommandsConsumer({
      queueUrl,
      sqs,
      handling: {
        handlers: { submit: handler, apply: vi.fn(), reconcile: vi.fn() },
        allowedRepositories: ALLOWED,
        handlerTimeoutMs: 5000,
        metrics: createFakeMetrics()
      },
      settings: {
        // The consumer sets the visibility of every message it receives, which
        // overrides the queue's: without this the three redeliveries of AC8
        // take three minutes, not three seconds.
        visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
        waitTimeSeconds: 1,
        handlerTimeoutMs: 5000,
        shutdownWaitMs: 5000
      },
      logger: createFakeLogger()
    })
    consumer.start()
  }

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8)

    deadLetterUrl = await createFifo(`aip-test-dlq-${suffix}.fifo`)
    queueUrl = await createFifo(`aip-test-${suffix}.fifo`, {
      VisibilityTimeout: String(VISIBILITY_TIMEOUT_SECONDS),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: await arnOf(deadLetterUrl),
        maxReceiveCount: '3'
      })
    })
  })

  afterEach(async () => {
    await consumer?.stop()
  })

  test('handles the commands of one message group in the order they were sent', async () => {
    const seen = []

    start(async (command) => {
      seen.push(command.attempt)

      return 'dispatched'
    })

    for (const attempt of [1, 2, 3]) {
      await send(exampleCommand({ attempt }))
    }

    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3]), { timeout: 20000 })
  })

  test('collapses a command sent twice with one commandId', async () => {
    const handler = vi.fn().mockResolvedValue('dispatched')
    const command = exampleCommand()

    start(handler)
    await send(command)
    await send(command)

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), {
      timeout: 20000
    })
    await new Promise((resolve) => setTimeout(resolve, 3000))

    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('AC8: a command that fails three times reaches the dead-letter queue', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('GitHub is down'))
    const command = exampleCommand()

    start(handler)
    await send(command)

    await vi.waitFor(
      async () => {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: deadLetterUrl,
            WaitTimeSeconds: 1
          })
        )

        expect(Messages.map(({ Body }) => JSON.parse(Body).commandId)).toEqual([
          command.commandId
        ])
      },
      { timeout: 40000, interval: 500 }
    )
    expect(handler).toHaveBeenCalledTimes(3)
  }, 60000)
})
