# Role playbooks

Since 7.66.00, Home's onboarding buddy (the setup checklist) offers a short first-week playbook for four roles:
**Product manager**, **Scrum master**, **QA** and **Engineering**. The person picks their role and gets five
steps. Each step links to the screen where it is done and says why it matters. Real activity ticks steps as it
happens, and the person can tick any other step by hand.

A playbook is content only:

- **It grants nothing.** A playbook role is not a permission, and it does not change the person's workspace role
  (viewer, editor or admin).
- **Nobody assigns it.** Each person picks their own role on Home, and can change it or clear it at any time. Since
  7.71.00 the admin who adds someone may suggest one (`playbook` on the member add, stored on their `MEMBER#` row; a
  trial's invite list does it, [Trial workspaces](multi-workspace.md#trial-workspaces)): Home offers it first, marked
  *Suggested for you*, and the person still picks.
- **It has no fixed cost.** It adds no model call, no worker and no table. Home reads a few rows it can already read,
  and only for the steps of the playbook the person chose.
- **It has no badges and no scores.**

## The steps

The catalogue is one file, `voc-datalake/schemas/playbooks.json`. The web app reads it
(`frontend/src/pages/Home/playbooks/playbookCatalogue.ts`), and the server's copy (`lambda/shared/playbooks.py`) is
pinned to it by a test. Each step has an id, the path of its screen and its *evidence*: what ticks it.

| Role | Steps (evidence in brackets) |
|---|---|
| Product manager | Read this week's dashboard · Generate personas (one of their projects has personas) · Draft a PR/FAQ or a PRD (one of their projects has a document) · Set your objectives and KPIs (objectives set) · Subscribe to the morning brief (brief on) |
| Scrum master | Subscribe to the morning brief (brief on) · Review the problems customers report most · Share the project with your team (one of their projects is shared) · Create a form for the sprint review (a form exists) · Read a form's results and report |
| QA | Create a feedback form (a form exists) · Test a form with its test link (a test response exists) · Find the feedback behind an issue · Review the problems · Watch the feedback after a release |
| Engineering | Connect a repository (a connection exists; administrators only) · Find the feedback behind an issue · Start an engineering run from a problem · Build a prototype from a PRD · Use VoC from your IDE (an MCP token exists) |

A step with no evidence is ticked by hand. A step that two roles share, such as "Review the problems", has the same
id in both roles, so its tick carries over when the person changes role. No playbook repeats the setup checklist
above it in the same Home section: asking the assistant and starting a project are the checklist's steps, not a
playbook's, and every role keeps five steps.

## How a step is ticked

- **Server signals.** `GET /settings/my-onboarding` adds the chosen playbook's signals to the first-run `signals` it
  already sends. They come from voc-aggregates in the request's scope: inside a workspace (`X-Workspace-Id`) they are
  that workspace's, and without the header they are the deployment's. The signals are:
  - `objectives_set`: their objectives row has at least one objective. This is the `USERCTX#{sub}` / `config` row
    that `PUT /settings/my-context` writes.
  - `form_test_response`: a test response of one of the scope's forms exists. Test links are anonymous, so the
    response is not necessarily this person's.
  - `feedback_form_configured`: a form exists in the scope.

  Each signal is one single-item read or a one-row Query, and only the signals of the chosen playbook are read.
- **Browser evidence.** Home already reads the person's morning brief settings (its brief card) and projects (the
  setup checklist), under the same cache keys, so these cost nothing more: "brief on" is the brief's own `enabled`,
  and a project counts only if the person owns it. Home also
  reads the engineering connections (an administrator's list, read only while the engineering agents are on) and
  the person's MCP tokens (Connect's list), and only for the Engineering playbook.
- **By hand.** `playbook_done` lists the steps the person ticked. A step whose evidence is true is shown as done and
  cannot be unticked. A step the person ticked can be unticked.

A step whose evidence is still loading is shown as pending, and a failed read counts as "not done yet". The step's
link still goes to the right screen.

## Data and routes

The person's choice and ticks are stored on their own onboarding row (`USERCTX#{sub}` / `onboarding`, the same row as
the buddy's state). The row has `playbook` (`product`, `scrum_master`, `qa`, `engineering`, or no value) and
`playbook_done` (a sorted list of step ids, at most 40). No new partition, table or API resource is involved.

| Method | Path | Body / answer |
|---|---|---|
| GET | `/settings/my-onboarding` | Adds `playbook`, `playbook_done` and the playbook's signals to the existing answer |
| PUT | `/settings/my-onboarding` | `{playbook: <role> \| null}`, or `{playbook_done: [step ids]}` (the list replaces the stored one). These can be sent beside the existing fields. An unknown role or step is a 400 |

Both routes are self only: they read and write the caller's own row. Since 7.66.00 they resolve `X-Workspace-Id`,
and the lambda/api cross-workspace suite has a case for each. A member of A who names workspace B gets the one 404,
and a request without the header keeps the deployment's signals, as before.

## The assistant's guidance

"Ask the assistant to walk me through it" opens a new conversation with the playbook in the composer. Nothing is sent
until the person presses send. MCP clients get the same guidance as the `playbook` prompt of the global MCP server
(`role`: `product`, `scrum_master`, `qa` or `engineering`; see [mcp.md](mcp.md)). The prompt lists each step with
why it matters, how the read tools show it with the deployment's own feedback, and where in the app it is done. It
asks before anything that writes. With a read-only token, it tells the model that the person makes every change in
the app.
