import { CreateTopicCommand, SubscribeCommand } from '@aws-sdk/client-sns'
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand
} from '@aws-sdk/client-sqs'
import { randomUUID } from 'node:crypto'

import { exampleEvent } from '../../test/fixtures/gitops-messages.js'
import { createSnsEventsPublisher } from '#/events/sns-events-publisher.js'
import { createSnsClient } from '#/sns/sns-client.js'
import { createSqsClient } from '#/sqs/sqs-client.js'

// Proves what the unit tests cannot: an event the worker publishes to its own
// FIFO topic reaches the queue subscribed to it, as the same JSON, with no SNS
// envelope (CDP delivers raw), and a repeat event ID collapses. It needs
// Floci, so it runs only when FLOCI_ENDPOINT is set (README, "Run locally").
const endpoint = process.env.FLOCI_ENDPOINT

describe.skipIf(!endpoint)(
  'events publisher on Floci (SNS FIFO to SQS)',
  () => {
    const sns = createSnsClient({ endpoint })
    const sqs = createSqsClient({ endpoint })
    let queueUrl
    let publisher

    async function receiveAll() {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 2
        })
      )

      return Messages.map((message) => message.Body)
    }

    beforeEach(async () => {
      const suffix = randomUUID().slice(0, 8)
      const { TopicArn } = await sns.send(
        new CreateTopicCommand({
          Name: `aip-test-events-${suffix}.fifo`,
          Attributes: {
            FifoTopic: 'true',
            ContentBasedDeduplication: 'false'
          }
        })
      )
      const { QueueUrl } = await sqs.send(
        new CreateQueueCommand({
          QueueName: `aip-test-events-${suffix}.fifo`,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' }
        })
      )
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ['QueueArn']
        })
      )

      await sns.send(
        new SubscribeCommand({
          TopicArn,
          Protocol: 'sqs',
          Endpoint: Attributes.QueueArn,
          Attributes: { RawMessageDelivery: 'true' }
        })
      )

      queueUrl = QueueUrl
      publisher = createSnsEventsPublisher({ client: sns, topicArn: TopicArn })
    })

    test('delivers the event to the subscribed queue as the same JSON', async () => {
      const event = exampleEvent('committed', { source: 'reconciler' })

      await publisher.publish(event)

      expect(await receiveAll()).toEqual([JSON.stringify(event)])
    })

    test('collapses an event published twice with one event ID', async () => {
      const event = exampleEvent('requested')

      await publisher.publish(event)
      await publisher.publish(event)

      expect(await receiveAll()).toEqual([JSON.stringify(event)])
    })
  }
)
