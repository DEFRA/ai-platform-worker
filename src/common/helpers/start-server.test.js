import hapi from '@hapi/hapi'

describe('#startServer', () => {
  let createServerSpy
  let hapiServerSpy
  let startServerImport
  let createServerImport

  // The worker plugin is replaced: a real one needs queues and App credentials.
  const worker = {
    plugin: {
      name: 'gitops-worker',
      register(server) {
        server.decorate('server', 'gitopsConsumer', { isRunning: true })
      }
    }
  }

  beforeAll(async () => {
    vi.stubEnv('PORT', '3098')
    createServerImport = await import('#/server.js')
    startServerImport = await import('./start-server.js')

    createServerSpy = vi.spyOn(createServerImport, 'createServer')
    hapiServerSpy = vi.spyOn(hapi, 'server')
  })

  afterAll(() => {
    vi.resetAllMocks()
  })

  describe('When server starts', () => {
    test('Should start up server as expected', async () => {
      const server = await startServerImport.startServer({ worker })

      expect(createServerSpy).toHaveBeenCalledWith({ worker })
      expect(hapiServerSpy).toHaveBeenCalled()

      await server.stop()
    })
  })

  describe('When server start fails', () => {
    test('Should log failed startup message', async () => {
      createServerSpy.mockRejectedValue(new Error('Server failed to start'))

      await expect(startServerImport.startServer()).rejects.toThrow(
        'Server failed to start'
      )
    })
  })
})
