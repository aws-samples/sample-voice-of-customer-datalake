# Moving projects between deployments

Two operator scripts copy research projects from one deployment to another: a demo to
production, one region to another, or a prefixed copy to its sibling in the same account.
They run on your machine with your own AWS credentials. No API route or Lambda is involved,
and nothing is sent anywhere except the two deployments you name.

Ported from PR #429 by @aws-bryan (`export_projects.py`, `import_projects.py`,
`migrate_projects.py`).

## Before you start

- AWS credentials for the source deployment (to export) and the target deployment (to import).
  The scripts use boto3's normal credential chain: `AWS_PROFILE`, environment variables or SSO.
  Nothing is hard-coded to an account, region or profile.
- The deployment prefix (the `-c deploymentPrefix` value; leave `--prefix` out for an
  unprefixed deployment) and the region. The scripts read the table, bucket and user-pool
  names from `<prefix>-VocCoreStack`'s outputs, and the API URL from `<prefix>-VocApiStack`.
- Run from `voc-datalake/` with the repo's virtualenv (`.venv/bin/python`). Plain export and
  import need only Python 3.12 and boto3. `--new-ids` also imports the platform's id helpers
  from `lambda/shared`, which need the virtualenv.

Permissions: the export reads the projects and aggregates tables (`Query`, `Scan`, `GetItem`),
the raw bucket (`ListBucket`, `GetObject`) and CloudFormation `DescribeStacks`. The import also
writes those tables (`PutItem`, `BatchWriteItem`) and the bucket (`PutObject`), and calls
Cognito `ListUsers` on the target user pool. Both need KMS decrypt / encrypt on the
deployment's key.

## Export

```bash
cd voc-datalake
.venv/bin/python scripts/project-export.py --prefix demo --region us-east-1 \
  --out ~/voc-bundles/example-air-checkout --project proj_20260101000000_aaaa1111
```

Repeat `--project` for several projects, or pass `--all` for every live project (deleted
projects and verification fixtures are skipped). `--out` must be a new or empty directory. A
project that does not exist or is deleted stops the export before anything is written.

## Import

Preview first. `--dry-run` resolves every owner and member and prints the rows and objects it
would write, per project, without writing anything:

```bash
.venv/bin/python scripts/project-import.py --prefix prod --region eu-west-1 \
  --bundle ~/voc-bundles/example-air-checkout --dry-run
```

Then run the same command without `--dry-run`.

| Option | Effect |
|---|---|
| `--owner-email <email>` | Owner on the target when the project owner's email is not in the target user pool. |
| `--new-ids` | Give the project and its personas, documents, comment series and pin forms new ids. Use it when the project id already exists on the target, for example to import a second copy into the deployment it came from. |
| `--dry-run` | Print the plan and write nothing. |

Every project is planned before anything is written. The import is refused, and nothing is
written, when:

- the project id already exists on the target (a deleted project's tombstone counts) and
  `--new-ids` is not given;
- the owner's email matches no single user in the target pool and `--owner-email` is not
  given, or `--owner-email` does not match one either;
- the bundle is not a `voc-project-bundle`, is a newer version than the script reads, or names
  an object path outside the bundle directory.

Writes go in this order: S3 objects, pin forms and pins, the project's other rows, and finally
META with a condition. A failed import therefore never shows as a project in the target's
list. To retry it, delete the partial rows or run again with `--new-ids`.

## What is carried

| Data | Where | Notes |
|---|---|---|
| The project (META), personas, PR/FAQs, PRDs, prototypes, custom and research documents, decision records, product-doc rows | projects table, `PROJECT#{id}` | The whole partition. |
| Document version counters and allocations | projects table, `DOCUMENT_VERSIONS#PROJECT#{id}` | Version numbers continue where they were. |
| Comment threads and replies | projects table, `DCOMMENTS#{id}#{series}` / `C#…` | |
| Prototype pin forms and pins | aggregates table, `FEEDBACK_FORM` / `FORM#pf_…`, `PINS#{form}` | |
| Prototype HTML, uploaded product docs, persona avatars | raw bucket, `prototypes/{id}/`, `projects/{id}/product_docs/`, `avatars/…` | Content type, cache control and metadata are kept. |

References are rewritten on the way in:

- **People.** A Cognito sub exists only in its own user pool. The import looks up the owner and
  each member in the target pool by email and replaces their subs everywhere in the project's
  rows. A member who is not in the target pool is removed from the project and reported.
- **The bucket.** `s3://<source bucket>/…` URIs (persona avatars) name the target bucket.
- **The API.** A prototype's pin widget posts to its deployment's API. The `pin-submit-url`
  metadata and the URL inside the HTML are pointed at the target API. When the target's API
  stack cannot be read, the metadata is dropped, and pins still work inside the app's
  prototype viewer.
- **Ids** (`--new-ids` only). The new ids follow the platform's own derivations, so a
  versioned document id, a comment series id and a pin form id are what the platform would
  compute for the new project.

## What is not carried

- **Review links** (`DOCSHARE#…`, the series' `SHARE` row, reviewer rate counters) and **MCP
  tokens**. These are credentials. Create new review links on the target.
- **Jobs** (the jobs table): progress rows for runs that already finished, with a TTL.
- **The agent that created a project** (`created_by_agent`): agents belong to their deployment.
- Feedback, participant lists and project links, Prioritization rows, and agents: they
  reference the source deployment's own data and people.
