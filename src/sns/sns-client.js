import { SNSClient } from '@aws-sdk/client-sns'

import { awsClientOptions } from '#/aws/client-options.js'

/**
 * Creates the SNS client for the worker's own events topic.
 * @param {{endpoint?: string, region?: string}} [options]
 * @returns {SNSClient}
 */
export function createSnsClient(options) {
  return new SNSClient(awsClientOptions(options))
}
