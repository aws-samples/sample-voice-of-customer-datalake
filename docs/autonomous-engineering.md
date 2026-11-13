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

*Partly built*: package detection with code owners (`voc-datalake/lambda/engineering/knowledge/workspaces.py`) and
the shard cutter with its size budget (`knowledge/shards.py`), as tested code nothing invokes yet (the Understand flow
that calls them lands with the agents, phase 4). Planned: partial clones and sparse checkouts, change impact (the
dependency graph between packages), shards' time budgets and the caches' writers (the cache's expiry rule is in the
stack). Designed for them from day one.

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
  time budget, and a shard too big is split again (built for the size: `knowledge/shards.py`). Only trusted code writes the cache: the connector's broker writes
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
category and source access, not the run owner's; what the viewer may not see is left out (built: an engineering run's
reads are admin-only, 403 for anyone else; sharing and the per-viewer filter are *planned*). A flow can use a connection only when it is shared with the agent's
owner, checked when the workflow is saved and again when the run starts.

## The knowledge pack

*Partly built* (`voc-datalake/lambda/engineering/knowledge/`): the packages and their owners, the shards, the map
step's one model call and its note schema, the reduce into documents, and the versioned store with approval, as
tested code that nothing invokes yet. Planned: the Understand flow and the mapper agent that run them (phase 4: until
then nothing reads a repository for a pack, and no pack exists), the REST routes to list, read, edit and approve a
version (admin only), several runs resuming one map, the dependency graph in the architecture document, and the
repository's tenets ([below](#the-repositorys-tenets)).

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

### The repository's tenets

