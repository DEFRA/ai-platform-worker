import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

/**
 * An in-memory SQS FIFO queue with a dead-letter queue, speaking just enough
 * of the SDK's `send(command, options)` for `sqs-consumer`: receive, delete
 * and change visibility. A message that was received and not deleted becomes
 * visible again at the next receive (as when its visibility timeout runs
 * out), and after `maxReceiveCount` receives it moves to the dead-letter
 * queue, as the redrive policy does on CDP (3 receives, plan 5).
 * @param {{maxReceiveCount?: number}} [options]
 */
// The body as the test enqueued it: JSON when it parses, else the text.
function bodyOf({ Body }) {
  try {
    return JSON.parse(Body)
  } catch {
    return Body
  }
}

export function createFakeSqsQueue({ maxReceiveCount = 3 } = {}) {
  const visible = []
  const inFlight = new Map()
  const deadLetters = []
  const deleted = []

  function releaseUndeleted() {
    for (const message of inFlight.values()) {
      if (message.receives >= maxReceiveCount) {
        deadLetters.push(bodyOf(message))
      } else {
        visible.unshift(message)
      }
    }

    inFlight.clear()
  }

  async function receive(abortSignal) {
    abortSignal?.throwIfAborted()
    releaseUndeleted()

    const message = visible.shift()

    if (!message) {
      await delay(5, undefined, { signal: abortSignal })

      return { Messages: [] }
    }

    message.receives += 1
    message.ReceiptHandle = randomUUID()
    inFlight.set(message.ReceiptHandle, message)

    return {
      Messages: [
        {
          MessageId: message.MessageId,
          Body: message.Body,
          ReceiptHandle: message.ReceiptHandle,
          Attributes: { ApproximateReceiveCount: String(message.receives) }
        }
      ]
    }
  }

  return {
    deadLetters,
    deleted,
    enqueue(body) {
      visible.push({
        MessageId: randomUUID(),
        Body: typeof body === 'string' ? body : JSON.stringify(body),
        receives: 0
      })
    },
    get pending() {
      return visible.length + inFlight.size
    },
    async send(command, { abortSignal } = {}) {
      switch (command.constructor.name) {
        case 'ReceiveMessageCommand':
          return receive(abortSignal)
        case 'DeleteMessageCommand': {
          const message = inFlight.get(command.input.ReceiptHandle)

          inFlight.delete(command.input.ReceiptHandle)
          deleted.push(bodyOf(message))

          return {}
        }
        default:
          return {}
      }
    }
  }
}
