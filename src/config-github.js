/**
 * The `github` section of the convict schema: the `ai-platform-orchestrator`
 * App credentials the worker mints its installation tokens from (plan 6.3).
 * It lives apart from `config.js` to keep that file short.
 */
export const githubConfigSchema = {
  appId: {
    doc: 'GitHub App ID (or its client ID) of ai-platform-orchestrator',
    format: String,
    nullable: true,
    default: null,
    env: 'GITHUB_APP_ID'
  },
  installationId: {
    doc: 'GitHub App installation ID, required alongside github.appId',
    format: String,
    nullable: true,
    default: null,
    env: 'GITHUB_APP_INSTALLATION_ID'
  },
  privateKey: {
    doc: 'GitHub App private key, base64-encoded on one line (a CDP secret)',
    format: String,
    nullable: true,
    default: null,
    sensitive: true,
    env: 'GITHUB_APP_PRIVATE_KEY'
  }
}