The Understand flow also drafts the target repository's own tenets, a TENETS.md in the style of this sample's (what
the team optimises for, ranked, each with its evidence from the history: PR review comments, reverted changes, the
code style, the CI rules, the code owners), and its review guide, in the style of this sample's REVIEW.md. They are
mined from text anyone with access can write, and they become the gate's bar, so an administrator edits and accepts
them (versioned, like the pack); the review agents and the quality gate then use the accepted
tenets as their bar, as this sample's own tenets review does. Changes to them are proposed by the learning loop and
need a person. Nothing is written to the repository unless a person opens that pull request.

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
  brief so, with its lease's epoch, which is always the task's attempt). Renew, progress and move need the lease and
  its epoch, on a task that has not ended. Before it continues an agent (a pause resumed, a slow boot), the supervisor
  is to refresh its lease (`BoardStore.refresh`), even one that ran out, for that agent at that epoch, and it is to
  re-post a task at the attempt it judged (`repost_task`); its Board port (`runtime/ports.py`) calls neither yet, so
  the board's tests drive them. A re-posted task is open again at the next attempt,
  its lease cleared, published again as `task.posted` to its role, its reason in the history row. The run's
  `coordinate` task (role `coordinator`) is to be written only by the run's start (`coordinate_items`, in its own
  transaction; the runtime's run start does not call it yet, nor record the run's `commit` and `connection`, which
  `launch` and `knowledge` read from META: until it does, a run has no coordinate task, so the coordinator's claim and its `knowledge` answer 404, and an
  agent's `knowledge` and a `launch` answer 503, the launch before it numbers an agent),
  never posted, and claimed only by the run's coordinator, which renews and reports progress on it like
  any agent. It records the coordinator the start is to launch on it (`coordinator-1`, with META's `agent_count` 1
  written in the same transaction, so the board's launches number from 2; the start in this tree writes neither). A new coordinator for it is to be recorded only by the run's trusted code
  (`BoardStore.launch_coordinator`: the task open at the attempt given, the next `coordinator-<n>`, a retry reusing
  it), never by a board op: the runtime's Resume of a run whose coordinator is gone is to re-post the task at the
  attempt it judged and then call it (not wired in this tree: its whole-run Resume only resumes the run). A
  coordinator acts only while it is the run's: every board op of the coordinator role checks the caller is the
  coordinate task's recorded coordinator at the task's attempt, so a replaced coordinator's session is refused (403)
  by the board from the re-post on, its claim included; a run whose start wrote no coordinate task has only its
  start's coordinator, so there the role is the check. The board alone checks it: the connectors broker and the
  bus source (`voc.engineering/conductor/<ws>/<run>`) still take the role, so the runtime is to end a replaced
  coordinator's session and MicroVM when it replaces it (voc-auto-b's next merge). The coordinate task's re-post
  publishes no `task.posted` (no role reads one for it). A task whose launched agent never claimed it (it died or stalled first) is re-posted too. The
  coordinator also lists its run's tasks (`tasks`) and launches an agent for an open task (`launch`:
  its role, language and paths; the board invokes the runtime's `launch` action only, with the run's commit and
  connection from its META, numbers the agent `<role>-<n>` from the run's counter, at most 999, and records it on the
  task with the attempt and paths it was launched at and a history row, so a retried launch at that attempt launches
  the same agent, and a re-posted task, at its new attempt, a new one; a task no longer open is refused before the
  runtime is asked). The runtime's refusals (a bad request, a run not active or stopped, a session busy) answer 409
  with their message, a session already there for the recorded agent (an earlier try got through) 200, anything else
  503. The board never chooses the agent's argv: the runtime's `launch` in this tree still requires a `harness`, so
  the board's launch is refused (409) until the runtime derives the harness from the role's skill. An agent reads
  the approved knowledge pack (`knowledge`, as data) of one of its task's paths (the spec's `paths` and the ones its
  agent was launched on) or of the root (`''`, the knowledge store's `.`), never another's; a package the store
  cannot key is a 400, and an approved version whose object is missing or unreadable, or whose row changed, a 503. Each change is published
  on the bus as the board's `task.*` event after the row is written. A failed publish answers 503, and the retry
  publishes the same event again. Each post, claim and move also writes a `TASKLOG#<task>#<at>#<state>` row in the
  same transaction (the actor and the operation; no past state is overwritten; a renewal or a progress report is
  not a move), and so does a re-post, which is the
  task's history; a result key a move records must be one of the caller's own workspace objects of the lease's attempt.
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
  section). Nothing writes agents' objects there yet: the runtime's agent roles write
  to the raw bucket (see [Runtime](#runtime-one-microvm-per-agent), "Not aligned yet").
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
- **The agents' access**: the [runtime](#runtime-one-microvm-per-agent)'s agent roles call the board's and the
  broker's function URLs, and put events on the bus only with their own source; the bus's policy admits the board's
  role and the agent roles with a voice (all but the coach: Runtime → Not aligned yet) and nothing else, and denies
  each agent role every source but its own.

Not built yet: the harness's side (its board, inbox and broker interfaces still refuse every call, and so do the run
coordinator's: [Runtime](#runtime-one-microvm-per-agent), "Not aligned yet"); the agents' findings in the workspace
(the runtime writes their checkpoints and patches there). The rest of this section is the
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
progress and moves through it) and from the API's own source as the signed-in person (a person's board actions,
`from.kind` human only; the supervisor's re-post as itself), the `skill.*` announcements only from the API (all three: an administrator's proposal, acceptance, promotion or
rollback, as the signed-in person) and the run's coach (`skill.proposed`, from its run-scoped source), and the talk (`finding`, `question`, `answer`,
`review.*`, `handoff`) from the run's own agents, with a person's `answer` from the API; the runtime's `pause`,
`continued`, `timed_out` and `run.health` only from the supervisor (on the bus: `signal.check_in` to an agent,
`run.agent_continued`, `run.agent_timed_out`, `run.agent_failed` and `run.health` to the run, and the `task.posted`
of a task it re-posts), `pause.ack` only from the paused agent, and
`methodology`, `run.done` and `run.failed` only from the board's API and the supervisor (trusted code, on the run
coordinator's or the flow's word). And the broker opens
a pull request only when the board holds a GO for that exact tree's hash. A person's `decision` and `stop` are thus
published only by the API, which writes the signed-in user; a decision needs an administrator, or a person the
connection is shared with to manage, not only to view.

