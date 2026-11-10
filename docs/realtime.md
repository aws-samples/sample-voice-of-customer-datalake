# Push notifications (AppSync Events)

The browser learns that a long piece of work finished without waiting for its next poll. When an
assist job or another long job ends (project jobs, category reprocess, erasure, imports, the morning brief),
an assistant run that a reloaded tab is following ends, or an agent run or approved
plan changes status, the Lambda that wrote the change sends one short notice to the person concerned
over [AWS AppSync Events](https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-welcome.html).
The browser then reads the row through the API at once.

Polling stays. A notice is a hint to re-read, never the data: every view still reads the row through
the REST API, which applies the caller's access exactly as on every poll. Polling is the fallback
for a reload, a reconnect, a lost notice, the dev mock, an older deployment and any caller that is
not the SPA.

What does not change:

| Concern | How it moves |
|---|---|
| Schedules (ingestion, heartbeat, retention, brief) | EventBridge rules, as before |
| Long work | A job row + a worker Lambda (assist twins, job Lambdas, Step Functions), as before |
| The assistant's live answer | SSE (AG-UI over `POST /chat/stream`), as before |
| MCP (`POST /mcp/global`) | Request / response. External clients cannot hold the app's Cognito session, so MCP has no notices |
| "Something finished" | **AppSync Events notice** (this page), with polling as the fallback |

## The Event API

One Event API in **VocCoreStack** (`lib/stacks/core-realtime.ts`, no new stack), named
`[<prefix>-]voc-events-<account>-<region>`. Core deploys before every stack that publishes and holds the user
pool the API authorizes against.

- **Connect and subscribe**: the app user pool, and only the SPA's own app client (`AppIdClientRegex`
  is the client id, anchored). An MCP OAuth client's token of the same pool is refused, as on the REST API.
- **Publish**: IAM only. No browser can publish. Core creates one customer-managed policy per namespace
  (`RealtimeJobsPublishPolicy`, `RealtimeChatPublishPolicy`, `RealtimeRunsPublishPolicy`), each
  `appsync:EventPublish` on exactly that namespace. Each publishing Lambda's role carries the policy of the one
  namespace it publishes to, attached in the Lambda's own stack (`lib/utils/realtime.ts` `grantRealtimePublish`),
  so the grant adds no statement to the role's inline policy.
- **Logs**: errors only, to `/aws/appsync/apis/<api id>` with the platform's 30-day retention, written by a
  role that may write only that group.

## Channels

Each person has one channel per namespace: `/<namespace>/<cognito sub>`.

| Namespace | Notice | Published by | When |
|---|---|---|---|
| `jobs` | `{type: 'job', job_id, job_type, status, project_id?}` | the projects, settings and scrapers APIs' assist twins (`shared/assist_jobs.py`) | an assist job ends (`completed` / `failed`), to its starter |
| `jobs` | the same shape (`shared/job_notices.py`) | the job Lambdas below | a long job ends, to the person who started it |
| `chat` | `{type: 'session', conversation_id, run_status, revision}` | `voc-chat-stream` (`lambda/stream/src/assistant/session/run-session.ts`) | a run's last session write landed (`finished` / `failed` / `interrupted` / `stopped`), to the caller |
| `runs` | `{type: 'run', agent_id, run_id, status}` | `voc-agent-conductor` (`lambda/agents/notices.py`) | a run started or ended, to the agent's owner and the person who started it (not for the heartbeat) |
| `runs` | `{type: 'plan', plan_id, change, step_id?}` | `voc-agent-conductor` | a plan started, a step started / finished / failed, the plan ended (each plan journal row), to the approver |

### Job ends on `jobs`

Every job below sends ONE notice when it ends, to the person who started it, and nothing while it runs.
A job started by nobody (a schedule, an agent, a row from an older release without a starter) sends none.

