/**
 * A command the worker will never act on: it names a repository or path it
 * is not for. It is thrown, not swallowed, so the message is redelivered and
 * reaches the dead-letter queue, where the alarm and the runbook (plan 13)
 * deal with it.
 */
export class CommandRefusedError extends Error {
  /**
   * @param {string} code - a stable code
   * @param {string} message - never includes the command's document or requester
   */
  constructor(code, message) {
    super(message)
    this.name = 'CommandRefusedError'
    this.code = code
  }
}

/**
 * Refuses a command whose target is not one of the worker's two state
 * repositories, or whose path is not under its own environment (plan 7,
 * guardrails: the worker acts only where it is meant to).
 * @param {{repository: string, environment: string, path: string|null}} command
 * @param {Set<string>} allowedRepositories - `owner/name`
 */
export function assertCommandTarget(command, allowedRepositories) {
  if (!allowedRepositories.has(command.repository)) {
    throw new CommandRefusedError(
      'repository-refused',
      `${command.repository} is not a state repository this worker acts on`
    )
  }

  if (
    command.path !== null &&
    !command.path.startsWith(`environments/${command.environment}/`)
  ) {
    throw new CommandRefusedError(
      'path-refused',
      `${command.path} is not under environments/${command.environment}/`
    )
  }
}
