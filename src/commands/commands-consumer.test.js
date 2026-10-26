import { EventEmitter } from 'node:events'

import {
  CDP_REQUEST_ID,
  OID,
  OPERATION_ID,
  TENANTS_REPO,
  DEPLOYMENTS_REPO,
  exampleApply,
  exampleCommand,
  exampleReconcile
} from '../../test/fixtures/gitops-messages.js'
import { createFakeLogger } from '../../test/fakes/fake-logger.js'
import { createFakeMetrics } from '../../test/fakes/fake-metrics.js'
import { createFakeSqsQueue } from '../../test/fakes/fake-sqs-queue.js'
import {
  createCommandsConsumer,
  createMessageHandler
} from '#/commands/commands-consumer.js'

const QUEUE_URL = 'http://floci:4566/000000000000/aip-gitops-commands.fifo'
const ALLOWED = new Set([TENANTS_REPO, DEPLOYMENTS_REPO])
const SETTINGS = {
  waitTimeSeconds: 20,
  handlerTimeoutMs: 30000,
  shutdownWaitMs: 20000
}

function setup({ handlers, handlerTimeoutMs = 30000 } = {}) {
  const logger = createFakeLogger()
  const metrics = createFakeMetrics()
  const allHandlers = {
    submit: vi.fn().mockResolvedValue('dispatched'),
    apply: vi.fn().mockResolvedValue('dispatched'),
    reconcile: vi.fn().mockResolvedValue('requested'),
    ...handlers
  }

  return {
    logger,
    metrics,
    handlers: allHandlers,
    handleMessage: createMessageHandler({
      handlers: allHandlers,
      allowedRepositories: ALLOWED,
      handlerTimeoutMs,
      logger,
      metrics
    })
  }
}

const message = (body) => ({ MessageId: 'm-1', Body: JSON.stringify(body) })

describe('#commands-consumer message handler', () => {
  test('runs the handler for the command type with a signal and a logger bound to its IDs', async () => {
    const { handleMessage, handlers, logger } = setup()
    const command = exampleCommand()

    await handleMessage(message(command))

    expect(handlers.submit).toHaveBeenCalledWith(command, {
      signal: expect.any(AbortSignal),
      logger
    })
    expect(logger.bindings).toEqual([
      {
        commandId: command.commandId,
        operationId: OPERATION_ID,
        type: 'submit',
        environment: 'infradev',
        traceparent: command.traceparent,
        trace: { id: CDP_REQUEST_ID }
      }
    ])
  })

  test.each([
    ['submit', exampleCommand()],
    ['apply', exampleApply()],
    ['reconcile', exampleReconcile('requested')]
  ])('routes a %s command to its own handler only', async (type, command) => {
    const { handleMessage, handlers } = setup()

    await handleMessage(message(command))

    for (const [name, handler] of Object.entries(handlers)) {
      expect(handler).toHaveBeenCalledTimes(name === type ? 1 : 0)
    }
  })

  test('AC13: binds the CDP request ID as the trace ID, and omits it when the command has none', async () => {
    const { handleMessage, logger } = setup()

    await handleMessage(message(exampleApply()))

    expect(logger.bindings[0]).not.toHaveProperty('trace')
  })

  test('never logs the document, the requester or the message body', async () => {
    const { handleMessage, logger } = setup()
    const command = exampleCommand()

    await handleMessage(message(command))

    const logged = JSON.stringify([
      logger.bindings,
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls
    ])

    expect(logged).not.toContain(OID)
    expect(logged).not.toContain('"revision"')
  })

  test('counts a handled command by type and outcome', async () => {
    const { handleMessage, metrics } = setup()

    await handleMessage(message(exampleCommand()))

    expect(metrics.counter).toHaveBeenCalledWith('commandsHandled', 1, {
      type: 'submit',
      outcome: 'dispatched'
    })
  })

  test('a handler failure is logged with its code and rethrown, so the message is not acknowledged', async () => {
    const error = Object.assign(new Error('GitHub is down'), { code: 'x-down' })
    const { handleMessage, logger, metrics } = setup({
      handlers: { submit: vi.fn().mockRejectedValue(error) }
    })

    await expect(handleMessage(message(exampleCommand()))).rejects.toBe(error)
    expect(logger.error).toHaveBeenCalledWith(
      { code: 'x-down', message: 'GitHub is down' },
      expect.stringContaining('redelivered')
    )
    expect(metrics.counter).toHaveBeenCalledWith('commandsHandled', 1, {
      type: 'submit',
      outcome: 'error'
    })
  })

  test('a failure with no code is logged by its name', async () => {
    const { handleMessage, logger } = setup({
      handlers: { submit: vi.fn().mockRejectedValue(new TypeError('bad')) }
    })

    await expect(handleMessage(message(exampleCommand()))).rejects.toThrow(
      'bad'
    )
    expect(logger.error.mock.calls[0][0].code).toBe('TypeError')
  })

  test.each([
    ['not JSON', { MessageId: 'm-2', Body: '{nope' }, 'invalid-command-json'],
    [
      'not a command',
      message({ schema: 'aip.gitops.command/1', type: 'submit' }),
      'invalid-command'
    ],
    [
      'a command with an extra field',
      message(exampleCommand({ surprise: true })),
      'invalid-command'
    ]
  ])('%s: refused and rethrown, never handled', async (_name, body, code) => {
    const { handleMessage, handlers, logger, metrics } = setup()

    await expect(handleMessage(body)).rejects.toMatchObject({ code })
    expect(
      Object.values(handlers).every((handler) => !handler.mock.calls.length)
    ).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      { messageId: body.MessageId, code },
      expect.stringContaining('dead-lettered')
    )
    expect(metrics.counter).toHaveBeenCalledWith('commandsHandled', 1, {
      type: 'unknown',
      outcome: 'error'
    })
  })

  test('a command for a repository the worker is not for is refused', async () => {
    const { handleMessage, handlers } = setup()

    await expect(
      handleMessage(message(exampleCommand({ repository: 'DEFRA/elsewhere' })))
    ).rejects.toMatchObject({ code: 'repository-refused' })
    expect(handlers.submit).not.toHaveBeenCalled()
  })

  test('the handler signal aborts at the handler timeout (every outbound call stops with it)', async () => {
    const { handleMessage, handlers } = setup({
      handlerTimeoutMs: 20,
      handlers: {
        submit: vi.fn(
          (_command, { signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason))
            })
        )
      }
    })

    await expect(
      handleMessage(message(exampleCommand()))
    ).rejects.toMatchObject({
      name: 'TimeoutError'
    })
    expect(handlers.submit).toHaveBeenCalledTimes(1)
  })
})