**Inboxes and roles.** One fixed rule sends every event to the inbox router (a Lambda, `bus/router.py`), which
writes it to the run's conversation and then routes it (`bus/routing.py`). There is no SQS queue per role or per
agent: a suspended MicroVM runs no code and cannot poll, so every message is pushed, per run. A posted task, and a
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
conversation, where the supervisor, the coordinator and the run view read it. The rule is fixed, never made per run,
so the bus's rule quota does not limit how many runs work at once. EventBridge is the bus; a push the router could
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
holder. A task another person holds is taken or blocked from them only when asked (`over`: the monitor asks first;
the write holds the holder it read), and an
agent's signal to a task a person holds is refused (no agent works on it). Blocking it ends it as needing a person,
with their reason (the only way a person sends a task there: a move to it is refused, so the why is always kept).
Never the coordinate task.

**The conversation.** Every event is also written to the run's conversation (DynamoDB, append-only, D1), which the run
view shows live as a chat between the agents beside the board. The person is a participant: their decisions, answers
and "stop" are events too.

**The run coordinator** (a small, cheap model) reads the conversation and the board and posts and orders the next
tasks; it decides when an agent's work is done and when the run has reached what it is allowed. When it sees an agent
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
`features.engineering`). *Planned*: the six default flows as templates.

**From the assistant.** Describing a flow ("every night, hunt bugs in the payments package and open PRs for the ones
you can fix") makes the AI assistant draft it behind an approval card, like its other writes: its workflow tools
(`validate_workflow`, `create_workflow`, `update_workflow`) take a `voc-workflow/2` definition with the engineering
steps, the agents API's `POST /workflows/validate` judges its rules, and a new one is created only where the
deployment has the engineering module (the API's 409; the web app's card checks `features.engineering` first, as the
library's New engineering flow and the editor's Save as do). *Planned*:
"refresh the knowledge pack", "pull the latest from the repository" and "what is agent X doing" from the assistant
too, through the same REST routes as everything else (an engineering run's reads are administrators-only, so no MCP
tool while an MCP token never acts as an administrator: TENETS.md's tenet 4 gap).

**The run monitor.** The run view shows every agent's status and where it is in the flow (the editor's graph with the
live step highlighted), the board, the conversation and the run's reports (each version's Markdown). Inspecting an agent shows its current step, its last progress,
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
not ship it; the workflow's Quality gate step is validated server side, with a `packs` pin the CLI keeps, and the
editor has the step with its settings panel, [above](#how-the-agents-work-together)). What exists:

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

- **The coach's and the gate runner's voices.** `bus/senders.py` takes an agent source's role from `VOICES`
  (`bus/schema.py` ROLES, the roles that claim tasks, and the gate runner), so the gate runner's
  `voc.engineering/agent/gate-runner/<ws>/<run>/<agent>` speaks, and only its gate results (`msg.finding`,
  `review.result`; a verdict stays the final-go agent's). The coach speaks as `voc.engineering/coach/<ws>/<run>`, a
  run-scoped source (the run and refs checks apply) whose `from.kind` is `coach`; there is no service-wide coach
  source. The coach role's session pin is to name that source (the stack's side).
- **The harness.** Its board, inbox and broker interfaces still refuse every call, and so do the run
  coordinator's (the board's task list, posting a task, launching its agent; the knowledge pack's agent reader).
  The board's side of them is built: its `tasks`, `post`, `launch` and `knowledge` ops, `launch` checking the
  caller is its run's coordinator (rather than an invoke grant on the runtime function, which would also reach its
  tick, its end of a run and its signals); the harness's ports are to call them.

Each agent of a run runs in its own Lambda MicroVM, from its language's image, with its own sparse checkout from the
cache. The idle policy suspends a MicroVM after 5 minutes without a request and ends one suspended for an hour; the
supervisor ends a finished agent's MicroVM at once. An agent on an open wait (its question, a review it asked for, a
human decision point) keeps its task and is outside every clock: the supervisor suspends its MicroVM, wakes it to
deliver a run monitor's signal or when the wait closes, and for a wait still open after 45 minutes (or once the
MicroVM nears its 8-hour limit) asks it to checkpoint and pause, holds it without a MicroVM (`waiting`), and
continues it in a new one once the wait closes.

