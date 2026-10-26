export const health = {
  method: 'GET',
  path: '/health',
  // 200 while the commands consumer runs; 503 once it has stopped, so the
  // platform replaces a worker that is no longer taking commands (plan 7).
  handler: (request, h) => {
    const running = request.server.gitopsConsumer?.isRunning === true

    return h
      .response({ message: running ? 'success' : 'consumer stopped' })
      .code(running ? 200 : 503)
  }
}
