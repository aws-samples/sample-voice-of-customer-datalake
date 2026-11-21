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
per-response cost) and it is listed on the form's Results and in Feedback with the form's tag.

Nothing is sent anywhere outside the deployment. There is no telemetry and no screen capture.

## Left out of the dashboards

The responses are about the tool, never about the customer's product (TENETS.md tenet 1), so they never move a
customer metric:

- **The aggregates.** The aggregator counts no item tagged `voc_app` (`lambda/shared/app_feedback_tag.py`). Such an
  item adds no daily total, source, category, sentiment, persona, dimension, tag, channel or usefulness counter, and
  no score to the sentiment average. If someone later adds the tag to an item, the item's counters are taken out. If
  someone removes the tag, the item is counted from then on.
- **The metric routes' item path.** A filtered dashboard, the categories, sentiment, sources, personas, dimensions,
  data quality, entities, problems, GitHub and release-watch routes (`metrics_handler.py` `_scoped_window_items`)
  leave these items out too, unless the request filters on the tag itself (`tag=voc_app`). That filter is the way to
  count them.
- **What still shows them.** The Feedback list, search and the form's own Results and Report. This is where the team
  reads them.

To have a form's answers counted again, remove the `voc_app` tag from the form. The form then can no longer receive
in-app feedback.

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