| Job | `job_type` | `job_id` | `status` | Published by | Starter recorded as |
|---|---|---|---|---|---|
| Persona generation / import, document generation / merge (`shared/jobs.py` `job_handler`) | the row's (`generate_personas`, …) | the job id, with `project_id` | `completed` / `failed` | `voc-job-persona-generator`, `-persona-importer`, `-document-generator`, `-document-merger` | the job row's `initiated_by` (read once, only when notices are on) |
| Research (`research_step_handler.py` save / error) | `research` | the job id, with `project_id` | `completed` / `failed` | `voc-research-step` | the job row's `initiated_by` |
| Company persona jobs | as above | with `project_id: company_personas` | as above | the persona generator / importer | as above |
| Category reprocess (`shared/reprocess_jobs.py` `finish_job`: finish, cancel, stale reclaim) | `category_reprocess` | `rp_…` | `completed` / `failed` / `partial` / `cancelled` | `voc-category-reprocess`, the settings API | the job row's `started_by_sub` |
| Erasure (`voc-retention` erase mode, `jobs/retention/runs.py`) | `erasure` | `er_…` | `completed` / `failed` | `voc-retention` | the job row's `started_by_sub` (new in 6.04.00, never in the job view) |
| S3 import reprocess run (`POST /s3-import/reprocess`) | `s3_import_reprocess` | the run id | `completed` / `error` | the `s3_import` ingestor | `started_by` in the ingestor's invoke event |
| Manual-import parse (`POST /scrapers/manual/parse`) | `manual_import_parse` | the job id | `completed` / `failed` | `voc-manual-import-processor` | the job row's `started_by_sub` (never in the status view) |
| Memory page import (`POST /memory/imports`) | `memory_import` | `imp_…` | `completed` | `voc-memory-extractor` (last chunk) | `notify` in the queue message, carried chunk to chunk; the import row keeps only its supporter hash |
| Morning brief (a build settles) | `morning_brief` | `brief_<day>` | `ready` / `failed` | `voc-briefing` | the build request's `sub` |

The voc-retention role (the only customer-data delete role, TENETS.md D5) gains only the publish grant and the
endpoint read; nothing else on it changes. The `s3_import` ingestor runs on a dedicated role
(`IngestorRoleS3Import`) since 6.04.00: its manifest declares `infrastructure.ingestor.jobNotices`, so the publish
grant never lands on the role other plugins share.

Every namespace runs the same subscribe handler (APPSYNC_JS, `lib/utils/realtime.ts`): a subscription is
allowed only to exactly `/<namespace>/<the caller's own sub>`. A wildcard (`/jobs/*`), the bare namespace,
a deeper path or another person's sub is refused with `unauthorized`. The rule is enforced by AppSync, not
by the SPA.

A notice carries ids and statuses only, never content.

## Publishers

- **Python** (`lambda/shared/realtime.py`): a SigV4-signed `POST https://<host>/event` with the Lambda
  role's credentials. Best effort: a failure is logged and swallowed, never raised, so a job never
  fails because a notice was lost. A no-op when the host is not configured.
- **Node** (`lambda/stream/src/lib/realtime-publish.ts`): the same request, through the SigV4 helper the
  web-search tool uses (`src/lib/sigv4.ts`). Resolves false, never rejects.

Every publisher reads one variable, `REALTIME_HTTP_DNS`: the Event API's HTTP host, a plain stack reference
to VocCoreStack's Event API (`grantRealtimePublish` sets it with the policy). The publishers:

| Namespace | Publishers |
|---|---|
| `jobs` | projects, settings, scrapers APIs and their assist twins; the four project job Lambdas; `voc-manual-import-processor` (VocApiStack); `voc-research-step`, `voc-category-reprocess`, `voc-retention`, `voc-memory-extractor`, `voc-briefing` (VocProcessingStack); the `s3_import` ingestor (VocIngestionStack, plugins with `jobNotices`) |
| `chat` | `voc-chat-stream` (VocApiStack) |
| `runs` | `voc-agent-conductor` (VocProcessingStack) |

## The SPA

`frontend/src/realtime/`:

- `session.ts` connects once per signed-in session (the Cognito `sub`), closes on sign-out or a change of
  user, and does nothing when the runtime config has no `realtime` block.
