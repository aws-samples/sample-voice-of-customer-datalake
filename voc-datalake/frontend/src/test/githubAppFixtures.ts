/**
 * @fileoverview Test data: a deployment's GitHub App (`271828`, an organization's, with a webhook, used by
 * `billing-api`) as the server lists it, and a repository connection through its installation (`31415926`).
 *
 * @module test/githubAppFixtures
 */

/** The App as `GET /agents/engineering/github-apps` lists it; `fields` replace its own. */
export const githubApp = (fields: Record<string, unknown> = {}) => ({
  app_id: '271828', slug: 'voc-agents-3f9a2c', owner: 'example-org', owner_type: 'Organization',
  html_url: 'https://github.com/apps/voc-agents-3f9a2c', webhook: true, connections: ['billing-api'],
  created_at: '2026-11-10T10:00:00Z', created_by: 'admin-a', version: 1, ...fields,
})

/** A private repository's connection through the App's installation, as `GET /agents/engineering/connections` lists it. */
export const appConnection = (connectionId: string, repository: string) => ({
  connection_id: connectionId, host: 'github', repository, default_branch: 'main',
  credential: { kind: 'app_reference', set: true, app_id: '271828', installation_id: '31415926', expires_at: null },
  created_at: null, created_by: null, updated_at: null, updated_by: null, version: 1, ci_attestation: null,
  repository_private: true,
})
