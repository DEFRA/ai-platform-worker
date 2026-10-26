import { SendMessageCommand } from '@aws-sdk/client-sqs'

import {
  exampleEvent,
  OPERATION_ID
} from '../../test/fixtures/gitops-messages.js'
import { createSqsEventsPublisher } from '#/events/sqs-events-publisher.js'
import { createSqsClient } from '#/sqs/sqs-client.js'

const QUEUE_URL = 'http://floci:4566/000000000000/aip-gitops-events.fifo'
const NO_WAIT = { sleep: async () => {}, random: () => 0 }

function setup(send = vi.fn().mockResolvedValue({})) {
  const client = { send }

  return {
    client,
    publisher: createSqsEventsPublisher({
      client,
      queueUrl: QUEUE_URL,
      retryOptions: NO_WAIT
    })
  }
}

describe('#sqs-events-publisher', () => {
  test('sends the event as JSON with its operation as the group and its event ID as the deduplication ID', async () => {
    const { client, publisher } = setup()
    const event = exampleEvent('committed', { source: 'reconciler' })

    await publisher.publish(event)

    const [command] = client.send.mock.calls[0]

    expect(command).toBeInstanceOf(SendMessageCommand)
    expect(command.input).toEqual({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(event),
      MessageGroupId: OPERATION_ID,
      MessageDeduplicationId: event.eventId
    })
  })

  test('passes the handler signal to the send', async () => {
    const { client, publisher } = setup()
    const signal = new AbortController().signal

    await publisher.publish(exampleEvent('requested'), { signal })

    expect(client.send.mock.calls[0][1]).toEqual({ abortSignal: signal })
  })

  test('refuses an invalid event without sending anything', async () => {
    const { client, publisher } = setup()

    await expect(
      publisher.publish(exampleEvent('requested', { surprise: true }))
    ).rejects.toMatchObject({ code: 'invalid-event' })
    expect(client.send).not.toHaveBeenCalled()
  })

  test('tries a send again after a transient failure', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('down'), { $metadata: {}, status: 503 })
      )
      .mockResolvedValue({})
    const { publisher } = setup(send)

    await publisher.publish(exampleEvent('requested'))

    expect(send).toHaveBeenCalledTimes(2)
  })

  test('propagates a failure that is not transient, so SQS redelivers the command', async () => {
    const error = Object.assign(new Error('denied'), { status: 403 })
    const { publisher } = setup(vi.fn().mockRejectedValue(error))

    await expect(publisher.publish(exampleEvent('requested'))).rejects.toBe(
      error
    )
  })
})

describe('#sqs-client', () => {
  test('uses static local credentials when an endpoint is given', async () => {
    const client = createSqsClient({
      endpoint: 'http://floci:4566',
      region: 'eu-west-2'
    })

    expect(await client.config.region()).toBe('eu-west-2')
    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: expect.any(String)
    })
  })

  test('uses the default provider chain and the standard region without an endpoint', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1')

    const client = createSqsClient()

    expect(await client.config.region()).toBe('eu-west-1')

    vi.unstubAllEnvs()
  })

  test('falls back to eu-west-2 when nothing names a region', async () => {
    vi.stubEnv('AWS_REGION', '')
    delete process.env.AWS_REGION

    const client = createSqsClient()

    expect(await client.config.region()).toBe('eu-west-2')

    vi.unstubAllEnvs()
  })
})
