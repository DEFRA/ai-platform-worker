/**
 * The `gitops` section of the convict schema: the GitOps queues, the two
 * state repositories the worker may act on, and the handler and shutdown
 * timing. It lives apart from `config.js` to keep that file short.
 */
export const gitopsConfigSchema = {
  commandsQueueUrl: {
    doc: 'URL of the worker-owned commands queue (aip_gitops_commands_worker.fifo), subscribed to the backend-owned commands topic; the worker consumes commands from it; required to run',
    format: String,
    nullable: true,
    default: null,
    env: 'GITOPS_COMMANDS_QUEUE_URL'
  },
  eventsTopicArn: {
    doc: 'ARN of the worker-owned events topic (aip_gitops_events_worker.fifo), which the backend-owned events queue is subscribed to; the worker publishes reconciler events to it; required to run',
    format: String,
    nullable: true,
    default: null,
    env: 'GITOPS_EVENTS_TOPIC_ARN'
  },
  tenantsRepo: {
    doc: 'owner/repo holding team files; the worker dispatches its submit.yml and apply.yml and reads its runs and commits',
    format: 'repository',
    default: 'DEFRA/ai-platform-tenants',
    env: 'GITOPS_TENANTS_REPO'
  },
  deploymentsRepo: {
    doc: 'owner/repo holding platform pins; the worker dispatches its submit.yml and apply.yml and reads its runs and commits',
    format: 'repository',
    default: 'DEFRA/ai-platform-deployments',
    env: 'GITOPS_DEPLOYMENTS_REPO'
  },
  awsSqsEndpoint: {
    doc: 'SQS endpoint override for local runs (Floci); unset on CDP',
    format: String,
    nullable: true,
    default: null,
    env: 'AWS_SQS_ENDPOINT'
  },
  awsSnsEndpoint: {
    doc: 'SNS endpoint override for local runs (Floci); unset on CDP',
    format: String,
    nullable: true,
    default: null,
    env: 'AWS_SNS_ENDPOINT'
  },
  awsRegion: {
    doc: 'AWS region of the GitOps queue and topic',
    format: String,
    default: 'eu-west-2',
    env: 'AWS_REGION'
  },
  handlerTimeoutMs: {
    doc: 'How long in ms the worker may take for one command, and the limit on every outbound call it makes for it; the queue visibility timeout (60 s) must stay above it',
    format: 'nat',
    default: 30000,
    env: 'HANDLER_TIMEOUT_MS'
  },
  sqsWaitTimeSeconds: {
    doc: 'Long polling wait in seconds for the commands queue',
    format: 'nat',
    default: 20,
    env: 'SQS_WAIT_TIME_SECONDS'
  },
  shutdownWaitMs: {
    doc: 'How long in ms a stopping worker waits for the command in flight before it exits',
    format: 'nat',
    default: 20000,
    env: 'GITOPS_SHUTDOWN_WAIT_MS'
  }
}
