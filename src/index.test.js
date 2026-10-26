const exitOnUnhandledRejection = vi.fn()
const startServer = vi.fn()

vi.mock('#/common/helpers/exit-on-unhandled-rejection.js', () => ({
  exitOnUnhandledRejection
}))
vi.mock('#/common/helpers/start-server.js', () => ({ startServer }))

describe('#index', () => {
  test('exits on an unhandled rejection and starts the server', async () => {
    await import('#/index.js')

    expect(exitOnUnhandledRejection).toHaveBeenCalledTimes(1)
    expect(startServer).toHaveBeenCalledTimes(1)
    expect(exitOnUnhandledRejection.mock.invocationCallOrder[0]).toBeLessThan(
      startServer.mock.invocationCallOrder[0]
    )
  })
})
