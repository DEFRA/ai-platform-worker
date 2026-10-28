import { EventEmitter } from 'node:events'

import { createFakeLogger } from '../../../test/fakes/fake-logger.js'
import { exitOnUnhandledRejection } from '#/common/helpers/exit-on-unhandled-rejection.js'

describe('#exitOnUnhandledRejection', () => {
  test('logs the failure and exits non-zero on an unhandled rejection', () => {
    const target = new EventEmitter()
    const logger = { ...createFakeLogger(), fatal: vi.fn() }
    const exit = vi.fn()

    exitOnUnhandledRejection({ logger, exit, target })
    target.emit('unhandledRejection', new Error('boom'))

    expect(logger.fatal).toHaveBeenCalledWith(
      { message: 'boom' },
      'Unhandled rejection, exiting'
    )
    expect(exit).toHaveBeenCalledWith(1)
  })

  test('copes with a rejection that is not an error', () => {
    const target = new EventEmitter()
    const logger = { fatal: vi.fn() }
    const exit = vi.fn()

    exitOnUnhandledRejection({ logger, exit, target })
    target.emit('unhandledRejection', undefined)

    expect(logger.fatal).toHaveBeenCalledWith(
      { message: undefined },
      expect.any(String)
    )
    expect(exit).toHaveBeenCalledWith(1)
  })

  test('exits through process.exit by default', () => {
    const target = new EventEmitter()
    const logger = { fatal: vi.fn() }
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined)

    exitOnUnhandledRejection({ logger, target })
    target.emit('unhandledRejection', new Error('boom'))

    expect(exit).toHaveBeenCalledWith(1)

    exit.mockRestore()
  })

  test('registers on the process, with the shared logger, by default', () => {
    const on = vi.spyOn(process, 'on').mockImplementation(() => process)

    exitOnUnhandledRejection()

    expect(on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function))

    on.mockRestore()
  })
})
