import { PublishCommand } from '@aws-sdk/client-sns'

import {
  exampleEvent,
  OPERATION_ID
} from '../../test/fixtures/gitops-messages.js'
import { createInMemoryEventsPublisher } from '../../test/fakes/in-memory-events-publisher.js'
import { describeEventsPublisherContract } from '#/events/events-publisher-contract.js'
import { createSnsEventsPublisher } from '#/events/sns-events-publisher.js'

const TOPIC_ARN =
  'arn:aws:sns:eu-west-2:000000000000:aip_gitops_events_worker.fifo'

describeEventsPublisherContract('in-memory fake', () => {
  const fake = createInMemoryEventsPublisher()

  return { publisher: fake, published: () => fake.events }
})

describeEventsPublisherContract('SNS adapter', () => {
  const sent = []
  const client = {
    // A publish the signal has aborted never reaches the topic.
    send: vi.fn(async (command, { abortSignal } = {}) => {
      abortSignal?.throwIfAborted()
      sent.push(JSON.parse(command.input.Message))
    })
  }

  return {
    publisher: createSnsEventsPublisher({ client, topicArn: TOPIC_ARN }),
    published: () => sent
  }
})

function setup(send = vi.fn().mockResolvedValue({})) {
  const client = { send }

  return {
    client,
    publisher: createSnsEventsPublisher({ client, topicArn: TOPIC_ARN })
  }
}

describe('#sns-events-publisher', () => {
  test('publishes the event as JSON with its operation as the group and its event ID as the deduplication ID', async () => {
    const { client, publisher } = setup()
    const event = exampleEvent('committed', { source: 'reconciler' })

    await publisher.publish(event)

    const [command] = client.send.mock.calls[0]

    expect(command).toBeInstanceOf(PublishCommand)
    expect(command.input).toEqual({
      TopicArn: TOPIC_ARN,
      Message: JSON.stringify(event),
      MessageGroupId: OPERATION_ID,
      MessageDeduplicationId: event.eventId
    })
  })

  test('passes the handler signal to the publish', async () => {
    const { client, publisher } = setup()
    const signal = new AbortController().signal

    await publisher.publish(exampleEvent('requested'), { signal })

    expect(client.send.mock.calls[0][1]).toEqual({ abortSignal: signal })
  })

  test('refuses an invalid event without publishing anything', async () => {
    const { client, publisher } = setup()

    await expect(
      publisher.publish(exampleEvent('requested', { surprise: true }))
    ).rejects.toMatchObject({ code: 'invalid-event' })
    expect(client.send).not.toHaveBeenCalled()
  })

  test('propagates a failure, so SQS redelivers the command', async () => {
    const error = Object.assign(new Error('denied'), { status: 403 })
    const { publisher } = setup(vi.fn().mockRejectedValue(error))

    await expect(publisher.publish(exampleEvent('requested'))).rejects.toBe(
      error
    )
  })
})
