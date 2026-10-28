/**
 * A recording stand-in for a pino logger. `child(bindings)` returns the same
 * recorder and remembers the bindings, so a test can see what a command's
 * logger was bound to.
 * @returns {{info: Function, warn: Function, error: Function, debug: Function, child: Function, bindings: object[]}}
 */
export function createFakeLogger() {
  const bindings = []
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    bindings,
    child: vi.fn((childBindings) => {
      bindings.push(childBindings)

      return logger
    })
  }

  return logger
}