describe('#commands-consumer (the real sqs-consumer over an in-memory FIFO queue)', () => {
  let consumer
  let queue

  function start({ handlers } = {}) {
    queue = createFakeSqsQueue({ maxReceiveCount: 3 })

    const world = setup({ handlers })

    consumer = createCommandsConsumer({
      queueUrl: QUEUE_URL,
      sqs: queue,
      handling: {
        handlers: world.handlers,
        allowedRepositories: ALLOWED,
        handlerTimeoutMs: 30000,
        metrics: world.metrics
      },
      settings: { ...SETTINGS, errorPauseMs: 5 },
      logger: world.logger
    })
    consumer.start()

    return world
  }

  afterEach(async () => {
    await consumer?.stop()
  })

  test('a handled command is deleted from the queue, once', async () => {
    const world = start()
    const command = exampleCommand()

    queue.enqueue(command)

    await vi.waitFor(() => expect(queue.deleted).toEqual([command]))
    expect(world.handlers.submit).toHaveBeenCalledTimes(1)
    expect(queue.deadLetters).toEqual([])
  })

  test('AC8: a command that fails three times reaches the dead-letter queue and is never deleted', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('GitHub is down'))

    start({ handlers: { submit: handler } })

    const command = exampleCommand()

    queue.enqueue(command)

    await vi.waitFor(() => expect(queue.deadLetters).toEqual([command]))
    expect(handler).toHaveBeenCalledTimes(3)
    expect(queue.deleted).toEqual([])
  })

  test('AC8: a command that fails once is redelivered and then deleted, with one effect', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue('dispatched')

    start({ handlers: { submit: handler } })

    const command = exampleCommand()

    queue.enqueue(command)

    await vi.waitFor(() => expect(queue.deleted).toEqual([command]))
    expect(handler).toHaveBeenCalledTimes(2)
    expect(queue.deadLetters).toEqual([])
  })

  test.each([
    ['a message that is not JSON', '{nope'],
    ['a message that is not a command', { hello: 'world' }]
  ])(
    'AC8: %s is never handled and reaches the dead-letter queue',
    async (_name, body) => {
      const world = start()

      queue.enqueue(body)

      await vi.waitFor(() => expect(queue.deadLetters).toHaveLength(1))
      expect(
        Object.values(world.handlers).every(
          (handler) => !handler.mock.calls.length
        )
      ).toBe(true)
      expect(queue.deleted).toEqual([])
    }
  )

  test('a duplicate delivery of one command is handled twice but each handler call is safe: the handler decides (AC3)', async () => {
    const world = start()
    const command = exampleCommand()

    queue.enqueue(command)
    queue.enqueue(command)

    await vi.waitFor(() => expect(queue.deleted).toHaveLength(2))
    expect(world.handlers.submit).toHaveBeenCalledTimes(2)
  })

  test('stop resolves once polling has stopped, and a second stop is immediate', async () => {
    start()

    expect(consumer.isRunning).toBe(true)

    await consumer.stop()

    expect(consumer.isRunning).toBe(false)
    await expect(consumer.stop()).resolves.toBeUndefined()
  })
})

