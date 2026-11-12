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
  prefix. Entries expire a set time after they were written and are rebuilt when needed. Every shard has a size and
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

*Planned* (the bus, the board, the conversation and the workspace in voc-datalake/lambda/engineering, CDK behind
`-c engineeringAgents=true`).

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
runtime lands. The conditions use the tags: an explicit deny on the bus refuses an event whose source is not the
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
readable as the connection is. One lifecycle rule for the whole workspace removes each object a retention period
after it was written (90 days by default, never under 75), and the run records the retention it ran under (D4); when a run's objects have gone, the supervisor writes one
`AUDIT#delete` row for the run (who: the workspace retention rule; what went; under which retention; when), as D5
asks of every workspace delete.
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

*Planned* (the step in voc-datalake/lambda/engineering/quality_gate, the packs in voc-datalake/engineering-gates).

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

*Planned* (voc-datalake/lambda/engineering/runtime, the images in voc-datalake/engineering-images). The service's
limits, prices, quotas and regions, and how a MicroVM keeps a sandboxed process away from the agent's credentials and
the network, are checked against the AWS documentation before this phase lands, and this section is corrected to what
is verified.

Each agent of a run runs in its own Lambda MicroVM (Firecracker, a container image built from a Dockerfile, up to
8 hours, suspend and resume with its state), with its own sparse checkout, warm from the cache, and its own credential
scope. It is suspended while it waits for a message (the idle policy) and ended as soon as its task ends.

