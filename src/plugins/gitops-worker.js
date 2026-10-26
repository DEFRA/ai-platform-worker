import { createWorkerRuntime } from '#/worker-runtime.js'

/**
 * Runs the GitOps worker inside the Hapi server (plan 7): the consumer
 * starts once the server has, and stops in `onPreStop` (which `hapi-pulse`
 * runs on SIGTERM), waiting up to `GITOPS_SHUTDOWN_WAIT_MS` for the command in
 * flight. The server holds only `/health`, which reports the consumer.
 */
export const gitopsWorker = {
  plugin: {
    name: 'gitops-worker',
    register(server, options = {}) {
      const { createRuntime = createWorkerRuntime } = options
      const consumer = createRuntime({
        logger: server.logger,
        metrics: server.metrics
      })

      server.decorate('server', 'gitopsConsumer', consumer)
      server.ext('onPostStart', () => {
        consumer.start()
        server.logger.info('The commands consumer started')
      })
      server.ext('onPreStop', async () => {
        server.logger.info('Stopping the commands consumer')
        await consumer.stop()
      })
    }
  }
}
