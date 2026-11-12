# Autonomous engineering agents

> **Status: design.** This page describes the planned design of autonomous engineering agents. Every section is
> marked *Planned* until its code is in the repository; the present tense below describes the intended behaviour,
> not something that runs today. Nothing here is deployed by default, and nothing here costs anything until an
> administrator connects a repository and enables an agent (TENETS.md tenet 7).

Connect a GitHub or GitLab repository and let agents learn how the team works, then work the way the team works:
understand issues, hunt and fix bugs, build features, review pull requests. Every change an agent makes goes through
the same quality gate a careful team uses: deterministic checks for the repository's languages, review rounds by
reviewer agents (three by default), then a final go. The flows stop at the pull request: **a person always merges**.

The agents work like a team: each in its own sandbox (a Lambda MicroVM), talking through one event bus, picking
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
7. [Runtime: one MicroVM per agent](#runtime-one-microvm-per-agent)
8. [Reports](#reports)
9. [Getting better: skills, the coach, the learning loop, memory](#getting-better-skills-the-coach-the-learning-loop-memory)
10. [Models](#models)
11. [Trust and safety](#trust-and-safety)
12. [Evaluation](#evaluation)
13. [Cost](#cost)
14. [Phases and status](#phases-and-status)

## Large repositories and monorepos

*Planned.* Designed for them from day one.

- **Partial clones.** A checkout is `git clone --filter=blob:none` plus a sparse checkout of only the paths a task
  needs. History and pull requests are read through the host's API, in pages, never by cloning everything.
- **Shards follow the repository's own structure.** Workspaces are detected (Cargo, npm / pnpm / yarn, Gradle /
  Maven, Go modules, Bazel, Python packages), and so are code owners. A package is the unit of the knowledge pack, of
  the review and of the gate.
- **Change impact.** The workspace's dependency graph says which packages a change touches; the gate and the reviews
  run on those packages, and the full gate runs on the pull request's final tree (again after any fix it sends back).
- **Warm caches.** Checkouts are kept per (connection, commit) and dependency caches per (connection, lockfile hash)
  in S3, under the connection's own prefix, so a new agent starts warm; an agent reads only its own connection's
  prefix. Entries expire 30 days after they were written (the raw bucket's `engineering-cache-expiry` rule on
  `engineering/cache/<connection>/…`, with `-c engineeringAgents=true`) and are rebuilt when needed. Every shard has a size and
  time budget, and a shard too big is split again. Only trusted code writes the cache: the connector's broker writes
  the checkouts, and the cache filler (a step that runs no repository code: fetch only, from the lockfile, install
  scripts off) writes the dependency caches. A toolchain whose dependency resolution runs build files (Gradle, Maven)
  gets no shared dependency cache: its resolution counts as repository code with network (the registry list only,
  nothing customer-derived, no credential), in the sandbox, for that run only. No MicroVM that
  runs repository code writes to the cache.

## Repository connectors

*Partly built*: the broker's caller identity, operations per role and write rules, the GitHub client and the
credential reader (`voc-datalake/lambda/engineering/connectors/`), deployed only with `-c engineeringAgents=true`.
Planned: the run records and the board's GO ledger (phase 2's board), the bundle reader, the connection page that
stores a credential, the checkout cache by commit sha, sparse clones, and the GitLab client. Until the run records
land, the broker finds no run, so every permitted, well-formed operation still answers 503 and nothing reaches GitHub.

**What is built.** The GitHub client (`connectors/github.py`) reuses a cached installation token or, to mint one, signs
a nine-minute App JWT (RS256, the App's private key from the connection's parameter, below) for an installation token for the connection's one repository and
only the permissions the operation needs: a file or history read `contents: read`, an issue read `issues: read`, a
pull request read `pull_requests: read`, a comment `issues: write` or `pull_requests: write`, a push
`contents: write`, a draft pull request `contents: read` and `pull_requests: write` (`metadata: read` comes with
every token). A token is kept in memory until five minutes before it expires (GitHub's tokens live an hour). Reads
follow the `Link` header's next page (the cursor is that page number, nothing else); a pull request read returns the
pull request, its conversation, its review comments and its reviews, a page of each. A rate limit (`Retry-After`,
`X-RateLimit-Remaining: 0` with `X-RateLimit-Reset`, or a secondary rate limit) is never waited out inside a call: it
is answered 503 with `Retry-After`. A file path with an empty, `.` or `..` part is refused before any request, and a
file that is not UTF-8 text is refused rather than read lossily. A push takes the bundle as the bundle reader parsed
it (its base commit and each commit's changed files; its changed paths and added lines cover every commit, not only
the final tree). The client refuses a commit that changes a path the bundle does not list, and refuses unless the
branch's head is the bundle's base or, for a branch not on GitHub yet, the base is the default branch's head or an
ancestor of it (a base GitHub does not have is refused too). It rebuilds the commits with the Git Data API (a tree on
the parent's tree with text files inline and other files as blobs, then a commit whose author and committer are the
App's bot), refuses unless the last tree GitHub computed is the tree the broker checked, and only then moves the
branch with `force: false` (or creates it): a push made meanwhile that the new commit does not descend from makes
the update fail (a fast-forward of the same lineage still passes, so the head check before it is the lease). Objects of a refused push
stay unreferenced. A draft pull request is opened, or its title and body updated, only when the branch's head has the
checked tree, and the pull request's head is checked again afterwards: if the branch moved meanwhile, a pull request
the client just opened is closed and the write refused. An update changes only the title and body: GitHub's REST API
cannot turn a pull request someone marked ready back into a draft. Every request goes to `api.github.com` through one
transport, with no redirect followed; a token is sent only in the `Authorization` header, never in a URL or a log
line. The client has no method for a merge, an approval, settings, branch protection, members, webhooks or secrets.
Each write the host accepts gets an operational log line with the operation, the caller, the connection and what was
written (issue or pull request number, branch, tree hash, commit count), never a body, a bundle or a token; the
durable audit row (D4) comes with the run records.

| Host | Credential | Permissions it holds | Never |
|---|---|---|---|
| GitHub | a GitHub App installed on the chosen repositories; each token is minted for one repository and the permissions the step needs, refreshed before it expires | `metadata: read`, `contents: write`, `pull_requests: write`, `issues: write` | `administration`, `workflows`, `secrets`, `actions`, `members`, any organization permission |
| GitLab | a project access token, role Developer, scope `api` (no narrower scope covers merge requests and comments; it includes the repository read and write scopes), with an expiry; the connection page shows when it expires and takes its replacement | the same, through the API | Maintainer or Owner role; group tokens |

**The broker.** One Lambda, the connector's broker, is the only code that holds a host credential: no agent's
MicroVM ever holds one. Agents ask it for typed operations, and each role may invoke only the operations it needs;
the broker is reached only through a Lambda function URL with IAM authentication (as is the board's API, below), whose
request carries the caller's assumed-role ARN, and it takes the caller's role,
run and agent from the caller's assumed-role identity (the role is the agent role; the session name, which the
runtime's launcher sets and no agent can change, names the run and the agent), never from the request; the run's
connection comes from the run's record. A unit test pins a fixer's push, and a committer's push to another run's
branch, being refused:

| Role | Operations |
|---|---|
| every agent | read files, history, issues and pull requests through the broker; checkouts come from the cache it fills |
| issue understander, PR reviewer | post a comment on the run's own issue or pull request (from the run's record) |
| committer | push a git bundle to the agent's branch |
| PR author | open or update the agent's draft pull request |

Every operation goes through the connector's rules, which refuse, before the host would: a push to any branch but
the run's own (`voc-agent/{run_id}/…`, the run from the caller's session name), the default branch above all; a push
to a branch with an open pull request unless the board holds a GO for the new tree; a bundle with other than exactly
one head ref; a merge, an approval; any call to
settings, branch protection, members, webhooks or secrets; a change to the CI definition paths it knows (the GitHub
workflows and actions folders, the GitLab CI files: best effort, since a pipeline can include other files; the CI
attestation below is the real boundary, and the GitHub App holds no `workflows` permission); a write that carries
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
until it is there. GitLab is the same (a Developer token cannot
read the CI/CD variables).

**Credentials** are SSM Parameter Store SecureString parameters under the stack's customer-managed KMS key (the
standard tier has no monthly charge), one per connection, `/voc/engineering/{connection_id}` (`{workspace_id}/` is
prefixed once multi-workspace lands; a prefixed deployment puts its prefix on the `voc` segment,
`/<prefix>-voc/engineering/…`). A GitHub connection's value is JSON: `app_id`, `installation_id`, `repository`
(`owner/name`) and `private_key` (the App's PEM key). Only the broker reads them (`connectors/credentials.py`:
`ssm:GetParameter` on that path only, `kms:Decrypt` on the stack's key only through SSM and only for those
parameters), decrypted, kept in memory five minutes at most; a missing or malformed one answers 503 and is logged by
connection id and error code only. They are never put in a model's context, an event, a log line, a checkpoint or a
MicroVM. Stopping a run turns the broker off for that run at once: every further operation is refused before any
token is used. Tokens are not revoked early: each is minted for one repository and one operation's permissions, held
only by the broker, and expires within the hour.

**Who can read and use.** Connections, the code read from them, the knowledge packs, the conversations and the
workspace are readable by administrators only by default; a non-admin sees an engineering run only when an
administrator shares its connection with them, and then every feedback-derived field it shows (ids, counts,
categories, problem labels, in findings, reports, the conversation and memories) is filtered by the viewer's own
category and source access, not the run owner's; what the viewer may not see is left out. A flow can use a connection only when it is shared with the agent's
owner, checked when the workflow is saved and again when the run starts.

## The knowledge pack

*Planned* (voc-datalake/lambda/engineering/knowledge).

"How this repository works": **one overview plus one pack per package**, each refreshed only when its package
changes. Built by the Understand flow, read by the other agents.

**Map.** Each package is cut into shards that fit one small model call: its directories, its history in windows of
commits, its pull requests in pages with their review threads. Each shard yields notes, every note citing its source
(`path:line`, a commit sha, a PR comment's URL), written to the run's workspace. A repository larger than one run's
budget is mapped over several runs, each resuming at the first shard not yet mapped.

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

### The repository's tenets

The Understand flow also drafts the target repository's own tenets, a TENETS.md in the style of this sample's (what
the team optimises for, ranked, each with its evidence from the history: PR review comments, reverted changes, the
code style, the CI rules, the code owners), and its review guide, in the style of this sample's REVIEW.md. They are
mined from text anyone with access can write, and they become the gate's bar, so an administrator edits and accepts
them (versioned, like the pack); the review agents and the quality gate then use the accepted
tenets as their bar, as this sample's own tenets review does. Changes to them are proposed by the learning loop and
need a person. Nothing is written to the repository unless a person opens that pull request.

Storage: Markdown in S3 under `engineering/{connection_id}/knowledge/{package}/v{n}/`, the index rows (version, the
sha it was built from, author, approved by) in `voc-agents` (`REPO#{connection_id}` / `KPACK#{package}#{version:06d}`).

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
| Committer | turns patches into commits by the knowledge pack's "How we work" and has the broker push them to the agent's branch | commits on the agent's branch |
| Commit reviewer | reviews each commit against the review guide, before the quality gate | findings |
| Gate runner | runs the language gate packs on the affected packages ([below](#the-quality-gate)) | gate results |
| PR author | writes the description: what changed, why, the feedback ids it came from (never review text), the test evidence, the gate record | a pull request |
| PR reviewer | reviews a pull request, the team's own included, with the review guide; several of them run the gate's review rounds | review comments (never an approval), findings |
| Final go | the gate's last word ([below](#the-quality-gate)) | a verdict |
| Run coordinator | a small agent that watches the run's conversation and board and assigns the next task ([below](#how-the-agents-work-together)); not the existing agents' conductor, whose role it plays for these runs | events |
| Coach | proposes skill changes after a failure ([below](#getting-better-skills-the-coach-the-learning-loop-memory)) | skill versions, as proposals |

## How the agents work together

*Partly built*: the bus, the inbox router, the conversation and the board (`voc-datalake/lambda/engineering/bus/`,
`conversation/`, `board/`), deployed only with `-c engineeringAgents=true` (`voc-datalake/lib/stacks/engineering-bus.ts`).
What exists:

- **The bus**: the `voc-engineering` EventBridge custom bus (no archive; its policy denies `events:PutEvents` to every
  principal but the board API's role and the agent roles with a voice, each pinned to its own source: "The agents'
  access", below), and its schema, voc-msg/1, checked in code
  (`bus/schema.py`: the envelope, the type list, the claim-check rules on `refs`, no credential-shaped summary, 16 KB
  at most). `bus/publish.py` is the one publish helper: it checks a message against the schema before `PutEvents`,
  and a message about a recorded change takes its event id from the change, so a retry is a redelivery.
- **The inbox router** (`bus/router.py`, the `voc-engineering-router` Lambda): one fixed rule sends every event of
  the account on the bus to it. It checks the schema and the sender (`bus/senders.py`: the event's `source` names the
  sender, and only the allowed sources may send each type, for their own run only), writes the message to the run's
  conversation, then fans it out (`bus/routing.py`): a posted task to its role's queue, a message for an agent or the
  conductor to the delivery function. It drops, and journals with the reason and never the content, a malformed
  message, a sender that may not send it, a run that does not exist and an event id reused for other content.
- **The conversation** (`conversation/store.py`): one row per message in the `voc-engineering` DynamoDB table
  (on demand, encrypted with the stack's key, point-in-time recovery, kept like `voc-agents`), never changed, the
  whole message kept (its sender the actor, its `at` the time). The sequence comes from a counter on the run's `META`
  row, and an event's marker is written with its row in one transaction, so a redelivered event changes nothing.
- **The board** (`board/store.py`, `board/api.py`, the `voc-engineering-board` Lambda behind a function URL with IAM
  authentication and no resource-based policy): `post`, `claim`, `renew` (the heartbeat) and `move`, each a
  conditional write on the same table. The caller's role, run and agent come from its assumed-role identity, as for
  the broker. A post counts the task against the run's cap, dedupes an equal task, and nests at most 3 deep. Who may
  post for whom: the coordinator for every role, the hunter for fixers, the builder for builders. A claim leases an
  open task of the caller's role for 5 minutes. Renew and move need the lease and its epoch. Each change is published
  on the bus as the board's `task.*` event after the row is written. A failed publish answers 503, and the retry
  publishes the same event again.
- **The role queues**: one SQS queue per task-pulling role (`bus/schema.py` ROLES), encrypted with the stack's key,
  redriving to `voc-engineering-dlq`. That one dead-letter queue also takes the events the rule could not hand the
  router, the router's invocations that failed every retry and the runtime's undelivered supervisor ticks, and
  alerting watches it like the platform's other
  failure queues. The role queues are fixed per role, not made per run as described below, and serve every run, so
  no agent role reads them: a run's posted tasks are to reach its own agents through the delivery function.
- **The agents' access**: the [runtime](#runtime-one-microvm-per-agent)'s agent roles call the board's and the
  broker's function URLs, and put events on the bus only with their own source; the bus's policy admits the board's
  role and the agent roles with a voice (all but the coach: Runtime → Not aligned yet) and nothing else, and denies
  each agent role every source but its own.

Not built yet: the router's side of delivery (it holds no invoke on the [runtime](#runtime-one-microvm-per-agent)'s
delivery function yet, sends a posted task to its role's queue rather than to it, and invokes it with the bare message
rather than `{"message", "seq"}`), and the board's
`inbox` op, so a run's posted tasks reach its agents only through the board; the run coordinator; the workspace. The rest of this section is the
design; where the built message types and queues differ from it, the code (`bus/schema.py`, `bus/routing.py`) is what
holds, and the design's type table and per-run inboxes are what the next slices bring the code to or the table to.

**The bus.** One EventBridge custom bus carries every message between agents, as events of one schema. The schema
lives in this repository; the one publish helper and the inbox router check every event against it (EventBridge
itself does not validate events).

| Field | What |
|---|---|
| `run_id`, `thread_id` | the run, and the thread inside it |
| `from_agent`, `to` | the sender; an agent or a role |
| `type` | the board: `task.posted`, `task.assigned`, `task.claimed`, `task.progress`, `task.review`, `task.done`, `task.failed`, `task.needs_human`; the talk: `finding`, `question`, `answer`, `review.requested`, `review.result`, `handoff`; the gate: `gate.go`, `gate.no_go`; people: `decision`, `stop`, `message`, `signal` (save, pause, resume, shut down, stop now); the runtime: `pause`, `pause.ack`, `continued`, `timed_out`, `run.health`; skills: `skill.version`; the run: `methodology` (a skipped methodology step, tenet 2), `run.done`, `run.failed` |
| `body` | a short summary |
| `refs` | S3 keys, commits, files, knowledge-pack versions |

Events stay small (EventBridge's limit is 256 KB, and it bills per 64 KB): an event carries ids, a short summary and
the S3 keys of its payload (the claim-check pattern), never findings, diffs or logs, never a token, and never
customer text (feedback ids only).

**Nobody can speak for someone else.** There is one fixed execution role per agent role (never a role per run). The
runtime's launcher, trusted code outside any MicroVM, assumes that role for each agent with its connection, run and
agent ids both as session tags (for the IAM conditions below) and in the session name (for the broker and the board's
API, which see the caller's identity but not its tags; the name holds a 26-character run id and a short agent index,
inside the 64 characters a session name allows, pinned by a test) (the roles' trust policy allows tagging only to the launcher, and no agent role may assume
a role), and hands the MicroVM that session. Sessions are short (15 minutes) and renewed only by the launcher, which
refuses a stopped run's agents, so stopping one run cuts its sessions without touching another run's. How a MicroVM
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
progress and moves through it), `skill.version` only from the API, and the talk (`finding`, `question`, `answer`,
`review.*`, `handoff`) from the run's own agents, with a person's `answer` from the API; the runtime's `pause`,
`continued`, `timed_out` and `run.health` only from the supervisor, `pause.ack` only from the paused agent, and
`methodology`, `run.done` and `run.failed` only from the board's API and the supervisor (trusted code, on the run
coordinator's or the flow's word). And the broker opens
a pull request only when the board holds a GO for that exact tree's hash. A person's `decision` and `stop` are thus
published only by the API, which writes the signed-in user; a decision needs an administrator, or a person the
connection is shared with to manage, not only to view.

**Inboxes and roles.** One fixed rule sends every event to the inbox router (a Lambda). The router puts a posted task
in its role's queue for that run (mapper, understander, hunter, fixer, committer, commit reviewer, gate runner, PR author, PR
reviewer, builder, final go; the run coordinator's and the coach's own tasks, such as the retrospective, come
assigned, to their inboxes), and an addressed event in its addressee's inbox, an SQS queue per agent of the run, so a
suspended agent resumes and reads it: EventBridge is the bus, SQS the queue. A queue belongs to one run, so no agent
ever sees another run's task. The rules are fixed, never made per run, so the bus's rule quota does not limit how many
runs work at once; a run's queues are made when it starts (an agent's inbox when it joins) and deleted when it ends.

**The board.** A run's work is a board of tasks: open → claimed → in progress → in review → done, failed or needs a
human. An agent takes a task through the board's API, which claims it with a conditional write on its row (DynamoDB,
one owner per task); the agent holds it by a lease that its heartbeat renews (a call once a minute, not an event); a lost lease frees the task for
another agent, which resumes it from its checkpoint. An agent suspended on an open wait (its `question`, a
`review.requested`, a human decision point) keeps its lease while the wait is open. Tasks are pulled: an agent of
the right role takes the next one from its role's queue; the run coordinator posts and orders tasks and may hand one
to a named agent (`task.assigned`). Agents post tasks within the run's budget and the flow's rules.
A person can post, re-prioritise, block or take a task, through the API.

**The conversation.** Every event is also written to the run's conversation (DynamoDB, append-only, D1), which the run
view shows live as a chat between the agents beside the board. The person is a participant: their decisions, answers
and "stop" are events too.

**The run coordinator** (a small, cheap model) reads the conversation and the board and posts and orders the next
tasks; it decides when an agent's work is done and when the run has reached what it is allowed. When it sees an agent
going in circles (the same step repeated), it tells the supervisor, which alone stops an agent and re-posts its task. The flow's definition, in the workflow editor, says who may talk to whom and what ends the run (the pull
request opened, or a human decision point).

**The workspace.** Findings and outputs live in S3, by agent and commit:
`runs/{run}/{agent}/commits/{sha}/{package}/{shard}.jsonl` (each finding with `file:line`, its evidence, a severity
and the rule or reviewer it came from), with logs, the gate packs' outputs and patches under the same commit. The
agent comes right after the run, so a write rule on the agent's own prefix cannot be matched by a key that only
mentions it later, and `{package}` is encoded (a package path has slashes). A reduce reads only the keys the board's
API recorded for each agent. Objects are immutable (one per shard and agent; a new attempt is a new object), so map
steps never collide. A run reuses only its own objects; what later runs share is the cache. Encrypted, private,
readable as the connection is. One lifecycle rule for the whole workspace removes each object 90 days after it was
written (built: the raw bucket's `engineering-runs-expiry` rule on the runs' keys, `engineering/runs/<run>/…`, its noncurrent version
removed a day later, deployed with `-c engineeringAgents=true`; a retention set per deployment, never under 75 days,
is *planned*). The run is to record the retention it ran under (D4), and when a run's objects have gone, the
supervisor is to write one `AUDIT#delete` row for the run (who: the workspace retention rule; what went; under which
retention; when), as D5 asks of every workspace delete (both *planned*).
No run outlives it:
the supervisor stops a run at 30 days at a human decision point that offers only "stop", and a decision point left
open for 30 more days closes the run. The board and the indexes point at the keys; the reports keep the summaries they cite, so they stay
whole after the objects go. Findings, notes, checkpoints, conversation and memory hold feedback ids, never review
text: no engineering agent reads review text at all (the hunter gets ids, counts, categories and problem labels), and
the customer-text check that guards host writes also runs in the publish helper and on workspace and memory writes,
so an erasure (D5) has nothing to chase there.

**Default flows.** Six flows ship ready to run, each a template in the workflow editor that a team can change:

| Flow | Steps | Stops at |
|---|---|---|
| Understand the repository | map shards → reduce → draft knowledge pack versions and the repository's draft tenets and review guide ([below](#the-repositorys-tenets)) | an administrator's approval |
| Issue triage | understand → classify (bug, feature, investigation) → reproduce or locate → propose | the proposal on the issue |
| Bug hunt and fix | hunt → understand → fix → commit → commit review → quality gate → PR | the draft pull request |
| Feature | understand (issue or PRD) → plan → build → commit → commit review → quality gate → PR | the draft pull request |
| PR review | read the PR → reviewers in parallel, one pass, against the repository's tenets and review guide → comments | the review comments |
| Self-improvement | the coach's loop over past runs → skill-version proposals → benchmark | an administrator's acceptance |

**New steps in the workflow editor**, each with its settings, a palette entry and validation rules, like the existing
steps and loops: Agent (a role from the catalog, with its skill version, model and budget), Map (fan-out over shards,
with its sharding rule) and Reduce, Board (post or claim tasks), Quality gate (gate packs, rounds, final go), the
existing human decision point, Learning loop (retrospective → memory), Self-improvement (coach → proposal → benchmark
→ acceptance), Memory read and write, and Stop at PR (the flow's end on a draft pull request; the validation refuses
a flow that pushes code, one with a committer, without it, and there is no merge step at all).

**From the assistant.** Describing a flow ("every night, hunt bugs in the payments package and open PRs for the ones
you can fix") makes the AI assistant draft it in the editor behind an approval card, like its other writes; "refresh
the knowledge pack", "pull the latest from the repository" and "what is agent X doing" work from the assistant too,
through the same REST routes and MCP tools as everything else (tenet 4).

**The run monitor.** The run view shows every agent's status and where it is in the flow (the editor's graph with the
live step highlighted), the board and the conversation. Inspecting an agent shows its current step, its last progress,
its heartbeat's age, its MicroVM's state and age, its recent tool calls and, when it looks stuck, why (no progress for
N minutes, the same step repeated). A person can message the run coordinator or an agent as a participant, and send
signals: Save (checkpoint now), Pause, Resume, Shut down (checkpoint, then stop) and Stop now. Stop now is the
[Stop](#trust-and-safety) of the run view, enforced by the supervisor, the launcher and the broker without the
agent's help; Shut down falls back to it if the checkpoint does not come; Resume is refused for a stopped run.
Messages and signals
are API calls with the signed-in user, allowed only to whoever may make a `decision`, published as `message` and
`signal` events that the router accepts only from the API's own source; an agent reads a person's message as DATA,
like everything else, and its work still goes through the gate. Cost and tokens show live per agent, per run and per
flow (model tokens in and out per model, MicroVM seconds, events), against the run's budget.

The commits are made before the gate, so the gate reviews exactly the tree that is pushed.

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

**How a flow starts.** A bug hunt is started by an administrator (Run now, or the agent's schedule, which only an
administrator sets or changes, checked when the agent is saved and again when the run starts), scoped to packages; in a hunt the understander writes its problem statement on the board's task, not on the host. On a public
repository, a flow that starts from someone's text starts only from an issue or pull request a maintainer labelled
for it. A pull request from a fork is only ever reviewed (comments), never fixed or pushed to.

## The quality gate

*Partly built*: the packs and the step, run as a CLI (`python -m engineering.quality_gate plan|check|gate`) that the
gate runner's MicroVM is to run; nothing deploys it yet (the [runtime](#runtime-one-microvm-per-agent)'s images do
not ship it, and the workflow editor's Quality gate step is phase 4). What exists:

- **The packs** (`voc-datalake/engineering-gates/`, [README](../voc-datalake/engineering-gates/README.md)):
  `rust-ts`, `python-ts` and `java`, each a `manifest.toml` (schema voc-gate-pack/1: the languages' markers and
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
   TypeScript, Java to start) run in the gate runner's MicroVM: format, lint, types, tests, the repository's own scripts
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

## Runtime: one MicroVM per agent

*Partly built, not yet run against AWS* (voc-datalake/lambda/engineering/runtime, the images in
voc-datalake/engineering-images, the stack in voc-datalake/lib/stacks/engineering-runtime.ts; deployed only with
`-c engineeringAgents=true`; the harness inside each MicroVM is built too, behind the board, the inbox and the
broker, which it reaches through interfaces that refuse until the runtime is wired to them, below). The service's
limits, prices, quotas and regions, its API's operation and field names, how a MicroVM receives a role session, how
its egress allowlist is enforced and whether Mountpoint, `unshare`, `setpriv` and `iptables` run inside one are not
yet checked against the AWS documentation; until they are, the flag stays off, and this section is corrected to what
is verified.

The runtime names its agents as the [broker](#repository-connectors) and the
[bus and board](#how-the-agents-work-together) read them: its roles are `connectors/identity.py`'s AGENT_ROLES (one
list, shipped in the images), its role names the broker's `voc-eng-{role}` pattern, its session names
`<run ULID>.<agent index>` and its bus sources of the shape `bus/senders.py` parses. Not aligned yet (the runtime's
next slice):

- **Workspace keys.** An agent role may write only `engineering/runs/<run>/<agent>/*` in the raw bucket
  (`engineering-runtime.ts`, `WriteOwnKeys`), while the board accepts an agent's result keys only under
  `ws/<ws>/runs/<run>/<agent>/attempt-<epoch>/` (`board/store.py`) and the bus's `refs.s3` only under `ws/<ws>/`
  (`bus/schema.py`). Both cannot hold: whatever an agent can write, the board and the router refuse to reference,
  and the reverse. One workspace layout (and the bucket it lives in) has to be chosen and both sides moved to it.
- **The gate runner's voice.** Its sessions are pinned to `voc.engineering/agent/gate-runner/…`, which
  `bus/senders.py` drops: its agent sources accept only the roles of `bus/schema.py` ROLES, the roles with a task
  queue, and the gate runner has none.
- **The coach's voice.** It may not put events on the bus at all yet: senders.py knows the coach only as the
  service source `voc.engineering/coach`, which names no workspace or run, so a coach session could speak, as the
  system, in any run. It gets a voice with a run-scoped coach source.
- **Posted tasks.** A role's task queue (`voc-eng-tasks-<role>`) serves every run, and IAM cannot narrow a queue
  to a run, so no agent role reads one (one run's agent would see, and could delete, another run's task notices).
  The delivery function (below) records a run's posted tasks in that run's inbox, but the router still sends them
  to the role queues, and the board's `inbox` op is not built: until both are, an agent learns of its run's tasks
  only from the board, which serves the caller's run only.
- **The harness.** Its board, inbox and broker interfaces still refuse every call.

Each agent of a run runs in its own Lambda MicroVM, from its language's image, with its own sparse checkout from the
cache. The idle policy suspends a MicroVM after 5 minutes without a request and ends one suspended for an hour; the
supervisor ends a finished agent's MicroVM at once. An agent on an open wait (its question, a review it asked for, a
human decision point) keeps its task and is outside every clock: the supervisor suspends its MicroVM, wakes it to
deliver a run monitor's signal or when the wait closes, and for a wait still open after 45 minutes (or once the
MicroVM nears its 8-hour limit) asks it to checkpoint and pause, holds it without a MicroVM (`waiting`), and
continues it in a new one once the wait closes.

- **No host token in any MicroVM.** Nothing in a MicroVM reaches the repository host: the
  [broker](#repository-connectors) holds the credential, fills the cache and makes every host write. An agent's egress
  allowlist is Bedrock, the run bucket's own S3 endpoint (never the regional one, which reaches every bucket) and SQS
  in its region, the broker's and the board's function URLs by name once the runtime is wired to them, and, for the agents that run
  repository code, its language's package registries (plus at most 10 configured hosts, a registry mirror for example).
- **Credentials from a launcher, never in the image.** A MicroVM starts with no AWS credential. The launcher (the
  supervisor's own code, outside every MicroVM) assumes the agent role's ONE fixed execution role (one per agent role,
  never one per run; its IAM name `voc-eng-<role>` with the stack's naming, the roles spelled as the broker spells
  them, `commit-reviewer`, `gate-runner`) with session tags naming the workspace, the run, the agent and the
  connection (`ws`, `run`, `agent`, `connection`), and the session name `<run>.<agent index>` (a ULID run id and an
  index of 0 to 999, which the broker and the board's API read as the caller's identity, the agent being
  `<role>-<index>`: an agent's identity is its role's IAM name and that session name together, which always fit IAM's
  limits, so no two agents of a run share one). The session lasts
  15 minutes and goes to the runner, which keeps it as the agent user's `credential_process` answer in `/run/voc`, a
  directory only root writes (so nothing planted there can redirect root's writes), readable by the agent user only
  and named to the agent's own commands, never to repository code. The supervisor renews it each tick it has under
  6 minutes left, and the launcher refuses a stopped run's agents, so a stop cuts that run's sessions within
  15 minutes although the roles are shared (its MicroVMs are ended at once anyway). The agent roles trust only the
  launcher's role, which alone may tag their sessions; they may assume no role themselves.
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
  still running. The entry point's code firewall, first in the output chain, stops `code` from reaching anything on
  loopback, the runner's port on any address and link-local addresses (name lookups on port 53 excepted), over IPv4
  and IPv6; without every rule in
  place the runner refuses the dependency step. Repository code runs under umask 0002, the agent's own commands under
  0022, and the checkout opens only its working tree to the group. The session lives on a file system of its own
  (a tmpfs at `/run/voc`) and the kernel's protected hard links are turned on, so repository code cannot hard-link
  the session into the checkout; unless one of the two holds, the runner runs no repository code at all. A killed or timed-out command is ended with its whole process group, and a boxed command's
  namespace dies with it.
- **Sparse partial clones.** The broker keeps a partial clone per connection in the cache, under
  `engineering/cache/<connection>/`. With its first session the runner mounts that prefix read-only at `/mnt/voc-cache`
  (Mountpoint for Amazon S3; nothing is written through it), and the agent clones from it with `--filter=blob:none`
  and a sparse checkout of only its task's paths (at most 200), then checks out the task's commit. The agent user runs
  every git command with the system config, terminal prompts, hooks, the file-system monitor, the pager, external diff
  tools and credential helpers off, and with git's own file modes (`core.sharedRepository=0644`, whatever the
  umask). The git directory lives beside the working tree (`/work/repo.git`, which repository code cannot write)
  and is made read-only to the group, and every agent git command runs from the working tree's root naming it and
  the work tree (no discovery; a bare repository is used only when named; what git writes, a restored patch
  included, lands inside the working tree), so repository code can change the working tree but neither the git
  directory nor which one the agent's git reads: a `.git` or a repository it plants in the working tree, with
  its config and filters, is never the agent's.
- **Scoped roles.** Each agent role reads only its connection's cache prefix and its run's workspace
  (`engineering/runs/<run>/`), writes only its own keys there (`engineering/runs/<run>/<agent>/`: the agent comes right
  after the run, so no other agent's key matches), reads no queue (the role queues serve every run; its run's
  messages are to be pushed to it by the delivery function, not built yet), calls the board's and the broker's function URLs (`lambda:InvokeFunctionUrl`, and the invoke behind it only through a function URL), may
  put events on the bus only with its own source
  (`voc.engineering/agent/<role>/<ws>/<run>/<agent>`, the run coordinator's `voc.engineering/conductor/<ws>/<run>`;
  an explicit deny in its own policy and another in the bus's, which admits only the board's role and the agent
  roles with a voice), calls the allowlisted models, and deletes nothing. No MicroVM
  auth token is ever put in an event, a log, a row or a checkpoint: it is minted when needed (at most 60 minutes),
  refreshed 5 minutes before it lapses, held in memory only, and refuses to be serialised.
- **Delivery.** voc-engineering-delivery, the function the inbox router invokes for a message to an agent, the
  run's conductor or a role of the run (a posted task): the supervisor's code and role. It records the message
  once in that run's inbox, `WS#<ws>#RUN#<run>` / `INBOX#<addressee>#<seq>#<event_id>` in voc-engineering (the
  addressee `agent:<agent>`, `conductor` or `role:<role>`; the seq its place in the conversation, kept on a
  redelivery, so a conditional put makes a redelivery write nothing; a message without its seq is refused), and
  wakes the run's live addressees: a working agent's MicroVM suspended for an open wait is resumed with a fresh
  session and kept awake 10 minutes (`wake_grace`, which a later message does not extend) so its harness reads the
  message and closes the wait, an agent held without a MicroVM is continued in a new one (once per wait), and a
  booting or pausing one reads its inbox once it runs. The wait's 45-minute hold counts from the wait's start,
  awake or not, so messages cannot keep a MicroVM running; only the one continuation a message makes per wait gets
  one grace before the hold applies again, to read the message, starting when its harness starts (a slow checkout
  does not eat it) and moved by no later message; a continuation after it (a crash, its own pause) gets none. (The wait's start is when a tick first saw it open: a
  wait closed and reopened between two ticks counts as one, held sooner; the board's lease carrying its wait's
  own start would end that.) Nobody is woken in a run that ended, is past its 30 days
  or spent its budget: the message waits in the inbox. No queue: a suspended MicroVM cannot poll, so delivery is a
  push. An addressee another move holds, or whose wake failed, fails the invocation; Lambda retries it twice (the
  row already there, only the wake repeats), then it goes to `voc-engineering-dlq`, and that agent is reached only
  when its wait's hold or a later message wakes it. Nothing deletes an inbox row; the board's `inbox` op reads the
  caller's run's rows after a seq cursor, and the harness keeps each message once by its event id.
- **The run's start and end.** The runtime's `start_run` writes the run's `META` row in voc-engineering
  (`WS#<ws>#RUN#<run>` / `META`: its task cap, which the board counts its tasks against, its hard caps on tokens and
  cost, its goal, repository, flow, status and start time, on which the router numbers the conversation) once, and
  lists it for the supervisor (`WS#<ws>#RUNS`, a row per run, in the same transaction); `end_run` sets its status
  (`done`, `failed` or `stopped`) and end time, ends every MicroVM of it, and the run stops being listed once none
  of its agents is live (one busy with another move is ended by the next tick, which sees the run ended). A retried
  start or end does what the first one left undone. After that first write only the run's own attributes are ever
  updated, never the board's or the router's counters. A run's agents are launched only while it is active, checked
  in the same write as the agent's row, so a run that ends meanwhile gets no agent nothing supervises. The
  supervisor reads its caps, its spend (its agents' tokens and what was priced on their rows), its start and its
  end from there; a human decision point is the run's status, and a Resume of the whole run makes it active again
  (never the 30-day one, which offers only "stop"). An agent's tokens are those of every MicroVM it ran in, not
  only the current one's.
- **Sessions.** One row per agent of a run, the board's own `AGENT#<agent>` row in the run's partition: ids, times,
  the MicroVM's id and endpoint, the boot step, the continuation count, the checkpoint it restored from, the run
  monitor's inspection data, the live cost counters and what the reports read (role, model, skill version, MicroVM
  seconds, tokens in and out). The row is created once and then only its own attributes are updated, so what the
  brokers add to it (the cost they priced) is never written over. The supervisor finds the live sessions through the
  listed runs (the table has no index). Every write is conditional on the row's sequence number, and every move first claims the row for at most
  5 minutes (a claim nobody else can take while it holds), so a tick and a run monitor's signal never move one agent
  at once; a continuation that loses its write ends the MicroVM it just started.
- **No fixed task cap: activity decides.** An agent runs as long as it makes progress (its lease's last progress on
  the board) and its heartbeat renews its lease. For a running agent, no progress for 10 minutes (2 to 60, per deployment)
  and the supervisor asks it for its state (a `question`); no progress within 3 minutes and it is stopped and its
  task re-posted from its checkpoint (`timed_out`); the run coordinator, which is not a task on the board, is
  restarted like a crash instead. An agent on an open wait keeps its task and is outside the rule.
  A lease not renewed for 3 minutes is a crash; so are a MicroVM whose calls fail three ticks in a row (gone, or
  never came up; a failing board, bus or launcher counts for nothing) and a boot (checkout and harness start) over
  30 minutes. The board counts re-posts: a task that
  times out twice is split or goes to a person. Model tokens and cost stay hard caps set by a person: past one, the
  run goes to a human decision point, every agent is checkpointed and held (`paused`, resumable once the cap is
  raised; raising a run's cap is not built yet, so today a person can only end the run from that decision point; until
  then it stays listed and the supervisor keeps ticking), and no new MicroVM starts.
- **The supervisor.** voc-engineering-runtime, invoked every minute by an EventBridge rule created disabled (TENETS.md
  tenet 7: schedules run on EventBridge rules). `start_run` turns it on; once no run is listed (after an `end_run`
  or a tick), it is turned off and the list re-read, and turned back on if a run started meanwhile. Each tick it renews sessions, boots new agents (the checkout, then the harness), judges each
  running agent as above, ends finished ones, continues paused and crashed ones, restarts a run coordinator that
  stopped answering or crashed, honours a run's end and a stop (a person's, an agent's kill switch, and the 30-day
  stop, which opens a human decision point offering only "stop"): every MicroVM of the run ended at once, without waiting for the agents.
  It emits `run.health` (counts by status, tokens, cost, inbox backlog). One agent's failing call is logged and never
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
  done, and the caller sends the signal again. For each agent the row carries its current step and recent tool calls (the
  harness's own report, bounded and scrubbed), its last progress, heartbeat age, MicroVM state and age, why it looks
  stuck, the last failed command's exit code and output tails, its MicroVM seconds (only while a MicroVM is up and
  not suspended) and its tokens per model.
- **Continuation past the 8 hours.** At 7 h 30 of a MicroVM's life by default (1 h to 7 h 40, per deployment) the supervisor
  sends a `pause`; the agent finishes its step, saves its checkpoint and exits its harness with code 75, its
  acknowledgement (it may also say `pause.ack` on the bus); the supervisor ends that MicroVM and starts a continuation
  in a new one, as the same agent and task, from the newest valid checkpoint, and emits `continued` (the continuation
  number, after a pause or a crash, the checkpoint). An agent pausing itself the same way, before a step longer
  than its MicroVM has left, is *planned* (the harness has no such tool yet). One that has not paused by 7 h 50 is treated as a crash, on an open wait too; one asked to pause for a long wait
  whose checkpoint does not come within 3 minutes is held as waiting, without its MicroVM, from its last checkpoint. A crash (an exit other than 0
  and 75, a lapsed lease) is continued twice in a row at most, then the task is re-posted (the run coordinator: the
  run goes to a person). Any number of continuations otherwise.
- **Checkpoints.** An agent saves each checkpoint as a new object,
  `engineering/runs/<run>/<agent>/checkpoints/<seq>-<nonce>.json`: its position, plan, notes and the key of its
  working tree as a patch (a continuation starts a fresh conversation from its notes). The supervisor restores from the newest of the last 5 that is at most
  256 KB, plain JSON with a `position`, and holds no token and no key that names a secret; with none, the task starts
  afresh.
- **Output.** The runner masks anything shaped like a credential (AWS keys, host tokens, bearer headers, private
  keys, `name=value` and JSON `"name": "value"` pairs whose name says secret) and keeps the last 4,000 characters of
  each stream; the runtime
  masks them again on receipt.
- **The harness** (voc-datalake/lambda/engineering/runtime/harness; `/usr/bin/python3 -I /opt/voc/harness.py run
  --adapter converse|cli --model <id>` as the agent user, from root-owned `/opt/voc`, outside the checkout). Inside
  each MicroVM the agent runs through one harness interface with two adapters, chosen per agent in its skill: a plain
  Bedrock Converse loop for small agents, or a coding-agent CLI in its headless mode. Whatever the adapter, it gets
  only the task's brief, its knowledge-pack and memory slices and the platform's tools: read, list and write files
  of the checkout (walked one directory at a time, never through a link, never into `.git`, never a file with two
  hard links), run a repository command (through the runner, as the sandbox user, without network; a command
  still running reports progress once a minute), install the dependencies (the one command with the registries,
  before any other), report progress (through the board's API), save a checkpoint, submit the work (a patch made
  by the agent's own git, one at a time, refused when a file it holds has two hard links or when it is over 50 MB,
  put under its own keys and handed to the broker, which alone writes to the host) and finish (its summary is the task's last progress); the agents that
  run no repository code get none of the code tools. It renews its task's lease once a minute. Everything from the
  repository, the knowledge pack, the memory or a checkpoint reaches the model fenced as data, which its
  instructions say is never an instruction. Between turns it reads its inbox: `save` checkpoints at once, `pause`
  checkpoints and exits 75; the Converse loop also checkpoints and pauses after 150 turns in one MicroVM or once a
  call's input passes 120,000 tokens (a fresh conversation from its notes). On any error either adapter saves a
  checkpoint before the crash is raised. A checkpoint carries the agent's
  working tree as a patch under its own keys, which the continuation applies to its fresh checkout and opens to
  repository code again, as the checkout does (one that
  does not apply is a crash, never a silent loss; one the patch rules refuse is saved without it and says why),
  and is written only when the supervisor would accept it (too big, its notes are cut). Which CLI follows the repository's
  own AI reviews (kiro-cli, else claude), minus any that needs an endpoint or login other than Bedrock with the
  agent's session: kiro-cli signs in to its own service, so it is not offered; `claude` runs at one pinned version
  only, with every built-in tool of its own off (`--tools ""`), the platform's tools from the harness's own tool
  server alone (`--strict-mcp-config`), in a fresh home outside the checkout (`HOME` and `CLAUDE_CONFIG_DIR` there,
  so no repository's or user's hooks, tool servers, steering or instruction files, or settings are loaded), with an
  environment the harness builds and Bedrock through the agent's session; a test plants each kind of such
  configuration in a checkout. Each `save_checkpoint` of a CLI is saved at once (and once more before a crash),
  other inbox messages reach it with its next tool result, and its whole process session is ended on every way
  out. It holds no host credential. It reports its status (step, recent tool calls, tokens
  per model) to the runner; a CLI agent's tokens are not counted yet (*planned*: the CLI's own usage report). The images ship it with boto3 pinned (`BOTO3_VERSION`), and everything they run needs
  nothing newer than Python 3.11 (their system `python3`; a test checks every shipped module). No image installs
  a CLI yet: the CLI adapter refuses one that is missing or not the pinned version.
- **Images.** python, node, rust and java, each a Dockerfile in this repository on one shared base (git, util-linux,
  iproute2, iptables, Python for the runner, Mountpoint for Amazon S3, the two users) and one entry point, with ready
  hooks that warm the toolchain caches (only from that language's registries) and validate hooks that prove the
  toolchain and the runner; the hooks run as root before any repository code, from `/`. Mountpoint is pinned: an image is built with `MOUNTPOINT_VERSION` and the `.deb`'s
  `MOUNTPOINT_SHA256`, and the build fails without them or on a mismatch. The stack builds no image: the
  supervisor launches only the images named by `-c engineeringImageArns` (a JSON object from these four languages
  to image ARNs, checked at synth; `{}` by default, so every launch is refused until it is set). Building and
  registering the images, and removing old versions, are *planned*.
- **Behind an interface.** The runtime is an interface with the AWS implementation and a local fake (a temporary
  directory and the same runner, which does not sandbox; it lives with the tests, so the deployed runtime cannot
  pick it); the supervisor's tests drive every path above on the fake,
  and the board, the bus and the run's controls through small interfaces with fakes until the runtime is wired to them (until then the
  deployed runtime's tick refuses rather than guess).

## Reports

*Planned.* Three levels, each a versioned document of the run, built from the workspace and the events, readable in
the run view and through REST and MCP, each naming the agent versions that made it:

- **Commit report**: what the commit changes and why (its task), the gate packs' results, each review round's
  findings and what was done about each, the final verdict, cost and time.
- **PR report**: the commits' reports rolled up, the PR review, the test evidence, the risks and what a person should
  look at, the gate record (it goes in the PR description).
- **Goal report**: the run's objective ("find and fix the top bugs in the payments package", "build feature X from
  its PRD"), the board's outcome (done, failed, needing a person), the pull requests opened and their state, what is
  left, total cost and time, what the agents learned (proposed knowledge-pack edits, for a person to accept) and what
  improved since the last run.

## Getting better: skills, the coach, the learning loop, memory

*Planned* (voc-datalake/lambda/engineering/skills, coach and memory).

**Skills, visibly and reversibly.** An agent's skill (instructions, examples, tool policy, model, harness) is
versioned. Each version keeps its diff, why it changed (the run, the failure, the person's comment), the benchmark
before and after, and who accepted it; a run records the versions it used, every report names them, and one click
rolls an agent back to an earlier version (a new version that restores it, so the history stays whole, D1). No
version change goes unannounced: it is an event in the run and in the agent's history ("Fixer rewrote its skill: v7 →
v8, two more examples, a stricter test rule").

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

**The learning loop.** After each run, a retrospective (the run coordinator's last task): what people accepted, changed or
rejected (review comments on the agents' pull requests, edits after merge, reverted commits), what the gates caught,
what timed out. Lessons go to memory and to the coach. A scorecard per agent version (pass rate, human edits needed,
review rounds needed, time, cost) shows how each version does over time.

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
- **Draft pull requests in every mode.** A person marks one ready and merges it. Tenet 3's dial today covers PR/FAQs
  and PRDs only ([ways-of-working.md](ways-of-working.md)), so these flows do not read it. Letting the dial decide how
  far a flow goes (Human-driven: proposals only; AI-assisted: draft pull requests; AI-driven: ready pull requests) and
  whether a passing skill version applies itself would widen tenet 3; it is proposed as a TENETS.md change of its own,
  for the owner to agree, and lands only with it.
- **Repository text is data, never instructions.** READMEs, code, issues, PR comments, the knowledge pack, memories,
  other agents' messages and customer feedback (which anyone can send through the public forms) reach a model inside
  DATA blocks. That lowers the risk of a planted instruction; it does
  not remove it, so what keeps the repository safe is what the agents cannot do: no host token in any MicroVM, each
  role limited to its broker operations, no forged messages, the agent process limited to the platform's own
  endpoints, the connector's refusals, the host's branch rules, a person merging. A test plants instructions in a fixture
  repository and in fixture feedback and checks that none of them gets past those limits.
- The connection's credential never reaches a model; secrets committed in the repository itself can, which is one
  more reason output is scrubbed. Every action is an event in the run's conversation with its actor
  (`agent:{agent_id}` and the skill version), time and reason (D4).
- **Stop.** A person's **Stop** on the run view (an API call, journalled as a `stop` event) does not wait for the
  agents: the supervisor ends the run's MicroVMs at once, the launcher stops renewing their short role sessions (which
  lapse within 15 minutes, and serve no ended MicroVM meanwhile), and the broker refuses the run's operations. Enabled only stops new runs.

## Evaluation

*Planned* (voc-datalake/lambda/engineering/benchmark).

A benchmark of small fixture repositories (written for this sample, MIT, in the test fixtures; a monorepo among them):
known bugs with their fixes, pull requests with known review findings, features with acceptance tests. Each agent is
scored per model and per skill version on pass rate, cost and time; the results decide the model table above and every
skill version the coach proposes. The results on the sample's own fixtures are published on this page; a
connection's own fixtures stay with it.

## Cost

*Planned.* Nothing runs, and nothing is billed, until an administrator connects a repository and enables an agent.
Then, per use: model tokens (Bedrock), MicroVM time while an agent works (suspended while it waits), EventBridge per
event, SQS, DynamoDB on demand, S3 for the workspace, caches and packs, the supervisor's invocations while a run is
active. The connection's credential is a standard SecureString parameter, with no monthly charge. No NAT gateway and
no other fixed cost by default. The cost of each run (events, MicroVM seconds, model tokens) is measured and shown on
the run.

## Phases and status

Each phase ships its REST routes and MCP tools with it (tenet 4); phase 5 adds the screens. Making a connection,
sharing it, approving a knowledge pack or a repository's or role's memory, accepting the repository's tenets or a
skill version (rolling one back, promoting one to the shared skill), Run now and the schedule of a hunt, and the CI
attestation are admin work, the kind
TENETS.md's tenet 4 row already lists as having no MCP tool (an MCP token never acts as an admin); they stay REST only,
and the phase that ships them names them in that row.

| Phase | Scope | Status |
|---|---|---|
| 0 | this design, the benchmark harness and its fixtures | design written; the benchmark harness and fixtures planned |
| 1 | the connectors (GitHub, then GitLab) and the broker, credentials, read paths, sparse clones; the Understand flow, the knowledge pack per package and the repository's tenets | in progress: the broker's caller identity, operations per role and write rules; the GitHub client and the credential reader (no run records or GO ledger yet, so it still refuses every operation with 503) |
| 2 | the runtime (one MicroVM per agent, the launcher, the harness, the supervisor, continuation, the cache, the mount, scoped roles); the bus, inboxes, board, conversation, workspace | in progress: the bus, the inbox router, the conversation, the board API and the role queues ([above](#how-the-agents-work-together)); the runtime (one MicroVM per agent, the launcher, the harness, the supervisor, continuation, checkpoints, sparse clones, the mount, scoped roles, the run monitor's signals, the images, the run's start and end, the agent roles' access to the board, the broker and the bus: built, not yet run against AWS, [above](#runtime-one-microvm-per-agent)); inboxes and workspace planned |
| 3 | the language gate packs and the quality gate; skills and their history, the coach, agent memory, the benchmark gate for skill versions | in progress: the three gate packs and the quality gate step, as a CLI ([above](#the-quality-gate)); skills, the coach, memory and the benchmark gate planned |
| 4 | the agents, the six default flows and the new editor steps' server side, the reports, the run monitor's signals | planned |
| 5 | the UI: the templates and new steps in the editor, the run monitor (graph, board, conversation, live cost), skill histories and scorecards, the reports, the assistant drafting flows | planned |
