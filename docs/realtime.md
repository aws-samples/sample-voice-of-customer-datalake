# Push notifications (AppSync Events)

The browser learns that a long piece of work finished without waiting for its next poll. When an
assist job ends, an assistant run that a reloaded tab is following ends, or an agent run or approved
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

One Event API in **VocApiStack** (`lib/stacks/api-realtime.ts`, no new stack), named
`[<prefix>-]voc-events-<account>-<region>`.

- **Connect and subscribe**: the app user pool, and only the SPA's own app client (`AppIdClientRegex`
  is the client id, anchored). An MCP OAuth client's token of the same pool is refused, as on the REST API.
- **Publish**: IAM only. No browser can publish. Each publishing Lambda holds `appsync:EventPublish`
  on exactly the namespace it publishes to.
- **Logs**: errors only, to `/aws/appsync/apis/<api id>` with the platform's 30-day retention, written by a
  role that may write only that group.

## Channels

Each person has one channel per namespace: `/<namespace>/<cognito sub>`.

| Namespace | Notice | Published by | When |
|---|---|---|---|
| `jobs` | `{type: 'job', job_id, job_type, status, project_id?}` | the projects, settings and scrapers APIs' assist twins (`shared/assist_jobs.py`) | an assist job ends (`completed` / `failed`), to its starter |
| `chat` | `{type: 'session', conversation_id, run_status, revision}` | `voc-chat-stream` (`lambda/stream/src/assistant/session/run-session.ts`) | a run's last session write landed (`finished` / `failed` / `interrupted` / `stopped`), to the caller |
| `runs` | `{type: 'run', agent_id, run_id, status}` | `voc-agent-conductor` (`lambda/agents/notices.py`) | a run started or ended, to the agent's owner and the person who started it (not for the heartbeat) |
| `runs` | `{type: 'plan', plan_id, change, step_id?}` | `voc-agent-conductor` | a plan started, a step started / finished / failed, the plan ended (each plan journal row), to the approver |

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

Where a publisher learns the host:

| Env var | Who | Value |
|---|---|---|
| `REALTIME_HTTP_DNS` | projects, settings, scrapers APIs and their assist twins; `voc-chat-stream` | the Event API's HTTP host |
| `REALTIME_HTTP_DNS_PARAMETER` | `voc-agent-conductor` (VocProcessingStack) | `/[<prefix>-]voc/realtime/event-api-http-dns`, an SSM String parameter VocApiStack writes |

The conductor lives in VocProcessingStack, which deploys before VocApiStack, so it cannot take the host as
a stack reference. It reads the parameter once per container (`ssm:GetParameter` on exactly that
parameter); a missing parameter (the first deploy, before VocApiStack exists) turns its notices off for
five minutes. Its publish grant on `runs` is a policy VocApiStack attaches to its role.

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

The runtime config (`config.json`, written by VocApiStack and `frontend/scripts/deploy.sh`) carries
`realtime: {httpDns, realtimeDns}` from the `RealtimeHttpDns` / `RealtimeDns` outputs. For local work
against a deployed stack, `frontend/scripts/update-env.sh` writes `VITE_REALTIME_HTTP_DNS` and
`VITE_REALTIME_DNS`. The dev mock has no Event API, so everything polls there.

## Cost

Pay per use, no fixed monthly cost (TENETS.md, tenet 7): about $1.00 per million Event API operations
(each publish, each delivered message, each connect) and $0.08 per million connection minutes
([AppSync pricing](https://aws.amazon.com/appsync/pricing/)). One signed-in tab open for an 8-hour day is 480
connection minutes. The SSM parameter is standard tier (free). Nothing here is listed in
`OPT_IN_FIXED_COSTS` (`voc-datalake/lib/test-support/fixed-cost-rules.ts`), and
`lib/stacks/api-realtime.test.ts` checks the stack carries no fixed-cost resource.

## Not covered yet

Other long work still only polls: project jobs (persona generation and import, document generation and
merge, research: `GET /projects/{id}/jobs`), category reprocess (`GET /settings/categories/reprocess`),
erasure jobs (`GET /settings/erasure`), the S3 import reprocess run, the manual-import parse job, memory
imports, the company persona jobs and the morning brief. Project jobs finish in one place
(`shared/jobs.py` `job_handler`), so they are the next candidate.
