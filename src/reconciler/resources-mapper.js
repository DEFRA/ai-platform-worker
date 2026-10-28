// Pure: a team's resources as the apply's run report holds them
// (`outputs.teams.value[slug]`, from ai-platform-infra `modules/team`
// `resources`) become the event's `resources[] {type, name, id}`. The type
// names follow the infra examples (`schemas/messages/examples/event-deployed.json`)
// and the patterns the backend reads them by (`operation-projection.js`).

const MAX_RESOURCES = 500

function entry(type, name, id) {
  return name && id ? [{ type, name: String(name), id: String(id) }] : []
}

/**
 * @param {object|null} report - the run report
 * @param {string|null} team - the team slug
 * @returns {Array<{type: string, name: string, id: string}>} empty for a removal, a pin, or a team with no outputs
 */
export function resourcesOf(report, team) {
  const outputs = report?.outputs?.teams?.value?.[team]

  if (!outputs) {
    return []
  }

  const { project, deployments, api, registration } = outputs

  return [
    ...entry('azapi_resource.foundry_project', project?.name, project?.id),
    ...Object.values(deployments ?? {}).flatMap((deployment) =>
      entry('azurerm_cognitive_deployment', deployment.name, deployment.id)
    ),
    ...entry('azurerm_api_management_api', api?.name, api?.id),
    ...entry('azuread_application', team, registration?.object_id),
    ...entry(
      'azuread_service_principal',
      team,
      registration?.service_principal_object_id
    )
  ].slice(0, MAX_RESOURCES)
}
