import {
  TENANTS_REPO,
  exampleApply
} from '../../../test/fixtures/gitops-messages.js'
import { workflowRun } from '../../../test/fakes/in-memory-github-client.js'
import { createWorld } from '../../../test/fakes/world.js'
import { applyInputs } from '#/github/workflow-dispatcher.js'

const APPLY = exampleApply({ createdAt: '2026-10-26T14:00:00Z' })

function seedApplyRunOf(world, command) {
  world.github.seedRuns(TENANTS_REPO, 'apply.yml', [
    workflowRun({
      id: 8,
      name: `apply infradev ${applyInputs(command).reason}`,
      createdAt: '2026-10-26T14:00:02Z'
    })
  ])
}

describe('#apply handler', () => {
  describe('AC3: a duplicate command creates no second dispatch', () => {
    test('dispatches apply.yml for the environment, naming the command in the reason', async () => {
      const world = createWorld()

      await expect(world.apply(APPLY, { logger: world.logger })).resolves.toBe(
        'dispatched'
      )
      expect(world.github.dispatches).toEqual([
        {
          repository: TENANTS_REPO,
          workflowId: 'apply.yml',
          inputs: applyInputs(APPLY)
        }
      ])
    })

    test('a redelivered command dispatches nothing', async () => {
      const world = createWorld()

      seedApplyRunOf(world, APPLY)

      await expect(world.apply(APPLY, { logger: world.logger })).resolves.toBe(
        'duplicate'
      )
      expect(world.github.dispatches).toEqual([])
      expect(world.logger.info).toHaveBeenCalledTimes(1)
    })

    test('a retry, which has its own command ID, is delivered even straight after', async () => {
      const world = createWorld()

      seedApplyRunOf(world, APPLY)

      await expect(
        world.apply(
          exampleApply({ attempt: 2, createdAt: '2026-10-26T14:00:30Z' }),
          {}
        )
      ).resolves.toBe('dispatched')
    })

    test('works without a logger', async () => {
      const world = createWorld()

      seedApplyRunOf(world, APPLY)

      await expect(world.apply(APPLY, {})).resolves.toBe('duplicate')
    })
  })
})