- **No host token in any MicroVM.** Nothing in a MicroVM reaches the repository host: the
  [broker](#repository-connectors) holds the credential, fills the cache and makes every host write. An agent's egress
  allowlist is Bedrock, its two buckets' own S3 endpoints (the raw bucket's for the cache, the workspace bucket's for
  its keys; never the regional one, which reaches every bucket) in its region, the broker's and the board's function URLs by name once the runtime is wired to them, and, for the agents that run
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
  6 minutes left (or a wake renews it), and the launcher refuses a stopped run's agents, so a stop cuts that run's sessions within
  15 minutes although the roles are shared (its MicroVMs are ended at once anyway). The agent roles trust only the
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
- **Scoped roles.** Each agent role reads only its connection's cache prefix (in the raw bucket) and its run's keys
  in the workspace bucket, `voc-eng-workspace` (`ws/<ws>/runs/<run>/`), writes only its own keys there
  (`ws/<ws>/runs/<run>/<agent>/`: the agent comes right after the run, so no other agent's key matches; create-only,
  since the bucket refuses a put without `If-None-Match`), reads no queue (there are none: the router invokes the delivery
  function, which records its run's messages in the run's inbox and wakes it), calls the board's and the broker's function URLs (`lambda:InvokeFunctionUrl`, and the invoke behind it only through a function URL), may
  put events on the bus only with its own source
  (`voc.engineering/agent/<role>/<ws>/<run>/<agent>`, the run coordinator's `voc.engineering/conductor/<ws>/<run>`;
  an explicit deny in its own policy and another in the bus's, which admits only the board's role and the agent
  roles with a voice), calls the allowlisted models, and deletes nothing. No MicroVM
  auth token is ever put in an event, a log, a row or a checkpoint: it is minted when needed (at most 60 minutes),
  refreshed 5 minutes before it lapses, held in memory only, and refuses to be serialised.
- **The run coordinator.** It plans; it changes no code. It runs in the harness's Converse loop on its skill
  record (`runtime/harness/skills.py`): a versioned record of its instructions, worked examples, tool policy, the
  model it was written for and the harness that runs it, in the shape the skills store keeps (a change is a new
  version, never an edit, and a session row's `skill_version` says which one ran, `coordinator@1`). Its tools are
  exactly its skill's tool policy: read the board, post a task for one role with instructions a person could follow,
  launch one agent for a task (on its run's connection and commit, which the board takes from the verified caller's
  run: neither the model nor anything in the MicroVM names them), read the knowledge pack on a topic (only through
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
  task, so none of the role is idle, and one held on its wait keeps its one wake for the message it waits for): a
  working agent's MicroVM suspended for an open wait is resumed with a fresh
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
  caller's run's rows after an `inbox_seq` cursor, and the harness keeps each message once by its event id. Its role is its
  own, with only what a wake needs: Get, Put, Update and Query on the runs' partitions (`WS#*#RUN#*`: the inbox
  rows, META and the agents' session rows; never the registry of active runs, and no delete), resuming a MicroVM
  and minting its auth token, running a new one and ending the old one (a continuation), reading the agents'
  checkpoints, the key only through DynamoDB, S3 and SQS, its failure records in `voc-engineering-dlq`, and the
  launcher's AssumeRole of the agent roles, which trust it as they trust the supervisor (with all four session
  tags), since a wake hands the MicroVM a fresh agent session. It cannot switch the supervisor's rule, suspend a
  MicroVM or touch the registry.
