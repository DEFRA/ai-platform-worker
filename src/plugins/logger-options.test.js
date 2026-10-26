import { Writable } from 'node:stream'

import { pino } from 'pino'
import { getTraceId } from '@defra/hapi-tracing'

import { loggerOptions } from '#/plugins/logger-options.js'

vi.mock('@defra/hapi-tracing', () => ({ getTraceId: vi.fn() }))

function capture() {
  const lines = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()))
      callback()
    }
  })

  return { lines, stream }
}

describe('#logger-options', () => {
  test('never logs a document, a requester, a token or a private key, at the top level or one level down', () => {
    const { lines, stream } = capture()
    const logger = pino({ redact: loggerOptions.redact }, stream)

    logger.info({
      commandId: 'c-1',
      document: '{"secret":true}',
      requestedBy: 'entra:00000000-0000-0000-0000-000000000001',
      token: 'ghs_secret',
      privateKey: 'pem',
      command: {
        operationId: 'op-1',
        document: '{"secret":true}',
        requestedBy: 'entra:x',
        token: 'ghs_secret'
      }
    })

    const line = JSON.stringify(lines[0])

    expect(lines[0].commandId).toBe('c-1')
    expect(lines[0].command.operationId).toBe('op-1')
    expect(line).not.toMatch(/secret|entra:|pem/)
  })

  test('does not log the health check', () => {
    expect(loggerOptions.ignorePaths).toContain('/health')
  })

  test('adds the trace ID of the request to a log line when there is one', () => {
    expect(loggerOptions.mixin()).toEqual({})

    getTraceId.mockReturnValueOnce('3f2b8d1c')

    expect(loggerOptions.mixin()).toEqual({ trace: { id: '3f2b8d1c' } })
  })
})
