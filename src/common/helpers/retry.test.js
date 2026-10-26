import { retry, isTransientError } from '#/common/helpers/retry.js'

const transient = () => Object.assign(new Error('boom'), { status: 502 })

describe('#retry', () => {
  test('returns the result of the first attempt without waiting', async () => {
    const sleep = vi.fn()
    const operation = vi.fn().mockResolvedValue('done')

    await expect(retry(operation, { sleep })).resolves.toBe('done')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  test('retries a transient error with jittered, growing delays, then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue()
    const operation = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue('done')

    const result = await retry(operation, {
      retries: 2,
      baseMs: 100,
      maxMs: 1000,
      random: () => 0.5,
      sleep
    })

    expect(result).toBe('done')
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([50, 100])
  })

  test('caps the delay at maxMs', async () => {
    const sleep = vi.fn().mockResolvedValue()
    const operation = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValue('ok')

    await retry(operation, { baseMs: 5000, maxMs: 200, random: () => 1, sleep })

    expect(sleep.mock.calls[0][0]).toBe(200)
  })

  test('gives up after the last retry and throws the last error', async () => {
    const sleep = vi.fn().mockResolvedValue()
    const error = transient()
    const operation = vi.fn().mockRejectedValue(error)

    await expect(retry(operation, { retries: 2, sleep })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(3)
  })

  test('does not retry an error that is not transient', async () => {
    const sleep = vi.fn()
    const error = Object.assign(new Error('missing'), { status: 404 })
    const operation = vi.fn().mockRejectedValue(error)

    await expect(retry(operation, { sleep })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  test('does not retry once the signal is aborted', async () => {
    const controller = new AbortController()
    const operation = vi.fn().mockImplementation(async () => {
      controller.abort(new Error('deadline'))
      throw transient()
    })

    await expect(
      retry(operation, { signal: controller.signal, sleep: vi.fn() })
    ).rejects.toThrow('boom')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  test('the default sleep waits and stops at once when the signal aborts', async () => {
    const controller = new AbortController()
    const operation = vi.fn().mockRejectedValue(transient())
    const pending = retry(operation, {
      signal: controller.signal,
      baseMs: 60000,
      maxMs: 60000,
      random: () => 1
    })

    setTimeout(() => controller.abort(new Error('deadline')), 5)

    await expect(pending).rejects.toThrow('deadline')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  test('the default sleep resolves after the delay', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValue('ok')

    await expect(
      retry(operation, { baseMs: 1, maxMs: 1, random: () => 1 })
    ).resolves.toBe('ok')
  })
})

describe('#isTransientError', () => {
  test.each([
    ['a 500', { status: 500 }, true],
    ['a 503', { status: 503 }, true],
    ['a connection reset', { code: 'ECONNRESET' }, true],
    ['a reset reported on the cause', { cause: { code: 'ETIMEDOUT' } }, true],
    ['a 404', { status: 404 }, false],
    ['a 422', { status: 422 }, false],
    ['a 403', { status: 403 }, false],
    ['an abort', { name: 'AbortError' }, false],
    ['a timeout', { name: 'TimeoutError', status: 500 }, false],
    ['nothing known', {}, false]
  ])('%s is transient: %s', (_name, error, expected) => {
    expect(isTransientError(Object.assign(new Error('x'), error))).toBe(
      expected
    )
  })
})
