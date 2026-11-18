# Autonomous engineering agents

> **Status: partly built, not yet run against AWS.** Each section says what of it is built (with its code's
> place) and what is *Planned*; the present tense in a planned part describes the intended behaviour, not something
> that runs today. Nothing here is deployed by default (`-c engineeringAgents=true` adds it), and nothing here costs
> anything until an administrator connects a repository and starts a run (TENETS.md tenet 7).

Connect a GitHub or GitLab repository and let agents learn how the team works, then work the way the team works:
understand issues, hunt and fix bugs, build features, review pull requests. Every change an agent makes goes through
the same quality gate a careful team uses: deterministic checks for the repository's languages, review rounds by
reviewer agents (three by default), then a final go. The flows stop at the pull request: **a person always merges**.

The agents work like a team: each in its own sandbox (an Amazon Bedrock AgentCore Runtime session, its own microVM), talking through one event bus, picking
tasks from a shared board, writing their findings to a shared workspace, reporting per commit, per pull request and
per goal, and getting better from run to run (versioned skills, a coach, memory, a benchmark that gates every
change to an agent).

This builds on [autonomous agents](autonomous-agents.md) (the agents page, the workflow editor, human decision points,
budgets, the run journal) and on [memory](memory.md).

## Contents

1. [Large repositories and monorepos](#large-repositories-and-monorepos)
2. [Repository connectors](#repository-connectors)
3. [The knowledge pack](#the-knowledge-pack)
4. [The agent catalog](#the-agent-catalog)
5. [How the agents work together](#how-the-agents-work-together)
6. [The quality gate](#the-quality-gate)
7. [Runtime: one AgentCore session per agent](#runtime-one-agentcore-session-per-agent)
8. [Reports](#reports)
9. [Getting better: skills, the coach, the learning loop, memory](#getting-better-skills-the-coach-the-learning-loop-memory)
10. [Readiness (7.50.00)](#readiness-75000)
11. [Models](#models)
12. [Trust and safety](#trust-and-safety)
13. [Evaluation](#evaluation)
14. [Cost](#cost)
15. [Phases and status](#phases-and-status)

## Large repositories and monorepos

*Partly built*: package detection with code owners (`voc-datalake/lambda/engineering/knowledge/workspaces.py`) and
the shard cutter with its size budget (`knowledge/shards.py`), as tested code nothing invokes yet (the Understand flow
that calls them lands with the agents, phase 4), and, since 7.05.00, the checkout cache's writer
(`voc-engineering-cache`, [below](#runtime-one-agentcore-session-per-agent), "The checkout cache"), from which every
agent's blob-less sparse checkout clones. Planned: change impact (the dependency graph between packages), shards' time
budgets and the dependency caches' filler (the caches' expiry rule is in the stack). Designed for them from day one.

- **Partial clones.** A checkout is `git clone --filter=blob:none` plus a sparse checkout of only the paths a task
  needs. History and pull requests are read through the host's API, in pages, never by cloning everything.
- **Shards follow the repository's own structure.** Workspaces are detected (Cargo, npm / pnpm / yarn, Gradle /
  Maven, Go modules, Bazel, Python packages), and so are code owners. A package is the unit of the knowledge pack, of
  the review and of the gate. Built: from the file listing and the manifests it names (`manifest_paths`), a package is
  a directory whose manifest names one (a crate's `[package]`, a `package.json`, a `go.mod`, a `pyproject.toml` /
  `setup.cfg` name or a `setup.py`, a `build.gradle[.kts]`, a `pom.xml`); a workspace's declarations (Cargo
  `members`, npm / yarn `workspaces`, `pnpm-workspace.yaml`, uv's workspace, Gradle's `include`, Maven's `<modules>`,
  `go.work`) add members and record the workspace, never remove one; top-most `BUILD` directories are packages only
  when nothing else found any; the root package `.` holds every other file. Owners come from the first `CODEOWNERS`
  GitHub reads, the last rule matching the package's directory, handles only (an e-mail address is never kept).
  Detection is deterministic and bounded: a listing of more than 200,000 paths, or with an absolute path or an
  empty, `.` or `..` part, is refused whole; manifests past the first 2,000 (the shallowest are kept), manifests over
  256 KB or that do not parse, a workspace's member patterns past its first 200 and packages past 2,000 are left out,
  and each is counted (`Layout.skipped`).
- **Change impact.** The workspace's dependency graph says which packages a change touches; the gate and the reviews
  run on those packages, and the full gate runs on the pull request's final tree (again after any fix it sends back).
- **Warm caches.** Checkouts are kept per (connection, commit) and dependency caches per (connection, lockfile hash)
  in S3, under the connection's own prefix, so a new agent starts warm; an agent reads only its own connection's
  prefix. Entries expire 30 days after they were written (the raw bucket's `engineering-cache-expiry` rule on
  `engineering/cache/<connection>/…`, with `-c engineeringAgents=true`) and are rebuilt when needed. Every shard has a size and
  time budget, and a shard too big is split again (built for the size: `knowledge/shards.py`). Only trusted code writes the cache: the checkout cache's writer
  (`voc-engineering-cache`, built in 7.05.00: fetch only, it runs no repository code) writes the checkouts, one
  immutable entry per (connection, commit), and the dependency caches' filler (planned: a step that runs no
  repository code, fetch only, from the lockfile, install scripts off) will write the dependency caches. A toolchain whose dependency resolution runs build files (Gradle, Maven)
  gets no shared dependency cache: its resolution counts as repository code with network (the registry list only,
  nothing customer-derived, no credential), in the sandbox, for that run only. Gradle runs without its daemon
  (`GRADLE_OPTS=-Dorg.gradle.daemon=false` in the Java image), whose client talks to it over loopback, which the
  dependency step's code firewall rejects; a build that asks for a JVM other than the client's
  (`org.gradle.jvmargs`, which many repositories set, `org.gradle.java.home`, daemon JVM criteria) still forks a
  single-use daemon, and worker processes talk over loopback too, which is rejected as well (unverified in a
  session: such a repository's dependency step may fail; making loopback usable there is a design change to the
  firewall). The dependency step reaches only its own egress proxy (its language's registries and the deployment's
  extra hosts), never the agent's (Bedrock, the buckets, the board), and the agent never reaches a registry
  ([Runtime](#runtime-one-agentcore-session-per-agent): two allowlists, two proxies). No session that runs repository
  code writes to the cache.

## Repository connectors

*Partly built*: the broker's caller identity, operations per role and write rules, the GitHub client and the
credential reader, and, since 6.23.00, its readers of what a run recorded: the run's own record, the board's GO
ledger, the committer's submitted patch and the dial (`voc-datalake/lambda/engineering/connectors/`: `records.py`,
`patches.py`, `dial.py`), deployed only with `-c engineeringAgents=true`, and, since 7.02.00, the harness's client of
it, so the agents' reads and writes reach it ([The agent catalog](#the-agent-catalog), "The harness's broker
client"), and, since 7.03.00, the connections themselves: an administrator stores one (Agents → Connections, or
the API below) with its GitHub App credential, which goes to the SSM parameter the broker reads, so a run on a stored
connection is served instead of answered 503, and, since 7.04.00, the CI attestation's record: an administrator
attests that the repository's CI meets the setup guide ("The target's CI", below), and the broker
serves a push or a pull request only while that attestation holds and the host's branch rules pass its own read-only
check; a file or history read is of the run's own default branch, and, since 7.06.00, the GitLab client
(`connectors/gitlab.py`, gitlab.com): a connection is GitHub's or GitLab's, its credential a GitHub App's or a GitLab
project access token, and the broker and the checkout cache's writer serve each connection on its own host's client
(`connectors/router.py`), below, and, since 7.09.00, the run's issue and pull request on its record ("The run's
issue and pull request", below), and, since 7.45.00, the in-app GitHub connect flow: an administrator makes a private
GitHub App in two clicks, its key goes straight to SSM, and every repository it is installed on becomes a connection
([A GitHub App in two clicks](#a-github-app-in-two-clicks-74500), below). Planned: its cited reviews on the run's record, sparse clones, a self-managed GitLab instance (its base URL is one constant today, `gitlab_api.py` `GITLAB_HOST`; the
owner decides whether a connection names its own), and the first real run against a repository (it waits for the
owner).

**The connections (7.03.00).** Administrators acting for themselves (a delegated MCP credential gets 403), only where
the module is deployed (404 otherwise), through the Agents API (`voc-datalake/lambda/engineering/connectors/connections.py`):

- `GET /agents/engineering/connections` → `{connections, limit}`: each connection's id, host (`github` or `gitlab`; a
  row stored before 7.06.00 is `github`), repository, default branch, who created and last changed it, of its
  credential only `{kind, set, app_id, installation_id, expires_at}` (`kind` `app` with the App's two ids, not secret,
  or, for GitLab, `project_token` with the day the token expires as GitLab reported it at the save; the page shows it,
  warns within 30 days and says so once it has passed), its `version` (any change of the connection moves it), and
  its CI attestation's newest version
  (`ci_attestation`, null for none, below). One Query of the
  connections' partition, and one Query of one row per connection for its attestation (at most 20).
- `PUT /agents/engineering/connections/<id>` `{host: "github", repository: "owner/name", default_branch,
  credential?: {app_id, installation_id, private_key}, reason?}` → `{connection, created}`. The id is 1 to 63 lower-case
  letters, digits or `-` (what a run's `connection` names); the repository is GitHub's `owner/name`; the default
  branch a name git takes, ASCII, at most 255 characters, never an agent's `voc-agent/` branch; the credential the
  App's id and installation id (digits) and its private key, an unencrypted RSA key in PEM (PKCS#1 as GitHub hands
  it out, or PKCS#8), with the rest at most 4 KB (a standard parameter: no monthly charge). Every refusal names the
  field, never its value. The credential is needed to add a connection and to change its host or repository (it is
  stored with them); a save without it keeps the stored one (the branch alone changes). A GitLab connection (7.06.00)
  is `{host: "gitlab", repository: "<namespace>/<project>", default_branch, credential?: {token}, reason?}`: the
  project's path as its address shows it (a group and up to 19 subgroups, then the project: 2 to 21 parts of letters,
  digits, `_`, `.` and `-`, at most 255 characters, no `..`, no part ending `.git` or `.atom`), and a project access
  token (`glpat-` and its body), checked once against gitlab.com before anything is stored (below). A host change
  while a run of the connection has not ended is refused like a repository change. A repository change while a run of
  the connection has not ended (the runs' registry, then each run's META) is refused, 409; so is a 21st connection,
  and a change made meanwhile (each change is conditioned on the version read). That 409 reads the runs, then writes,
  so a run started between the two is not seen: it is a courtesy, not the guarantee. What guarantees that a run never
  reads or writes another repository than the one it started on is the broker's own check: it serves a run only while
  the connection's credential names the run's repository, and refuses it otherwise (409), failing closed.
- `DELETE /agents/engineering/connections/<id>` `{reason?}` (the body optional) → `{removed: true}`: its parameter is
  deleted first, so every run on it is refused within five minutes (a warm broker keeps a credential it read that
  long), then its row is marked removed (kept, and listed no more). Not refused while runs are live: it is the way to
  cut a connection's access.
- `POST /agents/engineering/connections/<id>/ci-attestation` `{points, repository, version, reason?}` →
  `{attestation, created, connection_version}` (7.04.00): the administrator attests that the repository's CI meets the
  setup guide, confirming every one of its points by id (`protected_secrets`, `read_only_token`, `oidc_pinned`,
  `no_self_hosted_runner`, `no_privileged_pull_request`, `branch_rules`: the six of "The target's CI", below; 400
  naming the points not confirmed, never echoing a value), for the `repository` and the connection `version` they
  reviewed (what the page showed). The attestation is `{version, state, repository, points, by, at, reason, cause}`:
  it stands for that repository, and `by` is the administrator's name (their subject is kept on the row, never
  answered). It is recorded only while the connection still holds that repository at that version: 409 otherwise,
  checked on the row read and again in the write's own transaction condition, so another administrator repointing
  the connection between the page and the confirmation (or between the read and the write) never gets a repository
  nobody reviewed attested. One that already holds is answered as it stands (`created: false`, nothing written); 404
  for a connection that is not stored. `connection_version` is the connection's version after it (an attestation
  moves it).
- `DELETE /agents/engineering/connections/<id>/ci-attestation` `{reason?}` → `{withdrawn: true}`: withdraws it (404
  when none holds), so the broker refuses the next push or pull request on the connection.

The default branch (7.03.01) is the broker's: a run's start copies the stored connection's default branch onto the
run (META's `default_branch`, beside its `repo`), and the broker holds the run to it (never a push to it, a new branch
starts on it, a pull request is opened against it) once the host confirms the repository has it (one branch
lookup with `contents: read`, kept five minutes, made only after the repository check below, so a credential
re-pointed at another repository is never used for it); a branch the repository does not have refuses the run's every
operation, 409, until an administrator corrects the connection and starts the run again. A change of the branch
reaches the runs started after it. A run started before 7.03.01 has none on its META and is held to the repository's
own default branch, as before. A change's optional `reason` (one line, at most 500 characters, credential-shaped text
redacted: D4's why) is kept on its audit row.

A connection is a row in `voc-agents` (`CONNECTIONS#default` / `CONNECTION#<id>`) and its credential the parameter
below, written before the row. When the row then cannot be written (a change made meanwhile, a failed write), a new
connection's parameter is deleted again, and a stored connection's row is marked credential not set (with its audit
row), so the page says so and the next save needs the credential. Before a new connection's parameter is deleted
the row is read again (7.03.01): when two administrators add the same id at once, the losing save finds the
winner's row and deletes nothing (the parameter may be the winner's), and marks that row credential not set instead,
since the parameter may hold the loser's credential; a row that cannot be read is taken as none, and the parameter is
deleted, failing closed. One ordering is not prevented, and fails closed: the losing save's row write fails for
another reason than a conflict (a throttle), the winner's put lands, the loser's undo (finding no row yet) deletes it,
and the winner's row is written after; SSM has no conditional delete and the Agents API cannot read a parameter, so
the delete cannot be held to the loser's own version. The row then says its credential is set with none behind it:
the broker reads no credential and refuses every run on the connection (503) until it is saved again with its
credential, and never serves a run with another save's credential. Whatever the row says, the broker serves a run
only while its connection's credential names the repository the run started on (META's `repo`, which a start takes
from the stored connection): any other is refused, 409, before the host is read for the run (the default branch's
lookup included). Every
change writes a create-only audit row in the same transaction (`LOG#<at>#<hex>`: who, their subject and name, when,
created, updated or removed, each changed field's old and new value, for the credential only `replaced`, `kept`
or `removed`, and the administrator's reason when one was given; D4). The Agents API is the rows' one writer: every other role that writes `voc-agents` (the agents'
conductor, nodes, persona panel and heartbeat) has an explicit Deny of writes on the connections' partitions, as on
the hard cap's (`denyHardCapWrites`, pinned by `lib/stacks/hard-cap-guard.test.ts`). The private key is never answered, logged, put in an error or stored outside SSM, and the Agents
API cannot read it back: its role holds `ssm:PutParameter` and `ssm:DeleteParameter` on exactly the connections'
parameters, and `kms:Encrypt` and `kms:GenerateDataKey` on the stack's key only through SSM and only for those
parameters, never `ssm:GetParameter` (`voc-datalake/lib/stacks/api-assistant-lambdas.ts`, pinned by
`api-engineering-reads.test.ts`). Since 7.03.01 the role holds the stack's key only through the services that use it
for the role: DynamoDB (`voc-agents`, the aggregates table, `voc-engineering`), S3 (`kms:Decrypt`, for the workspace's
reports) and SSM (the statement above), each a `kms:ViaService` condition, and no unconditioned grant: it can call
KMS itself for nothing, so it can encrypt or decrypt nothing outside those services (pinned by the same test). A run
starts only on a stored connection (400 otherwise), and its `repo` and `default_branch` are the connection's.

**A GitLab connection (7.06.00, `connectors/gitlab_api.py` `check_token`).** gitlab.com only. Its credential is a
project access token for exactly the connection's project, role Developer, scopes `api`, `read_repository` and
`write_repository`, with an expiry (GitLab's tokens expire, at most a year after they are made). A save that carries
one asks gitlab.com three times before anything is stored (each read sent once, 6 s at most, so the save ends inside
the API's 29 s), with the token in the `Authorization` header alone:
`GET /api/v4/personal_access_tokens/self` (what a token reads of itself: active, not revoked, those three scopes, an
expiry after today, and its user's id), `GET /api/v4/projects/<the path, encoded>` (the project at that path must be
the one GitLab answers, case aside, with the token's user a direct member with the role Developer, 30; a Guest,
Reporter, Maintainer or Owner token is refused) and `GET /api/v4/user` (the token's user must be this project's own
bot: `bot: true`, the same id, and named as GitLab names a project access token's bot,
`project_<project_id>_bot_<random>`, or `project_<project_id>_bot<n>` for older tokens). So a personal access token
(its user a person, who reaches every project they can, even as a direct Developer member) or another project's token
is refused: "use a project access token of this project". A
refusal is 400 saying what to change (the scope missing, the role found, the day it expired), never the token; a
GitLab that cannot be asked (a rate limit, an outage, no answer) is 503, and nothing is stored. The parameter then
holds `{"host": "gitlab", "project_id", "repository", "token", "expires_at"}`, the project's id and path as GitLab
spells them; the row holds `host: gitlab` and `token_expires_at` (the day, not secret), never the token; a row with no
`host` (stored before 7.06.00) is GitHub's, with no migration. The token is never answered, logged or put in an error,
and the Agents API reads it back no more than it does a private key. This check is one of the Agents API's two reaches
outside AWS (the other, since 7.45.00, is GitHub's App manifest conversion: [A GitHub App in two
clicks](#a-github-app-in-two-clicks-74500)): its Lambda is not in a VPC, as before, so it needs nothing new for either. Replacing a token before it expires is an
edit of the connection with the new one (the same check); an expired token makes every read and write of the
connection fail at GitLab (401: the broker's 502, the cache writer's refusal) until it is replaced.

**The CI attestation's record (7.04.00, `connectors/attestations.py`).** Each change of a connection's attestation is a
create-only version row in a partition of that connection's attestations alone, `CONNECTIONS#default#CI#<id>` /
`V#<version>` (D1): its state (`attested`, `withdrawn`, or `voided`), the repository it stands for, the points
confirmed, who (subject and name) and when, and the administrator's reason or the void's cause. The newest version is
the one that holds. An attestation or a withdrawal is written in one transaction with the connection's own audit row
(`ci_attested`, `ci_withdrawn`, with the from and to states, the version and the repository; D4) and a bump of the
connection row's version conditioned on the version read, so a repository change made meanwhile refuses it (409). A
repository change and a removal void it in their own transaction: the void is the next version (cause
`repository_changed` or `connection_removed`), and the save's or the removal's audit row says `ci_attestation:
voided`. A voided attestation stays void: changing the repository back does not restore it, the new repository's CI
is attested again. The partitions match `CONNECTIONS#*`, so every other role that writes `voc-agents` is denied writes
to them too (`denyHardCapWrites`). On Agents → Connections each connection shows whether its CI is attested, by whom
and when (or that it was withdrawn or voided, and why), with **Attest CI** (a dialog listing the six points, each a
checkbox that must be ticked, and an optional note) or **Withdraw CI** (after a confirmation). For a GitLab connection
(7.06.00) the six points keep their ids and are worded for GitLab: CI/CD variables that hold secrets are protected,
so only pipelines on protected branches get them (`protected_secrets`); the CI/CD job token has the least access (no
project on its allowlist beyond what the pipelines need, no job pushes with it: `read_only_token`); cloud trust
through OIDC (`id_tokens`) is pinned to protected branches (`oidc_pinned`); no shared, group or instance runner with
access to secrets or networks runs jobs for unprotected branches (`no_self_hosted_runner`); no pipeline runs
merge-request code with secrets (`no_privileged_pull_request`); and the default branch is protected (no force push,
push and merge for Maintainers), pipelines must succeed before a merge (a skipped one not counting as a success), the
CI configuration uses only plain local includes and GitLab's own templates (shared CI from other projects, remote
includes and components are not supported for now), and `voc-agent/*` stays unprotected
(`branch_rules`).

**What the broker reads (6.23.00).** Reads only, of rows and objects other code writes:

- **The run** (`records.py`): the caller's run's `META` (its session names the run, never the request), read
  strongly consistent: its status, connection, commit and `started_by`, the person who started it (the run's start
  records it since 6.23.00; a run started with no person has none), and, since 7.03.00, its `repo`, the stored
  connection's repository at the start, which the connection's credential must still name. A META that names another run is no run; the
  broker serves only an `active` run (stopped, ended or waiting at a person's decision: 409, with the reason). The
  default branch is META's `default_branch` (7.03.01: the stored connection's at the start), once the host confirms
  the repository has it (kept five minutes; 409 when it does not); for a META without one, the repository's own
  default branch (kept five minutes). The broker asks the host either only after the repository check (`broker.py`);
  `records.py` reads nothing of the host. A file or history read is of that branch (7.04.00: `ref` and `sha` on the
  host's API), so a run whose connection names `develop` reads `develop`, never the repository's own default branch.
  Not read by the broker: the run's issue and pull request (on the record since 7.09.00, below, for the run monitor,
  the reports and the learning loop; not yet taken as the issue and pull request an agent may comment on, so no
  comment is accepted), and the reviews behind its feedback ids (not on the record yet, so the verbatim-quote rule
  has nothing to compare; the personal-data rules still run).
- **The CI attestation** (7.04.00, `records.py` `attested`): read at every push and pull request, after the dial,
  never for a read or a comment: in `voc-agents`, the newest version of the run's connection's attestation (one Query
  of one row, strongly consistent, of its key, `state`, `repository` and `version` alone). It holds only while it is
  `attested` for the repository the run started on (META's `repo`); none, a withdrawn or voided one, one for another
  repository, a run without a `repo`, or a deployment that names no agents table, and the push or pull request is
  refused (409, saying an administrator has not confirmed the repository's CI settings); a read that fails is 503.
  A withdrawal or a void holds from the next write. Then the broker checks the host's branch rules itself, read only,
  with the connection's `contents: read` token (`github.py` `ci_protection`: GitHub's branch read and the ruleset rules
  for a branch's name, which any reader of the repository sees; at most four requests): the run's default branch must
  be protected (classic branch protection or any ruleset rule) and require at least one status check, and the
  agent's branch must not be protected by any rule (a protected branch gets what protected branches get: the CI
  secrets and the cloud trust kept for them); otherwise 409 with what to change. A pass is kept five minutes per
  connection, repository and branch pair, in each warm broker container (at most 256 kept, the oldest dropped first):
  so rules weakened on the host after a pass (the default branch's protection or its required check removed, a rule
  added for `voc-agent/*`) can go unseen for up to five minutes, while a withdrawal or a void of the attestation, read
  at every write, takes effect at the next one. A failure is never kept: it is read again at the next write, so a
  fixed rule counts at once. Each write's claim row records what it was made on: the attestation's version, when the
  branch rules were read, and the required checks' names (at most 20). The check covers only those two things: the
  App's token cannot read the CI settings themselves (secrets, environments, runners, the workflow token's default),
  nor whether the App's own pushes are limited to `voc-agent/*` (the `branch_rules` point), so those stay the
  administrator's attestation. On a GitLab connection (7.06.00, `gitlab.py` `ci_protection`, with the connection's
  Developer token; at most seven requests, none a write) the broker reads the project's protected branches (at most
  five pages of 100; more is refused, failing closed), its "Pipelines must succeed" setting
  (`only_allow_merge_if_pipeline_succeeds`, which stands as the required check, recorded as `pipelines must succeed`)
  and, where the API shows it to the token, its push rule. The default branch must be covered by a protected branch
  rule (its name or a wildcard), and every rule that covers it (GitLab applies the most permissive) must allow no
  force push and push and merge for Maintainers only (or no one: access levels 0, 40 or 60, no user, group or deploy
  key let in by name); a merge without a passing pipeline must be off, and so must "Skipped pipelines are considered
  successful" (`allow_merge_on_skipped_pipeline`: on, or not answered, refuses); the agent's branch must be covered by
  no rule;
  and a push rule's branch name pattern, when it is shown, must take the agent's branch (a pattern the broker's
  regular expressions cannot read refuses, failing closed). Each refusal is a 409 in the same shape, saying what to
  change. A token that may not read the protected branches (403) is refused too, failing closed: on gitlab.com a
  Developer is expected to read them (to be confirmed on the first real connection, below). Code owner approval is
  read by no point of the attestation, so the check does not require it.
- **The GO ledger**: the run's `TASK#` rows (one Query of its partition). The final-go task that ended last
  (done, failed or needing a person, a person's block included) is the run's verdict whatever its state, with the
  gate record its own holder, a final-go agent, recorded last (`_gate/attempt-<n>/record.json`); an older task's
  passing record never stands in for it. Only a GO of a task that ended done, with no stop, for exactly the tree asked about,
  counts. Only that one record is read (at most 1 MB); one that cannot be read or is off `voc-gate-record/1` is no GO.
  Every push and every pull request needs it: the push for the tree it names, the pull request for the branch's
  tree on the host.
- **The submitted patch** (`patches.py`): the push names the committer's patch (what `submit_work` wrote,
  `git diff --cached --binary` against the run's commit), its message and the GO'd tree. Only a key of the caller's
  own is read (`ws/default/runs/<run>/<agent>/commits/<run's commit>/_patches/attempt-<n>/<name>.diff`), at most 6 MB (refused, never
  cut). It is applied file by file to the run's commit as the host has it: every hunk must match its base exactly, a
  binary file is a literal or a delta on its base; a copy, a submodule, a binary file without its content, a binary
  patch whose file is text by git's own rule (no NUL byte in its first 8000 bytes) or reads as UTF-16 text (it would
  pass the write rules unread: text comes as a text diff), a path with a
  control character, more than 1,000 files or 32 MB of content (a running total, and a delta's stated size before
  it is built) are refused. The write rules then read every path it changes and every line it
  adds, and the host's client pushes one commit on the run's commit and moves the branch only when the tree it
  rebuilt is the GO'd one. A branch takes one such push: a later push to it finds the branch moved and is refused
  (409) until pushes build on the branch's head (planned).
- **The dial** (`dial.py`, TENETS.md tenet 3): the way of working of the person who started the run, from
  `shared/ai_mode.py` (`USERFLAGS#<sub>` / `ai_mode` in the aggregates table, written only by the users API for an
  administrator), read again at every push and pull request. Human-driven: every push and pull request is refused
  (409, with the reason); reads and comments stay as the write rules allow. AI-assisted: a push or a pull request
  waits for a person's go on the run, `POST /agents/engineering/<run_id>/go` (an administrator acting for
  themselves; the board function writes one create-only `GO#person` row, `{by, at, reason?}` (a reason of at most
  500 characters, credential-shaped text redacted), while the run is live; a go already given is answered as it
  stands; no event, the row is the record). AI-driven: goes on to the GO and the write rules. It fails closed, on
  purpose stricter than `shared/ai_mode.py`'s reading for documents (where no row is AI-driven): only an explicitly
  stored AI-assisted or AI-driven lets a run push. A person with no saved way of working pushes nothing (they, or
  an administrator for them, set AI-assisted or AI-driven to let a run push); so does a stored mode outside the
  modes, a run that names no person, or one that names something that is not a person's subject; a read that fails
  is 503, never a pass. The broker reads only the row's `mode` (a projection, which its IAM grant requires). In every mode a pull request opens ready for review, or as a draft when the run's flow says `pr: draft` (7.50.00), and no operation marks a draft ready, approves or merges: a person approves and merges on the host. The go is one per run, not
  per step: marking where each flow's later steps wait is planned with the flows.

The broker's role reads exactly these (`voc-datalake/lib/stacks/engineering-broker.ts`, pinned by its test):
`dynamodb:GetItem` and `dynamodb:Query` on voc-engineering in the runs' partitions (`WS#*#RUN#*`), `dynamodb:GetItem`
on the aggregates table in the people's flag partitions (`USERFLAGS#*`) and of a row only its key and `mode`
(`dynamodb:Attributes`, `dynamodb:Select` `SPECIFIC_ATTRIBUTES`), `s3:GetObject` on the workspace's patches and the
final-go and gate-runner agents' gate records (`ws/default/runs/*/commits/*/_patches/*`,
`ws/default/runs/*/final-go-*/commits/*/_gate/*`, `ws/default/runs/*/gate-runner-*/commits/*/_gate/*`: the GO
ledger's rule reads both), `dynamodb:Query` on voc-agents in the CI attestations' partitions alone
(`CONNECTIONS#*#CI#*`, never a connection's own row or its audit rows) and of a row only its key, `state`,
`repository` and `version` (7.04.00), and `kms:Decrypt` through DynamoDB and S3. Its one write (7.02.00): `dynamodb:GetItem`,
`dynamodb:PutItem` and `dynamodb:UpdateItem` on voc-engineering in the runs' writes' partitions alone
(`WS#*#WRITES#*`: never a run's own, so it cannot overwrite a run's META, tasks, a person's go or its log), of a row
only a write claim's attributes (`pk`, `sk`, `state`, `op`, `at`, `result`, `closed_at`), with `kms:GenerateDataKey`
through DynamoDB; no other write to any table or bucket. The run's pull request's row (7.09.00, below) is written
under that same grant: no new action, partition or attribute.

**The run's issue and pull request (7.09.00).** The run's record keeps which issue it was started from and which
draft pull request (a GitLab merge request) it opened, for the run monitor, the goal and PR reports and the learning
loop (since 7.10.00, people's reactions on that pull request: [below](#peoples-reactions-on-the-host)). `engineering/run_links.py`:

- **The pull request**: `WS#<ws>#WRITES#<run>` / `PULL_REQUEST`, beside the write claims, written by the broker alone
  (`broker.py` `_keep_pull_request`, `records.py` `WriteClaims.record_pull_request`) when the host answers an open or
  an update of the run's draft with it: the host kind (`github` or `gitlab`), the number (GitLab's IID), the URL and
  the head and base branches as the host's answer names them (GitHub's `head.ref` and `base.ref`, GitLab's
  `source_branch` and `target_branch`), never a token, a title, a body or any other host text. Only a claim row's
  attributes (`op` `pull_request`, `at` when it was first recorded, `closed_at` when last written, `result` the link
  as JSON), so the broker's grant is unchanged. It is kept only when the URL is exactly that number's address in the
  run's own repository (META's `repo`: GitHub's `owner/name`, GitLab's project path with its subgroups) on its host's
  own domain over https (`https://github.com/<owner>/<name>/pull/<n>`, `https://gitlab.com/<path>/-/merge_requests/<iid>`)
  and the head is the branch the agent asked for; anything else is logged by its number and not kept. What is kept is
  the address rebuilt from the host, repository and number, never the host's own spelling of it. Keyed on the head
  branch: the same number again updates its base (a person may change it on the host) and its address; a new number
  on the same head (a person closed the draft and the next open made another) replaces it, the earlier numbers kept in
  `superseded` (at most 20, the oldest dropped); a pull request on another head is refused, so the record never moves
  to another branch's. The broker reads the row and writes it on the condition that it is still what it read (none,
  or its exact `result`), up to three tries. A write whose outcome is unknown (the host did not answer, or the check
  after the write failed) records nothing; the next open or update (another attempt) finds the pull request by its
  branch on the host (the clients' existing lookup) and records what that answers. A record that cannot be written is
  logged and counted (`EngineeringPullRequestUnrecorded`, namespace `VoC`, the broker's service; no alarm watches it
  yet) and never fails the write, which was made; the write's done claim keeps the same answer (number, URL, host and
  branches), so the readers take the newest done claim of the pull request author's when it is newer than the row and
  names another number, or there is no row: one Query of at most 10 of its claims (`WRITE#pr-author-…`, the role's
  only write, so the prefix holds its claims alone; it cannot be narrowed to the operation, which follows the agent
  and attempt in the key), last in key order first, the latest closed of them on the run's own branch, checked by the
  same rules; logged as a warning once per run, row and claim in each container, at debug after. The key orders
  agents and attempts as text (`pr-author-10` before `pr-author-2`), so past nine of either a newer claim can fall
  outside the read; the row then stands until the next open or update rewrites it. Planned: an alarm on
  `EngineeringPullRequestUnrecorded` (with the other engineering alarms, `lambda/shared/ops_alerts.py`).
- **The issue**: nothing carried one before (no start field, task input or flow step names it), so a run's start takes
  an optional `issue`, a whole number from 1 to 2,147,483,647 (`POST /agents/engineering/runs`, the flow page's Start
  a run): the start writes it to META's `issue` once, with the run, as `{host, number, url, verified: false}`, its
  address built from the stored connection's host and repository. It is recorded as given, labelled unverified: only
  the broker holds the connection's credential, and the start reads nothing of the host. Since 7.47.00 an engineering
  agent's start reads it through the broker's `head` (voc-engineering-start's one broker operation, read only): an
  open issue of the repository is recorded `verified: true`; a closed one, or a number the repository has no issue for
  (a pull request's included), refuses the start before anything is written. The broker serves that issue to the run
  (`records.py` `issue_number`): its understander comments on it alone, and its pull request's body names it, `Fixes
  #N` (GitLab: `Closes #N`) added when the body does not reference `#N` (`broker.py` `closing_body`).
- **Shown**: the run overview (`GET /agents/engineering/<run_id>`) answers `run.issue` and `run.pull_request` (null for
  none), each read back only when its address passes the same check; the run monitor links them, opened in a new tab
  with `rel="noopener noreferrer"`, only when the address is https on the record's host's own domain under the run's
  repository (else shown unlinked), an unverified issue saying so; the goal and PR reports name them, each in a code
  span (a report links, mentions and references nothing on the host). The broker does not take them as the issue and
  pull request an agent may comment on yet: comments stay refused.

**What is built.** The GitHub client (`connectors/github.py`) reuses a cached installation token or, to mint one, signs
a nine-minute App JWT (RS256, the App's private key from the connection's parameter, below) for an installation token for the connection's one repository and
only the permissions the operation needs: a file or history read `contents: read`, an issue read `issues: read`, a
pull request read `pull_requests: read`, a comment `issues: write` or `pull_requests: write`, an issue's triage
labels `issues: write` (7.50.00), a push `contents: write`, a pull request `contents: read` and `pull_requests:
write` (`metadata: read` comes with
every token). A token is kept in memory until five minutes before it expires (GitHub's tokens live an hour). Reads
follow the `Link` header's next page (the cursor is that page number, nothing else); a pull request read returns the
pull request, its conversation, its review comments and its reviews, a page of each. A rate limit (`Retry-After`,
`X-RateLimit-Remaining: 0` with `X-RateLimit-Reset`, or a secondary rate limit) is never waited out inside a call: it
is answered 503 with `Retry-After`. A file path with an empty, `.` or `..` part is refused before any request, and a
file that is not UTF-8 text is refused rather than read lossily; a patch's base file is read raw at the run's commit.
A push takes its commits as the patch reader read them (`BundleContents`: its base commit and each commit's changed files; its changed paths and added lines cover every commit, not only
the final tree). The client refuses a commit that changes a path the bundle does not list, and refuses unless the
branch's head is the bundle's base or, for a branch not on GitHub yet, the base is the default branch's head or an
ancestor of it (a base GitHub does not have is refused too). It rebuilds the commits with the Git Data API (a tree on
the parent's tree with text files inline and other files as blobs, then a commit whose author and committer are the
App's bot), refuses unless the last tree GitHub computed is the tree the broker checked, and only then moves the
branch with `force: false` (or creates it): a push made meanwhile that the new commit does not descend from makes
the update fail (a fast-forward of the same lineage still passes, so the head check before it is the lease). Objects of a refused push
stay unreferenced. A pull request is opened (7.50.00: ready for review, or as a draft when the run's flow says `pr:
draft`, META's `pull_request`), or its title and body updated, only when the branch's head has the
checked tree, and the pull request's head is checked again afterwards: if the branch moved meanwhile, a pull request
the client just opened is closed, and the write's outcome is unknown (7.02.00: it went out, so it is never answered as
refused, and never made again for that attempt). An update changes only the title and body, never whether it is
a draft (GitHub's REST API cannot turn a ready pull request back into a draft, and the client never marks a draft
ready; on GitLab an update keeps the merge request's draft marker as GitLab says it is now, and writes only the
description when GitLab does not say). The body the broker sends always ends with its own line that only a person
approves and merges the pull request (`MERGE_IS_HUMAN`). Every request goes to `api.github.com` through one
transport, with no redirect followed; a token is sent only in the `Authorization` header, never in a URL or a log
line. The client has no method for a merge, an approval, settings, a change of branch protection, members, webhooks or
secrets; of the branch rules it only reads what any reader of the repository sees (the CI check, above).
Each write the host accepts gets an operational log line with the operation, the caller, the connection and what was
written (issue or pull request number, branch, tree hash, commit count), never a body, a patch or a token; the
durable audit row of each write (D4) is still planned (the broker's one write, since 7.02.00, is each write's claim
row, which records its outcome but not who asked for it in D4's form).

The GitLab client (7.06.00, `connectors/gitlab.py`, over `gitlab_api.py`) holds the same contract with the
connection's project access token, which it uses as it is (nothing is minted, nothing revoked): every request goes
to `gitlab.com` under `/api/v4/projects/<id>` through one transport, no redirect followed, the token only in the
`Authorization` header. Reads: a file raw on the run's branch (`ref`), history (`ref_name`, `path`), an issue or a
merge request with a page of its notes (system notes left out; a merge request's diff notes as its review comments
with their path and line, its approvals as its reviews, on the first page), a patch's base file at the run's commit.
Pages follow `X-Next-Page` (the cursor is that page number, nothing else); a read lost on the way or answered 502,
503 or 504 is sent again once (two tries in all), a write never; a rate limit (429 with `Retry-After` or
`RateLimit-Reset`) is never waited out, it is answered 503 with `Retry-After`. What GitLab says of a refusal (its
`message`) is kept in the error only after the token and anything credential-shaped are cut out, on one line, at
most 200 characters. GitLab's API answers no commit's tree id, so the client works it out as git does
(`gitlab_tree.py`, pinned against real git by its tests): a branch's tree from its head's root listing, and a push's
from the base commit's listings of the directories it changes (at most 200 directories of at most 2,000 entries
each: more is refused, nothing written). A push is refused before anything is written when a commit changes a path
the bundle does not list, writes a symbolic link (the Commits API's actions cannot), or changes a CI definition the
project names (below); when the branch's head is not the bundle's base, or, for a new branch, the base is not an
ancestor of the default branch's head (`merge_base`); and when the tree its changes give on the base is not the
checked tree. The reads before the write are bounded: at most 400 requests, and none that could, with its retry,
end past the invocation's remaining time less 65 s (`hosts.WRITE_READY_BY` and `WRITE_RESERVE_SECONDS`, set by the
broker's handler from Lambda's context); and the first commit starts only if it, a page of its read-back and a
stop's reserve fit. Past any of them the push is refused with nothing written (its claim closed refused, never left
open; "push fewer changes at once"). Then each commit is one Commits API
call (`POST …/repository/commits`, its actions create, update, delete and, where the mode is not the one GitLab would
leave, `chmod`; content in base64; author and committer the token's bot); the first commit's updates and deletions
carry each file's last commit at the base (`last_commit_id`, read with one `HEAD` of the file: a partial lease, so a
file changed meanwhile refuses the commit, 400, nothing written). A new branch is created by its first commit
(`start_sha`: GitLab refuses it, 400, when the branch was created meanwhile, a conflict with nothing written). The
Commits API has no lease on an existing branch's head, so after the write each new commit's parent and the last one's
tree are read back: a commit that landed on another head or with another tree, or any failure once the first commit
is written (a rate limit or a lost read-back included), is an unknown outcome (never answered as refused, never made
again for that attempt). A push writes at most 20 commits (more is refused before anything is written). The time
after the first commit follows one model (`gitlab.py`), each step by its worst case: a request waits at most 10 s, a
read is sent at most twice (20 s), a write once (10 s). A stop keeps 35 s: the undo's read and delete (30 s) and the
answer (5 s). So no later commit starts unless it and a page of the read-back (30 s) and that reserve fit; no page of
the final read-back starts that would end inside the reserve (the read-back is cut short, and the outcome says so);
and the reserve the reads before the write leave is 10 + 20 + 35 = 65 s. A branch this push created is then deleted
when its head, checked just before, is one of the push's own commits: a read, then an unconditional delete (GitLab
has no conditional one, so a push landing between the two is not protected), and only when both still fit before the
invocation's end; otherwise it is left. The outcome's words say what landed and whether the branch was deleted or
left. These times are assumptions, not guarantees: http.client's timeout is per socket operation (a slow trickle of
bytes can outlast it) and the name lookup is not covered, and closing the write's claim is a DynamoDB write under
boto3's default timeouts and retries. Past them, Lambda's own timeout ends the call: the claim is left open, a repeat
of the write is answered unknown, and the write is never made twice. A draft merge request is opened (title
`Draft: …`, against the run's default branch, the source branch kept; an open one is the run's only when it is from
this project, not a fork, and into that branch) or its title and description updated only when the branch's head has
the checked tree, and checked again afterwards, as on GitHub: a merge request the client just opened is closed when the
check fails, and the outcome is unknown. An update keeps the `Draft:` title, so it stays (or becomes again) a draft.
A note's link is `https://gitlab.com/<project>/-/issues/<n>#note_<id>` (or `/-/merge_requests/`). The client has no
method for a merge, an approval, settings, protected branches, members, webhooks or variables.

**CI definitions on GitLab (`connectors/gitlab_ci.py`).** An agent never changes a CI definition, so before a GitLab
push the broker pins the project's CI definitions at the bundle's base, and refuses every push it cannot pin, failing
closed. **Agents push only to GitLab repositories whose CI configuration uses plain local includes and GitLab's own
templates.** Shared CI from other projects, remote includes and components are not supported for now (an owner
decision): the connection's token reads this project alone, so the broker cannot see what they hold or include.

- The CI file, `ci_config_path` from the project: an answer without the key is unresolved; an empty value is
  `.gitlab-ci.yml`; a file of another project (`<file>@<namespace>/<project>`), this project by `@`, a URL, or a path
  that climbs out is refused.
- Each CI file is parsed, not scanned (`connectors/ci_yaml.py`: PyYAML 6.0.3's pure-Python composer, from the
  broker's own `engineering-ci-deps` layer, held strict; JSON is YAML too). Before it is read, input that is not
  UTF-8, a byte-order mark, a carriage return without its line feed, U+0085, U+2028, U+2029 or U+FFFD refuses; in it,
  a second document, an anchor or an alias, a merge key (`<<`), a tag other than the standard ones and `!reference`
  (kept opaque), a duplicate key at any level, or a key that is not printable ASCII or is written with an escape
  refuses. Its top level must be a mapping, and its `include` is walked as structure: a string (a local path, or a
  remote one when it is a URL), a mapping, or a list of those. A mapping may hold only `local`, `template` (with
  `inputs`), `project`, `file`, `ref` and `remote`; `rules`, `component` or any other key refuses, and so does a `*`,
  a `$`, a `[[` or a backslash (an escaped double-quoted value included) in any value of it at any depth.
- `local` with a literal path is allowed, and the file it names is read at the base and walked by the same rules
  (at most 10 deep and 50 files); `template` (GitLab's own) is allowed; `project` (this project, whatever its ref, or
  another), `remote` and `component` are refused.
- Every job's `trigger`, in every file the walk reaches, is walked too: a child pipeline's `include` (a string, a
  list or a mapping) names CI definitions GitLab's lint does not list, so a literal `local` file is pinned and walked
  and a `template` allowed, and `project`, `artifact`, `remote`, `component`, a `$`, a glob or anything else refuses,
  naming it. A multi-project trigger (`trigger: <project>`, `trigger: {project: ...}`) is allowed: it runs another
  project's CI and puts nothing of this repository in CI. A job (any top-level key but the global keywords) whose
  value is not a mapping is unreadable, and refuses.

Known refusals and limits of the walk:

- A job that `extends` another may add only how its child pipeline runs (`trigger: {strategy: depend}`, `forward`):
  GitLab merges that into the extended job's `trigger`. When that job is in one of this repository's CI files (a
  hidden job included), the walk has already read its `trigger` and pinned what it includes; when it comes from a
  GitLab template, it is GitLab's own fixed content, which the walk does not read. The same
  `trigger: {strategy: depend}` without `extends`, or with an `include` of its own beyond the rules, refuses; so does
  `trigger: !reference [...]` (the walk cannot follow it).
- An empty top-level value (`variables:` with nothing under it, a job with no body) is not a mapping, so it refuses.
- The lint cross-check covers the parent pipeline's includes only: GitLab's lint does not list child pipelines,
  whose files the walk pins itself.
- A multi-project trigger (`trigger: {project: ...}`, a `$X` in it included) runs another project's CI with the
  variables the job forwards; protecting that project's pipelines is that project's own.
- GitLab's CI lint at the base (`GET …/ci/lint?content_ref=<base>`) is a cross-check: an answer that is not `valid`,
  an include it resolved of any kind but `local` or `template`, or a local one the walk did not reach, refuses, so
  GitLab's own reading of the files catches any reading the broker's missed.

Paths are normalised (`./`, a leading `/`) before they are compared. The CI definitions are the CI file and every
local file the walk reached, beside the paths the write rules know (`.gitlab-ci.yml` and the `.gitlab` CI folder): a
push that adds, changes, deletes or renames any of them is refused (`write_policy.check_ci_definitions`). A refusal
names the include: "The repository's CI configuration includes <it>, which the broker can't read and pin; agents can't
push to it while it does." The attestation stays the boundary for what the token cannot read (variables, runners).

| Host | Credential | Permissions it holds | Never |
|---|---|---|---|
| GitHub | a GitHub App installed on the chosen repositories; each token is minted for one repository and the permissions the step needs, refreshed before it expires | `metadata: read`, `contents: write`, `pull_requests: write`, `issues: write` | `administration`, `workflows`, `secrets`, `actions`, `members`, any organization permission |
| GitLab (gitlab.com) | a project access token for exactly the connection's project, role Developer, scopes `api`, `read_repository` and `write_repository` (`api` alone covers merge requests and notes; the repository scopes are what git's fetch and the Commits API name), with an expiry of at most a year; checked against the project at each save; the connection page shows when it expires, warns within 30 days, and takes its replacement | the Developer role's, through the API and git over https | Maintainer or Owner role; group or personal tokens; a self-managed instance (planned) |

**Egress.** The broker and the checkout cache's writer are Lambdas outside any VPC, so their way out is Lambda's own,
as for `api.github.com` before: what holds each to its host is the code. Each client's transport is bound to one host
when it is made (`transport.py` `HttpsTransport`: `api.github.com` for the GitHub client, `gitlab.com` for the GitLab
client; a path, never a URL, no redirect), and the cache writer's remote is one of two fixed prefixes
(`https://github.com/`, `https://gitlab.com/`) with git's redirects off. The Agents API reaches `gitlab.com` only for
a save's token check, and (7.45.00) `api.github.com` only for an App manifest's code exchange, each through the same
bound transport; the GitHub Apps' token function (`voc-engineering-app-tokens`) reaches `api.github.com` only, the
same way. The agents' own sessions reach no host of either: nothing new is on their allowlists.

**The broker.** One Lambda, the connector's broker, is the only code that holds a host credential for a run (since
7.45.00 one more function signs with a deployment's GitHub App key, the token function, for an installation's read and
the github_issues source's read-only tokens, never for a run: [A GitHub App in two
clicks](#a-github-app-in-two-clicks-74500)): no agent's session ever holds one. Agents ask it for typed operations, and each role may invoke only the operations it needs;
the broker is reached only through a Lambda function URL with IAM authentication (as is the board's API, below), whose
request carries the caller's assumed-role ARN, and it takes the caller's role,
run and agent from the caller's assumed-role identity (the role is the agent role; the session name, which the
runtime's launcher sets and no agent can change, names the run and the agent), never from the request; the run's
connection comes from the run's record. A unit test pins a fixer's push, and a committer's push to another run's
branch, being refused:

| Role | Operations |
|---|---|
| every agent | read files, history, issues and pull requests through the broker; checkouts come from the checkout cache, which its writer fills with the connection's read-only token; since 7.52.00 the run's connection's accepted tenets (`read` of kind `tenets`, target `accepted`: the store's, never the repository's file) |
| issue understander, PR reviewer | post a comment on the run's own issue or pull request (from the run's record) |
| issue understander | put its triage labels on the run's own issue (7.50.00, `label_issue`: `{number, labels}`, only `voc-triage/bug\|feature\|investigation` and `voc-severity/s1`–`s4`, at most one of each, once per attempt; no dial: a label changes no code) |
| committer | push its submitted patch, as one commit, to the agent's branch (`push_bundle`: `{branch, patch, tree_hash, message}`) |
| PR author | open or update the agent's pull request (ready for review, or a draft when the run's flow says `pr: draft`) |
| voc-engineering-start (no agent) | `head` (7.47.00: a connection's default branch's head and an issue's state, read only) and `push_approved_docs` (7.52.00: the approved knowledge docs or tenets, at an administrator's request: [The knowledge docs pull request](#the-knowledge-docs-pull-request-75200)) |

Every operation goes through the connector's rules, which refuse, before the host would: a push to any branch but
the run's own (`voc-agent/{run_id}/…`, the run from the caller's session name), the default branch above all; any
push or pull request the dial holds (above); any push or pull request without the board's final-go GO for exactly
its tree (since 6.23.00 every push, not only one to a branch with an open pull request); a push with other than
exactly one head ref; a merge, an approval; any call to
settings, branch protection, members, webhooks or secrets; a change to the CI definition paths it knows (the GitHub
workflows and actions folders, the GitLab CI files, and on GitLab, since 7.06.00, the project's own CI file and what it
includes from the project, "CI definitions on GitLab" above: best effort, since a pipeline can include other files; the
CI attestation below is the real boundary, and the GitHub App holds no `workflows` permission); a write that carries
customer text (below): a verbatim sentence of a cited review anywhere the agents wrote (comments, the pull request's
body, commit messages, the lines a diff adds; split at full stops and line breaks, compared after Unicode
compatibility normalisation, invisible format characters dropped), and personal data in their prose (comments, the
body, commit messages), never in what was already in the repository. The agents write a commit's author and
committer themselves, so both must be the connection's bot address, or the push is refused; a commit's
`Co-authored-by:` and `Signed-off-by:` trailers take only the form `Name <address>` with the bot's address, their
name part read as prose, and any other such trailer is refused. A branch name must also be one git accepts (no
component starting with `.` or ending with `.lock`, no `..`, `@{` or trailing `.`). The broker hands the host the tree it checked (and the GO is for): the client pushes the bundle's head only
when it has that tree, with a lease on the branch's head, and opens or updates a pull request only after verifying
that the branch's head has it. A unit test pins each refusal. The setup guide asks
the team to back them with the host's own rules: protect the default branch, and limit the App's or token's pushes to
`voc-agent/*` (a GitHub ruleset; GitLab protected branches, plus a branch-name push rule on the tiers that offer one).

**The target's CI.** A push to an agent branch can start the repository's own pipelines, and those run scripts an
agent can change. So, on unprotected branches, the repository's pipelines must get nothing worth taking: CI secrets
scoped to protected branches (GitHub environments with branch rules; GitLab protected variables); a read-only default
workflow token and no workflow asking for write `permissions:`; cloud trust through OIDC (`id-token: write`, GitLab
`id_tokens`) pinned to protected branches or environments; no self-hosted runner for unprotected branches; no
workflow that runs in the default branch's context on a pull request (`pull_request_target`, or `workflow_run`
downloading the triggering run's artifacts) checks out, runs or downloads the pull request's code or artifacts; on
GitLab, no job-token push. The App holds no permission that could read these settings, so this is an
**attestation**, not a check: an administrator confirms each point on the connection page, the confirmation is
recorded with who and when (D4), and every push to an agent branch and every pull request it would open are refused
until it is there (built in 7.04.00, above: the six points are those five and the branch rules of the setup guide,
the default branch protected with the repository's required checks and the App's pushes limited to `voc-agent/*`).
Of all that, the broker checks only two things for itself, with the App's read-only token, at each push and pull
request (above): that the default branch is protected with at least one required check, and that the agent's
branch is not protected. Everything else, the `branch_rules` point's limit of the App's pushes to `voc-agent/*`
included, is the administrator's attestation alone. GitLab is the same (a Developer token cannot
read the CI/CD variables, the job token's settings or the runners), so its attestation (7.06.00) is the same six
points in GitLab's words ("The CI attestation's record", above), and the broker checks for itself what its token reads
of the branch rules ("What the broker reads", above).

**Credentials** are SSM Parameter Store SecureString parameters under the stack's customer-managed KMS key (the
standard tier has no monthly charge), one per connection, `/voc/engineering/{connection_id}` (`{workspace_id}/` is
prefixed once multi-workspace lands; a prefixed deployment puts its prefix on the `voc` segment,
`/<prefix>-voc/engineering/…`). A GitHub connection's value is JSON: `app_id`, `installation_id`, `repository`
(`owner/name`) and `private_key` (the App's PEM key), or, for a connection made through one of the deployment's GitHub
Apps (7.45.00), the same ids and repository with `"key": "app"` in place of the key, which the reader resolves with a
second read of the App's own key, `/voc/engineering/_github-app/<app_id>/key` (`{app_id, slug, private_key}`, its App
id checked against the connection's, kept five minutes like a credential; the readers' grant on the path covers it, and
a leading `_` is never a connection id); a GitLab connection's (7.06.00) `host: gitlab`, `project_id`,
`repository` (the project's path), `token` and `expires_at`. The Agents API writes and deletes them (an administrator's
save or removal, above), and never reads one. Only the broker and the checkout cache's writer read them
(`connectors/credentials.py`:
`ssm:GetParameter` on that path only, `kms:Decrypt` on the stack's key only through SSM and only for those
parameters), decrypted, kept in memory five minutes at most; a missing or malformed one answers 503 and is logged by
connection id and error code only. They are never put in a model's context, an event, a log line, a checkpoint or a
session. Stopping a run turns the broker off for that run at once: every further operation is refused before any
token is used. Tokens are not revoked early: each is minted for one repository and one operation's permissions, held
only by the broker, and expires within the hour. A GitLab project access token is the connection's own, long-lived
credential (it lapses on its expiry, at most a year out), so it is never minted and no revocation call is made for
it: revoking it would cut the connection itself. Removing the connection deletes its parameter; revoking the token is
done in the project's settings.

**Who can read and use.** Connections, the code read from them, the knowledge packs, the conversations and the
workspace are readable by administrators only by default; a non-admin sees an engineering run only when an
administrator shares its connection with them, and then every feedback-derived field it shows (ids, counts,
categories, problem labels, in findings, reports, the conversation and memories) is filtered by the viewer's own
category and source access, not the run owner's; what the viewer may not see is left out (built: an engineering run's
reads are admin-only, 403 for anyone else; sharing and the per-viewer filter are *planned*). A flow can use a connection only when it is shared with the agent's
owner, checked when the workflow is saved and again when the run starts.

### A GitHub App in two clicks (7.45.00)

An administrator makes the deployment's own private GitHub App from Agents → Connections, without copying a key
(`voc-datalake/lambda/engineering/connectors/github_apps.py`, the Agents API's side; `connectors/app_tokens.py`, the
token function's). Only with `-c engineeringAgents=true` (404 otherwise); every route is an administrator's acting for
themselves (a delegated MCP credential gets 403), served through `/agents/{proxy+}` with Cognito: no new
unauthenticated endpoint. Pasting an App's key into a connection (above) stays.

1. **Create.** `POST /agents/engineering/github-apps/manifest` `{account: "user" | "organization", org?, workspace?}` →
   `{action_url, manifest, expires_at}`: the form's target, `https://github.com/settings/apps/new?state=…` or, for an
   organization (its login as GitHub spells one: letters, digits and single hyphens, at most 39),
   `https://github.com/organizations/<org>/settings/apps/new?state=…`, and the manifest: `VoC Autonomous Agent <hex4>`
   (7.49.00; 25 characters: GitHub takes at most 34, and an App's name is unique on all of GitHub, hence the suffix), private,
   no OAuth on install, its setup asked again on an update, Contents, Pull requests and Issues read and write and
   Metadata read; where the github_issues webhook is deployed, its hook on `<API>/webhooks/github_issues` with the
   issues and issue_comment events; `redirect_url` `/agents/connections/github/created` and `setup_url`
   `/agents/connections/github/installed` on the deployment's own CloudFront domain (a prefixed deployment's too). The
   manifest is written for each creation, so its `redirect_url` comes back into the workspace the flow started in
   (`/workspace/<slug>/agents/connections/github/created`, the request's `workspace`, a slug as the platform makes one; 7.49.00).
   The `setup_url` is fixed when the App is made and an install may start in any workspace, so it stays top-level: the
   SPA takes a return there (and to the created page outside a workspace) straight back into the workspace the flow
   started in, remembered in the tab when the manifest is posted or an install link opened (else the workspace last
   entered, else the caller's first), with GitHub's query carried through and never the workspace picker
   (`frontend/src/workspace/returnWorkspace.ts`). Both pages then take their query out of the address as before. The
   browser posts it to GitHub (the SPA's `form-action` admits `https://github.com` alone, only with the module:
   [deployment.md](deployment.md#the-web-apps-form-action-74500)). At most 5 Apps (409 past them).
2. **The code.** GitHub creates the App and sends the browser back with a `code` (a bearer credential for an hour, used
   once) and the state; the page takes both out of its address at once (a replace) and posts them once:
   `POST …/github-apps/conversions` `{code, state}` → 201 `{app, install_url, expires_at}`. The Agents API exchanges
   the code (`POST https://api.github.com/app-manifests/<code>/conversions`, no authentication, over the broker's
   crypto-free transport) and stores, before the App's row, its key once, `/voc/engineering/_github-app/<id>/key`
   (`{app_id, slug, private_key}`), and, when a hook was asked for, its webhook secret,
   `/voc/engineering/_github-app/<id>/webhook` (`{webhook_secret}`): SecureString, standard tier, the stack's key,
   never overwritten. The client id and secret are discarded; the key sits in memory once, in a value whose `repr`
   leaves it out. The answer's install link carries a new state, so the second click is a navigation. A code GitHub no
   longer takes (404 or 422: expired or used) is 409: the App may then exist on GitHub without its key here, and is
   deleted in GitHub's settings and made again. The referrer policy is `same-origin`, so the return page's address is
   never sent to another origin.
3. **Install.** GitHub sends the browser back to `/agents/connections/github/installed` with the installation's id,
   `setup_action` and the state: `POST …/github-apps/installations` `{installation_id, setup_action, state}` →
   `{app, account, connections: [{connection, created}], skipped: [{repository, reason}]}`. The token function reads
   the installation with the App's JWT (`GET /app/installations/<id>`: another App's installation answers 404 there,
   409 "belongs to another App"; one whose `app_id` differs or that is suspended is refused alike) and lists its
   repositories with an installation token of `{metadata: read}` alone, which it revokes before it answers (no token
   is ever answered to the Agents API). Every installed repository is saved as a connection (`ConnectionStore.save`,
   with its audit row): its id the repository's name (lower case, other characters `-`, then `-2`, `-3`… on a
   collision), its default branch GitHub's, its row `repository_private` and `credential_kind: app_reference`, its
   parameter a reference to the App's key (above, "Credentials"). An archived repository (`archived`), one already
   connected (`already_connected`), those past the 20 connections (`limit`) and one whose save fails or whose default
   branch the connections refuse (`not_saved`) are skipped and reported. `setup_action: request` (an owner must
   approve the installation) is refused without touching the state, which stays good until it expires; a return
   without a state calls nothing (the page points to **Check installation**). Before the agents push, each
   repository's CI is attested as for any connection.
4. **Afterwards.** `GET /agents/engineering/github-apps` → `{apps: [{app_id, slug, owner, owner_type, html_url, webhook,
   connections, created_at, created_by, version}], limit}`; `POST …/github-apps/<app_id>/install` `{}` → a new install
   link (to install it on more repositories); `POST …/github-apps/<app_id>/check` `{}` → `{repositories, missing}`: what
   the installations the App's connections name cover now, and the connections whose repository they no longer do
   (the broker refuses those, failing closed: GitHub mints no token for a repository outside the installation);
   `DELETE …/github-apps/<app_id>` `{reason?}` → `{removed: true}`, its parameters deleted first, then its row marked
   removed with its audit row; 409 while a connection uses it. Deleting the App on GitHub stays the administrator's
   (its settings page), and so does renaming it: GitHub → Settings → Developer settings → GitHub Apps → the App →
   **Edit**, its name (an organization's App is under the organization's settings). GitHub derives the App's slug, its
   `github.com/apps/<slug>` page and install link, from its name, so a rename can change it: **Check installation**
   records the slug the installation reports (`app_slug` of `GET /app/installations/<id>`, which the token function
   answers since 7.49.00) when it differs, with the App's page and a `github_app_renamed` audit row, so **Install
   more** keeps working; the App's row shows it at once. The App's name itself is not stored. The slug is learned
   from an installation, so rename an App after its first install: one renamed before it keeps the slug it was made
   with, and its **Install** link then names a page GitHub no longer has (rename it back, install, then rename it;
   or remove it here and make another).

**State.** Each step's state is `secrets.token_urlsafe(32)`, handed to the browser and never stored: its row,
`CONNECTIONS#default#SETUP` / `STATE#<sha256 of it>`, names its purpose (`create` or `install`), the administrator's
subject, the account, the App, `expires_at` (30 minutes) and `ttl` (a day; voc-agents' TTL attribute, which no other
row carries, removes it). One conditional UpdateItem claims it (the same administrator and purpose, unexpired,
unclaimed). A failure before the App's key is stored (GitHub unreachable, rate limited or failing, its answer lost or
off its shape) gives the claim back, so the page may post the code again (a code GitHub already spent then answers
the 409 above); a failure once the key is stored does not; the step's outcome is kept on the row, so the same administrator posting it again (a
refresh, React's double effect) gets the same answer (a code GitHub refused, the same 409); anything else is one
uniform 400 that says nothing of which check failed. The rows are in the connections' partition, so every other writer
of voc-agents is denied them (`denyHardCapWrites`).

**Rows and audit.** An App is `CONNECTIONS#default` / `GITHUB_APP#<id>` (its id, slug, owner and its kind, page, whether
it has a hook, who made it and when, a version); its creation and removal are create-only audit rows of the
connections' `LOG#` shape (`github_app_created`, `github_app_removed`: who, when, the slug, owner and hook, `key:
stored` or `removed`, never the key).

**The token function** (`voc-engineering-app-tokens`, VocProcessingStack, `lib/stacks/engineering-app-tokens.ts`): the
broker's code under a role of its own, with the broker's signing layer, entered at `connectors/app_tokens.lambda_handler`,
which takes `inspect_installation` (above), `issues_token` and, since 7.50.02, `ensure_label`, and refuses every other
action, and any request off its shape or naming a workspace, before anything is read. Its role holds `ssm:GetParameter` on `…/_github-app/*/key` only
and `kms:Decrypt` through SSM for those parameters alone (`PARAMETER_ARN`): no table, no bucket, no function URL, no
resource policy. The Agents API's role and the github_issues ingestor's may invoke it by name (IAM cannot tell which
action an invoker asks for: the Agents API's code asks `inspect_installation` and `ensure_label` only). `ensure_label`
`{app_id, installation_id, repository, label}` (7.50.02, the connections' follow of the GitHub Issues source,
[github-issues.md](github-issues.md#configured-by-your-github-connection-75002)): `label` must be exactly `voc-agent`,
the installation the one GitHub says covers the repository, and the token exactly `{issues: write}` for that one
repository; it reads the label, creates it only on a 404 (color `5319e7`, "Picked up by the VoC agents"), revokes the
token and answers `{repository, label, created}`. `issues_token` `{app_id,
repositories}` (the github_issues source's sign-in, [github-issues.md](github-issues.md#signing-in-with-a-github-app-74500)):
for each repository the installation covering it (`GET /repos/<o>/<r>/installation` with the JWT; a 404 is
`uncovered`), then one token per installation, exactly `{issues: read, metadata: read}`, `repositories` narrowed to
the run's ones it covers; the ingestor revokes each when its run ends.

**IAM, per role.** The Agents API: `lambda:InvokeFunction` on the token function by name, no new SSM grant (the Apps'
parameters are under the connections' path its put and delete already cover), still no `ssm:GetParameter`; since
7.50.02, where the github_issues plugin is deployed, `lambda:InvokeFunction` on `voc-engineering-issues-config` by name
and nothing on the shared secret or the schedule rule (`lib/stacks/api-engineering-issues-sync.ts`; pinned: no
`secretsmanager:*`, no `events:EnableRule`). The GitHub Issues settings function (`voc-engineering-issues-config`,
VocProcessingStack, `lib/stacks/engineering-issues-config.ts`, with the module and github_issues only): exactly
`secretsmanager:GetSecretValue` and `PutSecretValue` on the shared API-credentials secret's ARN and
`events:DescribeRule` and `EnableRule` on the github_issues schedule rule, no function URL, no resource policy, no
table, no bucket ([github-issues.md](github-issues.md#configured-by-your-github-connection-75002)). The token
function: above. The github_issues ingestor (its own role): `lambda:InvokeFunction` on the token function, only with the
module on. The shared webhook role: `ssm:GetParameter` on `…/_github-app/*/webhook` only, only where the github_issues
webhook and the module are both deployed (its `kms:Decrypt` is the role's grant of the stack's key). The broker and the
checkout cache's writer: nothing new. All pinned by `lib/stacks/engineering-app-tokens.test.ts` and
`api-engineering-reads.test.ts`.

## The knowledge pack

*Partly built* (`voc-datalake/lambda/engineering/knowledge/`): the packages and their owners, the shards, the map
step's one model call and its note schema, the reduce into documents, and the versioned store with approval, as
tested code that nothing invokes yet. Since 7.52.00 the REST routes list, read and approve a version (admin only,
[below](#the-knowledge-docs-pull-request-75200)), an approval records the docs the pack renders to, and those docs go
to the repository in a pull request; the repository's tenets have a store of their own ([below](#the-repositorys-tenets)).
Planned: the Understand flow and the mapper agent that run them (phase 4: until then nothing reads a repository for a
pack, and no pack exists), an edit route, several runs resuming one map, and the dependency graph in the architecture
document. A refresh starts as a run of the saved Understand flow: from
the flow's page (**Start a run**), `POST /agents/engineering/runs`, or the AI assistant's approval card ("refresh the
knowledge pack", 6.27.00: only an administrator's Approve starts it, as them; [From the
assistant](#how-the-agents-work-together)); until the runtime follows a flow's steps, such a run maps nothing yet.

"How this repository works": **one overview plus one pack per package**, each refreshed only when its package
changes. Built by the Understand flow, read by the other agents.

**Map.** Each package is cut into shards that fit one small model call: its directories, its history in windows of
commits, its pull requests in pages with their review threads. Each shard yields notes, every note citing its source
(`path:line`, a commit sha, a PR comment's URL), written to the run's workspace. A repository larger than one run's
budget is mapped over several runs, each resuming at the first shard not yet mapped.

Built (`shards.py`, `mapper.py`, `notes.py`): a package's files are cut in path order within a byte budget (48 KB by
default, each item costing 64 bytes more for its header); over it, at its subdirectories (siblings that fit share a
shard again), again deeper, and a single file over it is read in byte windows. History comes in windows of 50 commits
oldest first, so new commits change only the last window, pull requests in pages of 20 by number; a window or page
over the budget is halved, one big item windowed. A shard's id is a hash of its package, kind and items, so the same
cut always has the same ids and `pending` names the shards a resumed run still has to map. The map step is one model
call per shard behind the quality gate's model interface (the enrichment surface's default, the cheap model, until
the `eng_mapper` surface lands): the shard's text, a file's lines numbered as the repository numbers them, goes in a
DATA block with a random fence, credentials redacted first. Its answer is `voc-note/1` JSON lines (a kind: one of the
seven documents; the package; an optional subject; the claim; its citations). A line off the schema is dropped and
counted. Each citation must name what that shard itself read: a `path:line` of one of its files and a line it
showed, a full sha of its history window, or the URL of a review comment on the connection's own repository (GitHub
`…/pull/<n>#discussion_r<id>`, `#issuecomment-<id>`, `#pullrequestreview-<id>`; GitLab
`…/-/merge_requests/<n>#note_<id>`) that appears in its pull request page. Anything else is removed, a real path,
commit or comment of the repository the shard never read included, and a note left without one is dropped and
counted. A claim is cut to 400 characters on one line after credential-shaped strings and personal data are replaced,
as for a finding. The notes are written once under the mapper's own workspace key for the shard; the reduce reads a
shard's notes only from a key of this refresh's own workspace, run, agent, commit and package, named for that shard,
and checks them again against the package (its listed files and commits, a well-formed comment URL of the
repository). A key from anywhere else, or an object that is not there, stops the publish and names the shard, to be
mapped again.

**Reduce.** The notes become documents, per package and for the whole repository:

| Document | What it says |
|---|---|
| Architecture | components, data flow, boundaries, entry points, the dependency graph between packages |
| Conventions | code style with examples taken from the code, naming, error handling, logging |
| Review guide | what reviewers ask for, block on and praise, mined from PR review comments, and who owns what |
| Test strategy | test kinds, where they live, how they run, coverage expectations |
| CI and gates | the checks a change must pass, and how to run them locally |
| Glossary | the domain words and what they mean in this code |
| How we work | branching, commit messages, PR size, approval rules |

Every claim carries its citations; a claim without one is dropped. Each pack is **versioned** (D1: a new version per
refresh, the previous ones kept), editable by people (an edit is a new version with its author, D4); a refreshed
claim that contradicts a human edit is flagged, not applied. **A new version is a draft until an administrator
approves it**: the pack is mined from text anyone with access can write, so agents read only approved versions, and
they read them as DATA: they inform the work, they never override an agent's own instructions.

Built (`reduce.py`, `store.py`): within a document, notes making the same claim (case, spacing and the final full
stop aside) merge with the union of their citations (eight at most). A refresh starts from the latest approved
version and keeps its people's claims: a refreshed claim saying the same adds its citations to the edit, one on the
same subject saying something else is flagged ("Flagged for review: contradicts an edit, not applied", in the
document and in `pack.json`), and a claim without a subject contradicts nothing. Claims are ordered by subject, then
text, footnotes numbered by first use, and repository text is escaped so it renders no link, image, tag or table
cell: the same notes always give the same bytes. The overview is the root package's pack (`.`: the files no package
holds), whose architecture document starts with the table of packages, their kinds and owners. Every refresh and
every edit is a new version, a draft, with its author (an agent's id or a person's), the reason, the full sha it
was built from and the version it started from; an edit is an administrator's (a person's claim, added or in
place of the claim it names), held to the bar of a mapped claim (one redacted line of 400 characters at most, and
every citation one of the repository's listed paths, commits or review comments, or the edit is refused; a person
may cite nothing), and needs an approval like a refresh. Only an administrator approves, never an agent: one
transaction marks the draft approved with who and when, moves the package's approved version up and writes a
create-only `KPACKLOG#…#approved` row. Approving a version older than the approved one is refused, and so is
approving one built on an older version than the approved one (it would drop what that one added, a person's later
edit above all). The overview's table of packages is kept in its `pack.json`, so an edit of the overview keeps it.
Agents read a pack only through `for_agent`: the latest approved version's documents, each inside a DATA block with
one random fence (the quality gate's `data_block`, redacted), never raw Markdown in a prompt; a package with no
approved version has no pack to read.

### The knowledge docs pull request (7.52.00)

*Built* (`knowledge/render_docs.py`, `knowledge/docs.py`, the broker's `push_approved_docs`, voc-engineering-start's
`publish_docs`, `shared/agents_engineering_knowledge_routes.py`). The approved pack goes to the repository as Markdown
that people and other tools read: `docs/agents/index.md` (every package the overview lists, each with its document
or "not approved yet") and `docs/agents/<package path>.md` per package with an approved version (its seven documents,
its citations as footnotes numbered across the file). The root package is `docs/agents/repository.md`; a package whose
path is `index` or `repository` (in any case) is `index-package.md` or `repository-package.md`; a character outside
`[A-Za-z0-9@._+-]` in a path segment becomes `-`, and two packages that would land on one file (in any case) are
refused, never merged. A claim flagged for review is not rendered. The rendering is deterministic and of the standard
library only, so the Agents API and the broker render the same bytes, and its digest is the sha256 of the canonical
`[(path, sha256)]` list (sorted by path, JSON without spaces).

- **Approve** (`POST /agents/engineering/knowledge/<connection>/<package>/versions/<version>/approve`, `{}`): the store's
  approval, as before, and in the same transaction the connection's docs as they render with this version: every
  package the overview lists at its approved version, this one in its place. The digest is kept on the version
  (`rendering_digest`) and its `KPACKLOG#…#approved` row, and the connection's next rendering is recorded,
  `KDOCS` (its number, digest, each package's version, who and when; held to the number read, so of two approvals
  racing one is refused) and a create-only `KDOCSLOG#<n:06d>` (D1, D4). The answer is `{connection, version,
  rendering_digest, rendering}`. `<package>` is in the workspace layout's encoding (`=2E` for the root,
  `packages=2Fweb`).
- **Read**: `GET /agents/engineering/knowledge/<connection>` (each package's versions, its approved one, the recorded
  rendering) and `…/<package>/versions/<version>` (the version, its seven documents).
- **Preview** (`GET /agents/engineering/docs/<connection>/preview?kind=knowledge|tenets`): the files the approved
  docs render to now (`{path, sha256, bytes, text}`: since 7.52.00's integration each file's text, so the app reads
  each as a document, while the texts fit 2 MB, else `text: null` and `texts_truncated`), their digest and the
  approval's (`matches`), the branch, and a git patch that adds them (cut at 4 MB less the texts' bytes,
  `patch_truncated`): what a Human-driven administrator applies by hand.
- **Publish** (`POST /agents/engineering/docs/<connection>/publish`, `{kind, digest, pr?}`): 202 `{pr: {url, number,
  branch}, kind, version, digest, draft}`. The Agents API reads the requesting administrator's stored way of working
  first (Human-driven, or none stored: 409 `human_driven`, with the preview's address), then invokes
  voc-engineering-start's `publish_docs`, which asks the broker's `push_approved_docs` as its own role. The broker,
  voc-engineering-start's alone (no agent role may ask for it, and the runtime may not either):
  1. holds the connection's credential to the stored connection's repository;
  2. reads the approved version again (`KDOCS` and each package version it names, each still approved, or the
     accepted tenets version) and renders it again from the stored records; the request's digest, the approval's
     and the rendering's must be one (409 `digest_mismatch`; nothing approved: 409 `not_approved`);
  3. allows only `docs/agents/**` for the knowledge and exactly `TENETS.md` for the tenets (`write_policy.docs_paths`:
     never `docs/agentsX`, an absolute path, `..`, a CI file or anything else; 422), 4 MB at most;
  4. reads the requesting administrator's stored way of working again, failing closed (`human_driven` for
     anything but AI-assisted or AI-driven: their request is the person's go an AI-assisted push waits for);
  5. holds the connection's CI attestation and the host's branch rules, as for an agent's push (409);
  6. writes one commit (the bot's identity, a trusted message naming the version and the digest) on its own branch
     `voc-agent/docs/<kind>-v<n>` from the default branch's head, then opens the pull request ready for review, or as
     a draft when the request says `pr: draft` or else the flow's own `pr` setting says so (Understand the
     repository's for the knowledge, Tenets' for the tenets: both `ready`). Its body names the files, the version
     and the digest, and ends with the platform's line that only a person approves and merges it.

  Each write is made once per (connection, kind, version): the push and the pull request are claims of their own
  (`WS#default#DOCS#<connection>`, a run's claims' attributes), so a pull request whose open failed opens on a retry
  from the branch already pushed, and a second publish of a version whose pull request is open answers 409
  `already_published` with it. There is no final go (no code is written: D-6), no merge, approval or ready operation.
  A `TENETS.md` written by hand is replaced in the pull request's diff, which a person reviews.

### The repository's tenets

*Built* (7.52.00: `knowledge/tenets.py`, `templates/orchestration/flows/tenets.yaml`, the harness's `read_tenets` and
`write_tenets`, `runtime/tenets_end.py`). The Tenets flow's understander reads the approved knowledge pack its task
carries, the repository's `TENETS.md` if it has one (a file read through the broker) and the accepted tenets
(`read_tenets`), and writes the repository's tenets once with `write_tenets`: a `voc-tenets/1` record (1 to 30 tenets,
each an id such as `T1` or `D5`, a title, a statement, why, and the paths or commits it rests on) under its own keys,
`…/commits/<sha>/_tenets/attempt-<n>/tenets.json` (`_tenets` is one of the workspace layout's artifact kinds). At the
run's end (`tenets_end`, beside the triage's copy) the record, its text made safe (credentials and personal data
replaced) and checked again, becomes the connection's next version, a draft, once per run.

The versions are in the connection's partition beside its packs (`WS#default#REPO#<connection>`): the counter
`TENETS` (its versions, the accepted version with its `TENETS.md` digest and its ids), each version `TENETS#<v:06d>`
(its record, author, run, status) and a create-only `TENETSLOG#<v:06d>#<event>` per event (drafted, accepted,
rejected: who, when, why), and `TENETSRUN#<run>`, the run that drafted one. The runtime's role writes a draft's
attributes alone (an IAM `dynamodb:Attributes` pin), so it never accepts or rejects one. An administrator reads them
(`GET /agents/engineering/tenets/<connection>[/versions/<v>]`) and accepts (`POST …/versions/<v>/accept
{expected_accepted, reason?}`: never a version older than the accepted one) or rejects (`…/reject {expected_accepted,
reason?}`) a draft; a rejected one stays. `expected_accepted` (7.52.00's integration) is the accepted version the
screen showed (0 for none), the one the draft was read and compared against: another one now is 409 "read it again"
(an acceptance holds it in the counter's own conditional update; a rejection, which moves no accepted version, reads it
just before its write). Once accepted, `TENETS.md` is rendered from it and goes to the repository through the same
publish (`kind: tenets`). The Tenets flow's draft step asserts `tenets.recorded` (a `voc-tenets/1` record held to the
record's own rules), which the board evaluates on the draft its task recorded (it reads `…/_tenets/*` for it).

**Triage cites accepted tenets only** (the hard lock): `write_triage` refuses a tenet id the run's connection's
accepted version does not hold (the broker's `read` of kind `tenets`, the store's: never the repository's file), and so
does the triage run's end (the issue's trusted row is not written, `unaccepted_tenet`). With none accepted the list is
`[]`, and readiness's `tenets` check warns. The review agents and the quality gate are to take the accepted tenets as
their bar; changes to them are proposed by a new Tenets run and need a person.

Storage (built for the pack: `knowledge/store.py`, `workspace/layout.py`'s `knowledge_key`): each version's
`pack.json` and one Markdown file per document in the workspace bucket under
`ws/{ws}/knowledge/{connection_id}/{package}/v{version:06d}/`, each written once (`If-None-Match`) before its row, so
none is ever replaced; the index rows in `voc-engineering` (`WS#{ws}#REPO#{connection_id}` /
`KPACK#{package}#{version:06d}`: the status, author, reason, the sha it was built from, approved by and when), the
package's counter and approved version on `KPACK#{package}`, and the approval's `KPACKLOG#{package}#{version:06d}#approved`,
with `{package}` encoded as the workspace's keys encode it.

## The agent catalog

*Planned* (voc-datalake/lambda/engineering/agents).

Each agent is a pre-made, configurable template: its **skill** (instructions, examples, tool policy, model; versioned,
[below](#getting-better-skills-the-coach-the-learning-loop-memory)), its budget and its caps.

| Agent (role) | Does | Writes |
|---|---|---|
| Mapper | maps a shard of a package for the knowledge pack, and reduces the notes into its documents ([above](#the-knowledge-pack)) | notes, draft pack versions |
| Issue understander | classifies an issue as bug, feature or investigation, finds the code involved, writes the problem statement and acceptance criteria | a comment on the issue |
| Bug hunter | looks for defects from static signals, failing or missing tests, logs, and what this data lake's customer feedback says about the affected feature (feedback ids, counts, categories and the platform's problem labels, which the trusted code that posts the hunt task attaches to it, read within the run owner's category and source access; the hunter holds no user credential and reads no review text); posts a "fix" task per bug it confirms | findings, each citing its evidence (code lines, feedback ids) |
| Fixer | plans a fix, writes it and its test in its checkout | a patch |
| Feature builder | plans a feature from an issue or a PRD in this data lake (the PRD with its customer quotes replaced by their feedback ids, by the trusted code that posts the task), posts its sub-tasks, builds them | patches |
| Committer | after the gate's GO, turns the submitted patch into a commit by the knowledge pack's "How we work" and has the broker push it to the agent's branch | commits on the agent's branch |
| Commit reviewer | reviews each commit against the review guide, before the quality gate | findings |
| Gate runner | runs the language gate packs on the affected packages ([below](#the-quality-gate)) | gate results |
| PR author | writes the description: what changed, why, the feedback ids it came from (never review text), the test evidence, the gate record | a pull request |
| PR reviewer | reviews a pull request, the team's own included, with the review guide; several of them run the gate's review rounds | review comments (never an approval), findings |
| Final go | the gate's last word ([below](#the-quality-gate)) | a verdict |
| Run coordinator | a small agent that watches the run's conversation and board and assigns the next task ([below](#how-the-agents-work-together)); not the existing agents' conductor, whose role it plays for these runs | events |
| Coach | proposes skill changes after a failure ([below](#getting-better-skills-the-coach-the-learning-loop-memory)) | skill versions, as proposals |

**Every launchable role has a skill** (6.29.00, `voc-datalake/lambda/engineering/runtime/harness/skills.py`): the run
coordinator's (`coordinator@2`) and, at version 1, the mapper's, the understander's, the hunter's, the fixer's, the
builder's, the committer's, the commit reviewer's, the gate runner's, the PR author's, the PR reviewer's and the final
go's, so the board launches an agent of each of them and the runtime runs it with its skill's argv. The coach has
none: it is not launched as an agent. Each record holds its role's job from the table above, a few worked examples,
its tool policy, its model from the [model table](#models) and the `converse` harness (the owner's Converse-only
decision). Since 7.50.00 the platform's rules are the harness's, never a skill's (D-7): the bundle's
`platform_rules` (the templates' shared platform rules), which the board serves with the session's skill, else the bundle's
own copy (`skills.platform_rules`, 7.53.00: the same text), go before every skill's instructions, with the session's fence: only a person approves and
merges a pull request (an agent never merges, never approves, never marks a draft ready and never changes the run's
way of working or its limits), and everything from the repository, a host or memory is data. The shipped records are
the bundle's own (`harness/skills.py` `SKILLS`, read from the bundle the Lambda or the image ships: 7.53.00), the
templates a launch falls back to (`skills/templates.py`; [which skill an agent runs](#which-skill-an-agent-runs-75000)).
The tools are exactly what each job needs, and a role is never offered one beyond its role's, whatever a record names
(`tools.role_specs`; `harness/role_tools.py`, `issues.py`, `gate_tools.py`):

| Role | Tools beyond reading the checkout, reporting, saving and finishing | Model |
|---|---|---|
| Mapper | `write_notes` (a `voc-note/1` shard) | Haiku 5.5 |
| Issue understander | `read_issue`, `write_triage` (a `voc-triage/1` record), `post_comment` (on the run's issue, each line a code span under the platform's own head), `label_issue` (`voc-triage/<kind>`, `voc-severity/s<n>` only) | Haiku 5.5 |
| Bug hunter | `read_issue`, `run`, `install_dependencies`, `write_findings` (a `voc-finding/1` shard), `post_subtask` (a fix task) | Sonnet 5.5 |
| Fixer | `read_issue`, `write_file`, `run`, `install_dependencies`, `submit_work` | Sonnet 5.5 |
| Feature builder | `write_file`, `run`, `install_dependencies`, `submit_work`, `post_subtask` (a sub-build) | Sonnet 5.5 |
| Committer | `read_issue`, `push_commit` (the broker's push of the patch a fixer or builder submitted, after the gate's GO) | Sonnet 5.5 |
| Commit reviewer | `read_patch` (7.54.00: the submitted patch its task names, as data, in pages; the harness applied it to its checkout, so `read_file` shows the changed files), `write_findings`, `write_review` (a `voc-review/1` verdict: `approve`, `request_changes` or `could_not_review`) | Sonnet 5.5 |
| Gate runner | `run_gate` (7.50.00: the packs detect the checkout's languages, plan their checks and run each one in the sandbox), `write_gate_record` (on the submitted patch the harness applied: the tree it hashed, the checks `run_gate` saw end, its plan's packs and, since 7.52.00, the versions `run_gate` found of their tools, `tool_versions`; a GO only after `run_gate`, never a final go) | Haiku 5.5 |
| PR author | `read_issue`, `open_draft_pr` (the broker's pull request: ready for review, or a draft when the run's flow says `pr: draft`) | Sonnet 5.5 |
| PR reviewer | `read_patch` (when its task names a submitted patch), `write_findings`, `post_comment` (on the run's pull request), `write_review` (the run's record of its verdict, never the host's) | Sonnet 5.5 |
| Final go | `read_patch` (the submitted patch it judges, 7.54.00), `read_gate_record` (the gate runners' records of the tree it judges), `read_findings` (the run's findings at its commit), `write_gate_record` (its verdict; the harness writes the tree it hashed from the same patch and its final go section, the record the GO ledger reads) | Opus 5.5 |

The writers (committer, PR author, PR reviewer, and the understander on its issue) run no repository code: each gets
its broker writes and no code tool. The coordinator reads the run's issue too (`read_issue`). An output is written once under the agent's own keys, in the workspace's layout (its shapes, from the schema
names to the package encoding of a key, in `runtime/outputs.py`, which the images ship beside the harness and the
readers import), and its key is recorded on the task when the agent finishes (a continuation keeps it, and an
output its crashed session wrote is kept and recorded, S3's create-only refusal read as "written already"), so the
steps after it read what the board recorded; `submit_work`'s patch is recorded on the fixer's or builder's task so.
A GO never rests on what a model types: the harness builds a gate record field by field, the gate runner's checks are
the commands it saw it run and how they exited (a GO only when there is one and all passed; a gate runner's record
has no final go), the final go's section names its own session's agent and model, and the record's tree is the one
the harness hashed; every record it builds reads back through the readers' strict `GateRecord.from_dict` (a test
holds them together, as the module does not ship in the images).

**A review reads the patch it reviews, and a review that could not review is no pass** (7.54.00). The first live
run's commit reviewer was handed the fixer's patch key in its task's text only; `read_file` reads the checkout, so it
was refused, the reviewer read the unchanged files and wrote nothing, and the board step passed `review.no_blocking`
on zero findings (01M7QXJN02WSFMG92VWWZ00NKB). Now:

- A commit reviewer's task names the submitted patch (`post_task`'s `patch`, required for that role and taken for a
  PR reviewer too). The harness applies it to the reviewer's checkout before its first turn (`review_tools.
  show_submitted_patch`, the harness's own git; one that does not apply is told to the model, never a crash) and
  answers it with `read_patch`: the diff as data, in pages of at most 40 000 characters cut at line ends, the first
  listing the changed files. A task that names none, a key that is no submitted patch of the run, or an object that
  cannot be read is a refusal that says so. A CLI's or Kiro's tool server is handed the key (`VOC_PATCH_KEY`).
- The reviewer records its verdict with `write_review` (`voc-review/1`, `…/_review/attempt-<n>/review.json`): an
  `approve` or `request_changes` only once that session read every page of the patch, a request for changes only with
  a blocking finding written and an approval with none; `could_not_review` always. Its `finish` waits for a verdict,
  and a `could_not_review` ends its task needing a person (the board step blocks, so the coordinator cannot close it
  and go on to the gate), its reason on the task's progress.
- `review.no_blocking` with a reviewer as `by` fails when that reviewer recorded no review, when one says
  `could_not_review` (or is unreadable), or when one requests changes, besides any blocking finding; the board reads
  the verdicts beside the findings (its `ReadRecordedOutputs` grant on `_review/*`).

The gate judges the patch the committer pushes, end to end:

1. The coordinator names the fixer's or builder's submitted patch on the gate's tasks and the committer's
   (`post_task`'s `patch`, the task spec's; `read_board` lists each finished task's recorded outputs, the submitted
   patch among them). It takes only the key of a patch a fixer or builder of the run submitted at its commit, never a
   checkpoint's snapshot.
2. Before a gate runner's or final go's session runs anything, the harness reads that patch from the run's workspace
   and applies it to the session's fresh checkout of the run's commit, working tree and index
   (`role_tools.judge_submitted_patch`). It takes it by the broker's rules: the same keys and size, no copy and no
   binary file without its content (the lines the broker's reader refuses where git would apply them), and it must
   apply exactly. Anything else stops the session before any check runs (a crash, which the supervisor continues and
   then sends to a person). Its own git then hashes that tree (`git add --all`, `git write-tree`): the checks run on
   the change, and the tree is the record's. The model never types it, and a task that names no patch cannot write a
   GO. When the record is written the harness hashes the checkout again the same way, and refuses a GO when the
   tree differs from the judged one (the record can then only be a NO-GO or STOPPED). That compares the tree at the
   record's write only: no check is tied to the tree it ran on, so a command that changes the tree and another that
   changes it back leave the judged tree, and the checks between them ran on another one.
3. The tree is a function of the run's commit and the patch, so the gate runner and the final go, each hashing its
   own checkout, write the same tree. One GO ledger rule holds for the board, the flow and the broker
   (`flow/ledger.py` `go_tree`): the final go's GO counts only when the gate runner task that ended last ended done
   with a GO record (checks run and passed, no stop) on the same tree; after a gate runner's NO-GO, STOPPED or
   failure the gate takes its `fail` arrow and the broker pushes nothing. In a run that follows a flow, the board
   takes a final go's task that names a patch only after such a gate runner GO, for that task's patch
   (`board/flow_guard.py`); one naming none can still be posted, so the `fail` arrow stays reachable, but can only
   write a NO-GO. A gate
   session's checkpoints save its working tree as a patch on that tree, and its continuation applies the submitted
   patch again (hashed again) before it puts them back.
3a. A gate runner whose gate STOPPED (7.54.00: `run_gate` says when no check judged the code: `setup_failed`, a
   setup step failed; `nothing_checked`, the packs planned nothing; `tool_missing`, only tools were missing; the
   bundle's `gates.stops`) writes a STOPPED record with that reason (the harness's, never the model's; a NO-GO is
   refused then), and its `finish` sends the task to a person: a stopped gate says nothing about the code, so it is
   never a reason to revise the fix. Only a NO-GO, a check that failed on the code, starts a revision round. The
   python pack installs into a virtual environment of the gate's own (`py.venv`, under `/home/code/.voc-gate/venvs`
   in the images), never into the image's site-packages, which repository code cannot write (the first live run's
   gate stopped on `Errno 13` there).
4. The committer pushes that submitted patch with the tree. The broker refuses unless the GO ledger's rule gives a GO
   for exactly that tree (`has_go`: it reads the final go's and the gate runner's gate records), rebuilds the patch's commit on the host's copy of the run's commit, and moves the
   branch only when the rebuilt tree is that tree (the host's client checks it). So a push lands only the patch the
   gate judged; the broker takes a fixer's or builder's patch of the run only from a committer.

Three limits hold today. The gate runner's checks are whichever commands its model ran (the harness records each one
and how it exited, but nothing yet matches them to the packs' commands), so whether they were the packs' is the final
go's to judge. No check is tied to the tree it ran on (above): the tree is compared when the record is written, not
before and after each command. And a gate judges one submitted patch, so a run pushes one: when a hunter posts
several fixes, the coordinator names one, and the others are not pushed. Matching the checks to the packs, hashing
the tree around each check, and combining several fixes are follow-ups.

**The harness's broker client (7.02.00).** The harness reaches the broker the way it reaches the board
(`runtime/harness/broker_client.py`, beside `board_client.py`): every call is a POST of `{"operation", "args"}` to the
broker's function URL, signed SigV4 (service `lambda`) with the agent's own role session, so the broker takes the
caller's role, run and agent from the session as it always has, and alone decides what each role may do. The runtime
hands every agent the URL (`VOC_BROKER_URL`, from the supervisor's `ENGINEERING_BROKER_URL`; a continuation and the
CLI's tool server get it too) and puts its host, by name, on the agent's own egress proxy only (`egress.split`: the
dependency step's proxy, which repository code uses, never gets a function URL). Each agent role may call the
broker's function URL and no other but the board's (`lambda:InvokeFunctionUrl` on the broker's function alone, with
`lambda:FunctionUrlAuthType` `AWS_IAM`, its own statement, pinned by `lib/stacks/engineering-runtime.test.ts`). What
it covers:

- **Reads** (every role): a page of a file, a history, an issue or a pull request; retried on a 503 or a lost
  connection, twice, backing off.
- **Writes**: the committer's `push_commit` (`push_bundle`), the PR author's `open_draft_pr`
  (`open_or_update_draft_pr`), the PR reviewer's `post_comment` (`post_comment` on the run's pull request). Each is
  sent once, never retried, with the agent's attempt (`VOC_ATTEMPT`), and the broker makes it at most once per key:
  the caller's run, agent and attempt, the operation and a digest of what it writes (`broker.py` `write_key`,
  `_once`), so the same write asked again is one write and a different one (a second comment, a pull request's new
  text) is its own. Just before the host call it writes a create-only claim row in a partition of the run's writes
  alone (`WS#<ws>#WRITES#<run>` / `WRITE#<agent>#<attempt>#<operation>#<digest>`, `records.py` `WriteClaims`; never
  in the run's own partition, which its grant cannot reach) and closes it with the outcome: `done` with the answer (a
  number, a URL, a branch and tree, never a body), `refused` when nothing was written (a write rule, the host's lease,
  a target not found, a rate limit, answered 503 with its `Retry-After`: the key may be claimed again), or `unknown`
  (any other host error). A failure after the host may have written is `unknown`, never `refused`: a pull
  request opened or updated whose check after the write fails (the branch moved, a rate limit, a host error; a pull
  request the call opened is closed first, and a failed close changes nothing) is unknown, and so is a push whose
  trees or commits were made before a failure other than the branch's own refusal. A branch move the host refuses (a
  422, or a Conflict on the lease) is `refused`: its trees and commits stay unreferenced and the branch did not move. So is a failure to mint the host token (an answer other than a token,
  before the write): it errs on the safe side, and blocks that write for the attempt. A credential the broker cannot
  read is "no connection" (503, nothing written). A repeat is answered from its first outcome before the run's, the
  dial's and the board's checks (as the runtime answers a repeated launch), so a write made answers its answer even
  after the run moved on; a repeat of one whose outcome is unknown, or whose claim a crash left open, is not made
  again and answers 502. So a continuation that asks again, within the same task attempt, never posts a comment
  twice, pushes twice or opens a second pull request; a new attempt of the task is a new key, and after an unknown
  outcome it may post again (a person checks the host first).
- **Outcome unknown** (writes only): an answer that never came whole (a timeout, a lost connection, a cut body), a
  5xx other than the broker's own 503 (which says nothing was written: no connection, its records unreadable), so
  the broker's own 502 and the function URL's 502 or 504, and a 200 the client cannot read or that is off its shape.
  The model is told "outcome unknown: do not repeat it; it stays unknown until a person checks the host", and the
  task's progress says so; it is never told the write was refused, and the session never crashes for it. Nothing
  reads the host back yet: the claim row keeps the outcome (`unknown`) in the run's writes' partition, any repeat is
  answered from it and never made twice, and the PR author's draft still needs the pushed branch's tree on the host
  (a push that never landed is refused there: "push it first"). A person checks the host; reading the host back at a
  repeat (the branch's tree, the pull request by its head, the comment) and showing the unknown claims on the run
  monitor are planned.
- **Submit**: the broker defines no call for it. The fixer's or builder's `submit_work` writes the patch under its own
  keys, and the client checks that the key is one the broker pushes (a fixer's or builder's submitted patch of the
  run at its commit, the agent's own) and answers that the committer pushes it after the gate's GO; the broker reads it
  at that push (`patches.py`).

Every wait is bounded at 125 s, past the broker function's own 120 s, and a redirect is never followed. Any other
answer but a 200 (a read's every non-200, a write's 4xx and the broker's own 503) is a plain refusal with the
status and reason (at most 500 characters), which the tools hand the model as a result it reads (the writers'
skills: a refusal is the answer, never something to work around), never a crash.
The client logs no body, answer or credential.

**How far a run gets today.** On the local fake runtime with scripted models, the Bug hunt and fix template runs
from the hunt to the draft pull request (a test), and since 7.02.00 its writers go through the harness's own broker
client, each signed as its own session, to the broker's own handler behind a stand-in for the function URL's IAM
check that verifies each SigV4 signature: the broker's readers of the run's record, the GO ledger, the submitted
patch and the dial (the starter's way of working AI-driven) read the run's real rows and objects, and a host on the
fixture repository rebuilds the push with git and moves the branch only when its tree is the one the gate judged.
Against AWS nothing has run yet; once the owner starts one, a run gets as far as this: the board, the inbox and the
flow work through the board's API; every agent is launched with its skill; the agents read the checkout, run its
commands, write their outputs and post their tasks; the fixer's or builder's `submit_work` is recorded on its task,
so the gate judges it; and the committer's push reaches the broker, which, on a stored connection (7.03.00), refuses
it until an administrator attests the repository's CI (7.04.00) and the host's branch rules pass its check, and the
committer reads a refusal as its answer. The final go's model
judges from its brief (it has no tool to read the gate runner's record or the findings yet); its GO counts only by
the GO ledger's rule above, which needs the gate runner's own GO on the same tree. Not done yet: the final go's read
of the gate runner's record and the findings, and the first run, which waits for the owner.

## How the agents work together

*Partly built*: the bus, the inbox router, the conversation and the board (`voc-datalake/lambda/engineering/bus/`,
`conversation/`, `board/`), deployed only with `-c engineeringAgents=true` (`voc-datalake/lib/stacks/engineering-bus.ts`).
What exists:

- **The bus**: the `voc-engineering` EventBridge custom bus (no archive; its policy denies `events:PutEvents` to every
  principal but the board API's role, the runtime's two and the agent roles, each pinned to its own source: "The
  agents' access", below), and its schema, voc-msg/1, checked in code
  (`bus/schema.py`: the envelope, the type list, the claim-check rules on `refs`, no credential-shaped summary, 16 KB
  at most). `bus/publish.py` is the one publish helper: it checks a message against the schema before `PutEvents`,
  and a message about a recorded change takes its event id from the change, so a retry is a redelivery.
- **The inbox router** (`bus/router.py`, the `voc-engineering-router` Lambda): one fixed rule sends every event of
  the account on the bus to it. It checks the schema and the sender (`bus/senders.py`: the event's `source` names the
  sender, and only the allowed sources may send each type, for their own run only), writes the message to the run's
  conversation, then pushes it (`bus/routing.py`): a posted task, and a message for an agent or the conductor, to
  the delivery function with its conversation seq. It drops, and journals with the reason and never the content, a malformed
  message, a sender that may not send it, a run that does not exist and an event id reused for other content.
- **The conversation** (`conversation/store.py`): one row per message in the `voc-engineering` DynamoDB table
  (on demand, encrypted with the stack's key, point-in-time recovery, kept like `voc-agents`), never changed, the
  whole message kept (its sender the actor, its `at` the time). The sequence comes from a counter on the run's `META`
  row, and an event's marker is written with its row in one transaction, so a redelivered event changes nothing.
- **The board** (`board/store.py`, `board/api.py`, the `voc-engineering-board` Lambda behind a function URL with IAM
  authentication and no resource-based policy): `post`, `claim`, `renew` (the heartbeat), `progress` (when, a
  short step, whether it waits on a question, review or decision: the supervisor judges "no progress" from it and
  leaves a waiting task alone; published as `task.progress`) and `move`, each a conditional write on the same table. The caller's role, run and agent come from its assumed-role identity, as for
  the broker. A post counts the task against the run's cap, dedupes an equal task, and nests at most 3 deep. Who may
  post for whom: the coordinator for every role, the hunter for fixers, the builder for builders. An equal task is
  answered while it is under way; once it has ended (done, failed, needs a human), the same work can be posted
  again, and the dedupe marker moves to the new task. A claim leases an open task of the caller's role for 5
  minutes; the holder claiming again, on a task that has not ended, reads it as it is (a continuation reads its
  brief so, with its lease's epoch, which is always the task's attempt). A task with a launch recorded at its attempt
  is claimed only by that launch's agent, and an agent launched for an older attempt (the task re-posted or given
  back since) never claims it again, in the write's own condition too (409); a task with no launch at its attempt is
  any agent's of its role. Renew, progress and move need the lease and
  its epoch, on a task that has not ended. Before it continues an agent (a pause resumed, a slow boot), the supervisor
  refreshes its lease (`BoardStore.refresh`), even one that ran out, for that agent at that epoch. The supervisor
  re-posts a task at the attempt it judged (`repost_task`): open again at the next attempt,
  its lease cleared, published again as `task.posted` to its role, its reason in the history row. A re-post
  stamps `updated_op` `repost`; a retry that finds it landed publishes the same event again only while the task's
  last change is still the supervisor's own re-post at that attempt, and a task open at the next attempt by a
  person's release (which the API published as that person) publishes nothing, so the supervisor never sends
  another sender's change as its own. The run's
  `coordinate` task (role `coordinator`) is written only by the run's start (`coordinate_items`, in the start's
  transaction with META, which records the run's `commit` and `connection` that `launch` and `knowledge` read; a run
  started without its commit or connection answers 409 to `launch` and `knowledge`, with that reason: only a new
  run's start records them, so no retry can succeed),
  never posted, and claimed only by the run's coordinator, which renews and reports progress on it like
  any agent. It records the coordinator the start launches on it (`coordinator-1`, with META's `agent_count` 1
  written in the same transaction, so the board's launches number from 2). A new coordinator for it is recorded only
  by the run's trusted code (`BoardStore.launch_coordinator`: the task open at the attempt given, the next
  `coordinator-<n>`, a retry reusing it), never by a board op: a person's Resume of a run whose coordinator is gone
  re-posts the task at the attempt it was at and then calls it ([Runtime](#runtime-one-agentcore-session-per-agent)). A
  coordinator acts only while it is the run's: every board op of the coordinator role checks the caller is the
  coordinate task's recorded coordinator at the task's attempt, so a replaced coordinator's session is refused (403)
  by the board from the re-post on, its claim included; a run whose start wrote no coordinate task has only its
  start's coordinator, so there the role is the check. The board alone checks it: the connectors broker and the
  bus source (`voc.engineering/conductor/<ws>/<run>`) still take the role. The runtime replaces only a coordinator
  whose session failed, whose session the supervisor ended with it; if that end failed (it is logged), the old
  session can still reach the broker and speak from its bus source until its idle timeout ends it, and only the
  board refuses it. The coordinate task's re-post
  publishes no `task.posted` (no role reads one for it). A task whose launched agent never claimed it (it died or stalled first) is re-posted too. The
  coordinator also lists its run's tasks (`tasks`) and launches an agent for an open task (`launch`:
  its role, language and paths, the role one with a skill, the language one this deployment has an agent runtime
  for (`-c engineeringImages`, with `-c engineeringAgentNetwork`) and the paths by the checkout's own rule, all checked before an agent is
  numbered; the board invokes the runtime's `launch` action only (its code holds it to
  that: its role's grant is the whole function's), with the run's commit and
  connection from its META, numbers the agent `<role>-<n>` from the run's counter, at most 999, and records it on the
  task with the attempt and paths it was launched at and a history row, so a retried launch at that attempt launches
  the same agent, and a re-posted task, at its new attempt, a new one; a task no longer open is refused before the
  runtime is asked). The runtime's refusals (a bad request, a run not active or stopped, a session busy, the agent's
  session there for another task or attempt) answer 409 with their message; a bad request or another task's session clears the
  task's recorded launch with a `launch_refused` history row, so the next launch numbers a new agent with the
  settings it gives then (a busy session, or a run not active, keeps it). The runtime answers a repeat with its
  session, and one while the first still starts as busy, before any other check: such a refusal so means no session
  and no launch of the agent exist, and a repeat of a launch whose session got through gets that session (200);
  anything else 503. A launch is started once: the board waits for the runtime's answer up to 100 s, within its own 120 s limit,
  and its client never retries the call itself; the runtime holds the agent's row (`launching_until`, one
  conditional write) before it starts the session, so a repeat for the same task and attempt answers the session the
  first one wrote, and one while the first still starts its session is refused as busy (409), never a second session.
  The board never chooses the agent's argv: the runtime derives it from the role's skill, so a launch of a role
  with no skill yet is refused (409). An agent reads
  the approved knowledge pack (`knowledge` `{task_id, package}`, as data) of one of its task's paths (the spec's
  `paths` and the ones its agent was launched on) or of the root (`''`, the knowledge store's `.`), never another's:
  the board reads that one task's row and checks the caller holds its live lease; a package the store
  cannot key is a 400, and an approved version whose object is missing or unreadable, or whose row changed, a 503. Each change is published
  on the bus as the board's `task.*` event after the row is written. A failed publish answers 503, and the retry
  publishes the same event again. Each post, claim and move also writes a `TASKLOG#<task>#<at>#<state>` row in the
  same transaction (the actor and the operation; no past state is overwritten; a renewal or a progress report is
  not a move), and so does a re-post, which is the
  task's history; a result key a move records must be one of the caller's own workspace objects of the lease's attempt.
  In a run that follows its flow (6.28.00), every post names the step it is for (`flow_step`, and a map's `shard`),
  a post and a launch are taken only for a live step, and the coordinator also reads the conductor's plan (`flow`)
  and records the steps it does itself (`step`): [The flow a run follows](#the-flow-a-run-follows).
- **The workspace** (`workspace/`): the key layout below, voc-finding/1 shard lines (`workspace/findings.py`: a line
  off the schema is skipped and counted; credential-shaped strings and personal data are redacted) and the store
  (bounded reads, a cut read logged; create-only writes; its readers without ListBucket, the report builder, the
  Agents API and the board's `knowledge`, take a denied read as missing, and each such read is logged and counted
  as the `EngineeringWorkspaceDeniedReads` metric; a plain missing object counts too, as it is denied as well (a
  failed attempt's result, or a report version that was counted and never written when someone opens it), so a
  broken policy shows as the count rising well above its usual level; alerting's `engineering-denied-reads` alarm
  watches it, [docs/deployment.md](deployment.md)). It lives in its own bucket, `voc-eng-workspace` (VocCoreStack, private,
  encrypted with the stack's key, versioned, access-logged, kept under `-c protectData`), where nothing expires
  until a retention that writes its `AUDIT#delete` row exists (*planned*; "The workspace" further down this
  section). The runtime's agents write their checkpoints and patches there, each under its own keys
  ([Runtime](#runtime-one-agentcore-session-per-agent)); their findings are to follow.
- **The reads** (`views.py`, `rows.py`): the Agents API's `GET /agents/engineering/<run_id>/board`, `…/conversation`,
  `…/reports` and `…/reports/<level>/<subject>`, on only with `-c engineeringAgents=true` (anywhere else they answer
  404), and read by administrators only, acting for themselves, until a connection can be shared ([Repository connectors](#repository-connectors), "Who can read
  and use"; anyone else gets 403). An MCP token never acts as an administrator, so the global MCP server has no tool for them
  yet ([docs/mcp.md](mcp.md)).
- **No task queues**: every message is pushed per run by the delivery function ([below](#how-the-agents-work-together),
  "Inboxes and roles"). The one queue is `voc-engineering-dlq`, encrypted with the stack's key: the events the rule
  could not hand the router, the router's and the delivery function's invocations that failed every retry, the report
  builder's failed builds and
  the runtime's undelivered supervisor ticks; alerting watches it like the platform's other failure queues.
- **The agents' access**: the [runtime](#runtime-one-agentcore-session-per-agent)'s agent roles call the board's and the
  broker's function URLs, and put events on the bus only with their own source; the bus's policy admits the board's
  role, the runtime's two (the supervisor's and the delivery function's) and every agent role, and nothing else, and
  denies each of them every source but its own (the board `voc.engineering/board`, the runtime's two
  `voc.engineering/supervisor`, an agent its own, a run's coach `voc.engineering/coach/<ws>/<run>`).

Since 7.02.00 the harness's broker interface reaches the broker's function URL as the agent's own session ([the agent
catalog](#the-agent-catalog), "The harness's broker client"); since 7.03.00 a connection's credential is stored
(Agents → Connections), and the broker answers 503 only for a run whose connection has none. Since 6.29.00 every launchable role has a
skill ([the agent catalog](#the-agent-catalog)), so the board launches any of them (the coach is the one role with
none, and a launch of a role with no skill is still refused, 409), and the agents write their findings, notes and gate
records in the workspace beside their checkpoints and patches, each recorded on its task. The rest of this section is the
design; where the built message types and queues differ from it, the code (`bus/schema.py`, `bus/routing.py`) is what
holds, and the design's type table is what the next slices bring the code to or the table to.

**The bus.** One EventBridge custom bus carries every message between agents, as events of one schema. The schema
lives in this repository; the one publish helper and the inbox router check every event against it (EventBridge
itself does not validate events).

| Field | What |
|---|---|
| `run_id`, `thread_id` | the run, and the thread inside it |
| `from_agent`, `to` | the sender; an agent or a role |
| `type` | the board: `task.posted`, `task.assigned`, `task.claimed`, `task.progress`, `task.review`, `task.done`, `task.failed`, `task.needs_human`; the talk: `finding`, `question`, `answer`, `review.requested`, `review.result`, `handoff`; the gate: `gate.go`, `gate.no_go`; people: `decision`, `stop`, `message`, `signal` (save, pause, resume, shut down, stop now); the runtime: `pause`, `pause.ack`, `continued`, `timed_out`, `run.health`; skills: `skill.proposed`, `skill.accepted`, `skill.rolled_back`; the run: `methodology` (a skipped methodology step, tenet 2), `run.done`, `run.failed` |
| `body` | a short summary |
| `refs` | S3 keys, commits, files, knowledge-pack versions |

Events stay small (EventBridge's limit is 256 KB, and it bills per 64 KB): an event carries ids, a short summary and
the S3 keys of its payload (the claim-check pattern), never findings, diffs or logs, never a token, and never
customer text (feedback ids only).

**Nobody can speak for someone else.** There is one fixed execution role per agent role (never a role per run). The
runtime's launcher, trusted code outside any session, assumes that role for each agent with its connection, run and
agent ids both as session tags (for the IAM conditions below) and in the session name (for the broker and the board's
API, which see the caller's identity but not its tags; the name holds a 26-character run id and a short agent index,
inside the 64 characters a session name allows, pinned by a test) (the roles' trust policy allows tagging only to the launcher, and no agent role may assume
a role), and hands the session that session. Sessions are short (15 minutes) and renewed only by the launcher, which
refuses a stopped run's agents, so stopping one run cuts its sessions without touching another run's. How a session
receives a session is among the facts verified before the
runtime is turned on. The conditions use the tags: an explicit deny on the bus refuses an event whose source is not the
session's own, and S3 accepts its reads only under its connection's cache and its run's workspace and its writes
only under its own keys. Agents never write the conversation (the inbox router writes every event there, each as a
new row that may not exist yet) and never write the board themselves: the board's API (a Lambda function URL with IAM authentication) makes every board change,
checking the caller's assumed-role identity like the broker does (a lease only for the caller's own task, a verdict only from the run's final-go agent, an assignment
only from the run coordinator and only to an agent of the task's role in the same run). The sender is
the event's `source`, which the bus's policy pins to the session's own agent tag, and the inbox router drops an event whose `run_id` is not its sender's
run, so no agent can forge another's message or write into another run. The router also holds which sender may send
which type, and drops (and journals) anything else: `decision` and `stop` only from the API's own source, `gate.go`
and `gate.no_go` only from the run's final-go agent, the `task.*` events only from the board's API (agents report
progress and moves through it) and from the API's own source as the signed-in person (a person's board actions,
`from.kind` human only; the supervisor's re-post as itself), the `skill.*` announcements only from the API (all three: an administrator's proposal, acceptance, promotion or
rollback, as the signed-in person) and the run's coach (`skill.proposed`, from its run-scoped source), and the talk (`finding`, `question`, `answer`,
`review.*`, `handoff`) from the run's own agents, with a person's `answer` from the API; the runtime's `pause`,
`continued`, `timed_out` and `run.health` only from the supervisor (on the bus: `signal.check_in` to an agent,
`run.agent_continued`, `run.agent_timed_out`, `run.agent_failed`, `run.health` and `run.budget_alert` to the run, and
the `task.posted`
of a task it re-posts), `pause.ack` only from the paused agent, and
`methodology`, `run.done` and `run.failed` only from the board's API and the supervisor (trusted code, on the run
coordinator's or the flow's word). And the broker opens
a pull request only when the board holds a GO for that exact tree's hash. A person's `decision` and `stop` are thus
published only by the API, which writes the signed-in user; a decision needs an administrator, or a person the
connection is shared with to manage, not only to view.

**Inboxes and roles.** One fixed rule sends every event to the inbox router (a Lambda, `bus/router.py`), which
writes it to the run's conversation and then routes it (`bus/routing.py`). There is no SQS queue per role or per
agent: a suspended session runs no code and cannot poll, so every message is pushed, per run. A posted task, and a
message addressed to an agent or to the run's conductor, go to the delivery function (`voc-engineering-delivery`, the
runtime's), invoked asynchronously with the message and its conversation seq (`{message, seq}`; a redelivery carries
the seq the message was first written under). It records each notice once in the run's own partition, as an
`INBOX#<addressee>#<inbox_seq>#<event_id>` row (the addressee `agent:<agent>`, `role:<role>` for a posted task, or
`conductor`; `inbox_seq` the run's write-order counter, so a notice delivered late still numbers above everything
already read; the row keeps the conversation seq too), and wakes the addressee: the agent, or the run's
coordinator for the conductor. A posted task wakes nobody: an agent is launched for its task, so none of its role is
idle, and one held on a wait keeps its one continuation for what it waits for; its role's agents read the row on their next
inbox read. An agent reads its
notices with the board API's `inbox` op (`board/inbox.py`): its own, its role's and, for the coordinator, the
conductor's, after an `inbox_seq`, merged in write order (each with its `conversation_seq`); its session gives
its run, so it never reads another run's. Every read starts 20 below its cursor, a full page's as much as the
tail's (two deliveries may commit their numbers out of order), and moves the cursor to the last number read; the
reader keeps each notice once by its event id. A message to the run (a signal's record, run health, an outcome) stays in the
conversation, where the supervisor, the coordinator and the run view read it, but for the notices the conductor acts
on (7.54.00, `routing.CONDUCTOR_NOTICES`): one of the run's tasks done, failed or needing a person (the board's
`task.done`, `task.failed`, `task.needs_human`) and an agent that stopped answering or failed (the supervisor's
`run.agent_timed_out`, `run.agent_failed`), about any task but the coordinator's own. Those also go to the conductor's
inbox and wake the coordinator, which waits for its agents on them ([The coordinator waits for its
agents](#the-coordinator-waits-for-its-agents-75400)). The rule is fixed, never made per run, so the bus's rule quota
does not limit how many runs work at once. EventBridge is the bus; a push the router could
not make ends in `voc-engineering-dlq` after its retries.

**The board.** A run's work is a board of tasks: open → claimed → in progress → in review → done, failed or needs a
human. An agent takes a task through the board's API, which claims it with a conditional write on its row (DynamoDB,
one owner per task); the agent holds it by a lease that its heartbeat renews (a call once a minute, not an event); a lost lease frees the task for
another agent, which resumes it from its checkpoint. An agent suspended on an open wait (its `question`, a
`review.requested`, a human decision point) keeps its lease while the wait is open. Tasks are claimed: an agent of
the right role, told of a posted task in its inbox, claims it on the board; the run coordinator posts and orders tasks and may hand one
to a named agent (`task.assigned`). Agents post tasks within the run's budget and the flow's rules.
A person can post, re-prioritise, block or take a task, from the run monitor's Board tab or through the API (an
administrator acting for themselves: `/agents/engineering/<run_id>/board/tasks…`,
[docs/autonomous-agents.md](autonomous-agents.md)). Each is the board
store's own conditional write, with a history row naming `human:<subject>`, published as the board's `task.*` event
from the API's own source with `from.kind` human (the only `task.*` the bus takes from the API). Taking a task makes
the person its holder with no expiry (`lease_agent` `human:<subject>`, the lease's epoch its attempt): its agent can
move it no more, and the supervisor, which judges agents' sessions, leaves it alone; the person moves it on like any
holder, or releases it: open again at its next attempt, as a re-post, until the run coordinator launches an agent of its role
for it (from the task's spec: a new attempt starts with no checkpoint). A task another person holds is taken or blocked from them only when asked (`over`: the monitor asks first;
the write holds the holder it read), and an
agent's signal to a task a person holds is refused (no agent works on it). Blocking it ends it as needing a person,
with their reason (the only way a person sends a task there: a move to it is refused, so the why is always kept).
A person re-prioritises a task another person holds without `over`: a priority ends no hold, so nothing is taken
from them. Never the coordinate task. The Agents API makes none of these writes itself: after its own checks (an
administrator acting for themselves, an open run, the bus named) it invokes the board's function directly
(`voc-datalake/lambda/engineering/board/api.py` `person_request`, `{person: {op, run_id, subject, body, task_id?,
action?}}`), whose role already writes the board's rows; the board writes the change and hands back the events it
made, which the API publishes from its own source as the person (the bus takes a person's `task.*` only from there).
The API's role reads the table (GetItem, Query) and writes none of it, closing the gap where IAM, bounded only by the
run's partition, let it write any item of a run. The agent roles may invoke the board only through its function URL
(`lambda:InvokedViaFunctionUrl`), so a direct invoke, the only way into the person path, is the API's; a function
URL's event is always an agent's, whatever its body says.

**The conversation.** Every event is also written to the run's conversation (DynamoDB, append-only, D1), which the run
view shows live as a chat between the agents beside the board. The person is a participant: their decisions, answers
and "stop" are events too.

**The run coordinator** (a small, cheap model) reads the conversation and the board and posts and orders the next
tasks (in a run that follows a flow, only those of the steps the conductor says are ready:
[The flow a run follows](#the-flow-a-run-follows)); it decides when an agent's work is done and when the run has reached what it is allowed. When it sees an agent
going in circles (the same step repeated), it tells the supervisor, which alone stops an agent and re-posts its task. The flow's definition, in the workflow editor, says who may talk to whom and what ends the run (the pull
request opened, or a human decision point).

**The workspace.** Findings and outputs live in S3, by agent and commit:
`runs/{run}/{agent}/commits/{sha}/{package}/{shard}.jsonl` (each finding with `file:line`, its evidence, a severity
and the rule or reviewer it came from), with logs, the gate packs' outputs and patches under the same commit (built,
`workspace/layout.py`: `ws/<ws>/runs/<run>/<agent>/commits/<full sha>/<package | _kind>/attempt-<n>/<name>`, the
reports under `ws/<ws>/reports/<run>/<level>/<subject>/v<nnnn>.json` and `.md`). The
agent comes right after the run, so a write rule on the agent's own prefix cannot be matched by a key that only
mentions it later, and `{package}` is encoded (a package path has slashes). A reduce reads only the keys the board's
API recorded for each agent. Objects are immutable (one per shard and agent; a new attempt is a new object), so map
steps never collide. A run reuses only its own objects; what later runs share is the cache. Encrypted, private,
readable as the connection is. Today a run's objects are kept: nothing expires them, neither the agents' keys in
the workspace bucket (`ws/<ws>/runs/`) nor the reports; only the repository caches expire. A workspace retention (each object removed some days after it was written, set per
deployment, never under 75 days) is *planned*, and comes only with what D5 asks of every workspace delete: when a
run's objects have gone, the supervisor writes one `AUDIT#delete` row for the run (who: the workspace retention
rule; what went; under which retention; when), and the run records the retention it ran under (D4) (all *planned*).
No run is to outlive that retention:
the supervisor stops a run at 30 days at a human decision point that offers only "stop", and a decision point left
open for 30 more days closes the run. The board and the indexes point at the keys; the reports keep the summaries they cite, so they stay
whole after the objects go. Findings, notes, checkpoints, conversation and memory hold feedback ids, never review
text: no engineering agent reads review text at all (the hunter gets ids, counts, categories and problem labels), and
the customer-text check that guards host writes also runs in the publish helper and on workspace and memory writes,
so an erasure (D5) has nothing to chase there.

**Default flows.** Six default engineering flows to start from, each a template in the workflow editor that a team can
change (a run follows its flow since 6.28.00, as far as the runtime can do its steps:
[The flow a run follows](#the-flow-a-run-follows)):

| Flow | Steps | Stops at |
|---|---|---|
| Understand the repository | map shards → reduce → draft knowledge pack versions and the repository's draft tenets and review guide ([below](#the-repositorys-tenets)) | an administrator's approval |
| Tenets (7.52.00) | the understander reads the approved pack, TENETS.md and the accepted tenets → `write_tenets`; the run's end drafts the next tenets version ([below](#the-repositorys-tenets)) | the draft, for an administrator to accept; then the `TENETS.md` pull request |
| Issue triage | understand → classify (bug, feature, investigation) → reproduce or locate → propose | the proposal on the issue |
| Bug hunt and fix | hunt → understand → fix → commit review → quality gate → commit → PR | the draft pull request |
| Feature | understand (issue or PRD) → plan → build → commit review → quality gate → commit → PR | the draft pull request |
| PR review | read the PR → reviewers in parallel, one pass, against the repository's tenets and review guide → comments | the review comments |

*Built as templates*: since 7.50.00 the five (since 7.52.00 six, with Tenets) are compiled from `voc-datalake/templates/orchestration/flows/` into
the orchestration bundle (`templates/orchestration/bundle.json`, its Lambda copy `lambda/shared/orchestration_bundle.json`),
which the server and the web app both read (template ids `understand-repository`, `tenets`,
`issue-triage`, `bug-hunt-and-fix`, `feature`, `pr-review`; `shared/engineering_templates.py`),
each validated by the server's own rules and kept as written (`shared/test/test_engineering_templates.py`, which also
holds that none can merge and that the two pushing flows, Bug hunt and fix and Feature, end only at a stop at PR or a
human decision point) and by the editor's port of them (`frontend/src/api/engineeringTemplates.test.ts`). As
templates: Understand is a map over packages, a mapper, a reduce, an understander drafting the pack, tenets and
review guide and a repository memory write, ending at an administrator's approval; Issue triage recalls the
repository, then an understander classifies, a hunter reproduces or locates and an understander proposes on the
issue; Bug hunt and fix is a hunter and a board (the hunter posts; the understander, fixer and commit reviewer
claim) before the quality gate, whose GO goes to the committer, then the PR author and a stop at PR, and whose NO-GO
to a person; Feature is an understander and a coordinator's plan before a board (the builder and commit reviewer
claim) and the same gate, commit and ends (6.29.00: the commit moved after the gate, since the broker pushes only a
tree the board's GO names; before, the templates put the committer on the board, before the gate, where its push
could only be refused); PR review recalls the tenets and review guide, maps the pull request's pages to PR
reviewers in parallel, reduces and comments; Self-improvement recalls the roles' lessons and runs the coach's
self-improvement step, ending at an administrator's acceptance. The Agents API lists them for administrators where
the module is deployed (`GET /workflows/templates`, 404 elsewhere); the library's **Start from a template** lists them from the file and opens
an unsaved copy of the server's definition in the editor, and Save is the library's own `POST /workflows` (its validation, its 409 where the module
is off): no write path of their own ([docs/autonomous-agents.md](autonomous-agents.md)). The step titles are in
English in every language (the template's name and description are translated). A flow saved from one can be
started since 6.25.00 ([How a flow starts](#how-the-agents-work-together), below), and since 6.28.00 the run follows
its own copy of it, step by step ([The flow a run follows](#the-flow-a-run-follows)). *Planned*: the templates over MCP (their route is for
administrators, and an MCP token never acts as one: TENETS.md's tenet 4 gap, as for a run's reads), and marking in
each template where the dial stops it (tenet 3: human-driven stops at the proposal or plan, AI-assisted waits for a
person's go after the plan); today a template does not say, and the dial is enforced server side, not by the
template: the broker reads it before every push and pull request since 6.23.00 ([Repository
connectors](#repository-connectors)); the runtime's other steps do not read it yet.

**New steps in the workflow editor**, each with its settings, a palette entry and validation rules, like the existing
steps and loops: Agent (a role from the catalog, with its skill version, model and budget), Map (fan-out over shards,
with its sharding rule) and Reduce, Board (post or claim tasks), Quality gate (gate packs, rounds, final go), the
existing human decision point, Learning loop (retrospective → memory), Self-improvement (coach → proposal → benchmark
→ acceptance), Memory read and write, and Stop at PR (the flow's end on a draft pull request; the validation refuses
a flow that pushes code, one with a committer, without it, and there is no merge step at all).
*Server side built* (`voc-datalake/lambda/shared/workflow_engineering.py`, validated by `shared/workflow_schema.py`):
an engineering flow is a workflow of schema `voc-workflow/2` (start, end and the engineering steps: `agent`, `map`,
`reduce`, `board`, `quality_gate`, `learning_loop`, `self_improvement`, `memory`, `stop_at_pr`), held to the rules
above (every map meets one reduce on every way out, a quality gate's GO and NO-GO arrows with NO-GO to the human
decision point, a committer or PR author ends only at a stop at PR or a human decision point); the Agents API saves
and validates one (a new one only where the engineering module is deployed, 409 elsewhere; one already saved
anywhere), keeps each workflow's kind, lists both kinds in `GET /workflows` (each with its `kind`) and keeps
engineering flows out of every agent ([docs/autonomous-agents.md](autonomous-agents.md)). The quality gate step's
settings are the gate's own (`max_rounds`, `packs`, `final_go_model`, `reviewers`). The web app's workflow editor
builds them: an Engineering palette, each step's settings and the graph rules as you edit (held to the server by a
shared fixture); its library offers New engineering flow only where the module is deployed (`config.json`
`features.engineering`), and offers the six default flows as templates beside it (above).

**From the assistant.** Describing a flow ("every night, hunt bugs in the payments package and open PRs for the ones
you can fix") makes the AI assistant draft it behind an approval card, like its other writes: its workflow tools
(`validate_workflow`, `create_workflow`, `update_workflow`) take a `voc-workflow/2` definition with the engineering
steps, the agents API's `POST /workflows/validate` judges its rules, and a new one is created only where the
deployment has the engineering module (the API's 409; the web app's card checks `features.engineering` first, as the
library's New engineering flow and the editor's Save as do). `create_workflow` takes a whole definition, not a
template id: taking one is *planned* (its schema, the plan contract and the approval card's preview change together),
and meanwhile the assistant drafts from the flows above as from any description. "What is agent X doing" is the assistant's
`get_engineering_run` (administrators; read only; the run on screen by default): the run monitor's own routes, read
with the administrator's sign-in, the agents' words passed to the model as data.

"Refresh the knowledge pack" is built (6.27.00), behind an approval card (owner decision: the assistant only
proposes). The assistant's `propose_knowledge_refresh {connection, commit?, language?}` (administrators; refused for
anyone else) is a card, never an action: it names the action, the repository connection, the commit (or "the default
branch's head", whose full id the administrator enters on the card, since no connection can be read yet), the
language, the saved Understand flow it starts (its name and revision), the flow's monthly budget, and an estimate
of the minutes and the cost, called one. The estimate is the flow's map step's run cap (`shard_cap` shards, 200 at
most), each shard assumed to take about 20 seconds, plus about 10 minutes for the reduce and the drafting, with the
run's coordinator and one session per agent step of the flow (standard size, 2 vCPU and 8 GB, about $0.39 an hour
each at AgentCore's published rates) counted for the whole run: about 77 minutes and $1.50 for the template (three
sessions); model tokens come on top, and the run's own cost and token caps bound it either way.
Only an administrator's **Approve** on the card starts it: the web app calls `POST /agents/engineering/runs` with that
flow, in the approver's own session, where `require_admin_caller` checks the person at the click (anyone else, and a
delegated credential such as an MCP token, gets 403), and the run records who started it (META's `started_by`, its
`RUNLOG#` row: D4). The model's call alone starts nothing, nothing approves it automatically, and no plan step can
name it (a card-only write). The Understand flow is the saved engineering flow with the "Understand the repository"
template's steps (a saved flow records no template id; with several, the one saved last); Approve starts exactly the
flow and revision the card showed, or nothing. Where none is saved, the card says so and its Approve saves one from
the template the server serves (`POST /workflows`) and starts nothing; the refresh is a second card under the same
rules. What goes back to the model names only ids: the run's own words reach it only through `get_engineering_run`,
as data. Like every run started from a flow, it follows its copy of the flow as far as the runtime can do its steps
([The flow a run follows](#the-flow-a-run-follows): the Understand flow's memory write is not run yet), and it
reaches a repository through its stored connection (and starts only on one). *Planned*: "pull the latest from the
repository" from the assistant (the same card rules). An engineering run's reads and its start are
administrators-only, so no MCP tool while an MCP token never acts as an administrator (TENETS.md's tenet 4 gap).

**The run monitor** (since 7.51.00 the run workspace, [docs/autonomous-agents.md](autonomous-agents.md#the-run-workspace)).
The run view shows every agent's status and where it is in the flow (the editor's graph with the
live step highlighted, each step's agents as lanes), each agent's thread, the board and the run's reports (each version's Markdown). Inspecting an agent shows its current step, its last progress,
its heartbeat's age, its session's state and age, its recent tool calls and, when it looks stuck, why (no progress for
N minutes, the same step repeated). A person steers the run through its orchestrator ([Steering](#steering-restart-and-the-runs-list-75100)),
answers an agent on the thread its own question opened, and sends
signals: Save (checkpoint now), Pause, Resume, Shut down (checkpoint, then stop), Stop now and (7.51.00) Restart. Stop now is the
[Stop](#trust-and-safety) of the run view, enforced by the supervisor, the launcher and the broker without the
agent's help; Shut down falls back to it if the checkpoint does not come; Resume is refused for a stopped run.
**The run's Stop (7.50.03).** For an administrator on a run that has not ended the monitor shows **Stop** wherever
the deployment names the start function (`stop_available`), in one Run controls bar: Stop has the agents with a session save a checkpoint, then ends the run ("Stopping…" until they
have, 10 minutes at most), and its menu holds "Stop now, without saving" (asked first). It ends the run whatever its
agents are doing, a run waiting for a person whose coordinator never started included, through voc-engineering-start's
`stop_run` (`POST /agents/engineering/<run_id>/stop`), so it needs neither the runtime nor the bus on the Agents API:
META `stopped` with its `RUNLOG#` row (who, how), every task that
has not ended closed `failed` with a `stop` history row (no agent's failure for the coach), its launch holds run out,
its sessions ended, and its engineering agent's run ended with it (cancelled, the agent's lock released). The issue's
claim is kept (one run per issue, ever). Pause and Resume are one toggle by the run's state, Save a checkpoint sits under
⋯, and an agent's session has its own Stop and ⋯ (Save, Stop now, Restart). Since 7.51.02 those reach the run through
voc-engineering-start too (`signals_available`, [Run controls reach the agents](#run-controls-reach-the-agents-75102)),
and steering and answers over the bus (`steer_available`); each control shows by its own flag, and where one is off a
line beside Stop says so, or the composer is off, saying why. While the Stop is under way no agent is signalled,
restarted or steered. A failed read
keeps the page's last good read and its controls, says "Couldn't refresh" with a Retry, and polling backs off
(`lambda/engineering/runtime/stop.py`, `frontend/src/pages/Agents/RunStop.tsx` and
`RunWorkspace/RunControlBar.tsx`).
Answers, steering and signals
are API calls with the signed-in user, allowed only to whoever may make a `decision`: answers and steering published
as `msg.answer` and `msg.steer` from the API's own source, the only types the router (and since 7.51.02 the API role's
grant) take from it, the signals recorded on the run's `RUNLOG#` rows by voc-engineering-start (7.51.02); an agent
reads a person's message as DATA,
like everything else, and its work still goes through the gate. Cost and tokens show live per agent, per run and per
flow (model tokens in and out per model, session seconds, events), against the run's budget.

The gate judges the patch a fixer or builder submitted, and the committer pushes that patch only after the gate's
GO (6.29.00: the templates' commit step follows the gate): the broker pushes only the tree the GO names, so what is
pushed is exactly what the gate passed.

**Evidence (tenets 1 and 2).** A flow that starts from customer feedback keeps the feedback ids it used, and the PR
description lists them. **No customer text leaves the data lake**: every write to the host carries feedback ids at
most, and the connector refuses a write that contains, verbatim, a sentence of a review the run cited (the reviews
behind its feedback ids, those of the PRD it builds from included), or, in its prose, a value shaped like personal
data (an email address outside the reserved example domains, a phone number); a paraphrase can still pass, which is one more reason a person
reviews every pull request. An erasure (D5) removes the content; the id left on the host points at its tombstone. A
Feature flow reports every upstream methodology step it goes without, however it starts (from an issue: no PR/FAQ, no
PRD; from a PRD with no prototype or no PR/FAQ: those): the run journals it, as other agent runs journal their gaps
(`lambda/agents/run_methodology.py`), here as a `methodology` event in the run's conversation, with a new upstream
rule for a feature in `lambda/shared/methodology.py` (a rule, not a new step of the project overview), and the PR
description says what it was built from and what it skipped. A bug fix is a correction to what was already built,
not new product work, so it skips no methodology step; a "fix" that changes behaviour beyond the bug belongs in the
Feature flow, and the commit reviewer flags one that does.

**How a flow starts.** *Built* (6.25.00): an administrator acting for themselves starts a run of a saved engineering
flow, from the flow's page in the web app (**Start a run**, where `features.engineering` is on) or with
`POST /agents/engineering/runs` `{workflow_id, connection, commit, language, goal, issue?}` (no MCP tool: admin work,
TENETS.md's tenet 4 row). The Agents API checks each field (a saved `voc-workflow/2` flow; a connection's short id; a
full commit id of 40 hexadecimal characters; a language with a session image; a goal on one line of at most 500
characters, credential-shaped text redacted; since 7.09.00 an optional `issue`, the number of the issue the run
starts from, a whole number from 1, recorded as given: "The run's issue and pull request", above; nothing else, so
the request sets neither the budget, the caps, the repository nor the actor), mints the run's ULID, and invokes the start function, voc-engineering-start (the runtime's
code with a role of its own, holding only what a start needs: the run's rows and the registry, a flow's month
total and the hard cap's row, its rule switched on, and the runtime invoked for the launch; no session, agent role,
bus or delete. It is entered at `start_handler`, which takes `start_run` and refuses every other action
before anything is read), with the stored flow's monthly budget, a task cap of 100, the deployment's cost cap
(`-c engineeringRunCapUsd`, 50 USD by default, so a run's cost cap always bounds it, TENETS.md tenet 7; with the hard
cap on, the smaller of it and what is left of the flow's month) and token cap (`-c engineeringRunTokenCap`, 10 million
by default), the connection's id as the run's `repo` (the connection's repository once a connection's record can be
read; none can be stored yet), and the signed-in person as the actor: the run's `started_by`, whose way of working the
broker's dial reads, and its first `RUNLOG#` row, who and when (D4). The API's role may invoke that function by name
and never voc-engineering-runtime, so it can start a run and never tick, launch, signal or end one
(`lib/stacks/api-engineering-reads.test.ts`, `runtime/test/test_engineering_runtime_handler.py`). The start function
writes the run and switches the supervisor's rule on, then hands the coordinator's launch on to voc-engineering-runtime
(`launch_coordinator`, invoked asynchronously: a session's start takes longer than API Gateway's 29 s, and the
runtime has 5 minutes); the API answers 202 with the run's id as soon as the run is written, and the web app opens the
run monitor on it. `launch_coordinator` never raises: a launch under way elsewhere is left to it, and any other failure
sends the run to a person (the coordinator's decision point), whose Resume launches it. If that invocation itself
crashes or times out before it can, the supervisor's tick catches it: an active run started with a coordinator to
launch (its connection, commit and language) that has no coordinator session and no live launch hold of one, more than
6 minutes after its start or its last Resume, whichever is later (the runtime's 5-minute limit and a minute's margin,
`supervisor.COORDINATOR_LAUNCH_SECONDS`), or 21 minutes when a fill of its checkout began since (its META's
`cache_fill_at`: four 5-minute invocations, the fill and its two further asks among them, and a minute,
`COORDINATOR_FILL_LAUNCH_SECONDS`; a Resume records `resumed_epoch` on `META`, so its new coordinator gets a full
window of its own and no tick undoes the Resume), goes to a person (`needs_human` `coordinator`, actor `supervisor`).
The check uses the agent rows the tick already queries (sessions and launch holds, one query per listed run) and makes
one GetItem of the run's `META` per tick for each run with no coordinator session; it asks once, as the decision point
already waited at changes nothing. The runtime's refusals, all before anything is written (no image for the language,
the hard cap with nothing left of the flow's month), are answered 409 in its words. A start known to have written
nothing (never connected, refused by the service, a read it needed that failed, `StartReadFailed`, or its write that
failed, `StartNotWritten`) is 503 "start it again". Any start that wrote, or may have written, its run is 503 naming it,
with its `run_id` beside the message: a failure once the run is written (the rule, the hand-on, a launch under way:
`StartFailed`, the run sent to a person first unless a launch of its coordinator is under way), a failure whose read
back of the run failed too (`StartUncertain`), a failure of an unknown kind (a timeout, a crash), a read timeout, a
dropped connection. The dialog then shows **Open the run**, a link to that run's monitor (the run read from `run_id` in
the body, else from the message), and keeps Start off, so nobody starts a second run. An answer that names no run
after the request was sent (a 504, a 5xx with no reason of the server's own, a network failure, an answer that cannot
be read) keeps Start off too, says the run may have been started, and links to the flow's runs (Agents → Spend grouped
by run for the flow, the one place runs are listed, where a run shows once it has used something). Such a run launches its coordinator and reaches the repository through its stored connection (a start on a connection
that is not stored is refused, 400: [Repository connectors](#repository-connectors), "The connections").

*Built* (7.47.00, [engineering agents](autonomous-agents.md#engineering-agents)): a run is also started by an
engineering agent (an agent with `engineering` settings: the seeded **Bug fixer** and **Feature builder**), from its
trigger (the agents' heartbeat) or an administrator's Run now, through the same start function and the shared request
builder (`lambda/shared/engineering_agent_runs.py`): the agent's flow as stored now, its stored connection's repository
and default branch, the deployment's caps, the flow's budget (required) with the hard cap forced on (`hard_cap`: capped
at what is left of the flow's month even with the administrators' hard cap off), and, as its actor, the administrator
who enabled the agent (a Run now: the one who pressed it), re-checked in Cognito before each start. Its commit is
resolved by the start (`resolve_commit`, `commit` empty): the head of the connection's stored default branch, read
through the broker's `head` (its function URL, as the start function's own role, admitted for that operation alone:
`connectors/identity.py`), which also confirms the issue the run starts from (`issue.verified` true on META; an issue
the repository does not have, or has closed, refuses the start before anything is written). Where it came from is
recorded (D4): `via {agent_id, agent_run_id, trigger}` on its first `RUNLOG#` row, and on META the reviews it starts from
as ids only (`feedback {ids (at most 50), count, category}`) or the PRD (`prd {project_id, document_id}`); each is
checked before anything is written. Its goal is trusted text only: the agent's instructions (at most 300 characters)
and one sentence of numbers and names ("Fix the bug reported in issue #7 of owner/name."), credential-shaped text
redacted, never the issue's or a review's text; its agents read the issue's thread through the broker, and its pull
request's body names the issue so the merge closes it (`Fixes #N`, GitLab `Closes #N`, added when the body does not
reference it: `connectors/broker.py` `closing_body`), and its understander comments on that issue alone. A PRD's own
text does not reach the run yet (only its ids, in the goal and on META); *Planned*: the trusted code that hands the
builder the PRD with its customer quotes replaced by their feedback ids. On a public repository (a connection that
does not say `repository_private`, 7.45.00), a flow that starts from someone's text starts only from an issue a
maintainer labelled for it: an engineering agent's `github_issue` trigger needs its label there, and starts one run
per issue, ever (`ISSUE_RUN#` claims, docs/autonomous-agents.md). *Planned*: a bug hunt scoped to packages; in a hunt
the understander writes its problem statement on the board's task, not on the host. A pull request from a fork is only
ever reviewed (comments), never fixed or pushed to.

### The flow a run follows

*Built* (6.28.00, `voc-datalake/lambda/engineering/flow/`, `board/flow_guard.py`; not yet run against AWS): a run
started from a saved flow follows that flow's steps; the flow is the plan.

- **The run's copy.** The Agents API sends the stored flow's definition and revision with the start
  (`flow_definition`, `flow_revision`); the start function checks it again (the server's own rules, an engineering
  flow, no cycle) and writes it into the run's own `FLOW` row in the start's transaction, create-only (D1, D4:
  `{workflow_id, revision, definition, copied_at}`), and refuses it before anything is written otherwise. A later
  edit of the flow never changes a run under way, and the record shows what ran. A run started without a definition
  has no copy and runs as before: its coordinator plans from the goal, and the board takes posts with no step.
- **The conductor** (`flow/conductor.py`, pure, no AWS) decides what comes next from the copy's graph and the run's
  record: the tasks posted for each step (the board records each task's `flow_step` and, after a map, its `shard`),
  the run coordinator's own step rows (`STEP#<step>#done`, `#fan_out`) and a person's decisions
  (`STEP#<step>#decision#…`). Each step is `waiting`, `ready`, `running`, `collecting` (a board taking its posters'
  posts while they still run), `done`, `not_yet_run`, `passed` (a person went past it), `blocked` (a task of it
  ended without being done), `stopped` (a step the runtime cannot do that the flow cannot go on without), `human` (a
  human decision point reached) or `skipped` (on a quality gate's arrow its verdict did not take). A step after a
  join waits for every way that was taken. It is tested on the five default flows, each driven from its start to its
  end with every task done and again with each task failing once (`flow/test/test_conductor.py`), and on the edge
  cases.
- **The coordinator's tools** (its skill, `coordinator@2`): `read_flow` returns every step's status, and the live
  steps with their roles, settings, instructions, the shards left and what to do at them, fenced as data;
  `post_task` names the step (and the shard); `complete_step` records an agent step of the coordinator's own role
  (the Feature flow's plan) or closes a board; `fan_out` records a map's shards. They go through the board's `flow`
  and `step` ops, the coordinator's alone (a replaced coordinator's session is refused them, as every coordinator
  op). Since `coordinator@6` (7.54.00) it also waits for the agents it launched (`wait_for_agents`), and its `finish`
  is refused while they still work on a flow that runs ([The coordinator waits for its
  agents](#the-coordinator-waits-for-its-agents-75400)). `coordinator@7` (7.54.00) names the submitted patch on a
  commit reviewer's task (`post_task` refuses one without it), and leaves a task that ended at a person (a review that
  could not review, a gate that stopped) to the person: only a NO-GO or a blocking finding starts a revision.
- **The board's check.** In a run that follows a flow, a post names a live step (`flow_step`), for a role that step
  takes, from a poster it allows: the run coordinator for any live step, another agent only on a board step that
  names it a poster (within the board's own rule of who posts for whom), a person for any live step or for a task of
  their own with no step. An agent step takes one task at a time (each shard of a step after a map one), held against
  a racing post by a `SLOT#` marker written in the post's own transaction; every post for a step holds, in the same
  transaction, that the step was not closed (no `STEP#<step>#done`), so a post racing a board's close never lands on
  the closed board. A retried post is answered with the equal task it repeats while that task is under way, and
  refused once it has ended (never made a new task past the step's check). A board's close is held in its own write
  too (6.28.01): every post for a step adds one to the step's count (`POSTS#<step>`) in its transaction, and the
  close (`STEP#<board>#done`) is written only while the count is the one its plan read, with every task it counted
  ended (a task never leaves an ended state; a board read empty closes only while it has no count), so a post
  landing between the close's plan read and its write refuses the close. Each counted task is marked (`counted`),
  and a board holding a task posted before the count existed never closes (a person decides). A launch is only for a
  task of a live step (or a person's own task), and its record is written only while its step is not closed (a check
  on `STEP#<step>#done` in the launch's own transaction), so a launch racing the step's close starts no agent; one
  that lost to another launch before the close is answered with the agent that one recorded, and a retry of a
  launch that got through is never refused. The final go of a quality
  gate is taken only once a gate runner's task of the step is done, and an empty board closes only when an agent
  other than the coordinator was to post on it (a hunter that found nothing). The caps, the coordinator's single
  lease and the check of a replaced coordinator, the launch rules and the claim guard are unchanged.

  What this holds, and what it does not: the board refuses any post or launch for a step that is not live, for a
  role the step does not take or from a poster it does not allow, so the coordinator cannot start a later step before
  its turn, run a step the flow does not have, or take the pass arrow of a gate without a GO. It cannot tell good work
  from bad: a coordinator may still record its own agent step done, or close a board, with little done, and list a
  map's shards as it likes. **A map's shards are not checked against the checkout or the knowledge pack's package
  list**: only the checkout's path rule (relative, no `..`, no glob), each once, and the map's `shard_cap`; the steps
  after the map then work on what was listed.
- **A person at a step.** When the conductor says the run waits at a person (a human decision point reached, a
  step blocked, or one stopped), the supervisor's tick puts the run at `needs_human` with the step named
  (`flow:<step>`) and holds its agents (checkpointed, then paused), as for a spent budget. A person's Resume there is
  their decision on the step, recorded with who and when: it passes a decision point or a stopped step, and gives a
  blocked one another try. One decision is one more failed task allowed on the step: on a step after a map, that is
  one more on each of its shards, so one Resume retries every shard that failed once. A run already waiting at the
  step's decision point is not asked again; its agents stay held. A NO-GO of the quality gate takes its `fail` arrow
  to a person; nothing reaches the pull request then.
- **The gate's verdict is the GO ledger's** (`flow/ledger.py`, the one rule the broker's `has_go` uses too): the
  final-go task that ended last decides, and it is a GO only when it ended done and its own gate record reads as a
  GO (verdict GO, the final go's GO, no stop). The same rule over a different set of tasks: the broker's GO check
  reads all of the run's final-go tasks (a pull request is the run's), a flow's gate only its own step's. A final go
  that ended done with a NO-GO record, a missing record, one access denies (read as missing) or one off its schema
  takes the `fail` arrow. A transient S3 error on a gate record is no verdict: it waits and is read again, never
  failing the run nor taken for either verdict (the board answers 503 and its caller retries; the supervisor logs it
  and reads again at its next tick; a report's build that meets one fails that build, to be built again). The board
  and the supervisor read the record (the board's role reads the gate records' keys only, `ReadGateRecords`; the
  runtime's already did) and keep each verdict they read (`STEP#<gate>#verdict#<task>`, create-only): the board when
  the coordinator reads the plan, the supervisor once it has sent the run to its decision point (6.28.01; best
  effort: a failed write is logged, never delaying or failing the decision point). The run
  monitor reads no gate record: it shows a kept verdict, so a run at the gate's decision point shows there, and a
  verdict not kept yet as the gate still running, never as a GO. The broker still opens a pull request only for a GO
  on the exact tree.
- **The run monitor and the reports** show the flow with its steps lit: the overview carries the run's own copy of
  its flow, as its start wrote it, with its revision, each step's status and where the flow stands
  (`flow_definition`, `flow_revision`, `flow_steps`, `flow_outcome`); the monitor draws that copy (never the flow as
  saved since) with the conductor's lights, and every report has the flow's steps ([Reports](#reports)).

What runs today, and what does not. Each step the runtime cannot do is reported as `not_yet_run`, never faked: in
the run's record (a `STEP#<step>#not_yet_run` row the board writes when the coordinator first reads the plan), in
the run monitor and in the reports.

| Step | Today |
|---|---|
| agent | runs: one task for its role (an agent step of the coordinator's own role is the coordinator's to do and record). Only a role with a skill can be launched; since 6.29.00 every launchable role has one, so each step's agent is launched with its skill's argv (a test drives the Bug hunt and fix template on the local fake runtime with scripted models, from the hunt to the draft pull request). The first run against AWS waits for the owner, and the broker's writes for the harness's broker client |
| map | `shard_by: packages` runs: the coordinator lists the packages from its checkout, at most the map's `shard_cap` (not checked against the checkout or the knowledge pack: the path rule, each once, the cap), and each agent step after the map takes one task per shard. `history` and `pr_pages` have no shard source yet: the map stops at a person (a person's go passes it, and the steps after it are not run) |
| reduce | runs as the join of the map's shards: done once every shard's task is; the step after it reads their results |
| board | runs: tasks for its claimers, posted by the coordinator and its posters, while its posters still run too; the coordinator closes it once nothing on it is under way (`until: caps`: only at the run's task cap; an empty board only when an agent other than the coordinator was to post on it) |
| quality gate | routes by the GO ledger: the final go (only once a gate runner's task is done) takes the `pass` arrow only on a GO its gate record says, anything else the `fail` arrow, to a person. The gate runner has a skill since 6.29.00 and is one of the bus's task roles: its tasks are posted and claimed like any role's, at a step that takes it (the quality gate's, in the shipped templates). Its task and the final go's name the submitted patch, which the harness applies to their checkouts and hashes before anything runs; it runs the packs' checks on that tree as repository commands and writes its record, with the tree the harness hashed; the gate CLI is not in the images yet ([The quality gate](#the-quality-gate)), and the broker still opens a pull request only for a gate record's GO on the exact tree |
| stop at PR | runs: the flow ends at the draft pull request; the broker's dial still decides whether one is opened (tenet 3) |
| end, human decision point | runs: a completed end finishes the flow; a human decision point puts the run at a person |
| memory (read, write) | not yet run: the flow goes on without the read (context) or the write |
| learning loop | not yet run: the flow goes on; the run's retrospective at its end still runs for every run |
| self-improvement | not yet run, and it is the whole of its flow's work: it stops at a person |
| call a flow (7.52.00) | never reaches the runtime: expanded into the run's copy before the start ([Calling another flow](#calling-another-flow-call_flow-75200)); a copy that still held one would stop at a person |

#### Calling another flow (`call_flow`, 7.52.00)

*Built* (the server: `voc-datalake/lambda/shared/flow_expand.py`; the editor's Flows palette section is the web app's
planned). A `call_flow` step runs another saved engineering flow in its place: params `{flow: '<workflow_id>@<revision>',
inputs?, budget_share?}`. The revision is a pin: a later save of the called flow changes none of its callers.
`inputs` maps at most 10 names (lowercase letters, digits, `_`) to text of at most 200 characters, each one the called
flow declares (its `definition.inputs`, 7.52.00), recorded with the run; a call takes no `assert` of its own (its
called flow's steps carry theirs). The step's own shape is the rules'
(`shared/workflow_engineering.py`, mirrored by the editor's `engineeringRules.ts` and held to the same answers by
`frontend/src/test/engineeringFlows.json`); the rest needs the stored flows, so the expansion checks it.

- **Where it is expanded** (D52-4): in the Agents API and the agents' heartbeat, at a run's start, for both paths
  (`shared/engineering_agent_runs.py` `stored_flow`: an administrator's `POST /agents/engineering/runs`, and an
  engineering agent's Run now or trigger), before the start function is asked. The runtime only ever sees a flat
  flow; a flow whose start read none of its calls is refused before the start (409).
- **How.** Each called flow is read at its pinned revision; its steps become `<call>.<step>` (a call inside it
  `<call>.<inner call>.<step>`), each id at most 64 characters (the ids of an engineering flow take a `.` for this:
  a flow a person saves has none, the save refuses one). The arrows into the call go to the steps the called flow's
  start leads to, and what reached its plain end goes where the call led; its human decision points and its stop at
  PR stay. The called flow's agents' `budget_share` are that share of the call's (floored to six places), and the
  run's shares, the calls' included, add up to at most 1. Its own memory, Learn, pull request mode and monthly budget
  are not taken: the caller's apply to the run.
- **Refused** (409 at a start, 400 at a save): a call more than 2 deep (a flow, a flow it calls, a flow that one
  calls); more than 60 steps once every call is in; a cycle (a flow in its own chain of calls, by its id, whatever
  the revision); a called flow that ends at a pull request, or has no plain end, unless the call is its flow's last
  step (every arrow out of it goes to an end); a flow or a revision that is not saved, an agents workflow, or a flow
  that breaks a rule now; an input the called flow does not declare; and a flat flow that breaks any of the server's
  rules.
- **What the run records** (D4): the flat flow is the run's copy (its `FLOW` row), and its start step's
  `params.expansion` lists the calls, `[{step, flow, revision, inputs?}]`, the outer before the inner; an engineering
  agent's run row (voc-agents) keeps `expansion` too, and the start's answer names it. The run workspace's overview
  answers it as the run's `expansion` (7.52.00's integration: `shared/flow_expand.py` `recorded_expansion`, each entry
  off that shape left out), so the canvas regroups a call's steps under it.
- **At a save.** `POST`/`PUT /workflows` (and `POST /workflows/validate` for an administrator) simulate the expansion
  on the stored flows, so a flow whose calls cannot be expanded is never saved; `GET /workflows/<id>/expanded?revision=`
  (an administrator's) answers the flat flow a run of that revision would follow, with `expansion`, `calls` and
  `steps`, or 409 `{error, node_id}` with the refusal.

*Planned*: the conductor reading the dial itself (AI-assisted: a person's go after the plan; Human-driven: the flow
stops at the proposal), the run's end when its flow finishes (today the coordinator finishes its task and the run
stays open for a person to end), the memory steps, the learning loop and self-improvement as flow steps, shard
sources for a repository's history and a pull request's pages, and a person's Resume at a step saying which decision it is (today one
Resume is one decision).

## The quality gate

*Partly built*: the packs and the step, run as a CLI (`python -m engineering.quality_gate plan|check|gate`) that the
gate runner's session is to run; nothing deploys it yet (the [runtime](#runtime-one-agentcore-session-per-agent)'s images do
not ship it; the workflow's Quality gate step is validated server side, with a `packs` pin the CLI keeps, and the
editor has the step with its settings panel, [above](#how-the-agents-work-together)). What exists:

- **The packs** (`voc-datalake/templates/orchestration/gates/`, [README](../voc-datalake/templates/orchestration/gates/README.md)):
  `python`, `typescript`, `rust` and `java` since 7.50.00 (`python-ts` and `rust-ts` remain aliases of their two),
  each a `manifest.toml` (schema voc-gate-pack/1: the languages' markers and
  extensions, the tools and their versions, the registries the dependency step may reach, the ordered steps), with
  fixtures. Detection reads a listing of the repository and finds every root of a monorepo. A step runs only where
  the repository uses its tool. A repository with `scripts/validate.sh` runs that instead of the pack's checks, after
  the dependency steps. Only the dependency (`setup`) steps get the network; every later step runs offline. A check
  that looked at nothing fails.
- **The step** (`voc-datalake/lambda/engineering/quality_gate/`): the deterministic checks (`checks.py`,
  `runner.py`), up to N review rounds (default 3, at most 5) of fresh single-turn reviewers (security and quality
  blocking, first-principles advisory), then a final go by an agent that neither wrote nor reviewed the change
  (`gate.py`, `review.py`). The reviewers run on the `agent_worker` surface's default model and the final go on the
  `agent_reviewer` surface's (`shared/model_config.py`), through `shared/converse.py`. Each round (with
  `--fresh-checkout`, as the runtime's gate checkout always runs, after putting the checkout back to HEAD) runs every
  root's dependency steps, then the roots the change touches, then the rest, so a round
  passes only on the whole tree: the full gate of step 3 below is part of every round, not a step of its own. Red
  checks are a round's blocking findings, and no model is called. It stops at a human decision point
  (`loop_exhausted`, `no_fail_path`, or `verification` for a change to `scripts/validate.sh`, an oversized diff, a
  repository no check covers, a model or runner failure, or an answer that twice breaks its contract). The gate
  record (`record.py`) is written either way, never with a GO when it stopped, with its Markdown for the pull
  request. The CLI's `gate` is review-only: it has no reviser, so the first blocking round stops it for a person.
  In a flow, the fixer or builder is to be passed as the reviser.

The design:

1. **Deterministic gate.** The language packs detected for the affected packages (Rust + TypeScript, Python +
   TypeScript, Java to start) run in the gate runner's session: format, lint, types, tests, the repository's own scripts
   first when it has them. A pack is a manifest (detection rules, commands, what counts as a failure) plus its
   scripts; adding a language is adding a pack.
2. **Review rounds**, up to N (default 3, at most 5): PR reviewer agents, in parallel, read the change with the
   affected packages' review guides and report findings with a severity; a round passes when no finding is blocking.
   Blocking findings go back to the fixer or builder as tasks; the fix is committed and commit-reviewed like the
   first, the deterministic gate runs again, and the next round starts. A last
   round that still fails stops at a human decision point (accept, another round, stop).
3. **Full gate.** Once the rounds pass, the packs run once more over the whole repository on the final tree; a
   failure goes back to the fixer or builder like a blocking finding, and stops at the same human decision point when
   no round is left.
4. **Final go.** A fresh agent that did not write or review the change reads the diff, every round's findings and
   what was done about each, and answers GO (`gate.go`) or NO-GO (`gate.no_go`) with reasons. A NO-GO stops at a human
   decision point (accept, stop); a person who accepts is named in the gate record.

The **gate record** (the tree's hash, the rounds, each finding and its outcome, the final verdict, who accepted
anything) is part of the commit and PR reports and goes into the pull request's description. It holds summaries, never
raw tool output.

## Runtime: one AgentCore session per agent

*Partly built, not yet run against AWS* (voc-datalake/lambda/engineering/runtime, the images in
voc-datalake/engineering-images, the stacks in voc-datalake/lib/stacks/engineering-runtime.ts and
engineering-agentcore.ts; deployed only with `-c engineeringAgents=true`; the harness inside each session is built
too: it reaches the board and its inbox through the board API, and the broker through an interface that refuses until
it is wired, below; the supervisor's own board and bus are wired).

**Amazon Bedrock AgentCore Runtime, platform version V2** (owner decision, 2026-11-13; in place of Lambda MicroVMs,
whose path is removed). Checked that day in the developer guide (the runtime's limits and how it works) and the test
account's service quotas (service code `bedrock-agentcore`): each session is its own microVM, 2 vCPU and 8 GB by
default, billed per second for the CPU actually used (nothing while it waits on the model or a tool) and its memory
(idle memory reclaimed after 120 seconds); the V2 consumption rates are $0.1276 a vCPU-hour and $0.0169 a GB-hour, a
committed baseline $0.0997 and $0.0132. A resource configuration (`resourceConfigurations: [{minimumMemoryInMiB:
8192}]`) commits a baseline of 8 GB and 2 vCPU that bursts to 32 GB and 8 vCPU with a 32 GB disk (4096: 4 GB and 1
vCPU, bursting to 16 GB and 4 vCPU with a 16 GB disk). A session lasts at most 8 hours (`maxLifetime`) and ends after
15 minutes idle by default (`idleRuntimeSessionTimeout`, up to 8 hours). There is no account memory quota: 5,000 active
sessions per account in us-east-1 and us-west-2. Images are up to 10 GB (V2), in ECR; the container answers `/ping` and
`/invocations` on port 8080; `InvokeAgentRuntimeCommand` runs a command in a session (1 to 3,600 seconds, 300 by
default); the network is PUBLIC or VPC. Why: no account memory quota to raise before a run (the MicroVMs' 2,048 MB
default held two agents), pay for use (CPU only while an agent computes, where a MicroVM billed every second it was up),
and the same isolation (a microVM per agent, no credential in it but its own short role session).

**What is checked, and what is not yet.** The operations and request fields are botocore's model of
`bedrock-agentcore` (1.44: `InvokeAgentRuntime`, `InvokeAgentRuntimeCommand`, `StopRuntimeSession`; a test reads the
model) and of `bedrock-agentcore-control` (its `CreateAgentRuntime` has `resourceConfigurations` and
`platformVersion`), and the stack's resource is the pinned aws-cdk-lib's `AWS::BedrockAgentCore::Runtime`, whose L1
has no `ResourceConfigurations` yet (set as a property override). Not yet checked, because no session has run yet (the
first run, in a test account, waits for the owner): the answers' shapes (the runner's JSON in an invocation's
`response`; the command's event stream), whether the CloudFormation resource takes `ResourceConfigurations`, the IAM
action and ARN names (`bedrock-agentcore:InvokeAgentRuntime`, `…:InvokeAgentRuntimeCommand`,
`…:StopRuntimeSession` on the runtime and its `runtime-endpoint/DEFAULT`), whether the Lambda runtime's own boto3
knows the command API (else the layer pins one), whether Mountpoint mounts the cache in a session (`/dev/fuse` is there
and root has CAP_SYS_ADMIN, below: the mount itself has not run yet), how the runtime's execution role is offered
inside a session (the walls keep both users off every link-local address), that the runtime's `/ping` keeps a session busy while its
runner says so and ends an idle one an hour after its last work (7.50.03's idle clock, "Idle and lifetime" below), whether AgentCore logs or traces an invocation's payload (the `session` invocation carries the agent
role's short STS keys: if it does, the runner is to fetch the session by a reference instead, which the launcher's
design allows but is not built), and the billing behind `caps.py` BUILD_SIZES (that a resource configuration's
baseline is billed for its session's whole life at the committed rates, and only the burst above it at the
consumption rates), whether each toolchain's dependency step honours its proxy (pip, npm and cargo read
`HTTPS_PROXY`; Node's own fetch only with `NODE_USE_ENV_PROXY=1`, which the runner sets; Maven reads no variable, so
the Java image gives `code` a `~/.m2/settings.xml` naming the proxy; Gradle reads the JVM's `https.proxyHost`, which
`JAVA_TOOL_OPTIONS` sets; a toolchain that ignores all of them reaches nothing, since the walls hold it either
way), and whether a quota or throttle answer to a start (`ServiceQuotaExceededException`, `ThrottlingException`)
guarantees no session was made (the runtime does not stop one then; on any other failed start it does), and how
AgentCore gets the right to make a session's network interfaces in the deployment's subnets in VPC mode (likely its
service-linked role, made on first use, which then needs `iam:CreateServiceLinkedRole` once, from the deployer;
the stack grants nothing for it). Until that run the flag stays off, and this section is corrected to what it shows.

**What a session's container is (probed on the live runtime, 2026-11-17; 7.50.03).** The first run's coordinator never
started: its container refused `start`, because the 7.50.0 entry point could not install its iptables firewall
(`iptables v1.8.9 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)`) and could
not write `/proc/sys/fs/protected_hardlinks` (`Read-only file system`), and the runner, without `--egress-firewall`,
fails closed. One throwaway session of the python image (the owner's, stopped after) then showed:

- the container runs as root (`uid=0 gid=0`) with Docker's default capability set plus CAP_SYS_ADMIN
  (`CapEff = CapBnd = 0x00000000a82425fb`) and no CAP_NET_ADMIN: iptables is refused, and nft is not installed;
  `NoNewPrivs: 1`, `Seccomp: 0`, kernel `6.1.166-24.303.amzn2023.aarch64`, `max_user_namespaces` 32057;
- user and network namespaces work: `unshare -Urn` as root, `unshare -n` as root, and
  `setpriv --reuid=10001 --regid=10000 --init-groups unshare -Urn` as `unit` (util-linux 2.38.1), each with only its
  loopback (down until brought up);
- `/proc/sys` is mounted read-only, but `fs.protected_hardlinks` already reads 1; the tmpfs mount on `/run/voc` works
  (`/work` device 45, `/run/voc` device 47), so both hard-link guards hold;
- `/dev/fuse` exists (`crw-rw-rw-`), so Mountpoint can mount;
- the session's own way out is link-local: `eth0` holds 169.254.0.2/30 and 169.254.53.53/32 (and a global IPv6
  /128), and `resolv.conf` names 127.0.0.2 and 169.254.53.53. The root runner and its proxies need that interface;
  the agent's and repository code's commands must not reach any of it;
- `ps` is not installed; the runner's `status` answered 200; `InvokeAgentRuntimeCommand` runs its command without a
  shell (`/bin/sh -c` for a probe).

The AgentCore developer guide says none of this (its container contract is an arm64 image serving `/ping` and
`/invocations` on `0.0.0.0:8080`; each session "runs in a dedicated microVM with completely isolated CPU, memory, and
filesystem resources"; a V2 runtime restores a snapshot taken at the first healthy `/ping`): the user, the
capabilities, `/proc/sys`, user namespaces, FUSE and seccomp are the probe's alone, and a change of the service's could
change them. So the entry point assumes none of them: it checks at every start, and the runner reports what held.

**The walls, whichever the container supports (7.50.03).** The entry point's `walls.sh` (engineering-images/common)
tries the egress firewall first (iptables owner rules, as before 7.50.03, for a container where root has
CAP_NET_ADMIN), and otherwise checks, for each of `unit` and `code`, the chain the runner will use: drop to the user,
make a user and network namespace of its own, bring its loopback up, find no other interface up, drop every
capability. It passes the runner `--egress-firewall --code-firewall`, or `--egress-namespaces` and
`--code-namespaces` for the users whose check held, and `--hardlink-guard` naming the guards that hold (`own_device`,
`protected_hardlinks`: read, never written). The runner starts an agent only behind an egress wall (and both proxies),
accepts the dependency step only behind a code wall, and runs repository code only with a hard-link guard; with none it
fails closed, as before. Its `start` and `status` answers say which walls hold (`{"egress": "namespaces", "code":
"namespaces", "hardlink_guard": ["own_device", "protected_hardlinks"]}`), the runtime records each language's last one
(voc-engineering `WS#default#SANDBOX` / `LANG#<language>`, `runtime/sandbox.py`), and [readiness](#readiness-75000)'s
`sandbox` check reads it.

Behind the namespaces every command of the agent's (the harness and its git, as `unit`) and of repository code's (as
`code`, in root's PID namespace and `/proc` of its own as before) runs in a user and network namespace of its own
(`unit_runner.own_namespaces`): root of a user namespace that owns nothing but that network namespace, it brings its
loopback up, drops every capability (an empty bounding set, no new privileges) and starts its command through the
runner's forwarder (`unit_runner.py forward`), which binds `127.0.0.1:<port>` inside and bridges each connection to a
Unix socket the root runner serves outside, in `/run/voc-net`, made at the session's start (never in a V2 snapshot):

| In the namespace | Bridged to | Whose |
| --- | --- | --- |
| the agent's `127.0.0.1:8081` (the runner's agent API: `/exec`, `/status`) | `/run/voc-net/agent-api.sock` | `unit`'s |
| the agent's `127.0.0.1:3128` (its egress proxy) | `/run/voc-net/agent-proxy.sock` | `unit`'s |
| the dependency step's `127.0.0.1:3129` (its proxy) | `/run/voc-net/code-proxy.sock` | `code`'s, until other repository code runs |
| any other repository code | nothing | |

Each socket is mode 0600, owned by its user, and its server checks the connecting process's uid again on every
connection (`SO_PEERCRED`, the real uid outside any namespace). A Unix socket's path, unlike a loopback port, is
reachable from any network namespace, so the dependency step's socket is closed and removed for good the moment other
repository code starts (from then on the runner refuses the dependency step anyway).

What this keeps of the firewall's guarantees, and how it differs:

- **The same:** the agent reaches only the runner's agent API (never 8080, the service's port) and its own proxy; the
  dependency step reaches only its own proxy; other repository code reaches nothing; neither reaches a link-local
  address, a credential or metadata endpoint, or a name server; each proxy resolves its allowlisted hosts itself and
  refuses link-local and loopback answers; no command keeps a capability or regains one; the hard-link guard is the
  same two guards, now read rather than set.
- **Stronger:** there is no route at all instead of rules to get right (no interface but a loopback in the namespace,
  so a missed rule, IPv6 or a raw socket changes nothing), and it holds without CAP_NET_ADMIN.
- **Weaker, or new:** each command makes a user namespace, which widens the kernel interface it can reach (a user
  namespace's root may make calls an unprivileged user may not, within namespaces it owns: a kernel bug there is the
  risk, which the microVM per session bounds); the command sees itself as uid 0 of its namespace (files keep their
  real owners: it reads and writes as its user); the forwarder is one more process per command (it dies with the
  command); and a socket's path crosses namespaces, so its mode, its owner and the uid check are what keep the users
  apart (pinned by the tests). The wall depends on the service keeping user namespaces open (a seccomp profile like
  Docker's default would close them): the entry point then finds no wall, and the runner refuses every start.

The VPC-level fallback (a security group allowing 443 only to the VPC endpoints' and the NAT's prefix lists, plus
Route 53 Resolver DNS Firewall with an allowlist) is not built: the probe shows the namespaces hold, and that fallback
would be weaker still (it cannot tell the agent from repository code, nor keep either off the link-local resolver and
credential endpoints, which no security group filters). The session's VPC, TCP 443 out only, stays the second wall.

The runtime names its agents as the [broker](#repository-connectors) and the
[bus and board](#how-the-agents-work-together) read them: its roles are `connectors/identity.py`'s AGENT_ROLES (one
list, shipped in the images), its role names the broker's `voc-eng-{role}` pattern, its session names
`<run ULID>.<agent index>` and its bus sources of the shape `bus/senders.py` parses: the gate runner's
`voc.engineering/agent/gate-runner/<ws>/<run>/<agent>` (only its gate results, `msg.finding` and `review.result`; a
verdict stays the final-go agent's) and the coach's run-scoped `voc.engineering/coach/<ws>/<run>` (its session pinned
to it from its tags; `from.kind` `coach`) among them. Not aligned yet (the runtime's next slice):

- **The harness.** Its board and inbox are the board API's (`harness/board_client.py`: a POST to the board's
  function URL, `VOC_BOARD_URL`, signed as the agent's own session for the `lambda` service; the brief is the
  holder's claim, whose lease epoch goes with every heartbeat, progress report and move: in progress once briefed,
  done when the agent finishes; a session that ends without its finish (two
  answers without a tool; a CLI ending cleanly) sends its task to a person (needs a human), never done, its last
  progress report saying why (the run coordinator's is a crash instead, which the supervisor continues and then
  sends the run to a person, whose Resume replaces it: a coordinate task with a person would leave the run with
  nobody planning it); the inbox is read after a cursor, each notice kept once by its event id,
  `signal.save` and `signal.pause` acted on, anything else shown as data. A checkpoint holds no message: its cursor
  stops before the oldest one taken and not yet done, with every id done its continuation can meet again. A save or
  a pause is done once acted on; any other message once the model saved its notes after having it (the Converse
  loop's batch reaches the model when the loop comes back for more, the CLI's when its tool server took the batch),
  so a continuation, which starts from those notes, reads again from the board what is not in them and never acts
  on a pause twice; at worst the model sees a message twice. The lease's epoch is the task's attempt (the board's
  claim sets it so), so the harness, a continuation and the CLI's tool server renew, report and move on it without
  claiming: the supervisor refreshes a continuation's lease before its session starts and again when its harness
  starts (it may have run out on a long hold, a Resume long after a Pause, or over the boot's minutes), for the same
  holder at the same attempt only, else the session ends
  (the board store's `refresh`); each checkpoint saves
  the brief, so a continuation reads it there: only a fresh start claims, and saves a first checkpoint right after its claim
  (one write), so a continuation of any crash after it has one, and one without it claims again, which the board
  answers for its live holder. The run coordinator's planner and knowledge reader are the board's too: `tasks`,
  `post` and `launch` (the board checks the caller is its run's coordinator and launches on the run's connection
  and commit, never an invoke grant of the coordinator's on the runtime, which would also reach its tick, its end
  of a run and its signals), and `knowledge` (a package of the caller's own task, or the root: the coordinator's
  `coordinate` task, which the run's start posts, has no paths, so it reads the root's pack); a refusal of the
  board's (a 4xx) is a result the coordinator's model reads, never a crash. Its broker interface (7.02.00,
  `harness/broker_client.py`) is the broker's function URL (`VOC_BROKER_URL`, its host on the agent's own proxy),
  signed the same way; a broker's refusal is a result the model reads too, and a write is never retried.

Each agent of a run runs in its own AgentCore Runtime session (its own microVM; below, an agent's session or its
microVM), from its language's image, with its own sparse checkout from the cache (`runtime/agentcore.py`):

- **One session per agent.** `InvokeAgentRuntime` on the agent's language's runtime, with a `runtimeSessionId` of its
  own (`voc-<run>-<agent>-<nonce>`: every continuation gets a new one), starts it; that first invocation is the
  runner's `start` (the agent's ids and its two egress allowlists, once: the same start again changes nothing, any
  other is refused, so nothing in the session ever widens its egress). The runner's other ops are invocations of the
  same session: the role session (`session`), the harness's report (`status`, what the supervisor's status reads map
  to), and `hold` and `wake`. `StopRuntimeSession` ends it (one already gone is not an error). A start that fails in
  any way but the service's no-room answer (the runner's refusal, its firewall's included; an error; a broken answer)
  stops the session at once and refuses the launch.
- **Two faces of the runner.** Port 8080 is the AgentCore service's only (`/ping`, `/invocations`: the role session,
  start, hold, wake); the agent's harness has its own API on loopback port 8081 (`/exec`, `/exec/<id>`, `/status`),
  the one runner port the firewall lets `unit` reach, so the agent can never hand itself a session, start itself
  again or wake itself. The command API's client (root's) uses 8081 too. A hold keeps every command where it is, and
  the runner's role-session watchdog counts no lapse while held: the lapse counts from the wake, which the supervisor
  follows with a fresh role session (a hold lasts up to 45 minutes, a role session 15).
- **Commands through the runtime's command API.** The supervisor's commands (the checkout, then the harness's start)
  go through `InvokeAgentRuntimeCommand`: each call (60 seconds, under the API's 3,600) runs the runner's own client
  (`/usr/bin/python3 -I /opt/voc/unit_runner.py client start|poll <base64>`: one shell string with nothing in it anyone
  wrote), which starts the command as a job of the runner or reads it back. So a build or a test run longer than an
  hour is split into one call that starts it and calls that read it, never cut at the API's bound; a command longer
  than its session's 8 hours is refused, saying to split it or continue in a new session. The repository's own builds
  and tests run inside the session, through the same runner (the harness's tools; a repository command at most an
  hour, as before).
- **Sizes.** Every agent runs at AgentCore's default consumption size, 2 vCPU and 8 GB (the owner's floor). The roles
  that build and test the repository (`-c engineeringBuildRoles`, the gate runner by default) run on their language's
  build runtime, whose resource configuration (`-c engineeringBuildMemoryMiB`, 8192; 0: none) commits 2 vCPU and 8 GB
  and bursts to 8 vCPU and 32 GB with a 32 GB disk. 4096 is not offered: its 1 vCPU and 4 GB baseline is below the
  floor.
- **Idle and lifetime.** Every runtime ends a session after an hour with no work (`idleRuntimeSessionTimeout` 3,600)
  and at 8 hours (`maxLifetime` 28,800). The runner answers `/ping` `HealthyBusy` while a command of the agent runs and
  is not held, so an agent waiting on the model, a build or a tool is never ended for idleness; only a held one is
  idle, and the supervisor checkpoints a wait still open after 45 minutes and holds it without a session before the
  hour. Continuation before the 8 hours stays the supervisor's (below). **The idle clock (7.50.03).** A `Healthy`
  session's idle time is measured from the ping's `time_of_last_update`, and the HTTP protocol contract says: "Do not
  set `time_of_last_update` to the current time on every ping. A timestamp that advances on every ping signals a
  continuous status change, which prevents the idle session timeout from ever firing — sessions then persist until
  `MaxLifetime` and can exhaust your session quota" ([HTTP protocol
  contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html), read
  2026-11-17). Until 7.50.03 the runner did exactly that, so a held or forgotten session lived to its 8 hours. Now
  `time_of_last_update` is when the runner last did real work: the status's last change (a command starting, every
  command ending, a hold), an invocation that starts, hands over, holds or wakes the agent, a command's start; never a
  ping, a `status` read or a poll of a command's result (`unit_runner.Runner.ping`). An idle session ends an hour
  after its last work.
- **MMDSv2 (checked 2026-11-17).** The troubleshooting guide says: "Starting June 30, 2026, Amazon Bedrock AgentCore
  Runtime requires all agent runtimes to use MMDSv2 (MicroVM Metadata Service Version 2). The service rejects
  invocations targeting runtimes without `metadataConfiguration` set, or with `requireMMDSV2` set to `false` or
  `null`" ([troubleshooting](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-troubleshooting.html)).
  The stacks cannot set it: aws-cdk-lib 2.275.0's `CfnRuntime` has no such property, and CloudFormation's own
  `AWS::BedrockAgentCore::Runtime` schema in us-west-2 has no `MetadataConfiguration` (a property override would fail
  the deploy's validation). It holds anyway: the `b-` python runtime, made by these stacks, reads
  `metadataConfiguration: {requireMMDSV2: true}` (`get-agent-runtime`, read-only), so the service sets it on the
  runtimes CloudFormation makes, and invocations reach the container. When CloudFormation and aws-cdk-lib gain the
  property, set it explicitly and pin it in `engineering-agentcore.test.ts`.
- **Refused up front.** A run whose agents at once (its coordinator and one per task, at most the board's 999) are
  more than the deployment's sessions (`-c engineeringMaxSessions`, the account's 5,000 by default) is refused before
  anything is written, saying to lower its task cap; so is a start under clocks that would let an agent outlive its
  session without a continuation. When the service has no room for a new session (its quota of active sessions, or
  its throttle: `ServiceQuotaExceededException`, `ThrottlingException` on the start), a launch is refused in those
  words (`SessionsFull`) and a continuation is held without a session (`waiting`, never counted as a crash) and
  continued again every tick until there is room, for at most 30 ticks in a row, then held for a person (`paused`,
  their Resume continues it): the service's own answer, atomic, with no count of sessions read.
- **A session no row names.** When a new session's row write fails (a launch's, a continuation's), the row is read
  back first: one that names the session means the write landed, and the session goes on. Otherwise it is stopped;
  when its stop fails too, its id is logged and it is kept on a create-only row of its own (`LOST#<session id>` in
  its run's partition), which every tick stops again and counts until the stop succeeds (`stopped_at`; never
  deleted), and which keeps its run watched meanwhile. Each count is one transaction, as a session's priced write:
  its seconds and cost on that row, its cost on its agent's row (where the run's cost cap reads it; only onto a row
  that exists), the spend ledger and its flow's month total; one row's failure never stops the run's others. A lost
  row whose session its agent's row names after all is closed without being counted or stopped. If
  writing that row fails too, the session is only logged and its runtime's idle timeout ends it (an hour with nothing
  busy; its runner ends its commands once its role session lapses); so is one whose run was released before its row
  landed, since nothing watches that run any more.
- **A stop that fails.** A session whose stop fails keeps its row's end with `stop_pending`: every tick stops it
  again and counts its time meanwhile (its runner may still say busy), and the run stays watched until it is gone. Its
  runner also ends every command once the agent's role session lapses unrenewed (a minute past its 15 minutes), so a
  session its supervisor lost runs nothing, and its idle timeout then ends it. No command runs with a privilege to
  regain: `setpriv --no-new-privs --bounding-set=-all`, and the image keeps no setuid or setgid file.

The supervisor ends a finished agent's session at once. An agent on an open wait (its question, a review it asked
for, a human decision point, the coordinator's `wait_for_agents`: 7.54.00) keeps its task and is outside every clock: the supervisor holds its session (the runner
stops every command of the agent where it is: no CPU is used, and none billed), wakes it to deliver a run monitor's
signal or when the wait closes, and for a wait still open after 45 minutes (or once the session nears its 8-hour
limit) asks it to checkpoint and pause, holds it without a session (`waiting`), and continues it in a new one once the
wait closes.

- **The session's network: two allowlists, two proxies.** Network mode VPC, in the deployment's own subnets
  (`-c engineeringAgentNetwork`), behind a security group of the stack's that lets nothing in and only TCP 443 out.
  An agent's allowlist (`runtime/egress.py`) is parted in two (`egress.split`), each held by a proxy of its own in the
  runner (root's, on loopback; an HTTPS `CONNECT` only, to a host of its own list, on port 443; it never reads what
  goes through):
  - the agent's own (user `unit`, port 3128): Bedrock in its region, its two buckets' own S3 endpoints and the board's
    and the broker's function URLs. Never a registry.
  - the dependency step's (user `code`, port 3129, the one repository-code command with network): its language's
    package registries and the deployment's extra hosts. Never Bedrock, a bucket, the board or the broker.

  The session's walls (the egress firewall where the container allows iptables, else each command's own user and
  network namespace with a forwarder: [above](#runtime-one-agentcore-session-per-agent), 7.50.03) send each user to
  its own proxy only: `unit` reaches the runner and port 3128, `code` port 3129 (in the dependency step only), and
  neither reaches any other address or port, a link-local address or a name server. Each
  proxy resolves its host itself and refuses a link-local (169.254.0.0/16, fe80::/10), loopback or unspecified
  address, an IPv4-mapped, IPv4-compatible, 6to4 or NAT64 (64:ff9b::/96, 64:ff9b:1::/48) IPv6 address carrying one included, "this network" (0.0.0.0/8) and the EC2
  metadata service's IPv6 addresses (fd00:ec2::/32), whatever name resolved to it (a VPC endpoint's private address is allowed). An extra host shaped like one
  of the agent's own (a Bedrock runtime or S3 bucket endpoint, a function URL; other AWS hostnames are not judged) is refused at the launch: the two lists are parted by
  shape, so a registry mirror cannot sit on an S3 bucket's endpoint. Each user's
  commands are pointed at its own proxy (`HTTPS_PROXY`, and the JVM's proxy settings); every other repository command
  runs in a network namespace of its own, with only its own loopback. Without an egress wall, or without either
  proxy, the runner starts no agent.

  **The recommended network** (the deployer's, outside the stacks; [deployment.md](deployment.md) has its rough
  cost): private subnets with an S3 gateway endpoint (free) and a Bedrock runtime interface endpoint
  (`com.amazonaws.<region>.bedrock-runtime`, private DNS on) whose endpoint policy allows `bedrock:InvokeModel*` and
  `bedrock:Converse*` only for principals of this account (`aws:PrincipalAccount`), so the agent's Bedrock traffic
  never leaves the VPC and cannot be spent on another account; and a NAT gateway, which the package registries and the
  board's and the broker's function URLs need (a function URL has no VPC endpoint), ideally behind an egress firewall
  that admits only the registries, the extra hosts and the board's and the broker's hosts. The stack makes none of it (TENETS.md tenet 7).
- **The sessions' execution role.** One for every runtime: it pulls the images from the stack's repositories and
  writes the runtimes' logs, nothing else. Everything else a session does is done with the agent role's 15-minute
  session the launcher hands its agent user (below), whose grants are, all scoped by its session tags: read its
  connection's cache and its run's workspace keys, write its own keys (create-only), call the board's and the
  broker's function URLs, put events on the bus with its own source only, and call the allowlisted Bedrock models.
  *For the owner's sign-off*: that agent role, not the execution role, is what a session can reach in AWS.
- **One runtime path, two runtimes per language.** "One runtime" is one runtime path (AgentCore, the MicroVMs' path
  removed), not one AgentCore runtime: a resource configuration is set per runtime, so each language with an image has
  a standard runtime and, unless `-c engineeringBuildMemoryMiB=0`, a build runtime for the roles that build and test.

- **No host token in any session.** Nothing in a session reaches the repository host: the
  [broker](#repository-connectors) holds the credential and makes every host write, and the checkout cache's writer
  (below) mints a read-only token only for its own fetch. An agent's egress
  allowlist is, in its region, Bedrock and its two buckets' own S3 endpoints (the raw bucket's for the cache, the
  workspace bucket's for its keys; never the regional one, which reaches every bucket), the board's and the broker's function URLs by their own hosts (`<id>.lambda-url.<region>.on.aws`, never a generic
  Lambda endpoint; the broker's since 7.02.00, when the harness's client of it landed), and, for the agents that run
  repository code, its language's package registries (plus at most 10 configured hosts, a registry mirror for example),
  which only its dependency step reaches (the second proxy, above).
- **Credentials from a launcher, never in the image.** A session starts with no AWS credential of the run's (its runtime's execution role pulls its image and writes its
  logs, nothing else). The launcher (the
  supervisor's own code, outside every session) assumes the agent role's ONE fixed execution role (one per agent role,
  never one per run; its IAM name `voc-eng-<role>` with the stack's naming, the roles spelled as the broker spells
  them, `commit-reviewer`, `gate-runner`) with session tags naming the workspace, the run, the agent and the
  connection (`ws`, `run`, `agent`, `connection`), and the session name `<run>.<agent index>` (a ULID run id and an
  index of 0 to 999, which the broker and the board's API read as the caller's identity, the agent being
  `<role>-<index>`: an agent's identity is its role's IAM name and that session name together, which always fit IAM's
  limits, so no two agents of a run share one). The session lasts
  15 minutes and goes to the runner, which keeps it as the agent user's `credential_process` answer in `/run/voc`, a
  directory only root writes (so nothing planted there can redirect root's writes), readable by the agent user only
  and named to the agent's own commands, never to repository code. The supervisor renews it each tick it has under
  6 minutes left (or a wake renews it), and the launcher refuses a stopped run's agents, so a stop cuts that run's sessions within
  15 minutes although the roles are shared (its sessions are ended at once anyway). The agent roles trust only the
  two launchers' roles (the supervisor's and the delivery function's, whose wake renews a session), which alone may
  tag their sessions; they may assume no role themselves.
- **Repository code in a box of its own.** The runner (each image's entry point) starts as root only to drop every
  command to an unprivileged user, and runs its own tools by absolute path only: repository code (builds, tests, gate
  tools) to `code`, in a PID namespace and `/proc` of its own (no view of the agent's processes) and, except the
  dependency step, a network namespace of its own with only its own loopback (so builds and tests that bind
  127.0.0.1 work, and neither the runner nor a credential endpoint is there); everything else to `unit`, the agent.
  `code` owns no directory on anyone's `PATH`: the toolchains' writable homes (cargo, rustup, the package caches)
  live under `/opt/voc/cache`, which no `PATH` names, and only repository code is pointed at them.
  No command gets a credential in its environment. `code` and `unit` share the group `work`; `code` can write only
  the checkout (`/work/repo`), not `/work` beside it, where the agent's own commands start; the agent's home (its
  notes) is its own. The agent starts with its first session: anything the runner ran before it (an image hook) is
  ended and forgotten. The dependency step, the one repository-code command with
  network, runs before any other repository code, after every repository-code process still running is ended; once
  repository code has run, the runner refuses it, and any other repository code that starts ends a dependency step
  still running. A code wall keeps the dependency step to its own proxy: the entry point's code firewall (first in
  the output chain, over IPv4 and IPv6: nothing on loopback but its proxy, not the runner's port on any address, no
  link-local address), or, where iptables is refused (AgentCore Runtime), the step's own user and network namespace
  whose one way out is its proxy's socket, closed for good once other repository code runs; without a code wall the
  runner refuses the dependency step. Behind the namespaces, other repository code's network namespace is its own
  too, made by `code` itself (root, without CAP_NET_ADMIN, could not bring a namespace's loopback up). Repository code runs under umask 0002, the agent's own commands under
  0022, and the checkout opens only its working tree to the group. The hard-link guard: the session lives on a file
  system of its own (a tmpfs at `/run/voc`), or the kernel's protected hard links are on (read, never set:
  `/proc/sys` is read-only on AgentCore Runtime, where it reads 1), so repository code cannot hard-link the session
  into the checkout; unless one of the two holds, the runner runs no repository code at all. A killed or timed-out command is ended with its whole process group, and a boxed command's
  namespace dies with it (and its forwarder with it).
- **Sparse partial clones.** The checkout cache (below) holds each run's commit under its connection's prefix,
  `engineering/cache/<connection>/<commit>/g<N>/repo.git`. With its first session the runner mounts the connection's
  prefix read-only at `/mnt/voc-cache` (Mountpoint for Amazon S3; nothing is written through it), its files shown as
  the agent user's (`--uid`/`--gid` of `unit`, 7.51.03: the agent's git runs in a user namespace that maps only that
  user, and refuses a repository owned by any other uid as "dubious ownership", the clone and every later fetch of a
  blob from the cache alike), and the agent clones
  `/mnt/voc-cache/<commit>/g<N>/repo.git` (the commit checked as a full object id, `N` the generation its launch found
  and recorded on its session, checked as a whole number) with `--depth=1 --filter=blob:none` (git
  hangs on a blob-less clone of a shallow repository without the depth) and a sparse checkout of only its task's paths
  (at most 200), then checks out the task's commit. The agent user runs
  every git command with the system config, terminal prompts, hooks, the file-system monitor, the pager, external diff
  tools and credential helpers off, and with git's own file modes (`core.sharedRepository=0644`, whatever the
  umask). The git directory lives beside the working tree (`/work/repo.git`, which repository code cannot write)
  and is made read-only to the group, and every agent git command runs from the working tree's root naming it and
  the work tree (no discovery; a bare repository is used only when named; what git writes, a restored patch
  included, lands inside the working tree), so repository code can change the working tree but neither the git
  directory nor which one the agent's git reads: a `.git` or a repository it plants in the working tree, with
  its config and filters, is never the agent's.
- **Repository code's read-only git (7.54.00).** Repository code (as `code`) may run git's read-only commands on the
  checkout, from the working tree's root or below it: `git status`, `diff`, `ls-files`, `log`, `describe`, as a
  repository's own gate script or setuptools-scm does. Git refuses a repository its user does not own ("detected
  dubious ownership"), and the checkout is the agent's (`unit`'s; in `code`'s own user namespace it shows as the
  overflow uid's), so before 7.54.00 every such command exited 128 (found in 7.51.03). The runner gives
  repository-code commands, the dependency step included, and never the agent's own, `GIT_CONFIG_COUNT=2` with
  `safe.directory` set to exactly `/work/repo` and `/work/repo.git` (`unit_runner.code_git_env`: the runner's
  `CHECKOUT_DIR` and `GIT_DIR`, which `checkout.py` uses too, in its working directory; never a wildcard or a prefix),
  which git reads as command-line configuration, the protected kind a repository's own config cannot set, and
  `GIT_OPTIONAL_LOCKS=0`, so `git status` never tries to refresh the index. The runner's values win and nothing comes
  before them: a command's environment is the runner's named variables (`PASSED_ENV`, `TOOLCHAIN_ENV`: never a `GIT_*`
  one, so no `GIT_CONFIG_PARAMETERS` and no other keys) and then these, and an `/exec` call carries no environment, so
  `GIT_CONFIG_COUNT` counts these two keys only; what repository code sets for its own children changes only what its
  own git trusts. What does not change:
  - the git directory stays closed to `code` (the agent's, not group-writable, what git writes there 0644 whatever
    the umask): a commit, an `add`, a ref, a tag or `git config` fails with "Permission denied";
  - the agent's git: it gets none of these variables, and `repo_git` names `--git-dir` and `--work-tree`, so it never
    reads the working tree's `.git` file, which `code` can write; pointed at a repository of `code`'s, or replaced by
    one, it moves only `code`'s own git;
  - a repository below the working tree (one the agent made at `/work/repo/pkg/nested`, or a `.git` that `code` makes
    in a directory of the checkout's) is still refused to `code` as "dubious ownership".

  It opens nothing that was closed: `code` could already read the git directory (its files are world-readable, and
  git given an explicit `--git-dir` skips the ownership check); its file modes were the wall and still are.
  Pinned by `test_engineering_local_runtime.py` (the variables, the runner's winning, none for the agent),
  `test_engineering_checkout.py` (a `.git` file changed or replaced) and, run in the image as root,
  `test_engineering_namespaces.py` (as `code` and `unit` through the runner behind the namespace walls).
- **The checkout cache (7.05.00).** Its writer is `voc-engineering-cache`
  (`voc-datalake/lambda/engineering/connectors/cache.py`, the layout in `cache_layout.py`; CDK in
  `lib/stacks/engineering-cache.ts`), trusted code that runs no repository code, a container-image Lambda
  (`voc-datalake/engineering-cache/Dockerfile`: Lambda's Python base image pinned by digest, one exact build of the
  distro's `git-core`, every Python package pinned by version and sha256 in `engineering-cache/requirements.txt` and
  installed with `--require-hashes`, built by CDK as a Docker image asset for arm64).
  - *Layout.* One immutable entry per (connection, commit, generation) in the raw bucket:
    `engineering/cache/<connection>/<commit>/g<N>/repo.git/…`, a bare repository holding exactly that commit at depth
    1 under one ref (`refs/heads/voc-base`, HEAD pointing to it), `uploadpack.allowFilter` set, its objects repacked
    into one pack (`git repack -a -d`; the ref stays one loose file, since S3 keeps no empty directory and git opens a
    repository only with its `refs/`). The entry is complete only once `…/<commit>/g<N>/READY` exists: a JSON manifest
    (format 2, the connection, the repository it was fetched from, the commit, its generation and its ref, every file
    with its size and sha256, the total, when it was written), written last and create-only (`If-None-Match: *`, in
    the writer's IAM too), never rewritten. A fill that finds READY does nothing; files under `repo.git/` may be
    overwritten by a retry, since nobody reads an entry without READY. READY marks completion; it is not an integrity
    check against its readers: the writer is the only principal that may write under the cache's prefix (the raw
    bucket's deny, under *IAM* below), and
    each file's sha256 is sent with its put, which S3 checks against the bytes it stores (a mismatch is refused), so
    the manifest's hashes are what S3 stored. A fill redone after a failed one overwrites the files of the same names (the
    bucket is versioned: the old ones become noncurrent versions, which the cache's rule expires a day later) and may
    leave a pack the manifest does not list (its name is its content's hash, and a new repack may name another); it
    holds the same commit's objects and is harmless. The manifest's `repository` is where the commit was fetched from: a commit fetched by its id may be
    one only a fork's pull-request ref reaches, so it says nothing of the branch the commit is on.
  - *Generations.* `N = floor(epoch seconds / 14 days)`, from the caller's clock (`cache_layout.py`
    `GENERATION_SECONDS`, the one constant). A launch takes READY of generation `N`, or of `N - 1` while its
    manifest was written under 28 days ago; when neither is usable, generation `N` is filled beside the old one. Every
    entry expires with the cache's 30-day rule (S3, after it was written), so an entry in use is always at least two
    days from its expiry, and the old generation is never read near its deletion; nothing is renewed or rewritten.
    The writer refuses a generation more than one away from its own clock's.
  - *The fill.* `git init --bare` (no template, so no sample hooks), then `git fetch --depth=1 --no-tags
    https://github.com/<owner>/<repo>.git <commit>:refs/heads/voc-base` (a GitLab connection's, since 7.06.00:
    `https://gitlab.com/<namespace>/<project>.git`), HEAD set, the commit checked, the repack, in
    a fresh directory under `/tmp` removed afterwards. Every git command runs with the system and global config,
    hooks, the file-system monitor, credential helpers and terminal prompts off, https the only protocol, no
    redirect, no submodule and every fetched object checked, from an environment it is given whole (nothing inherited).
  - *The token.* An installation token for `contents: read` on the connection's one repository, minted as the broker
    mints its tokens (`github.py` `fetch_token`, the connection's GitHub App credential read from its SSM parameter as
    the broker reads it). It reaches git only through the fetch's environment: `GIT_CONFIG_COUNT=1`,
    `GIT_CONFIG_KEY_0=http.https://github.com/<owner>/<repo>.git.extraHeader`, `GIT_CONFIG_VALUE_0=Authorization: Basic
    <base64 of x-access-token:<token>>`. It is never in a URL, an argument, a file, a log line or an error: a git
    failure's words are redacted (the token, its header form, anything credential-shaped) and cut before they are
    raised. Once the fetch is over (or has failed) the token is revoked (`DELETE /installation/token`, best effort:
    sent once, never retried, a failure only logged; the token lapses within the hour anyway) and forgotten by the
    container. A GitLab connection (7.06.00) fetches with its own project access token, read from its SSM parameter
    (`router.py` `fetch_access`), the same way: `GIT_CONFIG_KEY_0=http.https://gitlab.com/<namespace>/<project>.git
    .extraHeader`, `GIT_CONFIG_VALUE_0=Authorization: Basic <base64 of oauth2:<token>>`, never in a URL, an argument
    or an error (both hosts' header forms are redacted). A project access token is long-lived (it expires on its own
    date, at most a year out) and is the connection's own, not one minted for the fetch, so no revocation call is
    made after it: revoking it would cut the connection, which stands until an administrator replaces or removes it. The same classification holds: git's "Authentication failed",
    "HTTP Basic: Access denied" or an answer of 401 or 403 is a refusal (an administrator replaces the token, which
    may have expired or lost its access), a missing project or commit is a refusal as above, and a 429 or a 5xx is a
    failure a later try may not meet.
  - *The claim.* Two fills of one commit's generation are kept apart by a claim row in `voc-engineering`: `pk`
    `WS#default#CACHE#<connection>`, `sk` `COMMIT#<commit>#G#<N>`, attributes `holder` and `expires_at` only. A fill
    takes it
    with a conditional put (`attribute_not_exists(pk) OR expires_at <= now`), a lease of 300 seconds (longer than the
    function may run), and ends its own lease when done (an update conditioned on its holder): at once when it landed
    or was refused, but 120 s later when it failed (`CacheFailed`, `FAILED_HOLD_SECONDS`), so during a host outage the
    launches meanwhile find the fill held (a launch waits; the board's and the continuations' hand nothing on, and an
    agent's launch is told "a fill of it is under way; try the launch again in a few minutes") instead of each minting
    a token and starting a fetch, about one fill per 2 minutes in all, not one per launch; a claim another fill
    holds refuses (`CacheBusy`, saying when to try again), and a crashed fill's claim is taken over once its lease ends.
  - *Bounds.* The function runs at most 240 s (2 GB of memory, 3 GB of ephemeral storage); the fetch gets at most
    150 s, and never more than what is left of the 230 s deadline once 80 s are kept for the steps after it (a slow
    mint shortens it; under 10 s left, the fill stops as "ran out of its time before its fetch"), the repack 30 s, each
    other git step 10 s, and no upload starts that would end, by an estimate from its size (50 MB/s), past 230 s into
    the fill. The deadline is the earlier of those 230 s and Lambda's remaining time less 10 s, when the invocation's
    context gives it (`cache.invocation_ends_by`: a cold start or a slow claim shortens it). Past it the fill ends
    in its own words (`CacheFailed`; an upload far slower than the estimate can still meet Lambda's limit). The real ceiling is so whichever comes first: 1 GB and 1,000 files once fetched and repacked (refused with
    the size and the cap, `EntryRefused`), or a depth-1 pack the fetch cannot bring within its budget ("the fetch did
    not finish within its budget: the repository is too large for the cache, or the host was slow; a Resume tries
    again", `CacheFailed`: a failure a later try may not meet, since a slow host looks the same); a pack too large for
    the 3 GB of scratch space fails as a git failure (`CacheFailed`, redacted). Nothing is uploaded and no READY written
    in any of them. Why not Lambda's 900 s: the runtime waits for the fill synchronously, inside its own function
    whose limit is 300 s, and that limit is also how long a move holds an agent session's claim (`CLAIM_SECONDS` in
    `runtime/supervisor.py`), so it is not raised for the cache; the wait (270 s: the writer's 240 s and a cold start)
    fits inside it. A host that is busy or unreachable for the token is `CacheFailed` with its retry time (never the
    claim's `CacheBusy`); a host that refuses it (401, 403 or 404: the App's installation or its contents permission
    removed) is `EntryRefused`, a person's at once, in those words, and so is any other 4xx but 408 and 429 (a 422,
    say: the request refused the same way every time; an administrator checks the GitHub App). Every failure a later
    try would meet again is a refusal (`EntryRefused`, `cache.fetch_refusal`, read from git's last words), its claim
    let go at once, each saying what a person does: a fetch the host answers with no such commit ("not our ref",
    "couldn't find remote ref", an unadvertised object: "push it to the connection's repository, or start the run on
    a commit that is there"; refused at the first such answer, a host's brief lag after a push included: a Resume
    once the commit is there fills it), with no such repository (the host's "Repository not found", or git's
    `fatal: repository '<url>' not found` in that form only: an administrator checks the
    connection's repository and the App's installation on it), or with an object that fails git's check (`fsck
    error`: someone checks the repository with `git fsck` and starts the run on another commit). A busy host (429,
    5xx), a timeout and a network error stay `CacheFailed`. Each file is one PutObject (no multipart upload).
  - *When it runs.* The runtime fills the run's commit (generation `N`) before it launches the run's coordinator,
    after a read of READY found no usable generation: `launch_coordinator` (the start's hand-on) invokes the writer
    and waits (up to 270 s), then hands the launch on to a fresh invocation of itself, so a fill's wait and a
    session's start never share the runtime's 5 minutes (a fresh invocation that still finds no READY is refused,
    never filled again). The start function cannot wait for a fill: the Agents API waits 25 s for it, behind API
    Gateway's 29 s, which is why the start already hands the coordinator's launch on to the runtime. A whole-run
    Resume checks READY first, whatever the coordinator's state, and hands a fill on when it is missing, so an entry
    gone under a live run is filled again. A fill refused or failed is said as the run's health in the writer's own,
    already redacted words, followed by "A Resume of the run tries again." for a failure a later try may pass, or, for
    a refusal, by what helps given its cause (`handler._refusal_ending`; never "tries again", which it would not
    pass): a Resume keeps the run's commit, so after no such commit "A Resume of the run keeps this commit: it fills
    the checkout once the commit is pushed; otherwise start a new run on a commit that is there.", after an object
    failing fsck "A Resume of the run keeps this commit and would meet it again: start a new run on another commit.",
    and after any other (the repository, the App, a cap) "Once that is put right, a Resume of the run fills the
    checkout."; and the run goes to a person at the
    `checkout_cache` decision point. One another fill holds (another run on the same commit) is waited for, reading
    READY and the claim every 10 s for up to 210 s, and that READY serves this run too; a claim that lapses with no
    READY (that fill crashed) ends the wait, and the launch's next ask, in a fresh invocation, takes it over (at most
    twice; then "fills of the commit kept ending with no READY"). A fill that outlasts the wait under a live claim is
    logged as that and the launch asked exactly once more; still none, a coordinator's launch sends the run to a
    person ("another fill of the commit held its claim past two waits"). Both of these endings are transient
    (contention a later try may not meet): a fill a board launch handed on counts them as below. A writer that cannot be asked, or does not answer within the wait, is
    the cache's failure too ("the cache writer could not be asked, or did not answer in time"; a container-image
    function idle for weeks goes Inactive and Lambda wakes it on that first call, which is said as such: a Resume a
    few minutes later fills it). A READY read
    that answers 403 cannot be told from a missing one (the roles list nothing, below): it is logged apart (not
    counted as a denied read, which every entry not filled yet would trip), and once a fill has written READY and the read still answers 403, the run is refused saying "the role
    cannot read the checkout cache (403)" and goes to a person, never held in silence. Every launch (the
    board's `launch` op included) is refused (`RuntimeRefused`, a 409 the coordinator reads) while the run's commit has
    no usable generation, or when generation `N`'s manifest names another repository than the run's and `N - 1` of
    the run's repository does not serve (its connection
    repointed since the fill: that generation's entry cannot be replaced, so the commit launches nothing through that
    connection until the next generation, within 14 days; the refusal says so, and that pointing the connection
    back, or a run on another commit, helps meanwhile; `N - 1` of another
    repository is simply passed over). A launch that finds one records its generation on the agent's session, and the
    agent's checkout clones that generation. A coordinator's launch (a start, a Resume) that finds only `N - 1` usable
    fills `N` ahead first, best effort (a failure leaves `N - 1` in use), so a run's later launches and continuations
    do not meet `N - 1`'s 28-day edge; the board's launch of any other agent that finds only `N - 1`, or nothing,
    hands the same fill on in an invocation of its own (the launch is answered as it is), unless a fill of `N`
    already holds a live claim, so launches after the first fill has taken its claim hand none on (launches racing before that fill takes
    its claim may both hand one on; the writer's claim keeps them to one fetch). A fill handed on while `N - 1` still
    serves is a background one: its failure is logged and said as the run's health, and sends nobody to a person; its
    refusal (`EntryRefused`, say the App uninstalled; likewise for a coordinator's fill ahead, whose launch is then not
    made) sends the run to a person at once, in the writer's words, never only at `N - 1`'s 28-day edge. An agent's
    launch refused while a fill is on its way (handed on by that launch, or holding its claim) is told so ("a fill of
    it is under way; try the launch again in a few minutes"), not that a person's Resume fills it. One
    handed on while nothing serves, the coordinator still working, sends the run to a person only on a refusal
    (`EntryRefused`, another repository's entry, `DENIED`) or on the third transient failure in a row (the writer's
    `CacheFailed`, a fetch past its budget, an invoke that failed or timed out, other fills that held the claim past
    two waits or kept ending with no READY), counted on the run's META row
    (`cache_failures`, `RunStore.count_cache_failure`; failures within 300 s of the last one counted are one spell,
    counted once, so racing fills that meet one outage count once; one more than an hour after the last counted starts
    the count again at 1) and cleared by a fill that lands or a launch that finds the current entry ready, or on the
    first transient failure once the streak is an hour old (`cache_failing_since`, its first failure's time, set beside
    the count and kept across its restart until the same clearing; `CACHE_FAILING_LIMIT_SECONDS`), so a coordinator
    asking less often than hourly still reaches a person rather than its agents being told to try again for ever;
    before that its failure is
    said as health only ("The run goes on; the next launch tries again (1 of 3 failures in a row)"), and the agent
    whose launch found nothing usable still gets its refusal. A continuation (the supervisor's, or a wake's in the delivery function) looks
    the cache up again and clones the generation usable then. A supervisor's continuation that finds only `N - 1`
    usable hands `N`'s fill on in the background as a board launch does (unless a fill of it holds a live claim), so
    a long run that launches nothing new never meets `N - 1`'s 28-day edge; a wake's, in the delivery function, hands
    nothing on (that role neither invokes nor reads a claim: the supervisor's next continuation or launch does). With
    none usable the agent is held (paused, never
    counted as a crash), the run's health says why and the run goes to a person (`checkout_cache`). Their Resume, when
    nothing is usable, leaves the run waiting at `checkout_cache` and hands the fill on; once it has landed, the run
    is resumed again, continuing the held agents, but only off that point (`RunStore.resume`'s `only_from`): a run
    that reached another decision point meanwhile (a flow step, the coordinator's) stays there for a person. A
    Resume whose run the previous generation still serves only fills ahead, and resumes nothing after it.
  - *IAM.* The writer's role: `s3:PutObject` on the raw bucket's `engineering/cache/*`, with an explicit deny of a
    READY put that sends no `If-None-Match` (the `s3:if-none-match` condition key, as the raw bucket's own policy
    uses for `raw/`), and `kms:GenerateDataKey` on the
    stack's key only through S3 and only for those keys (`kms:EncryptionContext:aws:s3:arn`); `s3:GetObject` on
    `engineering/cache/*/*/*/READY`; `ssm:GetParameter` on the connections' parameters and `kms:Decrypt` through SSM for
    them only, as the broker; `dynamodb:GetItem`, `PutItem` and `UpdateItem` on `voc-engineering` in the claims'
    partitions only (`WS#*#CACHE#*`), of a row only the claim's attributes, no ReturnValues, with the key through
    DynamoDB for that table; its own log group. No ListBucket, no delete, no other prefix. The supervisor's role gains
    `lambda:InvokeFunction` on that one function, `s3:GetObject` on the READY markers only (a missing one answers
    403: it lists nothing, and a ListBucket narrowed to the cache's prefix would not change that, while one on the
    whole raw bucket would list customer data), and `dynamodb:GetItem` of a fill's claim (`WS#*#CACHE#*`, its key and
    `expires_at` only, projected); the delivery function's role gains the same READY read, for a wake's continuation.
    The writer is the only writer at the bucket too: with the flag, the raw bucket's policy holds
    `DenyEngineeringCacheWritesButTheWriters`, a Deny of `s3:PutObject*` and `s3:DeleteObject*` on
    `engineering/cache/*` for every principal (`"AWS": "*"`) whose `aws:PrincipalArn` is not (`ArnNotEquals`) the
    writer's role, `arn:<partition>:iam::<account>:role/voc-engineering-cache-<account>-<region>` (a fixed name, so
    VocCoreStack names it without a reference to VocProcessingStack), nor, only without `protectData`, the stack's S3
    auto-delete provider's role (which empties the bucket with the stack). A role with a broader grant on the bucket
    (Data Explorer may put anywhere else in it) cannot plant a READY or overwrite a pack. The cache's lifecycle
    expiry is S3's own, no principal's, and reads are not denied. Data Explorer, besides, refuses a save of any key
    under `engineering/` (400, "Engineering files (engineering/) are read-only in Data Explorer") in whichever bucket
    it addresses; it can still list and preview the keys under `engineering/cache/*`, so an administrator can read the cached
    repository code there (the files of a bare repository: its packed objects and its refs).
  - *Planned.* The dependency caches' filler (per connection and lockfile hash) is not built.
- **Scoped roles.** Each agent role reads only its connection's cache prefix (in the raw bucket) and its run's keys
  in the workspace bucket, `voc-eng-workspace` (`ws/<ws>/runs/<run>/`), writes only its own keys there
  (`ws/<ws>/runs/<run>/<agent>/`: the agent comes right after the run, so no other agent's key matches; create-only,
  since the bucket refuses a put without `If-None-Match`), reads no queue (there are none: the router invokes the delivery
  function, which records its run's messages in the run's inbox and wakes it), calls the board's and the broker's function URLs (`lambda:InvokeFunctionUrl`, and the invoke behind it only through a function URL), may
  put events on the bus only with its own source
  (`voc.engineering/agent/<role>/<ws>/<run>/<agent>`, the run coordinator's `voc.engineering/conductor/<ws>/<run>`;
  an explicit deny in its own policy and another in the bus's, which admits only the board's role and the agent
  roles with a voice), calls the allowlisted models, and deletes nothing. The supervisor's calls into a session
  are signed with its own role (SigV4), never a token of the session's: there is no session token to put in an event,
  a log, a row or a checkpoint, and the agent's role session has no readable form and refuses to be serialised.
- **The run coordinator.** It plans; it changes no code. It runs in the harness's Converse loop on its skill
  record (`runtime/harness/skills.py`): a versioned record of its instructions, worked examples, tool policy, the
  model it was written for and the harness that runs it, in the shape the skills store keeps (a change is a new
  version, never an edit, and a session row's `skill_version` says which one ran, `coordinator@1`). A launch of a
  role with a skill runs that skill's harness and model (`/opt/voc/harness.py run --adapter <its harness> --model
  <its model>`, and its row is labelled with them; a launch naming another argv for it is refused), a role with no
  skill yet the argv its launch names. Its tools are
  exactly its skill's tool policy: read the board, post a task for one role with instructions a person could follow,
  launch one agent for a task (on its run's connection and commit, which the board takes from the verified caller's
  run: neither the model nor anything in the session names them), read the knowledge pack on a topic (only through
  the pack's agent reader: its run's connection's latest approved version), read the checkout, and report
  progress, save a checkpoint and finish. It has no tool that writes files or runs repository code (a skill's tool
  policy is bounded by its role: code tools only for a role that runs code, the planner's only for the
  coordinator), and everything the board or the pack returns is fenced as data.
- **Delivery.** voc-engineering-delivery, the function the inbox router invokes for a message to an agent, the
  run's conductor or a role of the run (a posted task): the supervisor's code, with a role of its own (below). It records the message
  once in that run's inbox, `WS#<ws>#RUN#<run>` / `INBOX#<addressee>#<inbox_seq>#<event_id>` in voc-engineering
  (the addressee `agent:<agent>`, `conductor` or `role:<role>`; `inbox_seq` the run's write-order counter, taken
  just before the write, so a delivery retried a minute later sorts after every notice already read, with the
  conversation's seq kept on the row; two deliveries at once can commit out of order by a moment, and a number can
  go unused, so the reader re-reads a window behind its cursor on every page and keeps each message once by its
  event id; a marker, `INBOXEVT#<event_id>`, written in the same transaction, makes a
  redelivery write nothing; a message without its seq is refused), and
  wakes the run's live addressees (a posted task, addressed to a role, wakes nobody: an agent is launched for its
  task, so none of the role is idle, and one held on its wait keeps its one wake for the message it waits for; a
  task's end or an agent's stop is the conductor's too, and wakes the coordinator, 7.54.00): a
  working agent's session suspended for an open wait is resumed with a fresh
  session and kept awake 10 minutes (`wake_grace`, which a later message does not extend) so its harness reads the
  message and closes the wait (so is one whose wait no tick has seen yet, which its lease says it is on: 7.54.00), an agent held without a session is continued in a new one (once per wait), and a
  booting or pausing one reads its inbox once it runs. The wait's 45-minute hold counts from the wait's start,
  awake or not, so messages cannot keep a session running; only the one continuation a message makes per wait gets
  one grace before the hold applies again, to read the message, starting when its harness starts (a slow checkout
  does not eat it) and moved by no later message; a continuation after it (a crash, its own pause) gets none. (The wait's start is when a tick first saw it open: a
  wait closed and reopened between two ticks counts as one, held sooner; the board's lease carrying its wait's
  own start would end that.) Nobody is woken in a run that ended, is past its 30 days
  or spent its budget: the message waits in the inbox. No queue: a suspended session cannot poll, so delivery is a
  push. An addressee another move holds, or whose wake failed, fails the invocation; Lambda retries it twice (the
  row already there, only the wake repeats), then it goes to `voc-engineering-dlq`, and that agent is reached only
  when its wait's hold or a later message wakes it. Nothing deletes an inbox row; the board's `inbox` op reads the
  caller's run's rows after an `inbox_seq` cursor, and the harness keeps each message once by its event id. Its role is its
  own, with only what a wake needs: Get, Put, Update and Query on the runs' partitions (`WS#*#RUN#*`: the inbox
  rows, META and the agents' session rows; never the registry of active runs, and no delete), waking a held session
  (`InvokeAgentRuntime`), starting a new one and ending the old one (a continuation: `StopRuntimeSession`; no command
  call), on this deployment's runtimes only, reading the agents'
  checkpoints, the key only through DynamoDB, S3 and SQS, its failure records in `voc-engineering-dlq`, putting
  events on the bus as the supervisor only (a continuation is reported to the run), and the launcher's AssumeRole
  of the agent roles, which trust it as they trust the supervisor (with all four session tags), since a wake hands
  the session a fresh agent session. It cannot switch the supervisor's rule, run a command in a session or touch
  the registry.
- **The run's start and end.** The runtime's `start_run` (reached from the Agents API's
  `POST /agents/engineering/runs` through voc-engineering-start, the same code entered where only `start_run` runs:
  [How a flow starts](#how-the-agents-work-together)) writes the run's `META` row in voc-engineering
  (`WS#<ws>#RUN#<run>` / `META`: its task cap, which the board counts its tasks against, its hard caps on tokens and
  cost, its goal, repository, flow, status and start time, its connection and base commit, which the board's
  launch starts the run's agents on, never taken from an agent, its language (the repository's toolchain image),
  on which the router numbers the conversation) once, with its `coordinate` task, and
  lists it for the supervisor (`WS#<ws>#RUNS`, a row per run, in the same transaction). It then launches the run's
  coordinator on that task, for a run started with its connection, commit and language: `coordinator-1`, the run's
  first agent (META's `agent_count` starts at 1, so the board numbers the agents it launches from 2), on the
  coordinator's skill's harness; a retried start of an active run launches it only if no session of it exists yet, so a start whose
  launch failed launches it on its retry. The coordinator's launch follows the board's launch rules: a first start
  whose coordinator could not be launched (the role with no skill, a language this deployment has no agent runtime
  for, `-c engineeringImages`) is refused before anything is written, and a Resume that would number a new
  coordinator checks the same before it re-posts or numbers anything; the runtime's `launch` answers a repeat
  from its session and refuses one while another launch of the coordinator still starts before any other check
  (a start that meets one is refused as busy, `SessionBusy`, the run written and the record kept, so it asks
  again; a Resume logs it and still answers; a Resume whose new coordinator is refused or whose session fails to start
  logs it and sends the run back to a person, as a start does); a refusal that means no session and no
  launch of it exist (a bad request, or its session there for another task or attempt) clears the coordinator
  recorded on the `coordinate` task with a `launch_refused` history row, so the next start or Resume numbers a new
  one (a start raises the refusal, a Resume logs it, since the Resume itself was applied), while a failure of the
  session service keeps the record. A start whose coordinator then does not launch (refused, or its session did not
  start) sends the run to a person (the `coordinator` decision point, the run monitor's Resume prompt) and raises
  the failure, so a run is never left active with no coordinator and no session; that person's Resume launches it.
  A coordinator a person shut down or stopped is never replaced: the run stays active, with no coordinator, until a
  person ends it (the run monitor's Stop, 7.50.03, below) or resumes that agent (the run monitor shows the
  coordinator's own status in its Agents panel, and says nothing more about it yet); `end_run` sets its status
  (`done`, `failed` or `stopped`; a `stopped` end also closes the run's tasks that have not ended and runs out its
  launch holds) and end time, ends every session of it, and the run stops being listed once none
  of its agents is live (one busy with another move is ended by the next tick, which sees the run ended), then hands
  the run's retrospective on to an invocation of its own (best effort: the learning loop,
  [below](#getting-better-skills-the-coach-the-learning-loop-memory)). A retried
  start or end does what the first one left undone. After that first write only the run's own attributes are ever
  updated, never the board's, the router's or the inbox's counters. A run's agents are launched only while it is active, checked
  in the same write as the agent's row, so a run that ends meanwhile gets no agent nothing supervises. The
  supervisor reads its caps, its spend (its agents' tokens and what was priced on their rows), its start and its
  end from there; a human decision point is the run's status, and a Resume of the whole run makes it active again
  (never the 30-day one, which offers only "stop", nor replaced by another decision point). A Resume of the whole
  run also makes sure it has a coordinator, as its start does: the one its `coordinate` task records is left alone
  while its session is live or held (the Resume continues a held one) or a person ended it (a Shut down or Stop
  now stays final), started if it has none yet, and replaced if its session failed (it kept crashing, which is what
  sent the run to a person): the task re-posted at its attempt
  (the store's re-post alone: no `task.posted`, since only the coordinator recorded next claims it), a new
  `coordinator-<n>` recorded at the next attempt by `BoardStore.launch_coordinator` with the person as its actor,
  and its session started. The board refuses the old one every coordinator op from the re-post on; its session was
  ended with its session, and if that end failed (logged), it can still reach the broker and its bus source until
  its idle timeout ends it: only the board refuses it. If sending the run to a person fails after the session was
  ended as failed, each later tick asks again while the run is active and that failed coordinator is still the
  coordinate task's (from the sessions the tick reads anyway, and that task's one row). Every change of the
  run's status (its start, its end, a decision point, a Resume) records who made it and when (D4): a row of its
  own, in the same transaction as META's change (`RUNLOG#<at>#<status>#<hex>`, a random suffix: the status, the actor, the reason,
  the time), so the run's history is more than its last state; a change that loses a race with another write of
  META is tried again. The actor is the request's `actor` (its printable text), `unattributed` when it names
  nobody, or `supervisor` for the decision points it sets. The run monitor sends the person's id with its signals,
  so a person's Resume is theirs; the Agents API's start (`POST /agents/engineering/runs`, through
  voc-engineering-start) sends the signed-in person's, so a run started there names who started it; no caller of
  `end_run` sends one yet, so an end is `unattributed` until one does. A decision point asked for again, for the same reason (the supervisor asks on every
  tick while a budget stays spent), changes nothing and writes no row. An agent's tokens are those of every session
  it ran in, not only the current one's.
- **Sessions.** One row per agent of a run, the board's own `AGENT#<agent>` row in the run's partition: ids, times,
  the session's id and its runtime's ARN (`vm_id`, `endpoint`), the boot step, the continuation count, the checkpoint it restored from, the run
  monitor's inspection data, the live cost counters and what the reports read (role, model, skill version, session
  seconds, tokens in and out). The row is created once and then only its own attributes are updated, so what the
  brokers add to it (the cost they priced) is never written over; the runtime adds its own beside it, the session
  seconds it has not priced yet (running, `microvm_seconds`, and held for an open wait, `held_seconds`), at its role's
  size and the deployment's AgentCore rates (`-c engineeringSessionRates`, AgentCore's published V2 rates by default:
  [Cost](#cost)), with the vCPU- and GB-seconds they count as (`vcpu_seconds`, `gb_seconds`), in the same conditional
  write that moves the session, so a second is priced once and a run's cost cap counts it. The supervisor finds the live sessions through the
  listed runs (the table has no index). Every write is conditional on the row's sequence number, and every move first claims the row for at most
  5 minutes (a claim nobody else can take while it holds), so a tick and a run monitor's signal never move one agent
  at once; a continuation that loses its write ends the session it just started.
- **No fixed task cap: activity decides.** An agent runs as long as it makes progress (its lease's last progress on
  the board) and its heartbeat renews its lease. For a running agent, no progress for 10 minutes (2 to 60, per deployment)
  and the supervisor asks it for its state (a `question`); no progress within 3 minutes and it is stopped and its
  task re-posted from its checkpoint (`timed_out`); the run coordinator, which is not a task on the board, is
  restarted like a crash instead. An agent on an open wait keeps its task and is outside the rule.
  A lease not renewed for 3 minutes is a crash; so are a session whose calls fail three ticks in a row (gone, or
  never came up; a failing board, bus or launcher counts for nothing) and a boot (checkout and harness start) over
  30 minutes. The board counts re-posts: a task that
  times out twice is split or goes to a person. Model tokens and cost stay hard caps set by a person: past one, the
  run goes to a human decision point, every agent is checkpointed and held (`paused`, resumable once the cap is
  raised; raising a run's cap is not built yet, so today a person can only end the run from that decision point; until
  then it stays listed and the supervisor keeps ticking), and no new session starts.
- **The supervisor.** voc-engineering-runtime, invoked every minute by an EventBridge rule created disabled (TENETS.md
  tenet 7: schedules run on EventBridge rules). `start_run` turns it on; once no run is listed (after an `end_run`
  or a tick), it is turned off and the list re-read, and turned back on if a run started meanwhile. Each tick it renews sessions, boots new agents (the checkout, then the harness), judges each
  running agent as above, ends finished ones, continues paused and crashed ones, restarts a run coordinator that
  stopped answering or crashed, honours a run's end and a stop (a person's, an agent's kill switch, and the 30-day
  stop, which opens a human decision point offering only "stop"): every session of the run ended at once, without waiting for the agents.
  It reads each task's lease from the board's store (`runtime/board_bus.py`: the holder, its heartbeat, its last
  progress, whether it waits, the task's attempt, and whether the task has ended, which its harness is then to
  exit on: never judged a crash) and re-posts a stalled or crashed agent's task through the board (`repost_task`:
  open again at its next attempt, guarded by the attempt the supervisor judged so a newer claim is never undone,
  `task.posted` published as the supervisor, which the router admits). A session whose task another agent holds
  now, or that is at another attempt (re-posted, claimed or not), is ended, never continued, on every path (a
  tick, a wake, a person's Resume); a task open at the next attempt is asked to re-post again, which publishes
  its event again only while its own re-post is the task's last change (one whose publish failed is so delivered
  on the next tick), and nothing after a person gave it back, so the supervisor never sends another sender's
  change as its own. A task ended with no holder (a person's block) reads as
  ended, never as a lost lease. It speaks on the bus as `voc.engineering/supervisor`: `signal.pause`,
  `signal.save` and `signal.check_in` (no progress: "what is your state?") to an agent; `run.health` (counts by
  status, tokens, cost; no inbox backlog, since the inbox has no read state) and an agent's fate,
  `run.agent_continued`, `run.agent_timed_out` and `run.agent_failed`, to the run; its figures in the summary. One agent's failing call is logged and never
  stops the tick for the others. A tick EventBridge could not deliver goes to the bus's `voc-engineering-dlq` (on the
  stack's key, watched by alerting like the platform's other failure queues), and a failed one is not retried (the
  next tick is a minute away; the errors alarm sees it); it records `EngineeringSupervisorHeartbeat` and
  `EngineeringLiveSessions` each tick (embedded metrics). An alarm on its errors bills monthly, so it is a second
  opt-in, `-c engineeringSupervisorAlarm=true`.
- **The run monitor's controls** (the runtime's `signal` action): Save (checkpoint now), Pause (checkpoint, then held
  for a person), Resume (a held agent continued from its checkpoint; refused for a stopped run or a spent budget), Shut down
  (checkpoint, then stopped; stopped anyway when no checkpoint comes within 3 minutes) and Stop now (ended at once),
  for one agent or the whole run. A Pause or Shut down on an agent already pausing (its 8-hour pause, a long wait),
  or held for a long wait, decides what follows; Shut down outranks a hold, Shut down on a paused agent stops it (Resume
  then leaves it alone), and a Resume while a hold is still pausing continues the agent once it has paused. An agent
  held by a Pause, a Shut down or a spent budget that stops answering or crashes while it pauses is held as asked,
  never continued or re-posted. An agent another move is working on answers `busy`: nothing was
  done, and the caller sends the signal again. The answer says, per agent, whether the signal took effect
  (`applied`: false when busy, when its move failed, a refused port or a session call, when there was nothing to
  do in the agent's state, answered with its status, a final one meaning nothing to send again, or `stale`: given
  the `attempt` of the task the caller saw, with its `agent_id`, an agent on another attempt is left alone; a Stop
  now is never stale). **A whole run's Shut down or Stop now ends the run** (7.50.03, `runtime/stop.py`): before, it
  only moved the run's sessions, so a run with none (its coordinator never started, waiting for a person) stayed where
  it was. Now a Stop now, or a Shut down with no agent that has a session (none started, or each held or paused, so
  checkpointed), ends it at once: `RunStore.end` (`stopped`, its `RUNLOG#` row naming the person and how), every task
  that has not ended closed `failed` with a `stop` history row (`BoardStore.close_for_stop`, held to the state and
  attempt read), every live launch hold run out, then every session ended and the run settled. A Shut down with agents
  that have a session records the request on META (`stop_requested_at`, `stop_mode`, `stop_requested_by`:
  `RunStore.request_stop`), asks each to save and stop, and each tick ends the run once none has a session left or
  `STOP_GRACE_SECONDS` (10 minutes) after the request (`_finish_stops`); meanwhile `SessionStore.create` refuses a new
  agent, a Resume is refused, and the supervisor neither sends the run to a person nor waits for a coordinator. The
  Agents API reaches it through voc-engineering-start's `stop_run` (its role gains a Query of the run's partition,
  `StopRunReads`), which ends a run with nothing to save itself and hands the rest on to this function's `finish_stop` (its `end_run` as stopped), or
  records the request and hands the agents' save on to its `stop_run`; a hand-on that fails stops the run at once
  instead (`fell_back`). For each agent the row carries its current step and recent tool calls (the
  harness's own report, bounded and scrubbed), its last progress, heartbeat age, session state and age, why it looks
  stuck, the last failed command's exit code and output tails, its session seconds (only while a session is up and
  not suspended) and its tokens per model.
- **Continuation past the 8 hours.** At 7 h 30 of a session's life by default (1 h to 7 h 40, per deployment) the supervisor
  sends a `pause`; the agent finishes its step, saves its checkpoint and exits its harness with code 75, its
  acknowledgement (it may also say `pause.ack` on the bus); the supervisor ends that session and starts a continuation
  in a new one, as the same agent and task, from the newest valid checkpoint, and emits `continued` (the continuation
  number, after a pause or a crash, the checkpoint). An agent pausing itself the same way, before a step longer
  than its session has left, is *planned* (the harness has no such tool yet). One that has not paused by 7 h 50 is treated as a crash, on an open wait too; one asked to pause for a long wait
  whose checkpoint does not come within 3 minutes is held as waiting, without its session, from its last checkpoint. A crash (an exit other than 0
  and 75, a lapsed lease, a running agent's new session that will not start) is continued twice in a row at most,
  then the task is re-posted (the run coordinator: the run goes to a person). A checkout command that exits with a
  failure code of its own (git's 128 and the like; never a timeout or a kill) is no crash (7.51.03): a new session
  would only repeat it. The agent ends failed at once, and the run goes to a person at `checkout_failed`. The reason
  (the step, the exit code, the redacted start of its stderr, e.g. "The repository checkout failed (git clone, exit
  128): fatal: detected dubious ownership in repository at …") is in the run's thread, on the decision point's
  `RUNLOG#` row and META's `needs_human_detail`, and in the agent's inspection data; a worker's task is re-posted
  with it, and a Resume launches a new coordinator in place of a failed one. Any number of continuations
  otherwise; an agent held without a session whose new one will not start is tried again at its next wake, tick or
  Resume.
- **Checkpoints.** An agent saves each checkpoint as a new object, in the workspace's layout under its task's commit
  and attempt (which its launch names),
  `ws/<ws>/runs/<run>/<agent>/commits/<sha>/_checkpoints/attempt-<n>/<seq>-<nonce>.json`: its position, plan, notes
  and the key of its working tree as a patch (under `_patches/attempt-<n>/`) (a continuation starts a fresh conversation from its notes). The supervisor restores from the newest of the last 5 that is at most
  256 KB, plain JSON with a `position`, and holds no token and no key that names a secret, of the same attempt (a
  re-posted task, the next attempt, starts from its own); with none, the task starts afresh.
- **Output.** The runner masks anything shaped like a credential (AWS keys, host tokens, bearer headers, private
  keys, `name=value` and JSON `"name": "value"` pairs whose name says secret) and keeps the last 4,000 characters of
  each stream; the runtime
  masks them again on receipt.
- **The harness** (voc-datalake/lambda/engineering/runtime/harness; `/usr/bin/python3 -I /opt/voc/harness.py run
  --adapter converse|cli --model <id>` as the agent user, from root-owned `/opt/voc`, outside the checkout). Inside
  each session the agent runs through one harness interface with two adapters, chosen per agent in its skill: a plain
  Bedrock Converse loop for small agents, or a coding-agent CLI in its headless mode. Whatever the adapter, it gets
  only the task's brief, its knowledge-pack and memory slices and the platform's tools: read, list and write files
  of the checkout (walked one directory at a time, never through a link, never into `.git`, never a file with two
  hard links), run a repository command (through the runner, as the sandbox user, without network; a command
  still running reports progress once a minute), install the dependencies (the one command with the registries,
  before any other), report progress (through the board's API), save a checkpoint, submit the work (a patch made
  by the agent's own git, one at a time, refused when a file it holds has two hard links or when it is over 50 MB,
  put under its own keys and handed to the broker, which alone writes to the host) and finish (its summary is the task's last progress); the agents that
  run no repository code get none of the code tools. Each role with a skill gets exactly its skill's tools, among its
  role's (6.29.00, [the agent catalog](#the-agent-catalog)): its outputs (`write_findings`, `write_notes`,
  `write_gate_record`, each written once under its own keys and recorded on its task when it finishes),
  `post_subtask` (the hunter's fixes and the builder's sub-builds, the board's own rule of who posts for whom) and
  the writers' one broker write each (`push_commit`, `open_draft_pr`, `post_comment`, through the harness's broker
  client since 7.02.00, signed as the agent's own session). It renews its task's lease once a minute. Everything from the
  repository, the knowledge pack, the memory or a checkpoint reaches the model fenced as data, which its
  instructions say is never an instruction. Between turns it reads its inbox: `save` checkpoints at once, `pause`
  checkpoints and exits 75; the Converse loop also checkpoints and pauses after 150 turns in one session or once a
  call's input passes 120,000 tokens (a fresh conversation from its notes). On any error either adapter saves a
  checkpoint before the crash is raised. A checkpoint carries the agent's
  working tree as a patch under its own keys, which the continuation applies to its fresh checkout and opens to
  repository code again, as the checkout does (one that
  does not apply is a crash, never a silent loss; one the patch rules refuse is saved without it and says why),
  and is written only when the supervisor would accept it (too big, its notes are cut). Which CLI follows the repository's
  own AI reviews (kiro-cli, else claude), minus any that needs an endpoint or login other than Bedrock with the
  agent's session: kiro-cli signs in to its own service, so the CLI adapter does not offer it (since 7.53.00 it runs on
  an adapter of its own, over ACP: [The Kiro harness](#the-kiro-harness-75300)); `claude` runs at one pinned version
  only, with every built-in tool of its own off (`--tools ""`), the platform's tools from the harness's own tool
  server alone (`--strict-mcp-config`), in a fresh home outside the checkout (`HOME` and `CLAUDE_CONFIG_DIR` there,
  so no repository's or user's hooks, tool servers, steering or instruction files, or settings are loaded), with an
  environment the harness builds and Bedrock through the agent's session; a test plants each kind of such
  configuration in a checkout. Each `save_checkpoint` of a CLI is saved at once (and once more before a crash),
  other inbox messages reach it with its next tool result, and its whole process session is ended on every way
  out. It holds no host credential. It reports its status (step, recent tool calls, tokens
  per model) to the runner; a CLI agent's tokens are not counted yet (*planned*: the CLI's own usage report). The images ship it with boto3 pinned (`BOTO3_VERSION`), and everything they run needs
  nothing newer than Python 3.11 (their system `python3`; a test checks every shipped module). No image installs
  a CLI yet: the CLI adapter refuses one that is missing or not the pinned version. **Converse only for now** (owner
  decision): every skill runs on the Converse loop (all twelve shipped records say `harness: converse`); the CLI adapter
  stays built and tested, and a CLI version is pinned and installed in the images only after the first session run.
- **Images.** python, node, rust and java, each a Dockerfile in this repository on one shared base (git, util-linux,
  iproute2, iptables, Python for the runner and the namespaces' forwarder, Mountpoint for Amazon S3, the two users)
  and one entry point with its walls script (`walls.sh`, 7.50.03: rebuild every image for it), with ready
  hooks that warm the toolchain caches (only from that language's registries) and validate hooks that prove the
  toolchain and the runner; the hooks run as root before any repository code, from `/`. Mountpoint is pinned: an image is built with `MOUNTPOINT_VERSION` and the `.deb`'s
  `MOUNTPOINT_SHA256`, and the build fails without them or on a mismatch. Every image is built for linux/arm64
  (AgentCore Runtime V2; Mountpoint's `.deb` is the arm64 one) and answers AgentCore's `/ping` and `/invocations` on
  port 8080. The stack builds no image: it makes one ECR repository per language (scanned on push, tags immutable;
  only untagged images expire, past the newest 10, so a runtime pinned to a tag or a tagged image's digest never
  loses its image), and an AgentCore runtime for a language only once `-c engineeringImages` names an image
  pushed there (a JSON object from these four languages to a tag or a `sha256:` digest, checked at synth; `{}` by
  default, so every launch is refused until it is set) and `-c engineeringAgentNetwork` names the sessions' VPC and
  subnets. Building and pushing the images is *planned* (docs/deployment.md says how, by hand).
- **Behind an interface.** The runtime is an interface with the AgentCore implementation (tested against a fake
  bedrock-agentcore client) and a local fake (a temporary
  directory and the same runner, which does not sandbox; it lives with the tests, so the deployed runtime cannot
  pick it); the supervisor's tests drive every path above on the fake,
  and the board, the bus and the run's controls through small interfaces with fakes; the deployed runtime wires
  them to the board's store, the bus and its own rows.

### Which skill an agent runs (7.50.00)

A launch resolves the agent's skill once (`lambda/engineering/skills/resolve.py`, from `runtime/handler.py`'s launch),
in this order, and records the label on the agent's session row (`skill_version`); the argv takes that skill's model
and harness:

1. the flow step's pin (an agent step's `params.skill_version` `v<n>`; since 7.52.00 also a quality gate's `runner`
   or `final_go` naming its role at a version, `gate-runner@v<n>`): version `n` of the run's connection's own
   skill, else of the shared skill, accepted only (a pin to no version, or to one nobody accepted, refuses the launch);
2. the skills store's current version for the run's connection (`SkillStore.current`: its own, else the shared one);
3. the role's bundled template, `<role>@template-<version>` (`skills/templates.py`: the templates' `bundle.json`,
   which every Lambda ships byte for byte as `orchestration_bundle.json` in its `shared` package and every image at
   `/opt/voc/orchestration/bundle.json`; since 7.53.00 the harness's shipped records, `harness/skills.py` `SKILLS`, are
   read from that same bundle, never written out a second time, and a test holds each to it).

A store that cannot be read refuses the launch (the board answers 503 and the coordinator asks again): a template never
stands in for a version a person accepted. An agent step made from a Registry card (7.52.00, `params.card`
`<card>@v<n>`) also names it on the session row (`card`, `card_version`), beside its skill label. The runtime's role reads the skill rows it already reads for the coach
(`LearningCoachSkills`, pinned). The session then fetches its record through the board's `skill` op, by the label its
session row records, never one it names (`board/api.py`); the board answers the record and the platform's rules (the
bundle's `platform_rules`). A label the board cannot serve (no row, a template version this deployment no
longer ships, a version not accepted, another connection's) is refused, and the harness takes any failure of the fetch
as a crash, never a fallback (`harness/main.py` `session_skill`). `ToolBox` still offers only the tools the skill names
within its role's (`tools.role_specs`). The board's role reads the skills', the agent memory's and the scorecards'
rows on its table-wide grant and is denied every write of them (`DenyLearningWrites`, engineering-bus.ts, pinned).

A fresh start's brief also takes its task's approved lessons (the board's `memory` op, `{task_id}`, the caller holding
the task's lease): `AgentMemoryStore.recall_for_task` over the run's connection's repository memories and its role's
lessons there, never a person's, as the run's flow sets the recall (its start step's `memory: {recall, scopes,
limit}`; no recall without one), fenced as data. A recall the board refuses is no recall, said on the session's
status: it is advisory, and a session never stops for it.

### Fences and the 7.50.00 tools

Every tool result that carries outside text (a file, a command's output, an issue, the board, the knowledge pack,
memory, an inbox message, the session's own earlier notes) is a DATA block (`quality_gate/text.data_block`, which the
images ship): redacted, from a line `<<<DATA <name> <fence>>>>` to `<<<END DATA <name> <fence>>>>`, the fence a random
nonce per session (the CLI's tool server takes the harness's, `VOC_FENCE`) that the text cannot hold (it is replaced in
it), and the platform's rules name it. Redaction applies to a file read too, so a credential-shaped string in a file
reaches the model as `<redacted>`.

- `read_issue` (understander, hunter, fixer, committer, PR author, coordinator): a page of an issue of the run's
  repository and its comments, through the broker's `read`.
- `write_triage` (understander): the issue's `voc-triage/1` record (`runtime/outputs.py`: kind bug, feature or
  investigation; severity S1-S4; priority P1-P4; summary; paths; acceptance criteria; tenets, or none), once, under
  its own keys (`…/_triage/attempt-<n>/triage.json`), recorded on its task; a triage run's end copies it to the issue's
  trusted row (`ISSUE_TRIAGE#default`, `runtime/triage_end.py`), which a Bug fixer's `requires_triage` reads.
- `post_comment` (understander, on the run's issue): each line a code span under the platform's own head, so no link,
  mention, image or HTML survives in it; `label_issue` (understander): `voc-triage/<kind>` and `voc-severity/s<n>`
  only, through the broker's `label_issue` ([Repository connectors](#repository-connectors)).
- `run_gate` (gate runner): the packs (`/opt/voc/gates` in the images) detect the checkout's languages and plan their
  checks (`quality_gate/packs.plan`), and `quality_gate/checks.run_plan` runs each one through the sandbox's runner:
  repository code as `code`, from its root, the dependency step alone with its registries (`runtime/egress.py`: since
  7.50.00 the Python and Rust images reach npm's registry for a mixed repository's TypeScript half, and Rust also
  `static.rust-lang.org`). The harness records each check as it ended and the plan's packs, which the gate record
  takes; a gate runner's GO needs `run_gate` (a free-form command's exit is no gate), across a continuation too.
- `read_gate_record` and `read_findings` (final go): the gate runners' records of the tree it judges, and the run's
  findings at its commit, read through its role's own run prefix (`ReadCacheAndRun`, `ListRun`), as data.

### Transcripts and the run's manifest (7.50.00)

Each session writes its whole transcript under its own create-only keys, which its role alone may write (the agent
role's `WriteOwnKeys`, unchanged; pinned: no agent role writes another prefix, a manifest or the index):

    ws/default/runs/<run>/<agent>/commits/<sha>/_transcripts/attempt-<n>/<chunk:04d>.jsonl

One `voc-transcript/1` event a line (`runtime/harness/transcript.py`): the session's start (role, skill label, model,
harness, task, attempt, tools), every message to and from the model, every model call (model, tokens in and out, stop
reason, time), every tool call and its result (a gate's outputs among them) with its time, every checkpoint, a crash,
and the end (how it ended, the tokens per model, the outputs). Every text is redacted (`quality_gate/text.redact`) and
cut before its put; the session's credentials never pass through its tools. A chunk is flushed at each checkpoint, past
512 KB held, and at the end, a continuation going on with the next free number. The dollars are the run manifest's
(each session row's `cost_usd` at the deployment's prices), not each transcript's.

When the run's record stops moving (its end, every agent ended; a run left at a person past its flow's hours), the
runtime writes, create-only (`runtime/manifest.py`): `ws/default/runs/<run>/_manifest/v<nnnn>.json`
(`voc-run-manifest/1`: the flow and its revision, the day, the status, each agent's role, skill, model, tokens, cost,
session time and transcript prefix, the models' tokens, the run's tokens and cost with Learn's, the outputs' keys) and
`ws/default/transcripts-index/<flow>/<yyyy-mm-dd>/<run>.json` (the run by its flow and day, and its first manifest's
key). The runtime's role reads the transcripts (`LearnReadsTranscripts`, `LearnListsTranscripts` under their prefix
only) and writes only the manifests and the index (`WriteRunManifests`); all pinned in engineering-runtime.test.ts.

**Kept forever** (owner decision, 2026-11-16): voc-eng-workspace has no expiry and no lifecycle rule on current
versions. The only removals are the multi-workspace erasure of a person's data where it requires one and a workspace's
hard delete ([3g3](multi-workspace.md#the-project-plan-phase-3)); until 3g3 they are deployment-wide and in no
workspace's export.

### Learn, every flow's last step (7.50.00)

Learn is the retrospective, the coach and the learning loop ([below](#getting-better-skills-the-coach-the-learning-loop-memory))
made a configured, final step no flow removes (`learning/loop.py`, the runtime's `retrospective` action): on a run's
end (done, failed, stopped), and by the supervisor's sweep on a run left at a person past its flow's
`learn.after_needs_human_hours` (72 by default; once per run, `RunStore.mark_learn_swept`, from `needs_human_at`).
Its settings are the flow's start step's `learn: {enabled, model, budget_share, roles, after_needs_human_hours}`
(`flow/settings.py`); `enabled: false` turns it off (no scorecard, no lesson, no coach); `roles` names the roles whose
failures it takes to the coach. The coach reads the failed attempt's transcript as short excerpts
(`learning/transcripts.py`: the last chunks, bounded, redacted again, fenced as data in its prompt), on Learn's model
when the flow names an allowed one. Its calls count in the run's spend (`LEARN#spend` in the run's partition and the
spend ledger, in one transaction: `learning/budget.py`; `RunStore.spend` adds it), and a call whose worst case would
pass Learn's `budget_share` of the run's cost cap is not made (an outcome, recorded). A proposal still needs the
benchmark gate and an administrator's accept (`skills/store.py`), never automatic.

### Steering, Restart and the runs list (7.51.00)

The run workspace ([docs/autonomous-agents.md](autonomous-agents.md#the-run-workspace)) is built on these runtime parts:

- **Steering goes to the orchestrator only.** A person's `POST …/steer {text, about?}` is `msg.steer` from the API to the
  run's conductor (`bus/senders.py` admits that sender and no other; the router records it in the conversation, who and
  when, D4, and delivery wakes the coordinator). The coordinator decides: `relay_steering(to, text)` (an agent
  `<role>-<n>` or a role, never itself, a person or the run; 1 KB at most) goes through the board's `steer` op, which
  publishes `msg.steer` from the conductor (agent sessions have no EventBridge egress), and `set_direction(text)` writes
  a create-only `DIRECTION#v<nnnnnn>` row and moves META's `direction_version` in the same transaction. Every inbox page
  names the direction's version; the harness reads the direction (the board's `direction` op) when it moves and at each
  session's start. The harness renders steering in its own `<<<STEERING …>>>` fence, below the platform rules, and
  `_shared/PLATFORM_RULES.md` says steering never changes the tools, the gates, the dial, the scope or the rules.
  Steering and answers go over the bus: where the Agents API does not name it (`ENGINEERING_BUS_NAME`) they answer 503
  and the workspace shows its composer off, saying why. Until 7.51.02 no deployment named it; since then every one
  with the module does, with a grant held to these two types ([below](#run-controls-reach-the-agents-75102)).
- **Live transcripts.** The harness flushes the transcript events it holds every 15 s (`FLUSH_SECONDS`) besides at a
  checkpoint, past 512 KB and at the end; each `tool_call`/`tool_result` carries `call_id`, `tool_kind` and `status`
  (the ACP shapes), and each steering instruction that reaches the model is a `steer` event `{source, text, by}`.
- **Restart one agent of a live run** (`signal.restart`, `{from: checkpoint | fresh}`): from its newest checkpoint (its
  session ended, then continued at once in a new one) or afresh (its task re-posted as `restarted` at the next attempt,
  its session ended as re-posted). Refused for a stopped run, past 30 days, with its budget spent, without an agent, for
  a fresh restart of the coordinator, and while a person's Stop of the run is under way.
- **Resume or Restart an ended run as a child run** (D51-3: never reopened). voc-engineering-start's `restart_run`
  (`runtime/restart.py`, `POST …/restart {mode, agents?, base, confirm}`, 409 while the run is live) writes the child in
  its start transaction: META `parent {run_id, mode, by, at, base}`, the parent's create-only `CHILD#<child>`, the
  parent's caps, connection, language, goal, issue (no new claim) and flow copy at the same revision, and for a Resume
  `STEP#<step>#inherited` rows the conductor treats as done (never a quality gate or a fixer's or builder's step). Then
  the runtime's `seed_restart` ends the parent if it had not, writes for each task the child takes over
  `ws/default/runs/<child>/_seed/<task>/patch.diff` and a `voc-resume-seed/1` record (the history as excerpts, or a
  summary by Learn's model charged to the child above 40 events or 200 KB, with the people's steering), posts those
  tasks with their `seed_key` and launches the child's coordinator. `base: head` rebases on the default branch's head
  (the broker's `head`); the harness then applies the seed with `git apply --3way`, and a conflict reaches the agent as
  data, never a crash.
- **The runs list.** `WS#default#RUNLIST#<yyyy-mm>` / `RUN#<started_at>#<run>` rows `{run_id, flow, goal, status,
  started_at, parent?}` are written in the start transaction and kept current on each status change; the end adds
  `ended_at`, `cost_usd` and `learn_cost_usd` (a Stop's end too).
- **Assertion records.** At the coordinator's `flow` read the board records create-only `ASSERT#<step>#<attempt>`
  `{results: [{check, status pass | fail | unread, detail, on_fail}]}` (`orchestration/assertions.py`). They are records
  only: the conductor does not block on them yet.
- **`max_parallel`**, an optional setting (1 to 50) on agent, board and gate steps: the board's `launch` refuses past it.
- **IAM** (pinned in CDK tests): voc-engineering-start `RestartReadsTheParent` (Query of `WS#*#RUN#*`) and the RUNLIST
  partitions beside its run rows; voc-engineering-runtime `RunsListRows`, `RestartReadsPatches` and `WriteRestartSeeds`
  (`ws/default/runs/*/_seed/*`, create-only); the board `ReadRecordedOutputs` with an explicit Deny on `_transcripts`
  and `_checkpoints` (since 7.52.00 also a Tenets run's draft, `…/_tenets/*`, for `tenets.recorded`); the Agents API `s3:GetObject` on the runs' transcripts, patches, gate records and manifests and
  `s3:ListBucket` held to the transcript and patch prefixes (`lib/stacks/api-engineering-run-reads.ts`). No agent role
  gains anything.

### The coordinator waits for its agents (7.54.00)

The first live engineering run (2026-11-18) stalled at its first step: its coordinator posted the classify task,
launched the understander, read the board ("classify running") and ended its turn, was nudged ("or call finish if the
task is done") and called `finish` with the run unfinished. Nothing woke a coordinator that had finished, and the
understander's `task.done` was addressed to the run, so it reached no inbox at all. Now:

- **`wait_for_agents`** (the coordinator's tool, in the harness's own registry, so the Converse loop, the CLI and Kiro
  get it alike; `runtime/harness/waiting.py`). It reads the board: the tasks an agent works on (not ended, with its
  lease's holder or the agent launched for it at its attempt; the board's `tasks` op now names that `agent`, and
  `read_board` shows it). With none it answers at once and names the tasks posted with no agent. Else it opens a wait
  on its lease (a progress report with `waiting`, one line: "waiting for 1 task: Understand and classify"), then looks
  at its inbox every 5 seconds (the Converse loop's `AgentSession.take_messages`; in the CLI's and Kiro's tool server,
  the batches its harness leaves, the harness being the inbox's one reader) and, every minute, renews the lease and
  reads the board again. It returns at the first news: a message (a task done, failed or needing a person, an agent
  that stopped, a question, steering), a waited task the board shows ended or moved on (should a delivery be lost), a
  pause, or 25 minutes without news ("no news yet: read the flow and the board, then wait again"; under the
  supervisor's 45-minute hold of a wait, and Kiro's limit on one tool call, a repository command's hour). The
  messages reach the model as data in the session's fence, steering in its steering block. Before it returns it
  renews the lease, then closes the wait (a progress report without `waiting`, saying what came).
- **Suspended and woken.** While the wait is open the supervisor suspends the coordinator's microVM: its harness
  stops in its sleep. The task's end is now the conductor's notice too (`bus/routing.py` `CONDUCTOR_NOTICES`, above),
  so the delivery function records it in the conductor's inbox and resumes the coordinator for `wake_grace`; the next
  look takes the message, and the renewal before the wait closes is taken by the board even though the lease ran out
  while the session was suspended (the board's holder check passes while a wait is open). A delivery that lands before
  any tick has seen the wait reads the lease: it is on a wait, so it gets the grace, and the next tick does not suspend
  it with its news unread. A wait still open after 45 minutes is the supervisor's long-wait pause, as for any agent:
  the wait sees the pause and checkpoints; without news the wait stays open, so the coordinator is held without a
  session until a message continues it, and with news it closes, so the continuation starts at once. A coordinator's
  continuation closes a wait its last session left open first thing (`main.py`), so a Resume after a person's Pause
  is never suspended on a wait nobody is in. On Kiro, a person's steering is a prompt mid-turn, so the adapter also
  leaves the tool server a wake (`SessionFiles.wake`): the server answers one call at a time, and a wait under way
  would hold the steered turn's next call.
- **The finish rule** (`waiting.finish_refusal`). The coordinator's `finish` is refused while an agent still works on
  a task of the run and the run can go on: its flow is running (or it follows none) and no task of it failed twice
  (ended failed or needing a person at its second attempt or later). The answer names the tasks ("finish refused:
  agents are still working on task-2 (understander-2): call wait_for_agents, …"). It goes through once the flow has
  finished or stopped at a person, a task failed twice, or no agent works on anything (the task cap refused the next
  post, say): the skill's "When to stop". No other role's `finish` is checked.
- **The nudge.** An answer without a tool is followed, for the coordinator, by "Continue with your tools: if agents
  are working, call wait_for_agents; when the flow has finished, call finish." (`converse_loop.nudge`, the Kiro
  adapter's too); every other role keeps "Continue with your tools, or call finish if the task is done."
- **The skill, v6** (`templates/orchestration/agents/coordinator`): its Steps say to call `wait_for_agents` after
  launching agents and to read the flow and the board again when it returns, and never to finish while the flow is
  running; an example shows it; its card lists the tool, and both bundles and its Kiro agent config are compiled from
  it (the harness's shipped `SKILLS` read the bundle, so they are v6 too).
- **The local fake run** (`orchestration/test/local_fake.py`) plays the coordinator the way a model now must: post,
  launch, `wait_for_agents`; the agent's session runs while it waits, its board events go through the inbox router and
  the delivery function, and the wait returns with its `task.done` from the conductor's inbox.

### Run controls reach the agents (7.51.02)

Until 7.51.02 the run workspace's steering, its Reply and Pause, Resume and Save a checkpoint reached no run on any
deployment: the Agents API named neither the bus nor the runtime's function, and a CDK test pins that it may never
invoke voc-engineering-runtime, which takes many actions IAM cannot tell apart. Only Stop worked (7.50.03, through
voc-engineering-start). Now each reaches its run by its own path:

- **Steering and Reply: the Agents API publishes them itself, as narrowly as IAM allows.** Its role gets one statement,
  `SpeakOnTheEngineeringBus`: `events:PutEvents` on the engineering bus's ARN alone, with `StringEquals`
  `events:source` `voc.engineering/api` and `events:detail-type` `msg.steer` or `msg.answer`
  (`lib/stacks/api-engineering-voice.ts`), and `ENGINEERING_BUS_NAME` with the module on. The bus's policy admits the
  role as it admits every publisher (`OnlyTheEngineeringPublishers`, and `OwnSourceOnlyAgentsApi` denying it every
  other source); it names the role by ARN, so the role is named `[<prefix>-]voc-agents-api-<account>-<region>` with
  the module on (VocProcessingStack cannot reference VocApiStack, which depends on it). The router admits that source
  for those two types and nothing else (`bus/senders.py` `API_TYPES`: no `task.*`, `signal.*` or `skill.*` from it any
  more), and drops any event whose `detail-type` is not its message's own type (`bus/router.py`), so a message whose
  body says another type than the one the grant checked is refused. The bus's policy does not repeat the detail types:
  it is near EventBridge's 10,240-character limit for a bus policy (8,897 characters live on `b-` before this, a test
  holds the worst case under it).
- **Pause, Resume, Save and an agent's signals: through voc-engineering-start, like Stop.** Its `signal_run` (`{run_id,
  signal, actor, note?, agent_id?, task_id?, attempt?, restart_from?}`, `runtime/run_signals.py`) takes Save, Pause and
  Resume of the whole run (its Shut down and Stop now stay its Stop, `stop_run`) and an agent's Save, Pause, Resume,
  Shut down, Stop now and Restart (`checkpoint` or `fresh`), and refuses anything else before it reads a thing. Then it
  checks the run (there, not ended, no Stop under way: a Stop decided, so nothing else is sent meanwhile), the agent
  (its session row in the run) and its task (held by it at the attempt the person saw, not ended, not open again),
  writes the person's create-only `RUNLOG#<at>#signal#<hex>` row (`kind: signal`, who, what, of whom, the note: D4,
  `RunStore.record_signal`) and hands the signal on to voc-engineering-runtime's `signal`, asynchronously, as it hands
  on `stop_run` and `finish_stop` (a Resume may launch a coordinator, which does not fit behind API Gateway's 29 s).
  The API answers `{signal: {status: sent}}`; the supervisor applies it as before, and the overview shows what came of
  it (an agent busy with another move is left as it was: send it again). The start role's grants are unchanged (its run
  rows' GetItem and PutItem, its invoke of the runtime) and pinned statement by statement; the Agents API gets nothing
  new for it.
- **Nothing else is said on the bus from the API.** A signal's and a Stop's conversation records (`signal.*`) are gone:
  the `RUNLOG#` rows are their record. A person's board actions publish the board's `task.*` from the API's source,
  which the bus no longer takes, so the overview says `board_available: false` and the board routes answer 503 before
  the board is asked (their go, which publishes nothing, still works).
- **The overview's flags.** `actions_available` is replaced by what is actually reachable: `steer_available` (the bus
  is named), `signals_available` and `stop_available` (the start function is), `board_available` (false). The
  workspace shows each control from its own flag: the composer and Reply, Pause, Resume and Save, an agent's Stop and
  ⋯, the Board tab's controls; a control that is off keeps its line saying why.

### MCP for runs (7.53.00)

Tenet 4: a local Kiro or Claude agent follows, analyses, steers and asks for runs through the global MCP server
(`/mcp/global`) and the existing Agents API, so nothing new listens and nothing is public
([docs/mcp.md](mcp.md#engineering-runs-75300)). Five tools, `lambda/shared/mcp_global_tools_engineering.py`:

| Tool | Route | What it gives or does |
|---|---|---|
| `engineering_runs_list` | `GET /agents/engineering/runs` | a month's runs, newest first |
| `engineering_run_get` | `GET /agents/engineering/<run>` | status, steps and lanes, gates, agents, cost, links; no transcript text, no diff |
| `engineering_run_analysis` | `GET /agents/engineering/<run>/retrospective` | the retrospective and the cross-run summary, labelled as model text |
| `engineering_run_steer` | `POST /agents/engineering/<run>/steer` | steering to the run's orchestrator |
| `engineering_run_request` | `POST /agents/engineering/requests` | a request for a Run now that an administrator confirms in the app |

- **Who.** Only a write token minted by an administrator who still is one: the MCP Lambda re-checks the minter in
  `admins` on every call and refuses a read, a non-admin's or a project-pinned token. The call is never an admin:
  it carries `voc:mcp_engineering` set to its one operation, and the route admits it for that operation alone
  (`_engineering_caller` in `agents_handler.py` and `shared/agents_engineering_run_routes.py`, through
  `project_access.delegated_engineering_allowed`). Signals, go, restart, Stop, answers, board actions, approvals, the
  registry, the connections, the dial and a request's confirm or decline refuse every delegated credential.
- **The retrospective** (`GET …/<run>/retrospective`, an administrator's too) is Learn's record of the run, built by
  rule from its own rows and gate records (`learning/records.py`, `learning/retrospective.py`, no model call): its
  failures (at most 50, the most severe first, each reason redacted and cut to 400 characters), a scorecard line per
  skill version, the failures Learn took to the coach (`RETRO#coach`) and what came of each (`LEARNED#`: the lesson and
  the coach's words). A live run's is its record so far (`ended: false`). `cross_run` is the newest weekly record of
  the run's flow from the scheduled cross-run Learn pass ([below](#the-scheduled-cross-run-learn-pass-75300)): its
  week and key, the model's analysis under its model-text `label`, the convergence and at most 20 recurring failures;
  `{available: false, reason}` for a run with no flow, a flow with no record yet, or a record that cannot be read.
- **Steering over MCP is a person's steering.** It is the minter's `msg.steer` to the conductor, recorded in the
  conversation with "(sent from a local assistant over MCP)" before it (the 1 KB counts the mark), fenced below the
  platform rules by the harness like any steering, and logged with `via: mcp:<token>` and the minter. The orchestrator
  decides what to relay.
- **Starting a run is a request (D53-3).** `engineering/run_requests.py` keeps one row per request in
  `WS#default#RUNREQ#queue` / `REQ#<ULID>` (`agent_id`, the issue or PRD, `note`, `via`, `requested_for`, `status`,
  `requested_at`, `expires_at`), for an enabled, set-up automation only, its Run now checked as Run now checks it. It
  waits `pending` for 24 hours (then reads `expired`); at most 3 of a token's and 20 in all wait at once, and the same
  Run now is asked once while it waits. Agents → Runs lists the waiting ones (`GET /agents/engineering/requests`); an
  administrator signed in confirms one (`POST …/requests/<id>/confirm`: the request is decided first, once, then the
  automation's Run now runs as that administrator, and its `outcome` is recorded: `started`, `uncertain` naming the
  engineering run, or the refusal's words) or declines it (`…/decline`). `GET …/requests/automations` lists what a
  request may name.
- **Rate.** The two tools that act are held to 20 an hour per token besides the token's 120 requests a minute
  (`ENGINEERING_ACTS_PER_HOUR`, counted on the token row; a store fault refuses), and every call is in the token's
  audit log.
- **IAM** (pinned in `lib/stacks/api-engineering-reads.test.ts`): the Agents API's `RunRequests` statement, PutItem and
  UpdateItem on voc-engineering held to `WS#*#RUNREQ#*` by `dynamodb:LeadingKeys`; the reads are its existing GetItem
  and Query, the retrospective's gate records its existing `_gate/` GetObject. The MCP Lambda gains nothing (its
  invoke of the Agents API already exists) and no agent role gains anything.
- **The skill** `templates/orchestration/mcp-skills/voc-runs/SKILL.md` teaches a local agent the five tools: a start is
  a request an administrator confirms, steering goes to the orchestrator, the analysis is model text.

### The Kiro harness (7.53.00)

*Built and tested against a scripted fake of `kiro-cli acp`, off by default, not yet run against AWS*
(`lambda/engineering/runtime/harness/kiro.py` and `acp.py`, `runtime/harness_switch.py`, `lib/stacks/engineering-kiro.ts`).
An agent can run as Kiro CLI over ACP, the Agent Client Protocol (`kiro-cli acp --agent-engine=v3`,
[kiro.dev/docs/cli/acp](https://kiro.dev/docs/cli/acp/)), in place of the Converse loop. The harness is kiro-cli's only
ACP client, the orchestrator stays the only one that talks to an agent, and a person still talks to the orchestrator
alone.

**The switch: per deployment, per role.** `-c engineeringHarness` ([deployment.md](deployment.md)) is `native` by
default (every role on its skill's own adapter: nothing changes until a live run proves Kiro), `kiro` (every
launchable role) or `kiro:<role>,<role>`. A launch of a role on Kiro has its skill's argv rewritten
(`harness_switch.harness_for`): `--adapter kiro`, the pinned `--kiro-version` and the deployment's
`--kiro-key-parameter`; its egress gains the Kiro service and SSM (below). The session row keeps the argv, so a
continuation runs on the harness its agent started on, whatever the switch says by then, and the delivery function
needs neither setting. The skill records are unchanged (`harness: converse`): the switch is the deployment's, not the
skill's.

**How a session runs.** The harness starts kiro-cli as its child, so it runs as the agent user `unit` inside the
harness's own user and network namespace (7.50.03's walls hold for it: its one way out is the agent's proxy, through
`HTTPS_PROXY`, which kiro-cli honours). Before it starts:

- **An isolated home.** `<agent home>/.voc/kiro/home`, wiped at each session's start (the same path in every session
  of the agent: Kiro keys its sessions by the working directory). No developer's, image's or repository's Kiro agents,
  settings, steering or skills load. kiro-cli starts in that home's empty `work/` directory, never the checkout (a
  `.kiro/agents` there would load as the workspace's), with an environment the harness builds (`kiro_env`: its home,
  its temporary and runtime directories in it, the agent's proxy, the key; no AWS variable, nothing inherited).
- **The agent's config, from the compiled bundle.** The role's compiled config (`templates/orchestration/kiro-agents/
  <role>.json`, in every image at `/opt/voc/orchestration/kiro-agents/`; [below](#kiro-agent-configs-75300)) is
  checked (its one tool server is the harness's, it offers no Kiro tool) and written to the home's `.kiro/agents/`
  for this session (`session_agent`): the session's own prompt (the platform rules with this session's fence, then the
  skill the board served), `tools: ["@voc"]`, and `allowedTools` and one `mcp` allow rule naming exactly the tools of
  the session's `ToolBox`.
- **The tools, generically.** The one MCP server is the harness's tool server (`tool_server.py`, `harness.py
  tool-server`, as the CLI adapter's), which serves exactly the session's `ToolBox.specs`: the role's skill's tool
  policy within its role, from the harness's own registry (`tools.role_specs`). A tool a release adds (7.52's
  `read_tenets`, `write_tenets`) reaches Kiro with no edit to the adapter. A read is the checkout's walled `read_file`,
  a write `write_file`, a command the sandbox runner's `run` (as `code`), as on every harness. Kiro's own tools
  (`read`, `write`, `shell`, `grep`, `glob`, web tools, `subagent`) are never offered, so the 7.53 prep's three gaps are
  closed: kiro-cli's V3 engine reads and writes outside its workspace without asking even when a deny rule matches
  (`scripts/ai-review/lib.mjs`), a builtin command would run as the agent rather than as `code`, and the skills name
  the harness's tools. The tool server's environment is the CLI's plus the agent's proxy, with `KIRO_API_KEY` blanked
  (and dropped again by the tool server itself), and Kiro's tool call timeout is an hour and ten minutes (a command may
  run its hour).

**The ACP mapping, as built.**

| Control | ACP | Notes |
| --- | --- | --- |
| The brief | `initialize` (no `fs`, no `terminal` capability), `session/new {cwd: <home>/work, mcpServers: []}`, `session/set_config_option {configId: mode, value: <role>}`, `session/prompt` with the opening | Refused (a crash) unless Kiro answers that the mode is the role: on any other agent its prompt and rules would not apply. |
| Steering: 7.51's `relay_steering` and the run's direction | a `session/prompt` sent mid-turn, its text the session's `<<<STEERING …>>>` blocks below the platform rules | Kiro cancels the running turn (`cancelled`) and goes on with the new prompt, keeping its context (the spike; the fake pins it). Each `steer` event is in the transcript; the message is seen once the prompt is taken, and done once the model saves notes after it (the CLI's rule). |
| Other inbox messages (answers, notices) | none: they wait for the tool server's next result, as data | As the CLI adapter's. |
| A person's Stop, a Shut down, a save-and-stop (`signal.pause`) | `session/cancel`, the turn's `cancelled` waited for (30 s), kiro-cli ended, then the checkpoint, exit 75 | A Stop now is still `StopRuntimeSession`. |
| `signal.save`, `save_checkpoint` | none: the checkpoint, Kiro's session state saved with it | |
| Progress | `session/update` | `agent_message_chunk` and `agent_thought_chunk` coalesced into one event per run of chunks; Kiro's own tool calls and refused calls as `tool_call` / `tool_result` with the ACP `call_id`, `tool_kind` and `status` (the platform's tools are the tool server's to record, with their results); `plan`, `usage_update`; each prompt's stop reason (`prompt_end`). |
| A permission request | `session/request_permission`, answered at once by the harness's policy | Below. |
| A continuation, a Restart from a checkpoint | `initialize`, then `session/load {sessionId}` | Below; falls back to `session/new` with the checkpoint's notes. |
| A child run (a Resume or Restart of an ended run) | `session/load` of the parent's session, copied with its seed | Falls back to the 7.51 seed's history. |
| `fs/*`, `terminal/*`, any other request | JSON-RPC method-not-found | No such capability is advertised. |

A turn that ends without the model's `finish` is nudged once, and a second ends the session unfinished (the task goes
to a person, as the Converse loop's two answers without a tool); a turn Kiro stops at its own token or request limit is
continued, 20 times at most in a session; a `finish` whose turn goes on is cancelled after two minutes.

**The permission policy, fail closed** (`permission_answer`). `allow_once` only for a `@voc/<tool>` the session's
ToolBox offers (which the tool server enforces again); `reject_once` for everything else: a Kiro tool, another
server's, a tool the role may not have, a call it cannot read. Never `allow_always`; `cancelled` when the option it
would answer is missing. Each decision is a `permission` event in the transcript, a refusal also on the session's
status. With the configs above Kiro asks for nothing the session may use: the allowed tools run without asking, and a
request is the trace of a call the platform does not allow.

**Where Kiro keeps a session, and resume.** kiro-cli keeps its ACP sessions in its home,
`$HOME/.kiro/sessions/<workspace hash>/<session id>/` (`session.json`, `messages.jsonl`: the conversation as Kiro holds
it), checked with kiro-cli 3.4.0 (a new process in a fresh home holding only that folder and the agent's config
`session/load`ed the session and replayed its history). Each checkpoint saves that folder under the agent's own keys,
`ws/default/runs/<run>/<agent>/commits/<sha>/_kiro/attempt-<n>/<seq>-<nonce>.tgz` (create-only; plain files only, a
JSON Lines file cut at its last newline since kiro-cli may be writing it, at most 32 MB packed), and its position
names it: `kiro: {session_id, state}`. A continuation (after a pause, a crash or a Restart from a checkpoint) unpacks it
into the new home (plain relative names only, no link, bounded) and sends `session/load`; its replay is counted, not
recorded again (the earlier session's transcript has it), and its first prompt says it continues. A state that is not
under the agent's own keys, cannot be read, is off its shape, or that kiro-cli refuses to load, opens a fresh session
instead, from the checkpoint's notes, as before 7.53. A child run's `seed_restart` copies the parent's newest saved
state beside the seed (`_seed/<task>/kiro.tgz`, `voc-resume-seed/1`'s `kiro` entry; the runtime's role gains
`RestartReadsKiroSessions`, `s3:GetObject` on `ws/default/runs/*/*/commits/*/_kiro/*`), and the child's agent loads it,
else takes the 7.51 seed's history.

**The key.** `KIRO_API_KEY` lives in one SSM SecureString under the deployment's path,
`/[<prefix>-]voc/engineering/_kiro/api-key`, which an operator stores ([deployment.md](deployment.md),
`engineeringHarness`: `aws ssm put-parameter --type SecureString …`); no stack and no function writes it. Only the
agent roles that run on Kiro may read it (`KiroApiKey`: `ssm:GetParameter` on exactly that parameter;
`KiroApiKeyDecrypt`: `kms:Decrypt` of the stack's key only through SSM and only for that parameter,
`kms:EncryptionContext:PARAMETER_ARN`). The harness reads it just in time with the agent's own role session and
hands it to kiro-cli's environment only: never an argument, a file, a log line, the transcript, the status or the tool
server. (As the connections' credentials and the GitHub Apps' keys under the same path, the broker's role, which reads
`/[<prefix>-]voc/engineering/*`, could read it too; it never does.) Readiness reads its type, never its value.

**Egress.** An agent on Kiro reaches, on its own proxy only (`egress.kiro_hosts`; an extra host of that shape is
refused, so the dependency step never gets them): `runtime.us-east-1.kiro.dev` (the model runtime),
`management.us-east-1.kiro.dev` (its model registry: a prompt fails `ModelRegistryUnavailableError` without it), and
`ssm.<region>.amazonaws.com` (the key). Measured with kiro-cli 3.4.0 and a key of Kiro's us-east-1 profile behind a
proxy that refused every other host: `app.kiro.dev`, `desktop-release.q.us-east-1.amazonaws.com`, the other regions'
and partitions' management hosts and telemetry were refused, and the session worked. A key of another Kiro region
needs that region's two hosts (a code change). The sessions' NAT, and any egress firewall in front of it, must admit
them.

**The image.** Every image installs kiro-cli 3.4.0 (`engineering-images/common/install-kiro.sh`: the musl build for
arm64 from `https://prod.download.cli.kiro.dev/stable/3.4.0/`, checked against the sha256 Kiro publishes in its release
index; one binary, root's, at `/usr/local/bin/kiro-cli`; its version in `/opt/voc/kiro/VERSION`), so a switch needs no
other image. The runner reports it (`walls`' `kiro_cli`), the runtime records it with the language's walls
(`WS#default#SANDBOX`), and the harness refuses a kiro-cli that is not the pinned version.

**Bounds and failing closed.** Frames over 4 MB, frames that are not JSON objects and answers to no pending request
are dropped (`acp.py`); the client sends only `initialize`, `session/new`, `session/load`, `session/set_config_option`,
`session/prompt` and the notification `session/cancel`. Deadlines: `initialize` and `session/new` 2 minutes,
`session/load` 5, the mode 1, a cancel 30 seconds; a turn with no frame for an hour and a quarter, kiro-cli ending
before its finish, a refused prompt, a mode that is not the role, a key that cannot be read, a missing or unpinned
kiro-cli, or a role with no compiled config is a crash, the work saved first, which the supervisor continues as any.
kiro-cli and its whole process group (its tool server too) are ended on every way out.

**Readiness (`kiro`).** Advice, as `sandbox`: not needed unless a role of the flow runs on Kiro; then it fails while
the key is not stored as a SecureString, and while the language's last session had no kiro-cli or another version, and
is unknown until a session of the image has started (Enable is not refused: a first session is what records the image).

**What it does not do yet, and what it costs.** A session's tokens are not counted (Kiro bills its own credits; a
`usage_update`, when Kiro sends one, is recorded). The code and issue text an agent reads go to the Kiro service.
kiro-cli runs as the agent user, so it could read what the harness can (as the CLI adapter's `claude`): it is offered
no tool that reads, at a pinned and checked version. **Still needs a live run**: a session on AgentCore Runtime
starting kiro-cli behind the namespaces, its proxy and the NAT; the key read through SSM with the agent's session;
`session/load` across two microVMs; the tool server's calls through kiro-cli for an hour-long command; Kiro's behaviour
on a long run (its own compaction). Until then keep `-c engineeringHarness=native` outside a test account.

### Kiro agent configs (7.53.00)

`npm run orchestration:compile` writes one Kiro CLI agent config per launchable role to
`voc-datalake/templates/orchestration/kiro-agents/<role>.json` (twelve; the coach is never launched). The files are
committed, `orchestration:validate` holds them to a fresh compile, as it does both bundles
(`lambda/engineering/orchestration/compile.py`, [the templates' README](../voc-datalake/templates/orchestration/README.md#kiro-agent-configs-75300)),
and every image ships them: the Kiro harness writes each session's agent from its role's ([above](#the-kiro-harness-75300)).
They are in Kiro's v3 universal format (one engine reads `tools` and `allowedTools`, the other `permissions.rules`;
each file has both).

- **What a config holds.** `name` is the role and `description` its card's purpose. `prompt` is the platform rules
  and then the role's skill, as the harness builds its system prompt, without the session's fence line (a nonce each
  session draws).
- **Its tools are its card's, all of them the platform's.** `tools` is `["@voc"]`, the harness's tool server, started
  as the CLI adapter starts it (`/usr/bin/python3 -I /opt/voc/harness.py tool-server`, `cli.py` `TOOL_SERVER`). No
  config offers a Kiro builtin, `subagent`, a web tool or `@builtin` (7.53.00; the prep mapped `read_file` to Kiro's
  `read` and `run` to its `shell`, which the harness never offers).
- **What runs without asking.** Each tool on the card: `allowedTools` `@voc/<tool>`, and one `mcp` allow rule on
  `voc/<tool>`, sorted, as `kiro-cli agent upgrade` derives it. No `fs_read`, `fs_write`, `shell` or `skill` rule:
  anything else asks the harness, which refuses it. kiro-cli 3.4.0's `agent upgrade` would add an `fs_read` allow on
  `./**` (its default); the files are kept without it, and `kiro-cli acp` loads them as they are.

**The validator.** It refuses a config that does not parse, that offers anything but `@voc`, allows without asking
anything beyond its card's tools (an `allowedTools` entry, or an allow rule other than `mcp` on them), or a tool server
other than the harness's, or whose prompt does not start with the platform rules. When kiro-cli is on `PATH` and the
developer's Kiro API key is in `~/.config/voc-kiro/api-key`, it also runs `kiro-cli agent validate --path <file>` on
each config. kiro-cli runs in a temporary home of its own, with the key as `KIRO_API_KEY`, and the key is never
printed. Without kiro-cli or the key the validator says it skipped that check: kiro-cli is never required.

### The scheduled cross-run Learn pass (7.53.00)

Learn's step (above) sees one run. The cross-run pass sees a flow's recent runs together, once a week, for what keeps
failing and whether the flow converges, and proposes; **it applies nothing**: everything it proposes waits for a
person (`learning/cross_run.py`, `cross_run_input.py`, `cross_run_answer.py`).

- **When.** One EventBridge Scheduler schedule, `voc-eng-cross-run-learn` (Mondays 06:00 UTC, no retry,
  `lib/stacks/engineering-cross-run.ts`), **created DISABLED**; `-c engineeringCrossRunLearn=weekly` enables it
  ([deployment.md](deployment.md)). It invokes voc-engineering-runtime with `{"action": "learn_cross_run"}` through
  a role of its own (assumed by EventBridge Scheduler for that schedule only; it may invoke the runtime and nothing
  else). That invocation lists the transcripts' index's flows (at most 100; `no-flow` left out) and hands each on as
  an invocation of its own, `{"action": "learn_cross_run", "flow"}`, as the retrospective hands on its failures, so
  each flow's model call gets the function's whole time.
- **Once a week.** A flow with no run in the last 28 days, or whose newest run's flow copy says `learn.enabled:
  false`, is skipped with nothing written. Otherwise the pass first claims the ISO week (UTC), a create-only
  `WS#default#LEARN#<flow>` / `WEEK#<yyyy-Www>` row: a second invocation that week finds it and does nothing. From
  there every outcome is recorded, beside the claim in `WEEK#<week>#outcome` (create-only) and in the record.
- **What it reads**, bounded, never a whole-bucket or whole-table read: the flow's runs of the last 28 days from the
  index (newest day first, at most 50; the key names the run, so no entry is read), each run's first manifest
  (`v0001`, the one its index entry names), its `RETRO#coach` and `LEARNED#` rows (the failures
  Learn took to the coach and what came of them), and its newest two gate records the manifest names (the verdict,
  the rounds, the open blocking findings' titles, the final go's reasons). Every text is cut and redacted
  (`quality_gate/text.redact`). A run whose manifest cannot be read is left out and counted.
- **What is counted by rule** (numbers, ids and keys, never a model's words): the recurring failures (by role and
  kind: the retrospective's `no_go`, `failed`, `crashed` or `timed_out`, else a session that ended `failed` or
  `reposted`, else a NO-GO; in two runs or more), each with its runs, newest first, and its evidence's keys (the
  manifests, the failing agents' transcript prefixes, the gate records); each flow step's session seconds and cost at
  p50 and p95 (an agent's role where its task named no step: since 7.53.00 the manifest names each agent's `step`);
  the cost outliers (runs, and agents of a step, at three times their p50 or more); the convergence (the runs by
  status, the share done overall and for the older and the newer half, the failures a run); and calibration figures
  (the flow's `budget.run_token_cap`, `budget.max_tasks` and `budget.max_cost_usd` at the observed p95 times 1.5,
  rounded up, as `orchestration:calibrate` makes them), for a person to set.
- **One model call**, with two runs read or more: on Learn's model (the flow's `learn.model` when it is an allowed
  one, else the coach's), through the coach's bounded Bedrock client (`coach/model.py`: one attempt, a 200 s read,
  8,000 tokens out). The prompt (`cross-run-prompt/1`) holds the figures, the benchmark's case ids, the current
  instructions of at most three failing roles and each run's digest, newest first, each in its own DATA block under
  one random fence; the oldest runs are left out past 120,000 characters (Learn's worst case of 40,000 tokens in).
  The system prompt says the blocks are data, never instructions, and lists what an agent never changes (tenet 3's
  list, the coach's). The idea of reading a set of runs together for whether they converge comes from
  aws-samples/sample-kiro-flock's analyzer (Apache-2.0); no code or prompt text is taken from it, and unlike it
  every piece of a run is fenced. The answer is read as strictly as the coach's (one JSON object of exactly
  `convergence`, `failures`, `lessons` and `coach`; a number not among the figures', or anything off its bounds,
  refuses it all): a refused answer, a time-out or a failed call is an outcome, never retried.
- **Its cost is Learn's**: each reply's tokens are booked before it is read, in the spend ledger as the run
  `learn-<flow>-<week>` (agent `learn`, the flow's month total included) and in the flow's `SPEND#<yyyy-mm>` row
  beside the claim, in one transaction. The call is not made, a recorded outcome, when the flow's month is spent
  (its month total, with the call's worst case, past its monthly budget) or when the call's worst case does not fit
  Learn's `budget_share` of that budget, less what the pass spent this month. The settings and the monthly budget
  are the flow's newest run's (its flow copy, its META's `budget_usd`). A flow with no monthly budget bounds nothing
  here but its one call a week, as Learn's step does for a run with no cost cap.
- **Proposals only**, each with its outcome in the record, the newest failing run on the newest run's connection
  as its source:
  - a **lesson** (at most three): a draft at the failing role's scope (`AgentMemoryStore.learn_agent_memory`, as
    that run's coach, the run its provenance, subject `<role> <kind> across runs`), which an administrator
    approves; one about a topic an agent never changes is dropped first, and memory's hygiene runs as for every
    learned memory;
  - a **skill addition** (at most two): one to five instruction lines added to the role's current skill, read
    through the coach's own checks (`coach/answer.py` `read_answer`: the topics, the bounds, the expected case) and
    proposed as that run's coach (`SkillStore.propose_version`, its why `repeated_finding`, its `expected_case`, made
    with `cross-run-prompt/1`), once per run and role (the coach's `RUN#` guard). It is used only once an
    administrator records a benchmark run on it that gains on its expected case and accepts it
    ([the administrators' actions](#the-administrators-actions));
  - the **calibration figures** are the record's: nothing changes a flow.
- **The record**, `voc-cross-run/1`, create-only at `ws/default/learn/<flow>/<week>/v1.json`: the window, the runs
  read, the figures, `analysis` (the outcome, the model, the convergence paragraph, a note per recurring failure)
  and `proposals`, labelled as model text (`model_text` names the model's parts). `GET
  /agents/engineering/learn?flow=&week=` (an administrator acting for themselves; 403 for anyone else, a delegated
  credential included; 404 while the module is off or for a week with no record; `shared/agents_engineering_learn_routes.py`)
  answers it with the flow's recorded weeks (one listing, newest first; `week` left out is the newest), its
  `label` and `model_text`. No web view yet.
- **IAM** (pinned in `engineering-cross-run.test.ts` and `api-engineering-reads.test.ts`): on the runtime's role
  `CrossRunListsIndex` (`s3:ListBucket` held to `ws/default/transcripts-index/*`), `CrossRunReadsManifests`
  (`s3:GetObject` on `ws/default/runs/*/_manifest/*`), `CrossRunRecords` (`s3:PutObject` on `ws/default/learn/*`,
  create-only by the bucket's rule) and `CrossRunRows` (GetItem, PutItem and UpdateItem with `dynamodb:LeadingKeys`
  `WS#*#LEARN#*`; never a delete); its model, the ledger's ADDs and the flow's month total, the skills' and the
  roles' lessons' rows, the runs' rows, the gate records and the invoke of itself it holds already. On the Agents
  API's role, `ws/default/learn/*` is added to its run reads' `s3:GetObject` and to its listing's prefixes. No agent
  role gains anything. The grants are there whether or not the schedule is enabled.
- **Not built**: a hand trigger (`POST /agents/engineering/learn/<flow>/run`, at most once a day): a run a day by
  hand does not fit the once-a-week claim and the week's one create-only record, so it needs a claim and record
  versions of its own first; a flow's own opt-out beyond `learn.enabled`; and the web app's view.

## Reports

*Partly built*: the builder (`voc-datalake/lambda/engineering/reports/`, the `voc-engineering-reports` Lambda,
deployed only with `-c engineeringAgents=true`), the administrators' reads through REST
([above](#how-the-agents-work-together); no MCP tool while the reads are admin-only) and the run monitor's Reports
panel in the web app (each report's versions as Markdown, [docs/autonomous-agents.md](autonomous-agents.md)). A report (voc-report/1) is built from what the run recorded: its `META`,
each agent's metering (`AGENT#`: skill version, model, session-seconds, tokens, metered cost), the conversation's
count, the board's tasks and their history, and only the workspace objects their result keys name (never a listing).
Since 6.28.00 a run that follows a flow has its flow in every report (`flow`, and a **Flow** table in the Markdown):
the revision its start copied, where the flow stands (under way, waiting at a person at a step, finished at an end)
and every step's status and why, the steps not run yet named as such
([The flow a run follows](#the-flow-a-run-follows)). The PR report takes the quality gate's record only from an ended final-go task under the PR's head commit, checked
against the gate's own shapes before its Markdown goes into the description. Every version is new (an atomic
counter, create-only objects, D1). Not built yet: its callers (the run coordinator's closing task, the supervisor,
the write broker before it opens a PR: nothing invokes it, and no role holds an invoke on it), and
"what the agents learned" and "what improved since the last run". The design:

- **Commit report**: what the commit changes and why (its task), the gate packs' results, each review round's
  findings and what was done about each, the final verdict, cost and time.
- **PR report**: the commits' reports rolled up, the PR review, the test evidence, the risks and what a person should
  look at, the gate record (it goes in the PR description). Built: a PR report whose winning gate record (the last
  final-go task to end, then its latest attempt) cannot be read or is off the schema is refused, never published
  without it or with an older one in its place.
- **Goal report**: the run's objective ("find and fix the top bugs in the payments package", "build feature X from
  its PRD"), the board's outcome (done, failed, needing a person), the pull requests opened and their state, what is
  left, total cost and time, what the agents learned (proposed knowledge-pack edits, for a person to accept) and what
  improved since the last run.

## Getting better: skills, the coach, the learning loop, memory

*Partly built*: the skills' record, diff and versioned store (`voc-datalake/lambda/engineering/skills/`) with the
benchmark gate on a coach's version ([Evaluation](#evaluation)), the coach that proposes a version from a failure
(`voc-datalake/lambda/engineering/coach/`), the agents' memory store with its recall for a task
(`voc-datalake/lambda/engineering/agent_memory/`), and the learning loop with its scorecards
(`voc-datalake/lambda/engineering/learning/`), which a run's end starts: it takes the run's failures to the coach,
drafts lessons in memory and writes a scorecard row per skill version, and since 7.07.00 the administrators' read
side of the skills and the scorecards (the routes and Agents → Skills, [below](#the-administrators-reads)), and
since 7.08.00 the administrators' actions on a version: accept, reject, roll back and record a benchmark
([below](#the-administrators-actions)), and since 7.10.00 people's reactions on the host to a run's pull request as
the loop's input ([below](#peoples-reactions-on-the-host)). Still to come: the harness reading the skills store and the
recall, proposing, promoting and seeding from a route, publishing the announcements, and the people's routes and
screens (phases 4 and 5).

**Skills, visibly and reversibly.** An agent's skill (instructions, examples, tool policy, model, harness) is
versioned. Each version keeps its diff, why it changed (the run, the failure, the person's comment), the benchmark
before and after, and who accepted it; a run records the versions it used, every report names them, and one click
rolls an agent back to an earlier version (a new version that restores it, so the history stays whole, D1). No
version change goes unannounced: it is an event in the run and in the agent's history ("Fixer rewrote its skill: v7 →
v8, two more examples, a stricter test rule").

What exists: the `voc-skill/1` record (`skills/model.py`: the role, a model from the deployment's allowlist, the
`converse` or `cli` harness, the tool policy as tool names, bounded instructions of at most 500 lines and bounded
examples; a record naming a
budget, a cap, the dial, permissions or safety instructions is refused, since none of them is ever in a skill; its
schema name, harness names and stored shape are the harness's own, `runtime/harness/skills.py`, which ships alone in
the agents' images, so the store writes exactly what the harness reads), the
diff of two versions and its one-line summary, made by rule from the diff and never by a model (`skills/diff.py`),
and the store (`skills/store.py`), in the `voc-engineering` table: rows `WS#<ws>#SKILL#<connection>#<role>` (the
connection empty for the shared skill) with a `HEAD` row (the version counter and the current version), one
`VER#<version>` row per version (its record, its base, its diff and summary, why, the benchmark pass rates the
proposer gave, which are only their claim (once a benchmark is recorded on the version, its rates are the ones
readers trust: `SkillVersion.trusted_rates`), who proposed it, its status; at most 256 KB, checked before it is written) and a create-only `LOG#` row
per acceptance, rejection and rollback, and for a promoted version's source. A proposal is used
only once an administrator accepts it, in one transaction that also checks its base is still the current version
(the scope's, or the shared skill's for a connection with none of its own), so a proposal written on a version that
moved meanwhile is refused; the coach (any agent) writes only the version of the connection its run is for (the
connection its identity carries), from that run's failure, once per run and failure kind (a conditional `RUN#` row
in the same transaction), naming the benchmark case it expects to gain on (`expected_case`), and never one that
changes the tool policy, the model or the harness. A connection reads
its own current version, else the shared skill's, and the history is read a page at a time. An administrator
promotes a connection's lesson by writing a new shared version: the store refuses one that adds an instruction line
or example text of 20 characters or more (case and spacing aside) which the connection's version also adds to the
shared skill, and the administrator carries the rest of keeping the connection's text out. The source connection is
kept only in that version's `promoted_from` log row, which only an administrator reads; the shared version every
connection reads does not name it. A rollback is an administrator's new version that restores an earlier accepted
one of the same scope. Each proposal, acceptance and rollback returns its announcement
(`skill.proposed`, `skill.accepted`, `skill.rolled_back`, the bus's types today) for the caller to publish.
**The benchmark gate on acceptance**: an administrator records a proposed version's benchmark (`record_benchmark`:
the pass rates before and after, the cases, the verdict and its reasons, the failure's case, with who ran it and
when) on its `VER#` row, once: written only where the row has none, with `benchmark_gate` (passed with a gain on a
named failure's case) beside it, in one transaction with a create-only `LOG#<version>#benchmarked` row, and refused
when it would take the row over its 256 KB; neither an agent nor any other person records one. A version an agent
(the coach) proposed is accepted only once its recorded benchmark passed with a gain on a named failure's case,
checked before the acceptance and, through `benchmark_gate`, as its transaction's condition. The record is
create-only (D1), so a failed or mis-recorded benchmark makes that version final: it is never accepted, and the
coach cannot propose again for the same run and failure kind; a new proposal comes from a new failure (another
run), or an administrator writes the fix as their own version, which needs no benchmark. The failure's case is the
one the administrator who records the benchmark names, and for a version the coach proposed it must be the case the
proposal named (the `VER#` row's `expected_case`, written with the row and never changed; the coach's proposal is
refused without one): a benchmark naming another case, or none, is refused (400), before the write and again as
its condition. A coach's version written before rows named a case takes only a benchmark naming none, so it is never
accepted. A version a person wrote is recorded and accepted as before, measured or not, whatever case it names.
Recording a benchmark announces nothing (the acceptance does).
**The shipped records seed the shared skill** (6.29.00, `SkillStore.seed_shared`): an administrator starts a role's
shared skill from the record its agents run (`runtime/harness/skills.py`), as the shared skill's first version,
proposed on no base and accepted, its why naming the shipped label; only while the shared skill has no version, so
a seed never writes over a history, and a seed racing another is refused by the acceptance's own condition. The
store numbers it (`<role>@1`, whatever the shipped number: the coordinator ships as version 2). The coach proposes
only on a version the store holds, so this is how a role's first version, a person's, comes from what ships.
Not yet: the harness reading the store (its agents still run the shipped record), the route that calls the seed, a
run recording the versions it used, the routes that propose and promote (accepting, rejecting, rolling back and
recording a benchmark have routes since 7.08.00, [below](#the-administrators-actions)), the step that runs the
benchmark for a proposal.

<a id="the-administrators-reads"></a>**The administrators' reads** (7.07.00, `voc-datalake/lambda/engineering/skills/views.py`,
the Agents API's routes, the web app's Agents → Skills): read only, for an administrator acting for themselves (403
for anyone else, a delegated MCP credential included; no MCP tool), 404 while the module is off, every input checked
(400) and every read bounded: a GetItem, or one Query of one partition with a page cap, never a whole-table read.

- `GET /agents/engineering/skills?connection=<id>` (empty or left out: the shared skills) → `{connection, roles}`:
  each role with a version in the scope, in the catalog's order, with its current version, the version numbers its
  counter has handed out (`versions`; a proposal refused after its number was taken leaves a gap) and its newest
  version's status and summary line. A `HEAD` GetItem per role (13) and, for a role that has one, one Query of its
  newest version.
- `GET /agents/engineering/skills/<role>/versions?connection=&page=<token>` → `{connection, role, current_version,
  versions, next_page}`: the history 20 versions a page, newest first (`SkillStore.lines`, one Query reading each row
  without its record and its diff). Each version: its number, status, summary, why (`{run_id, failure, comment}`), who
  proposed it (`proposed_by`, `proposed_by_kind`: `agent` for the coach) and when, who accepted or rejected it and
  when, the version a rollback restores, its base (`{shared, version}`: the scope's own or the shared skill's, never
  another connection's), `expected_case`, its benchmark (`{claimed, measured}`: the rates the proposer gave, a claim
  only, apart from an administrator's record of a benchmark run, its rates, cases and verdict as they entered them
  (with their optional `run_ref`), the rates acceptance goes by; the model's
  `SkillVersion.trusted_rates` property picks the same, and is not a field of the answer) and its events from the
  `LOG#` rows (accepted, rejected with its comment, rolled back, benchmarked: who and when; `SkillStore.events`, one
  Query per range of at most 100 version numbers, so a page whose versions sit far apart is read in a few ranges,
  at most one a version). `next_page` is an opaque token the server makes and checks: it names the scope it was
  made for and an unkeyed checksum (it catches a corrupted token, not a forged one), the scope is checked again, and
  only its version number is used, formatted into this scope's key, so a token from another scope, or changed, is
  refused (400) and a forged one reads nothing more.
- `GET /agents/engineering/skills/<role>/versions/<n>?connection=` → `{connection, role, version}`: one version (1
  to 999999; 404 when the scope has none), its line as above, its whole record (instructions, examples, tool policy,
  model, harness), how the coach made it (`made_with`) and its diff from its base (`skills/diff.py`'s stored diff:
  instruction lines and examples added and removed, the tools added and dropped, the model and harness moves).
- `GET /agents/engineering/scorecards/<role>?connection=<id>&versions=<n,n,…>` → `{connection, role, versions,
  cards, source, scope_known}`: `version_card` per version (`compare`: at most 10, each once), on the connection's
  own scorecards (400 without a connection: a scorecard row is a connection's). **The sessions cannot tell a
  version's scope**: a session names its skill `<role>@<n>`, with no scope, so a shared store version and a shipped
  one of the same number would read the same; the harness runs only the shipped skills today, so every scorecard
  number is a shipped skill's, and each card says so (`source: shipped`; the answer's `scope_known: false`, and the
  screen says it in words). A scorecard number is never one of the history's. By default the role's shipped version
  and the shipped ones before it (at most 5; none for a role that ships no skill), never mixed with the store's
  numbers. Once the harness reads the store, its labels must carry the scope for a card to name another source.
  A number asked for that the role never shipped (above its shipped version, or a role that ships none) is labelled
  `not_shipped` (7.08.00), never shipped. Each card: its source, the runs read, the
  pass rate, tasks done, failed and needing a person, re-posts, review rounds, attempts, cost, session seconds,
  whether older runs were left out (`more`) and the time they span.

**A promoted version's source is never answered**: the reads leave `promoted_from` out entirely. The events' Query
filters on the readable events (`READABLE_EVENTS`), so DynamoDB drops the `LOG#<n>#promoted_from` row before it
answers, and the store drops any event not among them again in code before it answers; only `SkillStore.promotion_source` reads it,
and no route calls it yet. **The grant** of the reads: none new (the actions' write grant is below). The Agents API's role already has `dynamodb:GetItem` and
`dynamodb:Query` on the whole `voc-engineering` table for the run views (with the stack's key through DynamoDB,
`AgentsTablesKey`), which covers the skills' (`WS#*#SKILL#*`) and the scorecards' (`WS#*#SCORE#*`) partitions; a
narrower `dynamodb:LeadingKeys` statement beside it would add nothing, so none is added (pinned in
`lib/stacks/api-engineering-reads.test.ts`); narrowing the one table read to the partitions the API reads is a
follow-up. Nothing appears while the module is off. **The screens** (Agents → Skills, administrators, only while the
module is on): a scope picker (the shared skills, or a stored connection), the scope's roles in a table, a role's
history a page at a time (each version's status badge, summary, why, who and when, the benchmark marked measured or
claimed, its events), a version's detail with its diff as plain lines added and removed (the record's text is shown
as text, never read as HTML) and its whole record, and a role's scorecards on a connection in a table (up to 10
versions named by number). The role and the version are the path (`/agents/skills/<role>/v/<n>`, 7.49.00) and the
scope a filter of the query (`?connection=`), so Back walks from a version to the history to the roles. The actions on a version are [below](#the-administrators-actions) (7.08.00). A role whose template in the repository is newer than its current version says **Template updated (vN)**, with the template's diff and an Adopt that proposes it as a person's version (7.50.00, [autonomous-agents.md](autonomous-agents.md#template-updated)).

<a id="the-administrators-actions"></a>**The administrators' actions** (7.08.00,
`voc-datalake/lambda/engineering/skills/actions.py`, the Agents API's routes, the version's detail in Agents → Skills):
for an administrator acting for themselves (403 for anyone else, a delegated MCP credential included), 404 while the
module is off. Each is the skills store's own function and transaction (its checks are never re-implemented): the
route checks the body (400), then what the screen showed against what is stored (409, "it changed since you opened
it"), takes an optional `reason` (at most 2,000 characters, its credential-shaped strings redacted, kept on the
action's `LOG#` row), and answers `{connection, role, version, event, announcement}`: the version as it is now, the
action's log event and the announcement. The connection is the query's `?connection=` (empty: the shared skill), and
every key is that scope's, so an administrator acts on one scope's partition at a time.

- `POST /agents/engineering/skills/<role>/versions/<n>/accept` `{expected_status, expected_current, reason?}`:
  `SkillStore.accept_version` (its base still current, checked before and in its transaction; a coach's version only
  once an administrator's record of a benchmark run on it says it passed and the pass rate rose, naming its
  `expected_case`, else 409 saying what
  is missing). `expected_status` is `proposed` (anything else is 400).
- `…/reject` `{expected_status, reason?}`: `reject_version`; the version stays, marked rejected.
- `POST /agents/engineering/skills/<role>/versions` `{base_version, instructions, examples, summary, reason?}` → 201
  (7.52.00's integration, `SkillActions.propose`): **a person's own version**, PROPOSED on the version the scope runs
  (`base_version`, its number as the screen showed it, 0 for none: another one is 409 "it changed since you opened
  it"), with that version's tools, model and harness (a person writes the text here: the instructions and the
  examples, `[{situation, action}]`, held to the skill's own limits), its provenance `person`, never applied: it is
  accepted or rejected as any other proposal. `summary` is one line of at most 200 characters, what the version
  changes; it and the reason are the version's why (`reason_comment`). Its record is the version row itself (who
  proposed it and when, its base, its provenance and why), as for an adopted template. 400 for a body off its shape
  or a version that changes nothing.
- `…/rollback` `{expected_current, reason?}`: `roll_back_to` version `<n>`, an earlier accepted version of the same
  scope (else 409), as a new version current at once; answered as that new version.
- `…/benchmark` `{expected_status, before, after, cases, passed, reasons, failure_case, run_ref?, reason?}`:
  `record_benchmark`, once (a second is 409): **an administrator's record of a benchmark run (its rates, cases and
  verdict as they enter them)**, linked to no measurement here; `run_ref`, optional, is their reference to the run (an
  id or a link, at most 300 characters), and it and each of the reasons are redacted as a reason is. The failure's
  case rules above hold (a coach's version takes only its `expected_case`, else 400). The model's own rules
  (`BenchmarkRun`): a new record whose verdict is passed but whose pass rate fell (`after` below `before`) is refused
  where it is written (400; `check_recordable`, called by `record_benchmark`, so every writer inherits it), while a
  row written before reads as recorded; and what a coach's acceptance needs (`gained`) is a passed verdict in which
  the pass rate rose (`after` above `before`), naming its expected case: equal rates, or a fallen rate in an old row,
  never let a version be accepted.

A 409 that starts "it changed since you opened it" means what the screen showed moved, whether the action's own
read saw it or its transaction's condition did (another administrator's change landing between the two): the screen
reads it again. Any other 409 is the store's own refusal, said in its words. A rollback hands the current version the person saw to
`roll_back_to` (`expected_current`), which compares it with the one it reads and holds that one as its transaction's
condition, so a version accepted meanwhile is never replaced silently.

**The announcements** (`skill.accepted`, `skill.rolled_back`; a rejection and a benchmark announce nothing, as the
store has it): since 7.51.02 the Agents API's role is one of the engineering bus's publishers, but for a person's
steering and answers alone (`msg.steer`, `msg.answer`: its grant's detail types and the router's `API_TYPES`), so these
are not published: the store keeps each announcement (its id, type and line) on the action's create-only `LOG#` row,
the answer returns it with `published: false`, and publishing it from the API's own source (`voc.engineering/api`)
would widen both that grant and `bus/senders.py`, which refuses these types from it. **The grant**: one statement on the Agents API's role
(`SkillDecisions`): `dynamodb:PutItem`, `dynamodb:UpdateItem` and `dynamodb:ConditionCheckItem` on `voc-engineering`
with `dynamodb:LeadingKeys` `WS#*#SKILL#*` and, since 7.52.00, the Registry's cards `WS#*#AGENTCARD#*`
([autonomous-agents.md](autonomous-agents.md#registry)) (`ForAllValues:StringLike`, beside `Null` `false` so a
request naming no key never matches it vacuously), exactly what the stores' writes use (a
transaction is authorised by its items' actions); no delete; the key through DynamoDB is `AgentsTablesKey`'s;
nothing while the module is off (pinned in `lib/stacks/api-engineering-reads.test.ts`). **The screens**: on a
version's detail, Accept and Reject (a proposed version), Record benchmark (a proposed version with none) and Roll
back to this version (an earlier accepted one, while the scope has a current version), each behind an approval card
that says what changes (from which version to which, naming the shared skill's version a connection with none of its
own runs, the change's summary, its base, flagged when it is not the version in use, and for a coach's version the
record of its benchmark run), with an optional reason. Accept stays off (focusable, its reason read out) for a
coach's version without an administrator's record of a benchmark run in which the pass rate rose, naming its expected
case. The
benchmark form, which says it records what the administrator enters, takes the pass rates in percent, the cases, the
verdict, its reasons, the failure's case, prefilled with a coach's `expected_case`, and an optional reference to the
run. A 409 reads the screen again
and says it changed since it was opened. Still planned: proposing, promoting and seeding from a route, and publishing
the announcements.

**The coach.** When an agent fails (an error, a timeout, a NO-GO, a review finding it keeps repeating, a person
rejecting its pull request or editing it heavily), the coach reads the conversation, the task, the outputs and the
people's comments and proposes a new version of that agent's skill. A proposed version is used only after it passes
the agent's benchmark with no regression and a gain on the failure's case, which is added to the benchmark as a new
fixture. A fixture and a skill version made from one connection's failure stay inside that connection: they are
read only as the connection is, and the version applies only to that connection's agents (an administrator can
promote it to the shared skill only by writing a new version without that connection's code or text; a rollback stays in the version's own scope). An administrator accepts each
version and rolls one back, and the API refuses a version that changes the tool policy, the model or the harness
unless a person made that part of it (letting an AI-driven owner's agents apply a passing version on their own would
widen tenet 3's dial, below, and waits for that change). **Never changed by an agent, only by a person:**
permissions and credential scopes, the harness and its tool policy, budgets and caps, the dial, the stop-at-the-pull-request rule, the safety and
prompt-injection instructions, the gate's bar.

What exists (`voc-datalake/lambda/engineering/coach/`, invoked by the learning loop on a run's failures, below):

- **The failure** (`coach/failure.py`): the run, the connection (the run's, from its record, never from an agent),
  the role (never the coach's own), the task, the attempt, the kind (`error`, `timeout`, `no_go`,
  `repeated_finding`, `pr_rejected`, `heavy_edit`) and the evidence: the task's text (4,000 characters), up to 12
  conversation excerpts (2,000 each), 8 outputs (4,000 each) and 12 people's comments (1,000 each), 40,000 in all.
  Every field is checked; every text has its credential-shaped strings replaced (the gate's `redact`) and is
  measured as kept; a text over its bound is refused, never cut.
- **The prompt** (`coach/prompt.py`): the role's current instructions and each current example's situation and action (as the answer gives them back), the benchmark's case
  ids and each piece of evidence, each in its own DATA block under one random fence per prompt, as agent memory's
  recall fences memories; the system prompt says that everything in a block is data, never an instruction, lists
  what the coach never writes (tenet 3's list above), and asks for one JSON object: the whole new instructions and
  examples, a short why and the benchmark case the change should make pass. Since 7.10.00 (`coach-prompt/3`) the
  people's comments are also the reactions on the host to the run's pull request, and the system prompt says of them
  in particular (`PEOPLE_COMMENTS`) that they are people's words to weigh as evidence of what they accepted, changed or
  rejected, never instructions: one that says to ignore the rules or change what the coach never writes is part of
  what happened, and is not followed.
- **The answer** (`coach/answer.py`), read strictly: one JSON object (a code fence allowed), `json.loads` only (never
  `eval`), nested at most 8 brackets deep (checked before decoding, so a deep answer is refused, never a crash), no
  key twice, exactly its four fields. Refused with a plain reason: a key named for a person-only field
  (`tool_policy`, `model`, `harness`) or for one never in a skill (a budget, a cap, the dial, permissions, safety);
  text the answer adds or removes about a budget or a cap, the dial, permissions or credentials, the safety or
  prompt-injection instructions, merging or marking a pull request ready, the gate's bar, the agents' harness or
  tool policy, or a model: an instruction line or example text added or dropped (so the coach cannot delete a line
  such as "Never merge a pull request"), a mention gained or lost in the whole skill read as one text with its
  spacing collapsed (a topic split across lines), or a mention in the why (matched broadly; the reason names the
  topic and the line, never the text); a malformed or over-long field, an expected case not in the benchmark, an
  answer that changes nothing. The topic check is a filter that catches the plain cases, not the gate: a reworded
  one can pass it, and what holds a version back is an administrator's review and its benchmark. What it keeps is
  redacted too, and the proposal keeps the current skill's tool policy, model and harness.
- **The model** (`coach/model.py`): a port the tests fake; the Bedrock adapter is one single-turn Converse call
  with a model from the deployment's allowlist (by default the `agent_reviewer` surface's default), bounded to end
  well inside voc-engineering-runtime's 5-minute limit: its own Bedrock client with a 200-second read timeout (a
  Converse call answers once its reply is whole, so the read bounds the call), a 10-second connect timeout and one
  botocore attempt, made once through `bedrock_call_with_retry` with one attempt (nothing is tried again, a
  throttle or a dropped connection included: a second attempt would not fit the limit), one model (no capacity fallback chain) and no continuation, and an output cap of 8,000
  tokens, thinking included, for a strict JSON answer in one call; a reply cut at the cap is refused. Its reply
  names the model that answered.
- **The proposer** (`coach/proposer.py`, `Coach.propose_for(failure, cases)`): refuses before any model call when the
  coach has proposed for that run and failure kind already (`SkillStore.coach_proposed`, the `RUN#` row; the
  proposal's transaction holds it again), and when the role has no skill yet (its first version is a person's);
  reads the connection's own current version, else the shared one; asks the model; proposes through the store's
  `propose_version` as the coach of the run's connection, the why being the run, the kind and the answer's why,
  written on the version it read, with the answer's case as the version's `expected_case` and how it was made
  (`made_with_model`, the model that answered, which must be an allowed one, and `made_with_prompt`, the prompt's
  version, `coach-prompt/3` since 7.10.00, on the `VER#` row, written with it and never changed: D4); and returns the change,
  its `skill.proposed` announcement as a checked `voc-msg/1` message from the run's coach to the run (its id made
  from the change, so a second publish is a redelivery) and the coach's run-scoped source
  (`voc.engineering/coach/<ws>/<run>`), for the caller to publish. A refused answer writes nothing and spends no
  proposal.

Still planned: a connection's own benchmark cases made from its failures and kept with it, the step that runs the
benchmark for a proposal, and publishing the coach's `skill.proposed` announcement on the bus (the runtime's role
speaks only as the supervisor; the announcement is logged by its id, and the proposal is in the skills store's
history).

**The learning loop.** After each run, a retrospective: what people accepted, changed or rejected (review comments on
the agents' pull requests, edits after merge, reverted commits), what the gates caught, what timed out. Lessons go to
memory and to the coach. A scorecard per agent version (pass rate, human edits needed, review rounds needed, time,
cost) shows how each version does over time.

What exists (`voc-datalake/lambda/engineering/learning/`, behind `-c engineeringAgents=true`):

- **The start** (`runtime/handler.py`): once an ended run has no live or moving agent (at its `end_run`, or at the
  tick that ends its last busy agent, when the run stops being listed), so that its record no longer moves and its
  sessions are priced, the runtime hands a `retrospective` action to an asynchronous invocation of
  voc-engineering-runtime itself; a failure to start it is logged and never fails the end or the tick. It runs
  apart because a coach's call can take minutes: the end stays as fast as before, and each failure the
  retrospective takes to the coach is handed on to an invocation of its own, with the function's whole time limit
  (5 minutes; the coach's call is bounded to end well before it, above, and a call that runs past its read timeout
  or fails is recorded on the failure's `LEARNED#` row as `timed_out` or `failed`, with the rule's lesson kept,
  and never made again). An invocation that fails is logged and answered, never raised, and Lambda never retries an
  asynchronous invocation of voc-engineering-runtime (`retryAttempts: 0`, pinned in its test): even one cut off at
  the limit is not delivered again, and a duplicate delivery finds its step's create-only claim and does nothing.
- **The record** (`learning/records.py`), what the platform records today and nothing else, never a listing: the
  run's `META` (its connection, status and times), the board's tasks and their history (`TASK#`, `TASKLOG#`), the
  agents' session rows (`AGENT#`: role, skill version, session seconds, cost, crashes and the supervisor's last word
  on a failure), and the quality gate's records the final-go tasks named (at most 20, the latest attempts first, each
  checked against `voc-gate-record/1`; one unread or off it is left out and logged; a key naming another run or
  workspace is never read). People's reactions on the host come in through a port, `HostReactions`, which since
  7.10.00 answers the run's latest recorded read of its pull request's reactions (the `REACTIONS#` row,
  `learning/reactions.py` `host_reactions`: the revert, people's commits after the merge, then each kept reaction,
  newest first, authors as labels, the run's pull request's and so every failure's, `task_id` ''), which become the
  people's comments of a failure's evidence; the reads come after the retrospective, so today they rarely reach the
  coach ([below](#peoples-reactions-on-the-host)).
- **The retrospective** (`learning/retrospective.py`, pure): each task's attempts, who held each (its claim, else
  its launch; a person's own attempt is nobody's skill and is left out, and an agent's attempt a person took over
  ends, for the agent, at the take: handed over, no failure and no tally), how each ended (a supervisor's re-post as
  `crashed` is a crash, any other of the supervisor's a time-out; a re-post by anyone else, such as a person's Resume
  replacing a coordinator, a crash when the agent's session failed, else no failure, as a person's release is; the
  task's state for its last attempt) and its review rounds (its `in_review` moves, plus the gate's rounds on the task the gate judged, the
  final-go task's parent). The failures: one per attempt that ended failed, timed out, crashed or got a NO-GO (the
  verdict or the final go's), most severe first (NO-GO, failed, crashed, timed out, then the task's priority); a
  NO-GO of a final-go task with no parent is counted apart. To the coach: the first per role and failure kind (the
  coach's own guard is once per run, role and kind), at most 3, never the coach's own. Each failure's evidence (the
  task, how the attempt ended and its moves, the agent's last failure, the gate's verdict and reasons) is cut to fit
  (2,000 characters a piece) and its credential-shaped strings replaced, then checked again by the coach's `Evidence`.
- **The loop** (`learning/loop.py`): the retrospective of an ended run with a connection (others are left alone)
  writes the scorecards and records the failures it takes to the coach once, in a create-only `RETRO#coach` row of
  the run's partition (a later retrospective of the run reads it back, so the bound of three per run holds whatever
  runs twice). Each of those failures, by its key (`<task>#<attempt>#<how>`, one that row names, else refused), is
  claimed first by a create-only `LEARN#<key>` row (who: the retrospective; when), so a duplicate delivery or a
  second start finds it and writes and asks nothing; then it gets one lesson draft, with no model call, at the failed
  role's scope for the run's connection (`learn_agent_memory`, as the run's coach, always a draft for an
  administrator to approve, its provenance the run and the task: a version's `prov_task`): a line made by rule for
  the way the attempt failed, with no model or task text, so the same lesson from another run confirms it; then the
  coach (`Coach.propose_for`, with the deployment's benchmark case ids, the shipped cases' directories named at
  synth in `ENGINEERING_BENCHMARK_CASES`; a role with no skill yet, the guard spent or a refused answer is an
  outcome, logged; a call past its read timeout or failing is `timed_out` or `failed`), one Converse call per
  failure, ever. The coach's why is not drafted as a memory: the proposed version's reason holds it, and
  model-written drafts must not fill a role's scope (200 live memories) ahead of an administrator's own. A memory
  the store refuses or cannot write is an outcome too. What came of it is a create-only `LEARNED#<key>` row beside
  the claim. So a run drafts at most three lessons, one per failure taken to the coach. The lessons pass memory's
  hygiene but no cited-review check: an engineering run cites no customer reviews (its record holds none; no route
  attaches feedback to a run yet), so `review_texts` is empty.
- **The scorecards** (`learning/scorecard.py`): one create-only row per skill version per run,
  `WS#<ws>#SCORE#<connection>#<role>#<version>` / `RUN#<run>` (`voc-scorecard/1`: tasks done, failed and needing a
  person by the agent of each task's last attempt, re-posts and review rounds by the agent of the attempt, attempts,
  the cost and session seconds of the version's agents, the run's status and times, who wrote it and when: D1, D4);
  never a counter updated in place, and a retried retrospective leaves a written row as it is. The reader,
  `version_card`, sums a version's latest runs (at most 200, newest first) with one bounded Query of its partition,
  never a whole-table read, with its pass rate (done over the tasks it ended), and since 7.10.00 those runs' human
  edits with a second bounded Query of the same partition ([below](#peoples-reactions-on-the-host)); `compare` reads
  up to 10 versions, two Queries each. A connection's scorecards are its own partitions.
- **The grants** (`lib/stacks/engineering-runtime.ts`, `grantLearning`, pinned in its test): on the runtime's role,
  besides the run's partitions it already reads and writes, `s3:GetObject` on the gate records only
  (`ws/*/runs/*/*/commits/*/_gate/attempt-*/record.json`), `GetItem`, `PutItem` and `UpdateItem` on the skills'
  partitions, `GetItem`, `Query`, `PutItem` and `UpdateItem` on the roles' lessons (never a person's memories),
  `PutItem` on the scorecards, Converse (`bedrock:InvokeModel`) on the allowlisted Claude models, and
  `lambda:InvokeFunction` on itself by name; never a delete. IAM bounds the DynamoDB grants by partition only
  (`dynamodb:LeadingKeys`), not by attribute: `dynamodb:Attributes` is not used, since whether it covers the
  attributes a condition expression names (the memory's `status`, the counters' own) and the transactions' writes
  could not be checked against the service here, and a condition that refused the code's own writes would break
  the loop. So the role can put or update any item of a skills partition (its `HEAD` row's `current_version`
  included) and of a role's lessons partition (a memory's status, approved version and statement included); only
  the code keeps it to its own writes: the version counter's `ADD versions`, a proposed version and its `RUN#`
  guard, each create-only, and a lesson's create-only draft rows and its confirmations' `ADD confirmations`. The
  scorecards' `PutItem` carries no condition in IAM either: the role could write over a scorecard row, and only
  the code's `attribute_not_exists` keeps each one create-only.

<a id="peoples-reactions-on-the-host"></a>**People's reactions on the host** (7.10.00, behind
`-c engineeringAgents=true`): what people did with a run's draft pull request (a GitLab merge request) once it ended,
read through the broker, recorded, and fed to the learning loop.

- **The read** (the broker's `reactions` operation, `connectors/broker.py` `Broker.reactions`; the host's part in
  `connectors/reactions.py`, `github_reactions.py`, `gitlab_reactions.py`): for an ended run (`done`, `failed` or
  `stopped`; any other is 409) whose connection's credential still names the repository it started on, of the pull
  request its record keeps (`run_links.py`: its row, else its author's newest done write claim; none: the answer is
  null and the host is asked nothing), on the run's default branch. Reads only, through each host's existing client
  (its token, its one-host transport, GitLab's bounded retry of a lost read, every error the host's status and its
  redacted words only), bounded pages:
  - the state: `open`, `closed` or `merged`, and when it merged;
  - its reviews (approved, changes requested or commented; GitLab's approvals and "requested changes" system notes),
    their review comments and the general comments, each with its author's handle and time, newest first, at most 50
    in all, each body cut to 2,000 characters. GitLab's notes and GitHub's review comments are asked for newest first
    (one page of 100). GitHub answers a pull request's reviews and its issue comments oldest first and cannot sort
    them, so for each the first page and, when the `Link` header names a `last` page, that page too are read (two
    pages of 100 at most): the newest and the oldest are read, and on a pull request with more than 200 of either the
    pages between are not, which `more` says;
  - a revert: a commit on the default branch after the merge, among at most 100, whose message names "Revert" and the
    merge's full commit id (GitLab: the merge commit, else the squash commit);
  - people's commits after the merge (`edits_after_merge.people_commits`): the commits on the default branch within
    14 days of it that touched the pull request's files, leaving out the merge itself, a bot's (GitHub: an author of
    type Bot or a `[bot]` login, the App's own among them; GitLab: an author or committer address of a project or
    group token's user, the connection's own token's, whose commits are the agents', among them) and an agent's (a
    message that names an agent branch, `voc-agent/…`: a later run's pull request merged since), as a count and the
    files (at most 20 listed; the history of at most 20 of its files is read, one request each), never a diff;
  - what was dropped (counts only) and whether a list had more than was read (`more`).
- **The trust filter.** On a public repository anyone can comment, and these texts become evidence a model reads. A
  reaction is kept only when its author has write access and is not a bot.
  - GitHub: `author_association` OWNER, MEMBER or COLLABORATOR is only the first cut (MEMBER is any member of the
    organisation, COLLABORATOR any collaborator, read and triage included). Each such author's permission is then read
    with "Get repository permissions for a user" (`GET /repos/{owner}/{repo}/collaborators/{username}/permission`),
    whose `permission` is `admin`, `write`, `read` or `none` (a maintain role answers `write`, triage `read`) and whose
    `role_name` names the role: kept when `permission` is `admin` or `write`, by that alone (`role_name` is never
    read: a custom role may be named anything). At most 20 authors a read, looked up newest first across reviews and
    comments (so past 20 the oldest authors are the ones dropped),
    each answer cached 10 minutes (at most 256); a lookup that fails (an error, a rate limit, an answer off its shape)
    drops the author and is not cached (fail closed). Bots (`user.type` Bot or a `[bot]` login, the App's own user
    among them) are dropped before any lookup.
  - GitLab: a project member at Developer, access level 30, or above, read through the members API (`members/all`),
    at most 20 authors a read, each level cached 10 minutes (at most 256). Bots are dropped: `bot`, a `user_type`
    other than `human` where the API answers one (a project bot, a service account), a project or group token's
    `project_<id>_bot…` user, and the connection's own token's user (read once from `/user` and cached).
  - Every kept body has its credential-shaped strings replaced (the gate's `redact`, as the coach's evidence already
    does), then email addresses, phone numbers and payment card numbers (agent memory's `redact_personal_data`), and
    its control characters dropped. Names and handles a person writes in the text are not replaced. The runtime
    checks and cleans the answer again before it keeps it (`learning/reactions.py` `checked`).
  - Handles: the rows and the run monitor keep each author's handle (the monitor is for administrators, who need to
    know whose review it was); the coach never sees one: each author is a label stable within the read (`reviewer-1`
    for the newest's, then `reviewer-2`, …).
- **Who reads, and when.** Only voc-engineering-runtime, never an agent: its call of the broker's function URL is
  SigV4-signed as its own execution role (`runtime/handler.py` `_broker_reactions`), and the broker admits that role
  in the session Lambda names after the runtime's function, by the names the stack hands it, checked as an agent's
  identity is (`connectors/identity.py` `runtime_caller_from_event`); an agent's session asking for `reactions` is 403
  whatever its role, and the runtime asking for any agent's operation is 403 too. The broker's function URL stays
  without a resource-based policy. The run's end reads nothing of the host (its retrospective keeps its whole time
  for the scorecards and the coach's hand-offs); reads happen:
  - `-c engineeringReactionsDelayDays` days after the end (3 by default, 1 to 30): the retrospective creates ONE
    one-time EventBridge Scheduler schedule per run (`voc-eng-reactions-<run>` in the deployment's
    `voc-engineering-reactions` group, `at()` in UTC, no flexible window, no retry, `ActionAfterCompletion` DELETE),
    only when the run's record keeps a pull request (`reactions_read.py` `has_pull_request`: a GetItem and one bounded
    Query of the run's writes' partition); it invokes the runtime by its unqualified ARN with `{"action":
    "reactions", "run_id", "asked_by": "schedule"}` and deletes itself once it has run; a second create for the run
    finds it and changes nothing. Pay per use: nothing stands between runs (tenet 7);
  - by hand: `POST /agents/engineering/<run_id>/reactions` (an administrator acting for themselves; 403 for anyone
    else, a delegated credential included; 404 while the module is off or for an unknown run; 409 while the run has
    not ended), the run monitor's "Read reactions now" behind a confirmation. The Agents API may invoke no runtime
    function but voc-engineering-start, so the route hands it to that function's second action, `ask_reactions`,
    which claims the run's `REACTIONS_ASK` row (who, when, until: at most one ask per run in a rolling 60 minutes,
    else 429 with `retry_after`; a rate limit, not a record, so it is written over once its hour has passed or it
    was released) and hands the read on to the runtime asynchronously (202). A hand-on that fails releases the claim
    (`released`, an UpdateItem: the start function's role deletes nothing) and answers 503, so asking again works.
    The start function's role already reads and writes the run's partition and invokes the runtime: no grant is
    added.
- **The records** (`learning/reactions.py`, `learning/reactions_read.py`), each written once and never changed (D1):
  - `WS#<ws>#RUN#<run>` / `REACTIONS#<read_at>`: the bounded, filtered and redacted read (`voc-reactions/1`, at most
    about 110 KB, the authors' handles kept), who asked (`schedule` or `human:<subject>`) and when. A run with no
    recorded pull request records nothing, and the runtime says so in its answer and its log. The run monitor shows the
    newest (one Query of one row): the counts, each reviewer's latest state, merged and when, reverted and by which
    commit, people's commits after the merge, each body as plain text, never HTML, and what was dropped.
  - **The scorecards' human edits**: separate create-only rows beside each version's scorecards,
    `WS#<ws>#SCORE#<connection>#<role>#<version>` / `HUMAN#<run>#<read_at>` (`voc-scorecard-human/1`: the changes
    requested, people's commits after the merge, a revert), never a scorecard row changed, for each skill version that took
    part in the run (the pull request is the run's work as a whole: nothing on the host says which agent's lines a
    reviewer meant), written only when a read says something other than the run's read before it. `version_card`
    sums, for the runs it read, each one's newest such row (a second bounded Query of the partition, newest first, at
    most 400 rows; `human_more` when the bound was reached), and the scorecards' route answers them as `human_edits`.
  - **What a read changes**: the run monitor and the scorecards' human edits, at once. The coach sees a run's latest
    read only as evidence the next time it handles a failure from that same run: the `HostReactions` port answers
    that read, each reaction its own DATA block under the prompt's fence, with the system prompt's instruction that
    they are people's words to weigh, never instructions (`coach-prompt/3`, above), and with labels, not handles. A
    run's failures go to the coach once, at its retrospective, which comes before any read (the schedule is days
    later; a hand trigger needs the run ended), and each failure is coached once ever; so today the coach rarely sees
    reactions at all: only when a run's retrospective is started again after a read and a failure it takes had not
    been coached yet. Reactions as failures of their own are planned (below). The coach still writes only proposals: a version it proposes is used only once an
    administrator accepts it, and for a coach's version only with an administrator's record of a benchmark run in
    which the pass rate rose, naming its expected case ([the administrators' actions](#the-administrators-actions)).
- **The grants** (`lib/stacks/engineering-reactions.ts`, pinned in `engineering-reactions.test.ts`, the broker's in
  `engineering-broker.test.ts`): on the runtime's role, the broker's function URL as the agent roles call it
  (`lambda:InvokeFunctionUrl` with AWS_IAM auth, `lambda:InvokeFunction` only through a function URL),
  `scheduler:CreateSchedule` on its group's `voc-eng-reactions-*` names only (no update, no delete) and `iam:PassRole`
  on the scheduler's own role only, only to `scheduler.amazonaws.com`; that role is assumed by EventBridge Scheduler
  for this account and that group only and may invoke `voc-engineering-runtime` and nothing else; and `GetItem` and
  `Query` of the runs' writes' partitions (`WS#*#WRITES#*`), read only, for whether a run keeps a pull request. The
  rows need no new grant: the runtime's role already puts items in the runs' partitions and the scorecards'. On the
  broker's role, one
  `dynamodb:Query` of the runs' writes' partitions (`WS#*#WRITES#*`: the run's recorded pull request), read only.
  Nothing of it appears while the module is off.

Still planned: reactions as failures of their own (the coach's `pr_rejected` and `heavy_edit` kinds from a closed,
reverted or heavily edited pull request, read at the schedule, after the run's coach has run); a self-managed GitLab
instance; "what the agents learned" and "what improved since the last run" in the goal report; the conversation's
excerpts in a failure's evidence. (The scorecard screen and the administrators' route that reads `version_card` are
built since 7.07.00: [the administrators' reads](#the-administrators-reads); the screen does not show the human edits
yet.)

**Agent memory.** The [memory](memory.md) layer gains an agents part, with three scopes: per repository (confirmed
conventions, reviewer preferences, recurring bugs and their fixes, flaky tests, what the gates usually catch), per
agent role (lessons) and per person (how they like pull requests, what they always ask for; only for a signed-in user
of this deployment, who approves their own, never for someone who exists only on the host). Each memory records its
provenance (the run, the PR comment, the person), a confidence and an expiry or review date. A learned memory is a
draft until it is approved (it is mined from text anyone with access can write, like the knowledge pack): a
repository's or a role's by an administrator, a person's by that person; an
edit is a new version with its author (D1, D4), and a person can forget one (archived and restorable, as every
memory is). Who reads them: a repository's memories
and each role's lessons follow the connection's sharing (one connection's lessons never reach another's agents), and
a person's are theirs, as personal memory is. The knowledge pack is the reviewed, documented layer; memory is the learned one, and a lesson confirmed
often enough is proposed for the knowledge pack. Retrieval puts the relevant memories in an agent's context for its
task, bounded; conflicting or stale memories are flagged, never silently mixed.

What exists (`voc-datalake/lambda/engineering/agent_memory/`): the scopes, the statement's rules and the pack
proposal (`model.py`), the recall for a task (`recall.py`) and the store (`store.py`), with nothing calling them yet.
**Where it lives, and why.** The agents' part follows the [memory](memory.md) layer's rules (a statement's hygiene,
the confidence an automated write needs, proposed until approved, forget = archived and restorable, never deleted,
fenced as data in a prompt) but is a store of its own in the `voc-engineering` table, not a third scope of
`voc-memory`: `voc-memory`'s company scope is read by every shared generator (research, PR/FAQs, PRDs, agent steps)
and has no connection in its keys, so a repository's lessons would reach outputs about customers and one
connection's lessons could not be kept from another's agents; it edits a memory in place, where an agent memory's
edit is a new version (D1); its curators are its memory reviewers, where these are a connection's administrators;
and, kept beside the engineering rows, the agents' recall needs no grant on a table that holds the company's and
every person's memories. Rows: one partition per scope, `WS#<ws>#AMEM#REPO#<connection>`,
`WS#<ws>#AMEM#ROLE#<connection>#<role>` and `WS#<ws>#AMEM#PERSON#<user>`, holding a `MEM#<connection>#<id>` row per
memory (keyed under the connection it applies to, `''` for a person's own; its status, latest and approved
version, the approved statement, its confirmations and a revision every change is conditioned on), a create-only
`VER#<id>#<version>` row per version (statement, provenance, confidence, review date, cited feedback ids, author,
the version it was written on, who approved it), a create-only `LOG#` row per approval, forget and restore, a
create-only `CONF#` row per confirming source, and in a person's partition a `REF#<partition>` row for each other
partition whose rows name them (as an author, approver or confirmer), which their erasure follows. A statement is
at most 400 characters (the pack's claim bound), on a subject (a few lower-case words) and of a kind (a
repository's `convention`, `reviewer_preference`, `recurring_bug`, `flaky_test` or `gate_catch`, a role's `lesson`,
a person's `preference`); credentials are replaced, then personal data, then the memory layer's hygiene runs (an
instruction-shaped, profane or judging statement is refused, quotations of six words or more dropped), and a
statement holding a sentence of a review the run cited is refused (feedback ids only): every learn, write and edit
must pass the reviews the run cited (`review_texts`, a required argument), so no caller skips that check. Its
provenance is one run, one review comment on the connection's own host (checked against the connection's
repository address), or one person; its review date is 90 days ahead unless given, at most a year. **An agent is
held to its run**: it acts through a `RunContext` the trusted caller builds from the run's record (its connection,
its run, its role and the signed-in users on its task), never from what it asks. It learns only into its run's
connection, a role's lessons only for its own role, a person's memory only for a person on its task, with its own
run (or a review comment) as the provenance (another run's id is refused), at a confidence of 0.8 or more, always
as a draft; the same statement on the same subject is a confirmation instead, and one that matches a forgotten
memory is refused (a person can restore it). An agent confirms from its own run only and a person as themselves
only; each source counts once (the one a memory was learned from never), and a memory stops counting at 20. A
person memory is kept only for a signed-in user of this deployment (the deployment's user directory says so) who
was never erased; one an agent learned applies only to that connection, one the person wrote to every connection.
An administrator approves a repository's or a role's draft, the person their own (an administrator neither
approves nor reads it); a person's edit is a new version on the latest one, approved at once when its author may
approve, and an older draft is never approved over a later approval. Forget and restore are the approver's. An
approved repository or role memory confirmed three times is returned as a proposal for the pack (its document,
claim, citations and feedback ids), and nothing is written to the pack. Recall reads the run's connection's
repository memories, its role's lessons there and the memories of the people on its task (at most 10) that apply
to that connection, approved and live only; an agent never reads another role's lessons, nor a person's memories
the run's record does not name. It keeps whole memories, 12 and 4,000 characters unless asked (at most 30 and
16,000), current ones before stale ones, then the most confirmed and the most confident, flags a memory past its
review date as stale and two on one subject that say different things as a conflict naming each other (even when
the bound left one out; the first five by id, then how many more, found by grouping on subject and statement, so
it costs O(n log n) in the memories read), and puts them in one DATA block with a random fence, under one line saying what the flags
mean. **Bounded reads**: a scope holds at most 200 live memories and 500 in all, forgotten ones included, per
connection (a person's: per person and connection, so one connection never fills another's quota or the person's
own), and a memory at most 21 confirmation rows; every learn, recall and proposal reads one key range of at most
that many rows. **Erasure (D5)**: a person's memories are their own data, erased for a legal obligation by an
administrator (`erase_person_memories`, with the legal basis, which holds no personal data): first a tombstone
(`AUDIT#tombstone#agent_memory_person` / the sha-256 of their user id: the legal basis, who, when) and an
`AUDIT#delete` row (what: their hashed id and how many rows and partitions; who; when; why), then every row naming
them in another scope is de-identified (their id as author, provenance, approver, log actor or confirmer becomes
one random `erased-…` id for this erasure; a confirmation row is re-keyed, since its key hashes its source), then
every row of their partition is deleted. Only an erasure reads a partition whole, and a re-run finishes a failed
one. The learning loop drafts a role's lessons ([above](#getting-better-skills-the-coach-the-learning-loop-memory));
a run's provenance may name the board task it was learned from (`task_id`, the version's `prov_task`), which never
counts as another source. Not yet: the harness reading the recall, the routes, a retention pass
for memories past their review date, and the call from the platform's erasure of a person (today
`POST /settings/erasure` erases feedback, `DELETE /participants/people/{id}` participants, and `DELETE
/users/{username}` removes a sign-in but none of its data; whatever comes to erase a signed-in user's data must
call `erase_person_memories` for each workspace, with the request's legal basis; its role needs Query,
PutItem, UpdateItem and DeleteItem on `voc-engineering`, the delete pinned to that caller as the customer-data
deletes are, and the `AUDIT#` row guard, `voc-datalake/lib/utils/audit-row-guard.ts`, must cover `voc-engineering`
so that no role changes or removes the erasure's tombstone and delete record). An erased person is refused in
every scope, not only their own: whatever would name them again (a write, an edit, a confirmation, an approval,
a forget or a restore, by them as a person or an administrator) is refused before anything is written, so no
`REF#` row comes back into their deleted partition.

## Readiness (7.50.00)

*Built* (`voc-datalake/lambda/engineering/readiness.py`, pure, its reads behind ports; the Agents API's wiring in
`readiness_aws.py`). `GET /agents/engineering/readiness?automation=<agent id>` (an engineering agent: its connection,
language, flow and `github_issue` trigger) or `?flow=<template id>` (a default flow), either with
`[&connection=<id>&language=<language>]`, answers `{subject, ready, checks}`, each check `{id, status, detail, fix,
docs, required}` with `status` `pass`, `fail`, `warn` or `unknown` (a read that failed, or one this API cannot make:
never taken for a pass). `connection` and `language` (7.50.01 for an agent; `readiness.preview`) answer as if the
subject were set up with them, read-only: nothing is saved, the agent keeps its settings and Enable still evaluates
what is stored. The Set up dialog asks it of its selection, so the App installation, the CI attestation, the branch
rules, the Issues source and the image are those of the connection and language it would save. The connection must
be stored and not removed and the language one with an agent image (`python`, `node`, `rust`, `java`): 400 otherwise
(503 when the connection cannot be read). Administrators acting for themselves only (403 otherwise, an MCP credential
included: REST only), 404 while the module is off. `ready` is true when no **required** check fails; Engineering
Enable (`POST /agents/<id>/enable`, and a create or update that turns an engineering agent on) runs the required
checks and answers 409 `{error, checks}` with the failing ones. A check the subject does not need (the Issues source
for a flow no issue starts) passes and says so. What a flow needs is its template's `requires` (`dial`, the ways of
working it runs in; `ci_attestation`; `image`; `issues_source`; `knowledge_pack`); a stored flow without one needs
what its roles do: a flow with a committer or a PR author a pushing way of working and the CI attestation. Since
7.52.00 `tenets` too (Issue triage requires it: advice, never blocking).

| Check | Required | Reads | Fix |
|---|---|---|---|
| `connection` | yes | the agent's stored connection | Agents → Connections, then the agent's Set up |
| `app_installation` | | the GitHub App installation, through `voc-engineering-app-tokens`' `inspect_installation`, for a connection made through one of the deployment's Apps (`unknown` for a connection with its own App key, which only the broker reads; GitLab: not needed) | add the repository to the installation on GitHub |
| `ci_attestation` | yes, where the flow pushes | the connection's CI attestation | the CI attestation under Agents → Connections |
| `ci_protection` | | `unknown`: the broker reads the host's branch rules with the connection's own token at each push; this API holds no host token | protect the default branch with its required checks, and leave `voc-agent/*` unprotected |
| `image` | yes | the languages with an agent runtime (`-c engineeringImages` with a network) | build and push the image, deploy with its digest ([deployment](deployment.md)) |
| `pack` | | the connection's approved knowledge pack, where the flow requires one, and its docs' rendering (7.52.00) | the Understand flow, then approve its pack |
| `tenets` | | the connection's accepted tenets version (7.52.00, `WS#default#REPO#<connection>` / `TENETS`), where the flow requires them (Issue triage): `warn` with none accepted, a triage then cites none | the Tenets flow, then accept its draft |
| `issues_source` | | the deployment-wide GitHub Issues source's settings naming the repository with a sign-in (7.50.02: its connection adds it, [github-issues.md](github-issues.md#configured-by-your-github-connection-75002)), else its watermark (`voc-watermarks`, `github_issues#repo#<owner/name>`) | Agents → Connections: turn on "Read this repository's issues"; or Administration → Data sources → GitHub Issues in its Deployment scope (`/admin/sources/github_issues?scope=deployment`) |
| `issue_label` | | the trigger's label (a public repository needs one); `voc-agent` passes once its connection created it or found it (7.50.02: the token function's `ensure_label`); another label's presence is `unknown` here | Agents → Connections → Check installation; or create the label, and let only maintainers put it on an issue |
| `dial` | yes | the STORED way of working of the person the runs follow (the enabling administrator, else the one asking), against the flow's `requires.dial`; nothing saved fails as "Not set yet: choose AI-assisted or AI-driven for <name>" (7.50.02: a run pushes nothing, whatever the documents' default), a saved Human-driven as Human-driven; the check names the person and each way of working by its name (Human-driven, AI-assisted, AI-driven) | Administration → People, the person's editor (`/admin/people/<username>`); in the Set up dialog, **Set my way of working to AI-driven** (the caller's own) |
| `budget` | yes | the flow's monthly budget | the flow's Workflow tab |
| `hard_cap` | | the hard cap's setting and this month's spend of the flow (`warn` while it is off) | Agents → Spend |
| `bedrock_models` | yes | Bedrock access (`GetFoundationModelAvailability`) of every model the flow's roles run on (their cards' models, a step's own `model`, Learn's) | Model access in the Bedrock console |
| `agentcore_quota` | | AgentCore's "Active Session Workloads per Account" (`L-3E5722B2`) against `-c engineeringMaxSessions` | a quota increase, or a lower setting |
| `memory_setting` | | `-c engineeringBuildMemoryMiB`: 8192 fails in a region whose CloudFormation does not take a runtime's resource configuration | deploy with `0` |
| `network` | | `-c engineeringAgentNetwork` | name the sessions' private subnets |
| `sandbox` (7.50.03) | | the walls the language's last session said it runs behind (the runtime's record, voc-engineering `WS#default#SANDBOX` / `LANG#<language>`): a pass only from that record ("verified on the live runtime (date): user and network namespaces; hard-link guard …"), unknown until the first session of the image, a fail when the record names no egress wall, no code wall or no hard-link guard ([Runtime](#runtime-one-agentcore-session-per-agent)) | rebuild all four images (python, node, java, rust) from 7.50.03 and deploy their digests with the stacks ([deployment](deployment.md)) |
| `session_storage` | | a probe of the workspace bucket: one create-only put of its one object under `ws/default/_readiness/*` (`readiness_aws.py` `PROBE_KEY`; answered, or refused as already there), then the same put without `If-None-Match`, which the bucket's policy must refuse | redeploy VocCoreStack |

The probe's one object is the deployment's, not a run's (no run key, nothing reads it); it is kept like every object
of the bucket. The Agents API's role gains, with the module on, `bedrock:GetFoundationModelAvailability` and
`servicequotas:GetServiceQuota` (both account-level: they take no resource ARN), `dynamodb:GetItem` of
`voc-watermarks`' `github_issues#repo#*` keys only, and `s3:PutObject` on `ws/default/_readiness/*` only with the key
through S3; nothing else (the `sandbox` record is a GetItem of voc-engineering, which the role reads already; the
supervisor's role alone puts it, `WS#*#SANDBOX` only).

## Models

*Planned.*

| Work | Default | Why |
|---|---|---|
| map shards, classification, the run coordinator, cheap checks | Claude Haiku 5.5 | many small calls |
| fixing, building, reviewing, the coach | Claude Sonnet 5.5 | the bulk of the reasoning |
| feature planning, the final go | Claude Opus 5.5 | the hardest calls, few of them |

The defaults are confirmed or changed per agent by the [benchmark](#evaluation); the cost of every run is recorded. As
for the other agents, the deployment default is set per surface in Administration → AI models and an agent's own choice
in its **Models** tab; the engineering agents add the surfaces `eng_mapper`, `eng_worker`, `eng_reviewer`,
`eng_planner` and `eng_coordinator`. A model not yet in the deployment's Bedrock allowlist is added to it, with its IAM
ARN, in the change that first uses it.

## Trust and safety

*Planned.*

- Writes to the host only through the broker, only to the agent's own branches and pull requests and as comments;
  people merge.
- **A person approves and merges in every mode; the dial decides how far a flow goes** ([TENETS.md](../TENETS.md)
  tenet 3, agreed by the owner). Human-driven: the agents find and propose (findings, plans, proposed changes for a
  person to make) and push no branch. AI-assisted: they write the change on their own branches and open a pull
  request, each step past the plan waiting for a person's go. AI-driven: the flow runs end to end to a pull request.
  Since 7.50.00 (the owner's decision) the pull request opens ready for review, so a person approves it without a
  "Ready for review" click (branch protection still requires their approval and the CI check), or as a draft when the
  flow says `pr: draft`; an agent never merges, never approves, never marks a draft ready and never changes the
  dial. Whether a passing skill version may apply itself in AI-driven mode is not part of this and still waits for
  the owner. *Built for the broker* (6.23.00, [Repository connectors](#repository-connectors)): it reads the dial of
  the person who started the run before every push and pull request, refuses both in Human-driven, holds both for a
  person's go on the run in AI-assisted (one go per run; per-step waits are planned), and has no operation that marks
  a draft ready, approves or merges (a test pins the broker's, the clients' and the router's methods and the clients'
  request paths); the rest of a flow does not read the dial yet.
- **Repository text is data, never instructions.** READMEs, code, issues, PR comments, the knowledge pack, memories,
  other agents' messages and customer feedback (which anyone can send through the public forms) reach a model inside
  DATA blocks. That lowers the risk of a planted instruction; it does
  not remove it, so what keeps the repository safe is what the agents cannot do: no host token in any session, each
  role limited to its broker operations, no forged messages, the agent process limited to the platform's own
  endpoints, the connector's refusals, the host's branch rules, a person merging. A test plants instructions in a fixture
  repository and in fixture feedback and checks that none of them gets past those limits.
- The connection's credential never reaches a model; secrets committed in the repository itself can, which is one
  more reason output is scrubbed. Every action is an event in the run's conversation with its actor
  (`agent:{agent_id}` and the skill version), time and reason (D4).
- **Stop.** A person's **Stop** on the run view (an API call, journalled as a `stop` event) does not wait for the
  agents: the supervisor ends the run's sessions at once, the launcher stops renewing their short role sessions (which
  lapse within 15 minutes, and serve no ended session meanwhile), and the broker refuses the run's operations. Enabled only stops new runs.
  *Built* (7.50.03): the run monitor's Stop and "Stop now, without saving" (`POST /agents/engineering/<run_id>/stop`,
  through voc-engineering-start's `stop_run`) end the run in every state that has not ended, a run with no session
  included: Stop lets the agents with a session save first (10 minutes at most), Stop now does not wait; the run's
  `RUNLOG#` row names the person (D4), its open tasks are closed, its sessions ended, and its engineering agent's run is
  ended with it ([The run monitor](#how-the-agents-work-together)). The `RUNLOG#` row is the record: the API says
  nothing but a person's steering and answers on the bus (7.51.02).

## Evaluation

*Partly built*: the harness, its fixtures and the benchmark gate for skill versions
(`voc-datalake/lambda/engineering/benchmark/`, the cases in `voc-datalake/templates/orchestration/evals/`), with nothing
invoking them yet.

A benchmark of small fixture repositories (written for this sample, MIT, shipped in
`voc-datalake/templates/orchestration/evals/<flow>/cases/`; a monorepo among them):
known bugs with their fixes, pull requests with known review findings, features with acceptance tests. Each agent is
scored per model and per skill version on pass rate, cost and time; the results decide the model table above and every
skill version the coach proposes. The results on the sample's own fixtures are published on this page; a
connection's own fixtures stay with it.

What exists:

- **Cases** (`benchmark/cases.py`): a `voc-bench/1` record per case directory (`case.json`: its id, which is the
  directory's name; its kind, `bug`, `review` or `feature`; a title; the task an agent is given; its fixture, a
  directory beside it; its check). A bug's or a feature's check is an argv (`python3` or `node` first), a directory of
  the repository to run it in, a timeout of at most 600 s, the paths a patch may not touch (the check's own tests,
  the packages a case leaves alone) and, optionally, the only paths it may change (every shipped case names them),
  both compared case aside; a review's is the findings it expects (a file, a line range, a short rule id)
  and how many others it may report. The loader checks every field, bounds the record (64 KB), every text, the
  fixture (400 files, 2 MB, 256 KB a file) and a suite (100 cases), and refuses a path that is not a plain relative
  one (`..`, absolute, `.git`), any link in the case and anything in a fixture but files and directories. Five cases
  ship in `voc-datalake/templates/orchestration/evals/` ([README](../voc-datalake/templates/orchestration/evals/README.md)), among them the owner's sandbox's divide bug, and: a Python
  bug with a failing unittest, a Node feature with acceptance tests (`node --test`, no dependencies), a review with
  three known findings, and a monorepo (a Python and a Node package) whose bug is in one package and whose other
  package is protected. Their checks need only `python3` and `node`, and no network.
- **The runner** (`benchmark/runner.py`): a candidate (`solve(case_view) -> Attempt`: a unified diff for a bug or a
  feature, findings for a review, its input and output tokens, cost and seconds) gets its own copy of the fixture
  and nothing else of the case. A patch over 256 KB, or naming a path outside the repository, in `.git`, protected
  or outside the paths the case allows, or making a link, a submodule or a binary, is refused before git reads it;
  the rest is checked with `git apply --check` and applied to a fresh copy made a git repository (its git directory
  beside the tree, hooks and every config but the runner's off), and the tree is walked again. The check runs
  without a shell, its tool by absolute path (Python isolated, `-I -P`, so a patch's `unittest.py` shadows nothing),
  with no credentials and no proxy in its environment (built from nothing: its tools' directories on PATH, a
  throwaway HOME), its process group killed at the timeout (a child that called `setsid` escapes it); it passes when
  it exits 0, and its scrubbed output's end is the reason it failed. It is not a sandbox: the check's network and
  file system are open. A review passes when every expected finding is matched within its line
  range with its rule and the other findings stay within the case's bound. Each case gives a result (passed, why,
  tokens, cost, seconds) and a candidate's run a scorecard (pass rate, results, total cost and time).
- **The gate** (`benchmark/gate.py`): `decide(baseline, candidate, failure_case)` refuses two scorecards that did
  not run the same cases, and passes only when none that passed in the baseline fails in the candidate and, when a
  failure's case is named, the candidate passes it and the baseline did not; each reason is a sentence naming its
  case (past 12 regressions the rest share one line, so a verdict always fits its record). The verdict carries the
  failure's case it checked, and the record made from it takes it from there, so a
  record never claims a gain the gate did not check. Its verdict is recorded on the version by the skills store, whose acceptance of a coach's version needs it ([above](#getting-better-skills-the-coach-the-learning-loop-memory)).
- Scripted candidates in the tests (every known fix replayed; one case left unfixed; a baseline that fails a
  failure's case and a version that fixes it) prove the runner and the gate end to end on the shipped cases.
- **A role's skill as a candidate** (6.29.00, `benchmark/candidate.py`): `SkillCandidate(skill, model_for)` runs a
  skill version (the shipped record or one the coach proposed) on the harness's own Converse loop, with its prompt
  and exactly its tools, on the case's copy as its checkout and the case's task as its brief; its answer is the
  change its tools made (a git patch read from the two trees) or, for a review, the `voc-finding/1` findings it
  wrote, and its tokens are the loop's count. Its ports are the benchmark's own: no board, no inbox, no host (the
  broker's writes say nothing is written) and no repository command (`run` and `install_dependencies` answer that the
  benchmark runs none: this machine is not a sandbox, so the case's own check is the only code that runs). The tests
  drive the fixer on `slug-cut-bug` and `monorepo-units-bug`, the builder on `duration-hours-feature` and the PR
  reviewer on `pagination-review`, each with a scripted model that answers with the case's known fix or its
  expected findings, and a fixer version that gains on `slug-cut-bug` over one that gives up passes the gate.

The coach that proposes a version is built, and names the case its version should gain on, which the recorded
benchmark must name; the learning loop invokes it on a run's failures
([above](#getting-better-skills-the-coach-the-learning-loop-memory)). Still planned: the step that runs the
benchmark for its proposal; a measured run of the role skills on a real model (the candidate is built: its first
run on Bedrock waits for the owner); the results published here; and a connection's own fixtures made
from its failures, kept with that connection. The benchmark assumes an honest candidate: a check's isolation is
the runner's (a clean environment, a throwaway directory, a timeout, the paths a patch may change), not a
sandbox's, and the code under test can still patch the framework that tests it. The shipped cases are the
sample's own; a connection's cases will run in the runtime's sessions.

## Cost

Nothing runs, and nothing is billed, until an administrator connects a repository and starts a run.
Then, per use: model tokens (Bedrock), each agent's AgentCore session while it lives (per second: the CPU it uses,
none while it waits on the model or a tool or is held for an open wait, and its memory), the images stored in ECR,
EventBridge per
event, SQS for the one dead-letter queue (no task queues), DynamoDB on demand, S3 for the workspace, caches and packs, the supervisor's invocations while a run is
active. The connection's credential is a standard SecureString parameter, with no monthly charge. No NAT gateway and
no other fixed cost by default: no session runs between runs, and a build runtime's committed baseline is billed only
while its session lives. The sessions' network is the deployment's own (`-c engineeringAgentNetwork`): its way out (a
NAT gateway and an egress firewall, or interface endpoints) is a fixed cost of that network's, outside this stack
([deployment.md](deployment.md)). Each run's session seconds and model tokens are measured on its agents' session
rows (session time and, since 7.50.00, model tokens priced) and kept by month in the spend ledger below, which Agents
→ Spend shows; *planned*: the run monitor's cost line. A run's end adds its retrospective:
one more invocation of voc-engineering-runtime (DynamoDB reads of the run's own rows, a few create-only writes), plus
one per failure it takes to the coach (at most three), each one Converse call (the prompt is at most the
40,000-character evidence plus the role's skill; the answer at most 8,000 tokens, thinking included; at most 200
seconds), made once per failure. The coach's Converse calls are not on a session row, so the spend ledger does not
count them yet.

**What a session counts as** (`voc-datalake/lambda/engineering/runtime/caps.py` SessionPricing, built). The run's
cost cap counts each session's CPU and memory at the deployment's AgentCore rates (`-c engineeringSessionRates`:
`vcpuHour`, `gbHour`, `baselineVcpuHour`, `baselineGbHour` in USD, AgentCore's published V2 rates by default: $0.1276,
$0.0169, $0.0997 and $0.0132; a rate of 0 leaves that part unpriced). The supervisor cannot see what the service
bills, so it counts an upper bound of it: every vCPU of the session's size while its agent runs, none while it is held,
its memory while it lives, and a build runtime's committed baseline (2 vCPU and 8 GB at the baseline rates) for its
whole life, its burst to 8 vCPU and 32 GB counted as used. A standard session (2 vCPU, 8 GB) counts as about $0.39 an
hour running ($3.12 for 8 hours) and $0.14 an hour held; a build session as about $1.48 an hour running. The bill is
lower: AgentCore charges only the CPU actually used, nothing while the agent waits on the model. Reading the
service's own usage per session in place of the bound is *planned*.

**What a model's tokens count as** (7.50.00, `caps.py` TokenPrices and `token_usd`, built). Each model's new tokens on
a session's priced write cost its price per million tokens (input and output; the cache prices are kept beside them
for a harness that reports cache tokens, which none does yet), ADDed to the session row's `cost_usd`, which the run's
cost cap reads, and to the model's ledger row and the flow's month total, in the same transaction: so a run's cost
cap (`-c engineeringRunCapUsd`), its token cap (`-c engineeringRunTokenCap`) and its flow's monthly budget all bound
model spend. The defaults are the AWS Price List API's figures for the global (cross-region) inference profiles,
standard tier, in us-west-2 (service code `AmazonBedrockFoundationModels`, the `*_global_standard` usage types,
published 2026-11-09, read 2026-11-16), in USD per million tokens (input / output / cache read / cache write): Claude
Haiku 5.5 $0.10 / $0.50 / $0.01 / $0.125, Sonnet 5.5 $2.00 / $10.00 / $0.10 / $2.50, Opus 5.5 $4.00 / $20.00 /
$0.20 / $5.00. A deployment in another region or tier sets its own per model with `-c engineeringModelPrices`
(`{"<model id>": {"input": …, "output": …, "cacheRead"?: …, "cacheWrite"?: …}}`, 0 to 1,000 USD per million, at most
12 digits after the point; checked at synth and again by the runtime), each replacing that model's default. A model
with no price (a new id, or a harness's model under another name) is priced at the dearest price listed, part by part:
an upper bound, so the caps still hold. Tokens used before 7.50.00 stay unpriced (pricing goes forward only).

**The spend ledger** (`voc-datalake/lambda/engineering/spend.py`, built). What the runs use is kept by day, workflow, run, agent and
model: one partition per workspace and month, `WS#<ws>#SPEND#<yyyy-mm>`, one row per
`DAY#<dd>#WF#<flow>#RUN#<run>#AGENT#<agent>#MODEL#<model>`, whose numbers only grow by ADD (`usd`, `tokens_in`,
`tokens_out`, `microvm_seconds`), with the run's repository on the row for grouping. Each row is written in the same
transaction as the session write whose metering it mirrors (the session store's priced writes: session seconds, priced
at the deployment's AgentCore rates, under the model `microvm`; each model's new tokens), so the ledger and the
sessions never drift and a retried write adds once. A row is booked to the day (UTC) of the write that measured it
(when the supervisor counted the session time, or the harness's report reached it), and the ledger starts when it is
deployed: a session's earlier tokens are not booked. Since 7.50.00 each model's tokens carry their dollars on their
row (above). The model names come from the harness's report, inside the session: names
that clean to the same key part (ASCII, at most 128 bytes, so a sort key always fits) are summed into one row, a
session ledgers only 8 models by name, the first in name order (any others on its `-` row, so no session opens rows
without end; a model that sorts earlier and is first reported later moves a later one onto `-` from then on, the
totals unchanged),
one write adds at most 32 rows (a transaction holds 100 items), and a reported model named `microvm` is ledgered as
`microvm-reported`, so no report can fail the session's write, flood the month or pass for session time. The writers' roles
may update the month partitions only (`WS#default#SPEND#20??-??`: UpdateItem, never a delete; IAM cannot limit an
update to ADDs, the code only ADDs to the counters, and refuses anything below zero); the supervisor alone also reads a
flow's month total there (GetItem); the Agents API reads them.
`GET /agents/engineering/spend?month=&by=&workflow=` (administrators) answers a month grouped by workflow,
repository, run, agent, model or day. The web app's **Spend** tab (Agents → Spend, `/agents/spend`: administrators,
while the engineering agents are on) reads it: the month's cost, tokens and session time, then each group, biggest
first; the month (the last 24 in its picker, any older one by its address), the grouping and a workflow are view
options in the address; a workflow's row narrows the view to its runs, and a run's or an agent's opens its run
monitor. Grouped by workflow, this month is set against each flow's monthly budget as it is now (the library's
`monthly_budget_usd`), its share marked from 80% (the first alert) and in the danger tone from 100%.
Each engineering flow may set a monthly budget (`budget: {monthly_usd}`, docs/autonomous-agents.md
"Engineering flows"). The runtime's `start_run` takes the flow's budget (`budget_usd`, under the flow's own rule,
refused for a run with no workflow id it could key) and keeps it on the run's META: a change applies to the next run.
The start route (`POST /agents/engineering/runs`, 6.25.00) reads it from the stored flow, never from the request.
Each workflow's month has its dollars in the ledger's partition,
`FLOW#<flow>`, ADDed in the same transaction as its runs' rows (one more item in it). The supervisor's tick reads it
with one GetItem per live run with a budget, after that tick's moves (so a level passed by an agent's last write,
or a stopping run's, is seen), never a Query of the month. As the month passes 80%, 100% and every
further 50% of the budget (up to 1,000%), each level's row, `ALERT#<flow>#<budget>#<percent>` in the month's
`WS#<ws>#BUDGET#<yyyy-mm>` partition (only the supervisor's role may write it: the delivery role has no grant on it,
and the bus's roles, which write the table elsewhere, an explicit Deny on it and on the ledger's months, so no other
writer can make, and so mute, an alert), is claimed by the live run whose tick saw it (D1, D4: which run, when, at what spend). That run says
it to its conversation (`run.budget_alert`, from the supervisor's own source) and then closes the row (`sent_at`): at
least once per flow, budget, level and month while a run of the flow is live. A send that fails gives the claim back
at once, for any live run of the flow's next tick (an unsaid claim is also taken over after 5 minutes; one whose close
failed after it was said may be said again); with no run of the flow left live, it waits for a later run that month.
A run being wound down is checked too (its agents' last writes), so it may be the one that says a level another run
passed. The budget and the flag are on the run's META, which the run's other trusted writers (the board, the router,
the delivery function) could also write: the alert trusts them as the run's caps do; a level passed
in a month's last minutes is said in the next month's first; a new budget has alerts of its own. Each live run of the flow (one the
supervisor ticks) is flagged with
the highest level said that month (`budget_alert`, `budget_alert_month` on META, only ever upward: never past a level
another run holds unsaid, which its later ticks try again); a tick that
jumps several levels claims each and says how far the month is. It counts session time and, since 7.50.00, model
tokens at their prices; the alerts stop nothing.

**The hard cap** (`voc-datalake/lambda/engineering/settings.py`, built; off by default). An administrator may turn
it on (Agents → Spend; `PUT /agents/engineering/settings {hard_cap}`): then a run's first start with its flow's
budget (`start_run`'s `budget_usd`) gets a cost cap (`max_cost_usd`) of what is left of the flow's month, the
budget less the flow's month total (one consistent GetItem), or the cap it was given if smaller, and a start with
nothing left is refused before anything is written, saying the flow, the month and the figures. The run's own cost
cap then holds it (the supervisor sends it to a person once it is spent). The cap is set once, per run, at its start:
runs of one flow at once may together pass its budget, each capped at what was left when it started. A retry of a
live run is not capped again; a setting that cannot be read refuses a budgeted first start, saying so (retry),
even when the cap is off, since the start cannot tell; off, nothing else changes. It counts session time and, since
7.50.00, model tokens at their prices. The start route reads the flow's
budget from the stored workflow and names it to the runtime (`budget_usd`, `flow`), so a run started there is capped
whenever its flow has a budget; a start of the runtime's own that leaves it out is not capped. The start route also
sends the deployment's run cap (`-c engineeringRunCapUsd`, 50 USD by default) as the run's `max_cost_usd`, so the hard
cap keeps the smaller of the two. The setting is one row in voc-agents, `SETTINGS#engineering` / `HARD_CAP`, beside the workflows whose budgets
it caps, with a create-only history row per change (`LOG#`: who, when, what; D1, D4), in the same transaction. The
Agents API writes it (an administrator acting for themselves) and the runtime reads it with GetItem on that one
partition; every other role that writes voc-agents (the agents' conductor, nodes, persona panel and heartbeat) has
an explicit Deny of writes on it (`denyHardCapWrites`, pinned by `lib/stacks/hard-cap-guard.test.ts`). The Agents
API's own grant covers all of voc-agents, so only its code keeps the `LOG#` rows create-only.

The run monitor's header and the run's reports (`cost.budget`, and a line under Cost and time in the goal and
commit reports' Markdown, never a pull request's, which is its description in the target repository) show the run's
flow budget and its flag: the highest level this run saw its flow's month pass (it stops rising when the run ends).
Agents → Spend, grouped by workflow, sets this month against each flow's budget as it is now (a past month ran
under the budgets its runs kept, which the alerts measured, so it shows none). The total is read consistently, right after
the tick's own writes. The ledger is a dated view of what the sessions measured: each agent's own
totals (its `cost_usd`, session seconds and tokens per model) stay on its session row, the record each run's caps and
the run monitor read, and every ledger row only ever grows with the session write that measured it, naming its
writer (`updated_by`), when (`updated_at`) and that session write's version (`session_seq`, D4). The rows are cost
records, kept under D5 like customer data: they are never deleted and carry no TTL (no writer has a delete grant on
them), and anything that ever removes one is to go through the AUDIT# guard. Because the two
are one transaction, a ledger row the table refuses also stops that session's move: the supervisor logs "could not
move" and tries again on the next tick, so a refused ledger (a grant that does not match the workspace) shows as
agents that stop moving.

Load: the month partition is a hot key per workspace, written with each priced session write, which the supervisor
makes about once a minute per live agent (its tick) plus its other moves: with 50 live agents, about 2 ledger rows a
second (session and model); at 2× (100 agents) 4, at 10× (500 agents) about 20 a second. Those writes are now one
transaction with the session row, which DynamoDB bills at 2 write units per KB per item (about twice the plain update
it replaces), and a partition takes about 500 transactional writes a second: 20 is far under it, so no sharding. The read is one Query of one month partition (eventually consistent), grouped
server-side by the route, never a whole-table read, and stops at 20,000 rows (`MAX_ROWS`; a month past it is answered
as far as it read and marked `truncated`): a month of 50 agents on 10 workflows stays in the low thousands of rows; it
reads the `DAY#` rows only. A flow's month total (`FLOW#<flow>`) is a hot key per flow: every priced write of its runs
ADDs to it in that same transaction, about 1 write a second with 50 live agents of one flow, 2 at 2× (100 agents),
about 10 at 10× (500 agents), far under the 1,000 writes a second one item takes. Two transactions on one item at
the same moment conflict: the session store tries again after a short jittered pause, 4 tries in all (120 to 240 ms
of pauses at most), then leaves the move to the next tick. A try whose answer was lost while it was still under way
is tried again with its own request token, so it is answered as it ended (as landed when it landed; still under way
after the last try, the next tick's read says which). A ledger row the table refuses refuses the whole write, so the
session never moves without its ledger rows. Nothing in the ledger is lost (the seconds are priced again then),
but a continuation whose save after its session started loses all four ends that session and boots again on the
next tick. At 10× on one flow conflicts become common; past it, the total is to leave the transaction (it is derived
from the DAY# rows). Its reads, per live run with a budget per tick: one GetItem of its META and one of the month
total (two in a month's first 7 minutes: the month before too)
(about 1 a minute each); an alert row is written about twice per flow, level and month (the claim, the close).

## Phases and status

Each phase ships its REST routes and MCP tools with it (tenet 4); phase 5 adds the screens. Making a connection,
sharing it, approving a knowledge pack or a repository's or role's memory, accepting the repository's tenets or a
skill version (rolling one back, promoting one to the shared skill), Run now and the schedule of a hunt, and the CI
attestation are admin work, the kind
TENETS.md's tenet 4 row already lists as having no MCP tool (an MCP token never acts as an admin); they stay REST only,
and the phase that ships them names them in that row.

| Phase | Scope | Status |
|---|---|---|
| 0 | this design, the benchmark harness and its fixtures | design written; the benchmark harness (the `voc-bench/1` cases, the runner, scorecards) and its four fixtures built, nothing invoking them yet ([Evaluation](#evaluation)) |
| 1 | the connectors (GitHub, then GitLab) and the broker, credentials, read paths, sparse clones; the Understand flow, the knowledge pack per package and the repository's tenets | in progress: the broker's caller identity, operations per role and write rules; the GitHub client and the credential reader; the broker's readers of the run's record, the board's GO ledger, the submitted patch and the dial, and a person's go on an AI-assisted run (6.23.00, [above](#repository-connectors)); the harness's client of the broker, the agents' reads and writes signed as their own sessions (7.02.00); the connections, stored by administrators with their GitHub App credential in the SSM parameter the broker reads, with an audit row per change (7.03.00); the CI attestation's record, attested and withdrawn by administrators with an audit row each and voided by a repository change, which every push and pull request waits for, beside the broker's own read-only check of the branch rules, and file and history reads on the run's stored default branch (7.04.00); the checkout cache's writer, one immutable entry per connection and commit filled before a run's coordinator is launched (7.05.00); the GitLab client on gitlab.com, a GitLab connection's project access token checked against its project at each save, its expiry on the connection page, its CI attestation in GitLab's words and the broker's own check of its protected branches, and the cache's GitLab fetch (7.06.00); the run's issue (as given at its start) and its draft pull request (as the host answered) on its record, shown on the run monitor and in the reports (7.09.00); planned: a self-managed GitLab instance, sparse clones, the dependency caches' filler and the first real run; the knowledge pack's package detection, shards, map step, reduce and versioned store with approval ([above](#the-knowledge-pack)), nothing invoking them yet |
| 2 | the runtime (one AgentCore Runtime session per agent, the launcher, the harness, the supervisor, continuation, the cache, the mount, scoped roles); the bus, inboxes, board, conversation, workspace | in progress: the bus, the inbox router, the conversation, the board API with each task's history, its agents' `inbox`, `progress`, `tasks` and `knowledge` ops, the coordinator's `coordinate` task and `launch`, the lease's refresh and the supervisor's re-post, the push to the delivery function, the workspace's layout, findings and store in its own bucket, and the administrators' run monitor (its reads, signals and answers) and the read routes for a run's board and conversation ([above](#how-the-agents-work-together)); the runtime (one session per agent, the launcher, the harness, the supervisor, continuation, checkpoints, sparse clones, the mount, scoped roles, the run monitor's signals, the images, the run's start and end, the agent roles' access to the board, the broker and the bus, the delivery function: built, not yet run against AWS, [above](#runtime-one-agentcore-session-per-agent)) |
| 3 | the language gate packs and the quality gate; skills and their history, the coach, agent memory, the benchmark gate for skill versions | in progress: the three gate packs and the quality gate step, as a CLI ([above](#the-quality-gate)); the skills' record, diff and versioned store with an administrator's acceptance and rollback, proposed to by the coach from a run's retrospective ([above](#getting-better-skills-the-coach-the-learning-loop-memory)); the agents' memory store and its recall for a task, its role lessons drafted by a run's retrospective (the recall in each fresh session's brief through the board's `memory` op since 7.50.00; same place); the benchmark gate for skill versions (no regression, a gain on the failure's case) and its record on a version, which a coach's version needs to be accepted, nothing invoking it yet ([Evaluation](#evaluation)); the coach (a failure in, a proposed version naming its expected benchmark case out, through the skills store, with its `skill.proposed` message for the caller to publish), invoked by the learning loop (same place as the skills); the learning loop and its scorecards, built: a run's end starts its retrospective (an asynchronous invocation of the runtime), which takes at most three failures to the coach (one Converse call each, once), drafts a lesson in agent memory for each failure taken to the coach (at most three per run) for an administrator to approve, and writes one create-only scorecard row per skill version per run, read by one bounded Query per version (same place); people's reactions on the host to a run's pull request as the loop's input (7.10.00: read through the broker by the runtime alone, trust-filtered and redacted, by one self-deleting schedule days after the run's end and by an administrator's hand, kept create-only, summed into the scorecards' human edits, and fed to the coach as quoted data only for a failure of the same run coached after a read, which today is rare: [People's reactions on the host](#peoples-reactions-on-the-host)); a connection's own cases from its failures, and the human edits on the scorecard screen planned |
| 4 | the agents, the six default flows and the new editor steps' server side, the reports, the run monitor's signals | in progress: the new editor steps' server side (engineering flows as `voc-workflow/2`, [above](#how-the-agents-work-together)), the six default flows as validated templates in one file the server lists (`GET /workflows/templates`) and the web app reads (same place), and the report builder with its administrators' REST reads ([Reports](#reports)), nothing invoking it yet; a run's start from a saved flow (6.25.00: `POST /agents/engineering/runs` and the flow page's Start a run, [How a flow starts](#how-the-agents-work-together)), which follows its own copy of the flow step by step since 6.28.00 (the conductor, the coordinator's `read_flow`, the board's check of every post and launch against the plan, a person at a step: [The flow a run follows](#the-flow-a-run-follows); memory, the learning loop, self-improvement and the history and pull-request shard sources not run yet); the agents' skills, one per launchable role with its tools, model and the Converse harness (6.29.00, [the agent catalog](#the-agent-catalog)), launched by the board with their skills' argv and driven through the Bug hunt and fix template on the local fake runtime with scripted models; their first run on AWS waits for the owner, and their broker writes for the harness's broker client |
| 5 | the UI: the templates and new steps in the editor, the run monitor (graph, board, conversation, live cost), skill histories and scorecards, the reports, the assistant drafting flows | in progress: the new steps in the editor (with a flow's monthly budget), Agents → Spend (the spend ledger by workflow, repository, run, agent, model or day, this month's share of each flow's budget, and the administrators' hard cap switch, [above](#cost)), and the run monitor (the flow with its steps lit: the revision the run copied, each step as the conductor reads it since 6.28.00, else its agents' steps; the run's flow budget and its alert flag, the board, the conversation, each agent as the supervisor saw it, an administrator's signals and answers, the reports with their versions; polling, no cost yet: [docs/autonomous-agents.md](autonomous-agents.md)), the assistant drafting flows behind its approval card ([above](#how-the-agents-work-together)), the assistant's "refresh the knowledge pack" (`propose_knowledge_refresh`: an approval card that only an administrator's Approve turns into the Understand flow's start, as that administrator, 6.27.00; same place), and the six templates in the library (Start from a template: an unsaved copy in the editor, saved through the library's own create; same place); live cost, skill histories, a template id in the assistant's `create_workflow` and the assistant's other run tools ("pull the latest from the repository") planned |
