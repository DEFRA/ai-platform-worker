import { resourcesOf } from '#/reconciler/resources-mapper.js'

const ARM =
  '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers'
const OUTPUTS = {
  tags: { 'aip-operation-id': 'op-7f3c9a1e' },
  project: {
    id: `${ARM}/Microsoft.CognitiveServices/accounts/a/projects/aip-alpha`,
    name: 'aip-alpha'
  },
  deployments: {
    'gpt-5-nano': {
      id: `${ARM}/Microsoft.CognitiveServices/accounts/a/deployments/alpha-gpt-5-nano`,
      name: 'alpha-gpt-5-nano',
      region: 'uksouth'
    }
  },
  api: {
    id: `${ARM}/Microsoft.ApiManagement/service/s/apis/alpha`,
    name: 'alpha',
    path: 'alpha'
  },
  registration: {
    client_id: '00000000-0000-0000-0000-0000000000c1',
    object_id: '00000000-0000-0000-0000-0000000000a1',
    service_principal_object_id: '00000000-0000-0000-0000-0000000000b1'
  }
}

describe('#resources-mapper', () => {
  test('flattens a team output into the typed resources the backend reads', () => {
    const report = { outputs: { teams: { value: { alpha: OUTPUTS } } } }

    expect(resourcesOf(report, 'alpha')).toEqual([
      {
        type: 'azapi_resource.foundry_project',
        name: 'aip-alpha',
        id: OUTPUTS.project.id
      },
      {
        type: 'azurerm_cognitive_deployment',
        name: 'alpha-gpt-5-nano',
        id: OUTPUTS.deployments['gpt-5-nano'].id
      },
      { type: 'azurerm_api_management_api', name: 'alpha', id: OUTPUTS.api.id },
      {
        type: 'azuread_application',
        name: 'alpha',
        id: OUTPUTS.registration.object_id
      },
      {
        type: 'azuread_service_principal',
        name: 'alpha',
        id: OUTPUTS.registration.service_principal_object_id
      }
    ])
  })

  test('skips the registration when Entra skipped it', () => {
    const report = {
      outputs: {
        teams: { value: { alpha: { ...OUTPUTS, registration: null } } }
      }
    }

    expect(resourcesOf(report, 'alpha').map(({ type }) => type)).toEqual([
      'azapi_resource.foundry_project',
      'azurerm_cognitive_deployment',
      'azurerm_api_management_api'
    ])
  })

  test('skips anything without both a name and an ID', () => {
    const report = {
      outputs: {
        teams: {
          value: {
            alpha: {
              project: { name: 'only-a-name' },
              deployments: { x: { id: 'only-an-id' } }
            }
          }
        }
      }
    }

    expect(resourcesOf(report, 'alpha')).toEqual([])
  })

  test.each([
    ['no report', null, 'alpha'],
    ['no outputs', {}, 'alpha'],
    [
      'a team the report does not hold (a removal)',
      { outputs: { teams: { value: {} } } },
      'alpha'
    ],
    ['no team', { outputs: { teams: { value: { alpha: OUTPUTS } } } }, null]
  ])('is empty for %s', (_name, report, team) => {
    expect(resourcesOf(report, team)).toEqual([])
  })

  test('never holds more than the contract allows', () => {
    const deployments = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [
        `d${index}`,
        { id: `/id/${index}`, name: `d${index}` }
      ])
    )
    const report = { outputs: { teams: { value: { alpha: { deployments } } } } }

    expect(resourcesOf(report, 'alpha')).toHaveLength(500)
  })
})
