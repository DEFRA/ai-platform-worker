import { createSnsClient } from '#/sns/sns-client.js'
import { createSqsClient } from '#/sqs/sqs-client.js'

describe.each([
  ['SQS', createSqsClient],
  ['SNS', createSnsClient]
])('#%s client', (_service, createClient) => {
  test('uses static local credentials when an endpoint is given', async () => {
    const client = createClient({
      endpoint: 'http://floci:4566',
      region: 'eu-west-2'
    })

    expect(await client.config.region()).toBe('eu-west-2')
    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: expect.any(String)
    })
  })

  test('uses the default provider chain and the standard region without an endpoint', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1')

    const client = createClient()

    expect(await client.config.region()).toBe('eu-west-1')

    vi.unstubAllEnvs()
  })

  test('falls back to eu-west-2 when nothing names a region', async () => {
    vi.stubEnv('AWS_REGION', '')
    delete process.env.AWS_REGION

    const client = createClient()

    expect(await client.config.region()).toBe('eu-west-2')

    vi.unstubAllEnvs()
  })
})
