import { config } from '#/config.js'
import { createCommandsConsumer } from '#/commands/commands-consumer.js'
import { createApplyHandler } from '#/commands/handlers/apply.js'
import { createReconcileHandler } from '#/commands/handlers/reconcile.js'
import { createSubmitHandler } from '#/commands/handlers/submit.js'
import { createSnsEventsPublisher } from '#/events/sns-events-publisher.js'
import { createGithubAppClient } from '#/github/github-app-client.js'
import { createOctokitGitHubClient } from '#/github/octokit-github-client.js'
import { createWorkflowDispatcher } from '#/github/workflow-dispatcher.js'
import { createCommitFinder } from '#/reconciler/commit-finder.js'
import { createRunReader } from '#/reconciler/run-reader.js'
import { createSnsClient } from '#/sns/sns-client.js'
import { createSqsClient } from '#/sqs/sqs-client.js'

function nameOf(repository) {
  return repository.split('/')[1]
}

function requireMessaging({ commandsQueueUrl, eventsTopicArn }) {
  if (!commandsQueueUrl || !eventsTopicArn) {
    throw new Error(
      'GITOPS_COMMANDS_QUEUE_URL and GITOPS_EVENTS_TOPIC_ARN must both be set'
    )
  }
}

/**
 * The composition root (plan 7, "ports passed by factory"): builds the
 * commands consumer and everything it needs from configuration, and nothing
 * else knows how the parts are joined. It fails at once, before anything is
 * polled, when the queue URL, the topic ARN or the GitHub App credentials are
 * missing.
 * @param {{logger: import('pino').Logger, metrics: {counter: Function, millis: Function, gauge: Function}}} deps
 * @param {object} [overrides] - the parts to replace, for a test
 * @returns {ReturnType<typeof createCommandsConsumer>}
 */
export function createWorkerRuntime(
  { logger, metrics },
  {
    settings = config.get('gitops'),
    createClient = createSqsClient,
    createTopicClient = createSnsClient,
    createAppClient = createGithubAppClient,
    createConsumer = createCommandsConsumer
  } = {}
) {
  requireMessaging(settings)

  const repositories = [settings.tenantsRepo, settings.deploymentsRepo]
  // One client per state repository, its token down-scoped to that
  // repository alone (plan 6.3). Built now so missing credentials fail at
  // startup rather than at the first command.
  const clients = new Map(
    repositories.map((repository) => [
      repository,
      createAppClient(
        { repositoryNames: [nameOf(repository)] },
        {
          onRateLimit: (remaining) =>
            metrics.gauge('githubRateRemaining', remaining)
        }
      )
    ])
  )
  const github = createOctokitGitHubClient({
    clientFor: (repository) => clients.get(repository)
  })
  const sqs = createClient({
    endpoint: settings.awsSqsEndpoint ?? undefined,
    region: settings.awsRegion
  })
  const sns = createTopicClient({
    endpoint: settings.awsSnsEndpoint ?? undefined,
    region: settings.awsRegion
  })
  const runReader = createRunReader({ github })
  const commitFinder = createCommitFinder({ github })
  const dispatcher = createWorkflowDispatcher({ github, runReader, metrics })
  const events = createSnsEventsPublisher({
    client: sns,
    topicArn: settings.eventsTopicArn
  })

  return createConsumer({
    queueUrl: settings.commandsQueueUrl,
    sqs,
    handling: {
      handlers: {
        submit: createSubmitHandler({ runReader, dispatcher }),
        apply: createApplyHandler({ dispatcher }),
        reconcile: createReconcileHandler({
          github,
          runReader,
          commitFinder,
          dispatcher,
          events,
          metrics
        })
      },
      allowedRepositories: new Set(repositories),
      handlerTimeoutMs: settings.handlerTimeoutMs,
      metrics
    },
    settings: {
      waitTimeSeconds: settings.sqsWaitTimeSeconds,
      handlerTimeoutMs: settings.handlerTimeoutMs,
      shutdownWaitMs: settings.shutdownWaitMs
    },
    logger
  })
}
