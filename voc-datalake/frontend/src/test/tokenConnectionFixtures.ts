/**
 * @fileoverview Fine-grained token connections as the server answers them (7.60.00), for the specs of the token
 * dialog, the rows and the run's go. A token here is built at runtime from obvious filler, so nothing reads it as a
 * real one (and it is shorter than any real fine-grained token).
 */

/** A fake fine-grained token: the prefix and filler, nothing more. */
export const FAKE_TOKEN = `github_pat_${'Z'.repeat(30)}`

/** A token connection on `repository`, its token `daysLeft` from expiring, saved by the viewer unless said. */
export function tokenConnection(id: string, repository: string, daysLeft: number | null, extra: Readonly<{
  savedByYou?: boolean; set?: boolean; login?: string; owner?: string
}> = {}) {
  return {
    connection_id: id, host: 'github', repository, default_branch: 'main', kind: 'fine_grained', repository_private: false,
    credential: {
      kind: 'fine_grained_token', set: extra.set ?? true, app_id: '271828', installation_id: '31415926',
      expires_at: daysLeft === null ? null : '2026-12-01', expires_in_days: daysLeft, login: extra.login ?? 'casey-dev',
      saved_by_you: extra.savedByYou ?? true, owner: extra.owner ?? 'Casey',
    },
    public: null, fork: null, version: 2, ci_attestation: null,
    created_at: '2026-11-01T10:00:00Z', created_by: 'Casey', updated_at: '2026-11-02T10:00:00Z', updated_by: 'Casey',
  }
}
