import { SQSClient } from '@aws-sdk/client-sqs'

const DEFAULT_REGION = 'eu-west-2'
// A local queue (Floci) accepts any credentials, so the standard ones are
// used when set and the conventional literals otherwise; against AWS the
// default provider chain applies.
const LOCAL_CREDENTIAL = 'test'

/**
 * Creates the SQS client. With an `endpoint` (a local queue) it uses static
 * local credentials; without one it relies on the default AWS provider chain.
 * @param {{endpoint?: string, region?: string}} [options]
 * @returns {SQSClient}
 */
export function createSqsClient({ endpoint, region } = {}) {
  return new SQSClient({
    region: region ?? process.env.AWS_REGION ?? DEFAULT_REGION,
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? LOCAL_CREDENTIAL,
            secretAccessKey:
              process.env.AWS_SECRET_ACCESS_KEY ?? LOCAL_CREDENTIAL
          }
        }
      : {})
  })
}
