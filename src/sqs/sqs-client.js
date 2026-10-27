import { SQSClient } from '@aws-sdk/client-sqs'

import { awsClientOptions } from '#/aws/client-options.js'

/**
 * Creates the SQS client for the worker's own commands queue.
 * @param {{endpoint?: string, region?: string}} [options]
 * @returns {SQSClient}
 */
export function createSqsClient(options) {
  return new SQSClient(awsClientOptions(options))
}