- **No host token in any MicroVM.** Host writes are operations of the [broker](#repository-connectors), and each
  role may invoke only its own.
- **Repository code in a box of its own.** Where repository code runs (the fixer, the builder, the hunter's tests,
  the understander's reproduction in a triage, the gate runner) it runs as a separate OS user with no credential in its environment, no network (loopback and
  link-local included, so neither the runtime's nor the credential endpoint), no view of the agent process
  (`/proc`, its temporary files) and no customer-derived file where it can read it. The checkout's git directory
  belongs to the agent user and the sandbox user cannot write it; the agent runs every git command with hooks,
  file-system monitors, pagers, external diff tools and system config off, and runs no toolchain command itself, so
  nothing the repository's code planted runs as the agent. The agent's own file tools open nothing whose real path
  is outside the checkout (links are not followed), so a planted link cannot lead it to its own credentials. Only the dependency step has network, and it runs first,
  before any repository code (every sandbox-user process is ended before it starts, should one exist), with the
  registry list enforced on the network, not only in the tool's settings (the mechanism is among the facts to
  verify): it runs as the sandbox user, holding no credential and no customer-derived file, fetches only from the platform's own list of
  package registries (the repository's registry settings are ignored), only what the lockfile names (git and URL
  sources refused), with install scripts off, and builds nothing (except the Gradle and Maven resolution above);
  builds then run offline in the sandbox. The agent process itself reaches only the broker, the board's API, its
  queues, S3 and Bedrock (the mechanism is among the facts to verify). The committer runs no repository
  code at all.
- **Scoped roles.** Each agent's execution role, bound by its session tags, reads only its connection's cache prefix
  and its run's workspace and writes only its own keys there, and reads only its own inbox and its run's queue for its
  role (queues named by run and agent, the role's SQS resources written with the session's tags); it may call only the models its skill names. No MicroVM auth token is ever put in an event, a
  log or a checkpoint; it is minted when needed and refreshed.
- **The cache mount.** A MicroVM may mount its connection's cache prefix read-only with Mountpoint for Amazon S3 for
  warm checkouts and toolchain caches. Mountpoint supports neither appends nor random writes, so results are written
  as plain S3 puts, one object per shard.
- **No fixed task cap: activity decides.** An agent runs as long as its task needs and it makes progress: it sends
  progress (what it did, what is next) through the board's API, which publishes it as `task.progress`, and a
  heartbeat every minute (the lease renewal on its board
  row). For a running agent, no progress for 10 minutes (configurable) is the stop signal (an agent suspended on an
  open wait is not running, and keeps its task): the supervisor asks the agent for its state, and with no answer stops it and
  re-posts its task from the checkpoint. A task that times out twice is split or goes to a person. Hard caps on model
  tokens and cost stay, set by a person.
- **The supervisor.** An EventBridge Scheduler schedule, every minute while any run is active and off when none is,
  invokes the supervisor (a Lambda). The runs' own transitions switch it: a run's start turns it on, and the end of the
  last active run (a counter changed in the same transaction as the run's status) turns it off; the supervisor never
  does. The schedule call cannot share that transaction, so every switch re-reads the counter afterwards and puts the
  schedule back on if a run started meanwhile. It checks each active run (the run coordinator answering, each task's lease and
  heartbeat, the cost caps, the MicroVMs' states, events piling up in an inbox), restarts a stopped run coordinator, frees
  and re-posts timed-out tasks, suspends or ends idle MicroVMs, stops a run past its caps (at a human decision point,
  never silently) and emits `run.health` events. Its failed invocations go to a dead-letter queue, watched like the
  platform's other dead-letter queues; an alarm on its own heartbeat metric bills monthly, so it is opt-in (tenet 7).
- **Continuation past the 8 hours.** The supervisor knows each MicroVM's start time. Ahead of the limit (7 h 30 by
  default, earlier when a long step is about to start) it sends a `pause`; the agent finishes its step, saves a
  checkpoint (its working tree as a patch in the workspace, its notes, its plan and position, its conversation
  cursor) and acknowledges (`pause.ack`); the supervisor ends that MicroVM and starts a continuation in a new one, which restores the
  checkpoint and goes on as the same agent and task. The conversation and the board show "continued in a new
  MicroVM"; any number of continuations, each on the reports. The same protocol serves a person's pause and a crash
  (from the last checkpoint).
- **Output.** Tool output is scrubbed of anything shaped like a credential and capped in size before it is stored or
  sent to a model.
- **The harness.** Inside each MicroVM the agent runs through one harness interface with adapters, chosen per agent in
  its skill: a coding-agent CLI in its headless mode (the pattern this sample's own `scripts/ai-review` already uses,
  which picks `kiro-cli`, else `claude`, and is reused for the choice), or a plain Bedrock Converse loop for small
  agents. Whatever the adapter, it gets only the task, the knowledge pack and memory slices and the platform's tools:
  a CLI runs with every built-in tool of its own off (its shell, file and web tools), so repository code still runs
  only as the sandbox user, through the platform's run tool; it starts in a directory outside the checkout and loads
  only the platform's own configuration, never the repository's or a user's (hooks, tool servers, steering and
  instruction files, settings), so nothing committed to the repository runs as the agent (a unit test plants such
  configuration in a fixture repository); it reaches models only through Bedrock with the agent's
  session, and a CLI that needs any other endpoint or login is not offered. It holds no host credential, and every
  write goes through the broker.
- **Images.** One per language toolchain, built from a Dockerfile in this repository; the image's ready and validate
  hooks prefetch the toolchains. Old image versions are removed.
- **Behind an interface.** The runtime is an interface; tests and local runs use a local fake, so every flow is
  proven without an AWS account.

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
| 2 | the runtime (one MicroVM per agent, the launcher, the harness, the supervisor, continuation, the cache, the mount, scoped roles); the bus, inboxes, board, conversation, workspace | planned |
| 3 | the language gate packs and the quality gate; skills and their history, the coach, agent memory, the benchmark gate for skill versions | planned |
| 4 | the agents, the six default flows and the new editor steps' server side, the reports, the run monitor's signals | planned |
| 5 | the UI: the templates and new steps in the editor, the run monitor (graph, board, conversation, live cost), skill histories and scorecards, the reports, the assistant drafting flows | planned |