- **The run's start and end.** The runtime's `start_run` writes the run's `META` row in voc-engineering
  (`WS#<ws>#RUN#<run>` / `META`: its task cap, which the board counts its tasks against, its hard caps on tokens and
  cost, its goal, repository, flow, status and start time, on which the router numbers the conversation) once, and
  lists it for the supervisor (`WS#<ws>#RUNS`, a row per run, in the same transaction); `end_run` sets its status
  (`done`, `failed` or `stopped`) and end time, ends every MicroVM of it, and the run stops being listed once none
  of its agents is live (one busy with another move is ended by the next tick, which sees the run ended). A retried
  start or end does what the first one left undone. After that first write only the run's own attributes are ever
  updated, never the board's, the router's or the inbox's counters. A run's agents are launched only while it is active, checked
  in the same write as the agent's row, so a run that ends meanwhile gets no agent nothing supervises. The
  supervisor reads its caps, its spend (its agents' tokens and what was priced on their rows), its start and its
  end from there; a human decision point is the run's status, and a Resume of the whole run makes it active again
  (never the 30-day one, which offers only "stop"). An agent's tokens are those of every MicroVM it ran in, not
  only the current one's.
- **Sessions.** One row per agent of a run, the board's own `AGENT#<agent>` row in the run's partition: ids, times,
  the MicroVM's id and endpoint, the boot step, the continuation count, the checkpoint it restored from, the run
  monitor's inspection data, the live cost counters and what the reports read (role, model, skill version, MicroVM
  seconds, tokens in and out). The row is created once and then only its own attributes are updated, so what the
  brokers add to it (the cost they priced) is never written over; the runtime adds its own beside it, the MicroVM
  seconds it has not priced yet at the deployment's price (`-c engineeringMicrovmUsdPerSecond`; unpriced by default),
  in the same conditional write that moves the session, so a second is priced once and a run's cost cap counts it. The supervisor finds the live sessions through the
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
  done, and the caller sends the signal again. The answer says, per agent, whether the signal took effect
  (`applied`: false when busy, when its move failed, a refused port or a MicroVM call, when there was nothing to
  do in the agent's state, answered with its status, a final one meaning nothing to send again, or `stale`: given
  the `attempt` of the task the caller saw, with its `agent_id`, an agent on another attempt is left alone; a Stop
  now is never stale). For each agent the row carries its current step and recent tool calls (the
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

*Partly built*: the builder (`voc-datalake/lambda/engineering/reports/`, the `voc-engineering-reports` Lambda,
deployed only with `-c engineeringAgents=true`), the administrators' reads through REST
([above](#how-the-agents-work-together); no MCP tool while the reads are admin-only) and the run monitor's Reports
panel in the web app (each report's versions as Markdown, [docs/autonomous-agents.md](autonomous-agents.md)). A report (voc-report/1) is built from what the run recorded: its `META`,
each agent's metering (`AGENT#`: skill version, model, MicroVM-seconds, tokens, metered cost), the conversation's
count, the board's tasks and their history, and only the workspace objects their result keys name (never a listing).
The PR report takes the quality gate's record only from an ended final-go task under the PR's head commit, checked
against the gate's own shapes before its Markdown goes into the description. Every version is new (an atomic
counter, create-only objects, D1). Not built yet: its callers (the run coordinator's closing task, the supervisor,
the write broker before it opens a PR: nothing invokes it, and no role holds an invoke on it), and
"what the agents learned" and "what improved since the last run". The design:

- **Commit report**: what the commit changes and why (its task), the gate packs' results, each review round's
  findings and what was done about each, the final verdict, cost and time.
- **PR report**: the commits' reports rolled up, the PR review, the test evidence, the risks and what a person should
  look at, the gate record (it goes in the PR description).
- **Goal report**: the run's objective ("find and fix the top bugs in the payments package", "build feature X from
  its PRD"), the board's outcome (done, failed, needing a person), the pull requests opened and their state, what is
  left, total cost and time, what the agents learned (proposed knowledge-pack edits, for a person to accept) and what
  improved since the last run.

## Getting better: skills, the coach, the learning loop, memory

*Partly built*: the skills' record, diff and versioned store (`voc-datalake/lambda/engineering/skills/`), nothing
invoking them yet (the harness, the coach and the administrators' routes land with phases 4 and 5); the coach, the
learning loop and memory planned.

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
`VER#<version>` row per version (its record, its base, its diff and summary, why, the benchmark pass rates when
measured, who proposed it, its status; at most 256 KB, checked before it is written) and a create-only `LOG#` row
per acceptance, rejection and rollback, and for a promoted version's source. A proposal is used
only once an administrator accepts it, in one transaction that also checks its base is still the current version
(the scope's, or the shared skill's for a connection with none of its own), so a proposal written on a version that
moved meanwhile is refused; the coach (any agent) writes only the version of the connection its run is for (the
connection its identity carries), from that run's failure, once per run and failure kind (a conditional `RUN#` row
in the same transaction), and never one that changes the tool policy, the model or the harness. A connection reads
its own current version, else the shared skill's, and the history is read a page at a time. An administrator
promotes a connection's lesson by writing a new shared version: the store refuses one that adds an instruction line
or example text of 20 characters or more (case and spacing aside) which the connection's version also adds to the
shared skill, and the administrator carries the rest of keeping the connection's text out. The source connection is
kept only in that version's `promoted_from` log row, which only an administrator reads; the shared version every
connection reads does not name it. A rollback is an administrator's new version that restores an earlier accepted
one of the same scope. Each proposal, acceptance and rollback returns its announcement
(`skill.proposed`, `skill.accepted`, `skill.rolled_back`, the bus's types today) for the caller to publish. Not yet:
the harness reading the store, a run recording the versions it used,
the routes, the benchmark gate on acceptance.

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
| 1 | the connectors (GitHub, then GitLab) and the broker, credentials, read paths, sparse clones; the Understand flow, the knowledge pack per package and the repository's tenets | in progress: the broker's caller identity, operations per role and write rules; the GitHub client and the credential reader (no run records or GO ledger yet, so it still refuses every operation with 503); the knowledge pack's package detection, shards, map step, reduce and versioned store with approval ([above](#the-knowledge-pack)), nothing invoking them yet |
| 2 | the runtime (one MicroVM per agent, the launcher, the harness, the supervisor, continuation, the cache, the mount, scoped roles); the bus, inboxes, board, conversation, workspace | in progress: the bus, the inbox router, the conversation, the board API with each task's history, its agents' `inbox`, `progress`, `tasks` and `knowledge` ops, the coordinator's `coordinate` task and `launch`, the lease's refresh and the supervisor's re-post, the push to the delivery function, the workspace's layout, findings and store in its own bucket, and the administrators' run monitor (its reads, signals and answers) and the read routes for a run's board and conversation ([above](#how-the-agents-work-together)); the runtime (one MicroVM per agent, the launcher, the harness, the supervisor, continuation, checkpoints, sparse clones, the mount, scoped roles, the run monitor's signals, the images, the run's start and end, the agent roles' access to the board, the broker and the bus, the delivery function: built, not yet run against AWS, [above](#runtime-one-microvm-per-agent)) |
| 3 | the language gate packs and the quality gate; skills and their history, the coach, agent memory, the benchmark gate for skill versions | in progress: the three gate packs and the quality gate step, as a CLI ([above](#the-quality-gate)); the skills' record, diff and versioned store with an administrator's acceptance and rollback, nothing invoking them yet ([above](#getting-better-skills-the-coach-the-learning-loop-memory)); the coach, memory and the benchmark gate planned |
| 4 | the agents, the six default flows and the new editor steps' server side, the reports, the run monitor's signals | in progress: the new editor steps' server side (engineering flows as `voc-workflow/2`, [above](#how-the-agents-work-together)) and the report builder with its administrators' REST reads ([Reports](#reports)), nothing invoking it yet; the agents and the six default flows planned |
| 5 | the UI: the templates and new steps in the editor, the run monitor (graph, board, conversation, live cost), skill histories and scorecards, the reports, the assistant drafting flows | in progress: the new steps in the editor, and the run monitor (the flow with its agents' steps lit, the board, the conversation, each agent as the supervisor saw it, an administrator's signals and answers, the reports with their versions; polling, no cost yet: [docs/autonomous-agents.md](autonomous-agents.md)); the templates, live cost, skill histories and the assistant drafting flows planned |
