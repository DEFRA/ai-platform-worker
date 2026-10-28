import {
  CommandRefusedError,
  assertCommandTarget
} from '#/commands/command-target.js'
import {
  DEPLOYMENTS_REPO,
  TENANTS_REPO,
  exampleApply,
  exampleCommand
} from '../../test/fixtures/gitops-messages.js'

const ALLOWED = new Set([TENANTS_REPO, DEPLOYMENTS_REPO])

describe('#command-target', () => {
  test('accepts a command for either state repository under its environment', () => {
    expect(() => assertCommandTarget(exampleCommand(), ALLOWED)).not.toThrow()
    expect(() =>
      assertCommandTarget(
        exampleCommand({
          repository: DEPLOYMENTS_REPO,
          path: 'environments/infradev/platform.json'
        }),
        ALLOWED
      )
    ).not.toThrow()
  })

  test('accepts an apply for no operation, which has no path', () => {
    expect(() => assertCommandTarget(exampleApply(), ALLOWED)).not.toThrow()
  })

  test('refuses a repository the worker is not configured for', () => {
    expect(() =>
      assertCommandTarget(
        exampleCommand({ repository: 'DEFRA/other' }),
        ALLOWED
      )
    ).toThrow(
      expect.objectContaining({
        name: 'CommandRefusedError',
        code: 'repository-refused'
      })
    )
  })

  test('refuses a path outside the command environment', () => {
    const error = (() => {
      try {
        assertCommandTarget(
          exampleCommand({ path: 'environments/prod/alpha.json' }),
          ALLOWED
        )
      } catch (thrown) {
        return thrown
      }
    })()

    expect(error).toBeInstanceOf(CommandRefusedError)
    expect(error.code).toBe('path-refused')
  })
})
