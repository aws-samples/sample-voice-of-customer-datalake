# The import wizard: bring your own signals in minutes

**Data sources → Import a file** (`/scrapers/import`, and the call to action on a new workspace's Home) takes the file
a team already has (app store reviews, support tickets, or another survey tool's results), says what each column
holds, and imports it once a person has confirmed. The first insights follow as the rows are analysed. Importing is
admin-only, like every import (#242): in a workspace, its admins.

After a workshop, **Create a trial** (7.71.00, [Trial workspaces](multi-workspace.md#trial-workspaces)) opens this
wizard inside the new trial workspace, so the customer's own feedback and the workshop's survey (as an imported form)
go straight into it. A paused trial still takes imports: only its plugins and live forms stop.

## The four steps

1. **Upload.** A CSV, TSV or JSON file up to 10 MB (a survey export up to 2 MB: it rides the first import call whole),
   or an Excel workbook (`.xlsx`) up to 256 KB. The browser sends the file's first 256 KB (cut at a line end) to
   `POST /scrapers/manual/detect`. A workbook is sent whole, because the browser cannot read one: the server reads its
   first sheet with the Documents Library's zip-plus-XML reader (`shared/library_extract.py` `xlsx_rows`, each cell
   in its own column) and sends its rows back. The first 20 rows are shown.
2. **Map.** What the file is: **reviews or tickets** (each row is one piece of feedback) or **a survey export** (each
   row is one person's answers). Then each column, with the kind detected, its confidence (*Sure*, *Likely* or *A
   guess*), its reasons in the reader's language, and a few of its values. Every kind can be changed. Dates are read
   day first, month first or year first; the wizard proposes the order the values show and lets a person change it.
3. **Confirm.** For a survey export, the name of the imported form and the questions it becomes, shown with the
   builder's type chips, plus the columns that cannot become a question and why. For reviews, which columns are the
   text, the rating, the date and the id, and which are left out.
4. **First insights.** How many rows were imported (and why any were not), how many are analysed so far, then the
   sentiment split, the top categories, a survey's NPS and three quotes. Links open the dashboard filtered to the
   source and, for a survey, the form's Results.

## Detection

`shared/import_detect.py` reads the sample and decides one kind per column. It is deterministic and free: no model
is called and nothing is stored. The sample is read as follows:

- a byte-order mark is dropped;
- the separator is found on the header line among `,`, `;`, tab and `|`;
- a blank header is named `Column n` and a repeated one `Name (n)`;
- JSON is an array of objects, an object holding one, or one object per line.

The kinds are:

| Kind | Read from |
|---|---|
| `id` | Every value different and short, or the header says so (`id`, `identyfikator`, `identificador`, `ticket`) |
| `date` | ISO 8601, `31/12/2026`, `12/31/2026 9:30 PM`, `31.12.26`, or an Excel serial number (`46095`) under a date header |
| `rating_1_5`, `rating_1_10` | Whole numbers from 1, the header saying rating, stars, score, *valoración*, *ocena*… |
| `nps_0_10` | Whole numbers from 0 to 10 whose header says recommend (*recomendar*, *polecić*, *empfehlen*…), or any 0 among them |
| `csat` | 1 to 5 with a satisfaction header (*satisfacción*, *zadowolenie*…) |
| `choice` | 12 different values or fewer that come back |
| `multi_choice` | Answers separated by `;` (or `,`) that come back, in a third of the values or more |
| `matrix_cell` | `Row -- answer; Row 2 -- answer` pairs |
| `open_text` | Free text (spaces, 25 characters on average, or a comment, feedback, why… header) |
| `email`, `name` | Email addresses; a name header or two or three capitalised words. **Personal data, left out by default** |
| `url`, `channel` | Web addresses; a channel, source or platform header with few values |
| `ignore` | Empty columns, other numbers |

Each reason is a code with parameters (`{"code": "values_range", "params": {"min": 0, "max": 10}}`) that the app
words in nine languages. An English `reason` (`values 0-10, the header says 'recommend'`) is there for logs and
integrators. A file with an NPS, a multiple-choice or a grid column, two scales or more, or no free text at all is
suggested as a survey export; any other file is suggested as reviews.

## Reviews or tickets

These rows go through the CSV import (`POST /scrapers/manual/csv-upload`), which takes the wizard's `mapping`
(`{header: kind}`) instead of `column_map`, together with the file's `delimiter`, its `date_order` and an
`import_tag`. They are read by `shared/import_wizard.py` `reviews_fields`:

- the open-text columns are the text (several are joined, each under its header);
- a 1-5 rating or a CSAT is the rating, and a 1-10 rating is halved up to 1-5 (its own value is kept in metadata);
- an NPS is kept as a metadata value, never as the rating: the queue refuses a 0 rating;
- the date is normalised to UTC; a row whose date cannot be read keeps the import date, with a warning;
- a choice column named like a configured dimension (by its key or its label) fills that dimension
  (`dimension:<key>`);
- every other kept column is a metadata value under its header;
- email, name and ignored columns are dropped.

Every row carries the import's tag (`import-YYYY-MM-DD-xxxx`), so First insights reads only this import's reviews
(`tag=` on the metrics routes). Row identity, datasets and source profiles work as for any CSV upload
([csv-import.md](csv-import.md)).

## A survey export: an imported form

A survey export becomes a real Feedback Form v2 ([feedback-forms.md](feedback-forms.md)). Its definition is inferred
on the server (`shared/import_survey.py` `infer_form`, validated by `shared/forms_v2.py` `validate_definition` like
any form), from the kinds a person confirmed and from every distinct value of the choice, multiple-choice and grid
columns over the whole file (`values`):

| Column | Question |
|---|---|
| `open_text` | `open_text`, long |
| `nps_0_10` | `nps` |
| `csat` | `csat` |
| `rating_1_5`, `rating_1_10` | `rating`, 5 stars or 10 points |
| `choice` | `single_select`, one option per distinct value (at most 50) |
| `multi_choice` | `multi_select`, one option per distinct answer |
| `matrix_cell` | `matrix` (7.61.00): its rows and columns from the pairs (at most 20 rows and 10 columns) |
| `date`, `id` | The response's date and its own id |
| `channel` | The hidden field `channel` |
| `email`, `name`, `url`, `ignore` | Left out |

No question is required and none carries logic. A column that cannot become a question (more than 50 answers, a grid
that is too large, more than 30 questions) is named with its reason. The form is created with
`imported: {from, at, filename}` (`POST /feedback-forms`). An imported form:

- is **Off for good** and has **no public link**: its config, iframe, submit and events routes answer 404 as for an
  unknown id; a save that turns it on is a 409 `imported_form`; and it takes no test link;
- can still be renamed and its questions' wording edited. Its answers lock as any answered form's does.

Its rows are imported by `POST /feedback-forms/{form_id}/import`. The wizard sends 1,000 rows a call, and the route
takes at most 5,000:

- **Checks.** Each row is checked for its types and ranges like any response: option codes, scales, grid rows and
  columns, the character limits and declared hidden fields. The logic path is **not** enforced and no answer is
  required, because the row followed the other tool's logic, not this form's (owner decision). A row with no answer,
  a value that is not an option, a score out of range or a date that cannot be read is refused with its file row and
  code (`answer_invalid`, `empty_response`, `date_invalid`, `duplicate_row`…).
- **The queued response.** Each accepted row is queued as a response of the form's current revision, dated with its
  own date, under the form's brand partition, so Results, Report and Compare read it. NPS stays in `form_answers`:
  the item's rating is the first rating or CSAT answer, never the NPS. The text is the open answers under their
  headlines, else `headline: answer` lines. Its metadata names the run (`form_import_run`).
- **Idempotent.** A row's id is derived from the form and the row's own id (else its file row and its answers), so
  importing the same file into the same form again names the same items, and the processor skips them.
- **Dry run.** `dry_run: true` checks every row and writes nothing.
- **Who.** Admins acting as themselves only: the workspace's admins in one, never a delegated caller (an MCP token,
  an agent or a plan step). A form that was not imported is a 409 `not_imported`.

## The original file

The bronze layer keeps the original file write-once. A survey export's file rides the first import call (`file`, at
most 2 MB, a workbook in base64) and is kept at `raw/feedback_form/import/{form_id}/{run}.{csv|tsv|json|xlsx}` (a
workspace's: `ws/{ws}/raw/feedback_form/import/…`), with `If-None-Match: *`, as the bucket's policy requires under
every bronze root. Later calls name it (`file_key`, checked to be this form's), and every response points at it.

A reviews file is kept as every CSV upload's is, at `raw/csv_upload/{yyyy}/{mm}/{dd}/{run}.csv`. Both follow the
source's policy: the whole file is kept only under a profile that allows personal data and keeps it for good; under a
retention period each response gets its own raw copy; under a redacting profile nothing is kept. A workspace that saved no profile for the
source redacts ([source-policies.md](source-policies.md)).

## In a workspace

The manual import acts in the workspace `X-Workspace-Id` names (7.67.00), for every route: paste, CSV, JSON, detect
and history. This closes a D8 gap ([multi-workspace.md](multi-workspace.md)):

- **Who.** The workspace's admins (a member admin, or a platform admin who entered). The deployment's `admins` group
  grants nothing there; an editor gets 403 and a non-member the one 404.
- **What it uses and writes.** The workspace's own source profiles, its raw copies under `ws/{ws}/raw/…`, every
  queued message stamped with the resolved `workspace_id` (never a body field), its dataset rows read in its own
  partitions, and its runs in `WS#{ws}#IMPORT_RUN`, which its history lists.
- **What it refuses.** A Radar brand: Radar is not keyed by workspace.
- **A paste's parse job.** The job row stays deployment-wide for its hour, naming the workspace it was started in.
  Read or confirmed from any other place, it answers the unknown job's 404.

The form import works the same way through the forms API's own resolution.

## Import history

Every reviews import is a `csv` run and every call of a survey import is a `form` run, both with their counts and
refusals ([import-history.md](import-history.md)).

## Cost and limits

- **Cost.** Detection is free and adds no fixed cost. Processing is the usual enrichment per item, about $1 for 1,000
  rows (to be measured).
- **Speed.** "About two minutes" to the first insights depends on the processor's concurrency (to be measured on a
  test deployment).
- **Timeouts.** Each call stays far inside the API's 29 s: 1,000 rows a call, sent to the queue ten at a time.
- **Not included.** Live Google Sheets, a store API (the app review plugins exist), and de-duplication across
  datasets beyond `csv-row-v2`.
