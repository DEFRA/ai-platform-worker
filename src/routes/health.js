const HTTP_OK = 200
const HTTP_SERVICE_UNAVAILABLE = 503

export const health = {
  method: 'GET',
  path: '/health',
  // 200 while the commands consumer runs; 503 once it has stopped, so the
  // platform replaces a worker that is no longer taking commands (plan 7).
  handler: (request, h) => {
    const running = request.server.gitopsConsumer?.isRunning === true

    return h
      .response({ message: running ? 'success' : 'consumer stopped' })
      .code(running ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE)
  }
}
