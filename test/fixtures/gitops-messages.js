// Valid `aip.gitops.command/1` and `aip.gitops.event/1` messages for tests,
// built from the shapes in ai-platform-infra's `schemas/messages/examples/`.

export const SHA = '0123456789abcdef0123456789abcdef01234567'
export const OID = '00000000-0000-0000-0000-000000000001'
export const TRACEPARENT =
  '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
export const CDP_REQUEST_ID = '3f2b8d1c-6a4e-4c7b-9d2a-1e5f0a7b8c9d'
export const TENANTS_REPO = 'DEFRA/ai-platform-tenants'
export const DEPLOYMENTS_REPO = 'DEFRA/ai-platform-deployments'
export const OPERATION_ID = 'op-7f3c9a1e'
export const TEAM_PATH = 'environments/infradev/alpha.json'
export const PIN_PATH = 'environments/infradev/platform.json'

let sequence = 0

// A UUIDv7-shaped command ID, unique per call, as the backend creates them.
export function nextCommandId() {
  sequence += 1

  return `0198a1b2-c3d4-7e5f-8a6b-${String(sequence).padStart(12, '0')}`
}

/**
 * A valid submit command; `overrides` replace any field.
 * @param {object} [overrides]
 */
export function exampleCommand(overrides = {}) {
  return {
    schema: 'aip.gitops.command/1',
    type: 'submit',
    commandId: nextCommandId(),
    operationId: OPERATION_ID,
    environment: 'infradev',
    team: 'alpha',
    repository: TENANTS_REPO,
    path: TEAM_PATH,
    action: 'write',
    document: '{\n  "environment": "infradev",\n  "revision": 4\n}\n',
    expectedRevision: 3,
    attempt: 1,
    requestedBy: `entra:${OID}`,
    traceparent: TRACEPARENT,
    cdpRequestId: CDP_REQUEST_ID,
    createdAt: '2026-10-26T12:00:00Z',
    ...overrides
  }
}

/**
 * A valid reconcile command for a state. From `requested` it carries what a
 * submit needs; from later states it carries the target only.
 * @param {string} state
 * @param {object} [overrides]
 */
export function exampleReconcile(state, overrides = {}) {
  const { action, document, expectedRevision, ...target } = exampleCommand()

  return {
    ...target,
    ...(state === 'requested' ? { action, document, expectedRevision } : {}),
    type: 'reconcile',
    state,
    createdAt: '2026-10-26T12:10:00Z',
    ...overrides
  }
}

/**
 * A valid apply command for no operation, as `command-apply.json`.
 * @param {object} [overrides]
 */
export function exampleApply(overrides = {}) {
  return {
    schema: 'aip.gitops.command/1',
    type: 'apply',
    commandId: nextCommandId(),
    operationId: null,
    environment: 'infradev',
    team: null,
    repository: TENANTS_REPO,
    path: null,
    attempt: 1,
    requestedBy: 'app:ai-platform-backend',
    traceparent: null,
    cdpRequestId: null,
    createdAt: '2026-10-26T14:00:00Z',
    ...overrides
  }
}

const RUNS = {
  submit: 25000000001,
  apply: 25000000010,
  pause: 25000000020,
  reconciler: 25000000030
}

const SOURCE_OF = {
  requested: 'submit',
  'checks-failed': 'submit',
  committed: 'submit',
  deploying: 'apply',
  deployed: 'apply',
  'deploy-failed': 'apply',
  paused: 'pause',
  resumed: 'pause'
}

// The fields a status carries beyond the common ones (plan 5, event table).
function statusFields(status) {
  if (['committed', 'deploying', 'deployed'].includes(status)) {
    return { commitSha: SHA, committedAt: '2026-10-26T12:00:24Z' }
  }

  return {}
}

const EXTRAS = {
  'checks-failed': {
    failureReason: {
      code: 'validation-failed',
      message: 'The file failed validation',
      retryable: false
    }
  },
  'deploy-failed': {
    failureReason: {
      code: 'apply-failed',
      message: 'The apply failed',
      retryable: false
    },
    failingTeams: ['alpha'],
    attributable: true
  },
  deployed: { appliedSha: SHA, resources: [] }
}

/**
 * A valid event for a status; `overrides` replace any field. The run ID is
 * per source, and the event ID follows the contract.
 * @param {string} status
 * @param {object} [overrides]
 */
export function exampleEvent(status, overrides = {}) {
  const source = overrides.source ?? SOURCE_OF[status]
  const runId = overrides.runId ?? RUNS[source]
  const runAttempt = overrides.runAttempt ?? 1
  const operationId =
    'operationId' in overrides ? overrides.operationId : OPERATION_ID
  const subject = operationId ?? overrides.environment ?? 'infradev'

  return {
    schema: 'aip.gitops.event/1',
    eventId: `${subject}:${status}:${runId}:${runAttempt}`,
    environment: 'infradev',
    team: 'alpha',
    path: TEAM_PATH,
    action: 'write',
    status,
    timestamp: '2026-10-26T12:00:05Z',
    source,
    requestedBy: `entra:${OID}`,
    repository: TENANTS_REPO,
    traceparent: TRACEPARENT,
    cdpRequestId: CDP_REQUEST_ID,
    operationId,
    runId,
    runAttempt,
    runUrl: `https://github.com/${TENANTS_REPO}/actions/runs/${runId}`,
    ...statusFields(status),
    ...EXTRAS[status],
    ...overrides
  }
}
