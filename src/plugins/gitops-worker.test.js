import { gitopsWorker } from '#/plugins/gitops-worker.js'
import { createServer } from '#/server.js'

function fakeConsumer() {
  const state = { running: false }

  return {
    state,
    start: vi.fn(() => {
      state.running = true
    }),
    stop: vi.fn(async () => {
      state.running = false
    }),
    get isRunning() {
      return state.running
    }
  }
}

async function serverWith(consumer) {
  const createRuntime = vi.fn().mockReturnValue(consumer)
  const server = await createServer({
    worker: { plugin: gitopsWorker.plugin, options: { createRuntime } }
  })

  return { server, createRuntime }
}

describe('#gitops-worker plugin', () => {
  test('builds the runtime from the server logger and metrics, and does not start it yet', async () => {
    const consumer = fakeConsumer()
    const { server, createRuntime } = await serverWith(consumer)

    expect(createRuntime).toHaveBeenCalledWith({
      logger: server.logger,
      metrics: server.metrics
    })
    expect(consumer.start).not.toHaveBeenCalled()
    expect(server.gitopsConsumer).toBe(consumer)
  })

  test('starts the consumer once the server has started, and stops it in onPreStop, awaiting it', async () => {
    const consumer = fakeConsumer()
    let release
    const stopping = new Promise((resolve) => {
      release = resolve
    })

    consumer.stop.mockImplementation(async () => {
      await stopping
      consumer.state.running = false
    })

    const { server } = await serverWith(consumer)

    await server.initialize()
    await server.start()

    expect(consumer.start).toHaveBeenCalledTimes(1)
    expect(consumer.isRunning).toBe(true)

    let stopped = false
    const stopPromise = server.stop().then(() => {
      stopped = true
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(consumer.stop).toHaveBeenCalledTimes(1)
    expect(stopped).toBe(false)

    release()
    await stopPromise

    expect(stopped).toBe(true)
    expect(consumer.isRunning).toBe(false)
  })

  test('/health is 200 while the consumer runs and 503 when it is not running', async () => {
    const consumer = fakeConsumer()
    const { server } = await serverWith(consumer)

    await server.initialize()

    expect((await server.inject('/health')).statusCode).toBe(503)

    consumer.start()

    const running = await server.inject('/health')

    expect(running.statusCode).toBe(200)
    expect(running.result).toEqual({ message: 'success' })

    await consumer.stop()

    const stopped = await server.inject('/health')

    expect(stopped.statusCode).toBe(503)
    expect(stopped.result).toEqual({ message: 'consumer stopped' })
  })

  test('the only route is /health', async () => {
    const { server } = await serverWith(fakeConsumer())

    expect(server.table().map((route) => route.path)).toEqual(['/health'])
  })
})
