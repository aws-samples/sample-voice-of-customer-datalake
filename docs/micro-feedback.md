# In-app micro-feedback

Since 7.66.00, the app can ask a short question right after a key action: "Was this useful?", with a thumb up or a
thumb down, and then an optional "What's missing?" (500 characters at most). It takes two seconds and the person
stays on the page. The team reads the answers as feedback about the tool. The feature is **off by default**, and an
administrator turns it on.

## Where it asks

The control appears once per action instance, inline, after these actions:

| Action | Where | Instance |
|---|---|---|
| `personas` | a generated persona's page in a project (not one that was imported, copied or comes from the library) | the persona |
| `research`, `prfaq`, `prd` | under a research report, PR/FAQ or PRD the app wrote (not one written by hand or merged) | the document |
| `prototype` | under a built prototype | the prototype version |
| `form_draft` | in the builder's "AI draft" / "Changed with AI" banner | the draft shown |
| `import` | on a CSV import's success screen | the import |
| `engineering_run` | in a run's workspace once it ended (done, failed or stopped) | the run |

"At most once" is kept in the person's browser (`voc-micro-feedback:<sub>`, the newest 200 instances). A sent
answer and a "Not now" both count. If the browser's storage is full or blocked, the control may ask again.

## Setting it up

Administration → General → **In-app feedback** (`/admin/general#app-feedback`):

1. Create a form from the **In-app micro-feedback** template: Feedback Forms → New → This app, or the card's link.
   Save it and turn it on.
2. Choose that form in the card.
3. Turn on "Ask after key actions", and untick any action it should not ask after.

Each control saves on its own. Inside a workspace the settings are that workspace's, and its admins change them.
Outside a workspace they are the deployment's, and its `admins` group changes them. Everyone else can read the card.

## The form

The answers go to a normal feedback form of the same workspace, not to a new pipeline. The form is checked when it is
chosen (`lambda/shared/app_feedback.py` `form_problems`), and must have:

- `q_verdict`: a single choice with the codes `up` and `down`. It is a choice and never a rating, so it does not move
  any average rating.
- `q_missing`: an open text question.
- the hidden fields `action`, `page`, `app_version` and `workspace_role`. These are ids only: the action, the route's
  first segment (`projects`, `agents`…), the app's version and the person's role in the workspace (`none` outside
  one). They never hold a name, an email, a user id, a workspace id or a URL.
- the tag `voc_app`.

The template makes exactly this form (`frontend/src/pages/FeedbackForms/templates/appTemplates.ts`). If any of these
is missing, the save is refused (400 `app_feedback_form_unfit`, with the `problems`). A form that is Off can still be
chosen, but the control stays hidden until the form is on. If the form is deleted, the card says so and the control
disappears.

## What is sent, and where

The app sends each response to the form's own public submit route, `POST /feedback-forms/{id}/submit`, with no
credentials. The body is a version 2 response:

```json
{"answers": {"q_verdict": {"code": "down"}, "q_missing": "…"},
 "hidden": {"action": "prd", "page": "projects", "app_version": "7.66.0", "workspace_role": "editor"},
 "language": "en"}
```

So the forms' own validation, throttles and access rules apply exactly as they do to any respondent, and nothing new
sits on the public path. `language` is the app's language when the form has it, otherwise it is left out and the form's
own language is used. The response then becomes a feedback item like any form response: it is enriched (the normal
per-response cost) and it is listed on the form's Results with the form's tag.

**The throttle is shared.** The submit route's limit is one stage method setting for every form of the deployment and
every caller (20 requests a second, a burst of 40: `.kiro/steering/structure.md`, "Rate limits on the four public
routes"), so the in-app thumbs and the customers answering the deployment's forms draw on the same budget. A response
over it is a `429`: the control says "Couldn't send it." and offers Try again, and nothing is lost but that answer. An
administrator sees these in Administration → System → Logs with warnings shown, as the API access log's rows
`POST /feedback-forms/{id}/submit → 429`.

Nothing is sent anywhere outside the deployment. There is no telemetry and no screen capture.

## Never customer evidence

The responses are about the tool, never about the customer's product (TENETS.md tenet 1), so they never move a
customer metric and never stand as a customer's evidence:

- **The aggregates.** The aggregator counts no item tagged `voc_app` (`lambda/shared/app_feedback_tag.py`). Such an
  item adds no daily total, source, category, sentiment, persona, dimension, tag, channel or usefulness counter, and
  no score to the sentiment average; it keeps only its day's sentinel (a field of the daily total's row that no
  reader sums), so a later edit on a day of micro-feedback alone still finds the day.
- **Every read through the shared item filters** (`lambda/shared/item_filters.py`, whose default leaves these items
  out): the metric routes (filtered dashboards, categories, sentiment, sources, personas, dimensions, data quality,
  entities, problems, GitHub, release watch), the Feedback list and search (the REST routes, MCP `feedback_search`
  and the assistant's `search_feedback` tool, `lambda/stream/src/tools/search-feedback.ts`), and the urgent list
  (once a scope chose an in-app feedback form its pages are read in full, because the urgency index holds no tags
  and its count would include these items).
- **Every evidence read**: persona generation and its pre-check, research, PR/FAQ and PRD generation and the
  document merger (`lambda/shared/feedback.py`), the persona focus groups' evidence packs, freshness counts and
  Refresh evidence (`lambda/shared/persona_grounding.py`), Revise from comments' evidence, the morning brief's
  counts, urgent reviews and quotes, the release watch card, and the agents' new-review triggers.

Only a request that asks for the tag (`tag=voc_app`) reads them; that filter is the way to count or list them. The
form's own Results, Report, responses and CSV show them (they read the form's own source partition), and so do a
review opened by its id, the Data Explorer, and a workspace's export and delete, which read every item.

**The tag is reserved.** Only a form made from the In-app micro-feedback template carries `voc_app`: any other form,
a scraper's or connector's saved labels and a source profile refuse it (400), a manual tag edit can neither give it
to a review nor take it from one, and every producer other than a form (a CSV or pasted import, a plugin, a webhook,
an inbox) has it dropped from its messages, never refusing the review. So no customer's review is left out of the
dashboards by a tag.

To have a form's answers counted again, remove the `voc_app` tag from the form. Only the answers it receives after
that are counted: the items it already wrote keep the tag, and stay out. The form then can no longer receive in-app
feedback.

## Routes

| Method | Path | Who | Body / answer |
|---|---|---|---|
| GET | `/settings/app-feedback` | any member (any signed-in user without a workspace) | `{enabled, form_id, actions, updated_at, tag, form: {form_id, found, name, enabled, languages, problems} \| null, active}`. `active` is true when the feature is on and its form is found, fit and on. It never says who saved the settings |
| PUT | `/settings/app-feedback` | the workspace's admins (the deployment's `admins` without a workspace), never a delegated caller | `{enabled?, form_id?, actions?}`. A save changes only the fields it names. A form the scope does not hold is a 404. Turning it on without a form is a 400 `app_feedback_form_required` |

The settings route is the settings Lambda's own, under the existing `/settings/{proxy+}`. It adds no API Gateway
resource and no IAM. The row is `SETTINGS#app_feedback` / `config` for the deployment, or
`WS#{ws}#SETTINGS#app_feedback` / `config` in a workspace, and holds `{form_id, enabled, actions, updated_by: {sub,
kind}, updated_at, reason}`. A workspace's hard delete sweeps it with the workspace's other settings rows. The
workspace export does not carry settings rows yet.