- `connection.ts` subscribes the three own channels through aws-amplify's `events` client
  (`amplifyTransport.ts`, loaded lazily; Amplify reconnects the socket with fresh tokens), retries a failed
  connect with backoff (1, 2, 5, 15, 30, 60 s) and drops every message that is not a valid notice (Zod,
  `events.ts`).
- `hub.ts` holds the live state and the waits the polling loops use. Becoming live (the first connect and
  every reconnect) wakes every waiting loop, since a notice may have been missed.

What uses it:

| View | Without push (as before) | While subscribed |
|---|---|---|
| Assist jobs (`api/assistJobs.ts`) | poll every 1.5 s | poll at once on the job's notice; fallback poll every 10 s |
| A reloaded "still generating" assistant session (`assistant/runtime/followServerRun.ts`) | GET with backoff (1, 2, 3, then 5 s) | GET at once on the session notice; fallback GET every 15 s |
| Agent runs, the agents list, plans (`realtime/session.ts`) | their own polling | the same polling, plus an immediate refresh of the named run / plan on its notice and of every agent and plan query on a reconnect |
| Project jobs and the project (`pages/ProjectDetail/useProjectData.ts`), company persona jobs (`pages/Company/useCompanyPersonas.ts`) | poll every 3 s while a job runs | re-read on the project's job notice; a running job polled every 10 s |
| Category reprocess (`components/CategoriesManager/useReprocessJob.ts`) | poll every 2 s | re-read on a `category_reprocess` notice; fallback every 10 s |
| Erasure jobs (`components/SourcesManager/useErasureJobs.ts`) | poll every 2 s | re-read on an `erasure` notice; fallback every 10 s |
| S3 import reprocess run (`components/S3ImportExplorer/S3ImportReprocess.tsx`) | poll every 2 s | re-read on the run's notice; fallback every 10 s |
| Manual-import parse (`pages/Scrapers/ManualImportModal.tsx`) | poll every 2 s | read on the job's notice; fallback every 10 s |
| Memory imports (`pages/Memory/MemoryImports.tsx`) | poll every 3 s | re-read on the import's notice; fallback every 10 s |
| Morning brief (`pages/Home/brief/useBrief.ts`) | poll every 3 s while pending | re-read on a `morning_brief` notice; fallback every 10 s |

The job views use `realtime/jobRefresh.ts`: `useRealtimeJobRefresh` invalidates the view's queries on a
matching job notice (by `job_type`, `project_id` or `job_id`) and on every (re)connect, `useRealtimeJobWake`
does the same for a view that polls by hand, and `realtimePollInterval` slows the poll to at least 10 s only
while push is live.

The runtime config (`config.json`, written by VocApiStack from Core's references and by
`frontend/scripts/deploy.sh`) carries `realtime: {httpDns, realtimeDns}`, VocCoreStack's `RealtimeHttpDns` /
`RealtimeDns` outputs. For local work
against a deployed stack, `frontend/scripts/update-env.sh` writes `VITE_REALTIME_HTTP_DNS` and
`VITE_REALTIME_DNS`. The dev mock has no Event API, so everything polls there.

## Cost

Pay per use, no fixed monthly cost (TENETS.md, tenet 7): about $1.00 per million Event API operations
(each publish, each delivered message, each connect) and $0.08 per million connection minutes
([AppSync pricing](https://aws.amazon.com/appsync/pricing/)). One signed-in tab open for an 8-hour day is 480
connection minutes. Managed policies cost nothing. Nothing here is listed in
`OPT_IN_FIXED_COSTS` (`voc-datalake/lib/test-support/fixed-cost-rules.ts`), and
`lib/stacks/core-realtime.test.ts` checks VocCoreStack carries no fixed-cost resource.

## Not covered yet

Design references (Knowledge → Company → Design system, `pages/Company/DesignSystemSection.tsx`) still only poll
every 5 s while one is read: the capture worker (VocIngestionStack) records no starter, so wiring it needs the
settings route to pass one, the worker to publish and a dedicated grant, more than the few lines the others took.