describe('#commands-consumer options and events', () => {
  function fakeLibrary() {
    const emitter = new EventEmitter()
    const created = []
    const status = { isRunning: false }
    const library = Object.assign(emitter, {
      status,
      start: vi.fn(() => {
        status.isRunning = true
      }),
      stop: vi.fn((options) => {
        status.isRunning = false
        library.stopOptions = options
        emitter.emit('stopped')
      })
    })

    return {
      library,
      created,
      createConsumer(options) {
        created.push(options)

        return library
      }
    }
  }

  function build() {
    const fake = fakeLibrary()
    const logger = createFakeLogger()
    const consumer = createCommandsConsumer({
      queueUrl: QUEUE_URL,
      sqs: {},
      handling: {
        handlers: {},
        allowedRepositories: ALLOWED,
        handlerTimeoutMs: 30000,
        metrics: createFakeMetrics()
      },
      settings: SETTINGS,
      logger,
      createConsumer: fake.createConsumer
    })

    return { fake, consumer, logger }
  }

  test('creates the consumer as DD14 and plan 7 say', () => {
    const { fake } = build()

    expect(fake.created[0]).toMatchObject({
      queueUrl: QUEUE_URL,
      batchSize: 1,
      suppressFifoWarning: true,
      alwaysAcknowledge: true,
      waitTimeSeconds: 20,
      visibilityTimeout: 60,
      handleMessageTimeout: 30000,
      pollingCompleteWaitTimeMs: 20000,
      authenticationErrorTimeout: 10000
    })
    expect(fake.created[0].handleMessage).toEqual(expect.any(Function))
  })

  test('the visibility timeout stays above the handler timeout', () => {
    const { fake } = build()

    expect(fake.created[0].visibilityTimeout * 1000).toBeGreaterThan(
      fake.created[0].handleMessageTimeout
    )
  })

  test('takes the visibility timeout from the settings when given, so a test queue can redeliver quickly', () => {
    const fake = fakeLibrary()

    createCommandsConsumer({
      queueUrl: QUEUE_URL,
      sqs: {},
      handling: {
        handlers: {},
        allowedRepositories: ALLOWED,
        handlerTimeoutMs: 30000,
        metrics: createFakeMetrics()
      },
      settings: { ...SETTINGS, visibilityTimeoutSeconds: 1 },
      logger: createFakeLogger(),
      createConsumer: fake.createConsumer
    })

    expect(fake.created[0].visibilityTimeout).toBe(1)
  })

  test('starts, and stops by aborting the long poll', async () => {
    const { fake, consumer } = build()

    consumer.start()

    expect(fake.library.start).toHaveBeenCalled()
    expect(consumer.isRunning).toBe(true)

    await consumer.stop()

    expect(fake.library.stopOptions).toEqual({ abort: true })
  })

  test('logs the library events with IDs and the failure only', () => {
    const { fake, logger } = build()

    fake.library.emit('error', new Error('queue gone'))
    fake.library.emit(
      'processing_error',
      new Error('wrapped', { cause: new Error('the cause') }),
      { MessageId: 'm-9', Body: 'SECRET DOCUMENT' }
    )
    fake.library.emit('timeout_error', new Error('too slow'), {
      MessageId: 'm-8'
    })

    expect(logger.error).toHaveBeenCalledWith(
      { message: 'queue gone' },
      'The commands queue failed'
    )
    expect(logger.warn).toHaveBeenCalledWith(
      { messageId: 'm-9', message: 'the cause' },
      expect.stringContaining('redelivered')
    )
    expect(logger.warn).toHaveBeenCalledWith(
      { messageId: 'm-8', message: 'too slow' },
      expect.stringContaining('timed out')
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET')
  })

  test('a processing error with no message and no cause is still logged', () => {
    const { fake, logger } = build()

    fake.library.emit('processing_error', new Error('plain'))

    expect(logger.warn).toHaveBeenCalledWith(
      { messageId: undefined, message: 'plain' },
      expect.any(String)
    )
  })
})
