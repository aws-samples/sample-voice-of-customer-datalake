# How-to: Move all Projects from `d` to `f`

Copies every live research **Project** (metadata, personas, PRDs, PR/FAQs,
research docs, custom docs, product reports, prototypes, product-context and
version-allocation records) plus their backing S3 objects (persona avatars,
prototype HTML, uploaded product docs) from the `d` deployment to the `f`
deployment.

**Feedback is NOT moved** (you will re-import it). Jobs, tombstoned (deleted)
projects, and verification fixtures are intentionally skipped.

Account `459119164048`, region `us-east-1`, profile `KiroAccess`.

---

## What moves, and why it's safe

| Source | Target | Notes |
|---|---|---|
| DynamoDB `d-voc-projects-…` partition `PROJECT#{id}` (every item) | `f-voc-projects-…` | Whole-partition copy — picks up every sk type (`META`, `PERSONA#`, `PRD#`, `PRFAQ#`, `RESEARCH#`, `DOC#`, `PRODUCT_REPORT#`, `PROTOTYPE#`, `PRODUCT_CONTEXT#`, `ALLOCATION#`) without cherry-picking. GSI keys (`gsi1pk`/`gsi1sk`) are relative to the project id, so they copy verbatim. |
| S3 `avatars/{persona_id}.*` | same key in `f` raw-data bucket | Avatar `avatar_url` is stored as `s3://…` but only the FILENAME is used at read time (re-signed against `f`'s own CloudFront), so no rewrite is needed — the object just has to exist under the same key in `f`. |
| S3 `prototypes/{project_id}/{doc_id}.html` | same key in `f` raw-data bucket | Prototype URL is re-minted per request from `f`'s `PROTOTYPES_CDN_URL`; only the object must exist. |
| S3 `projects/{project_id}/product_docs/**` | same key in `f` raw-data bucket | Uploaded product docs + extracted text. (None present on `d` today, but copied if any appear.) |

**Not moved:** `voc-jobs` rows (transient run state, no functional back-reference), feedback, tombstoned projects (`status in {deleting,deleted}` or `deletion_started_at` present), `verification_fixture_id` rows.

**No field rewriting is required for correctness.** The only deployment-specific
string is the bucket name embedded in `avatar_url`, and the read path ignores it
(filename-only). Both raw-data buckets are KMS-encrypted with per-deployment
keys; the S3 copy re-encrypts with `f`'s key automatically.

---

## Resource names (resolved)

| | Source `d` | Target `f` |
|---|---|---|
| Projects table | `d-voc-projects-459119164048-us-east-1` | `f-voc-projects-459119164048-us-east-1` |
| Raw-data bucket | `d-voc-raw-data-459119164048-us-east-1` | `f-voc-raw-data-459119164048-us-east-1` |
| `f` raw-data KMS key | — | `arn:aws:kms:us-east-1:459119164048:key/86eaba4a-f8ad-4972-a98b-b8e63bdc11d4` |

On `d` today: 17 project METAs (6 tombstoned → **11 live**), 30 personas (29 with avatars), 24 prototypes, plus PRD/PRFAQ/research/report/context/allocation rows. 184 items total.

---

## Steps

All commands assume:

```bash
export AWS_PROFILE=KiroAccess AWS_REGION=us-east-1
cd voc-datalake
```

### 1. Dry-run the migration (writes nothing)

Lists exactly which projects, items, and S3 objects would move.

```bash
.venv/bin/python scripts/migrate_projects.py \
  --source-prefix d --target-prefix f \
  --account 459119164048 --region us-east-1
```

### 2. Apply the DynamoDB + S3 copy

```bash
.venv/bin/python scripts/migrate_projects.py \
  --source-prefix d --target-prefix f \
  --account 459119164048 --region us-east-1 \
  --apply
```

The script is **idempotent**: DynamoDB puts are keyed on pk/sk (re-running
overwrites with the same bytes), and S3 copies overwrite the same key. Safe to
re-run if interrupted.

### 3. Verify (counts + spot check)

```bash
# Live project META count on each side (f should equal d's live count = 11)
for p in d f; do
  echo -n "$p live projects: "
  aws dynamodb scan --table-name "$p-voc-projects-459119164048-us-east-1" \
    --filter-expression "sk = :m AND attribute_not_exists(deletion_started_at) AND (attribute_not_exists(#s) OR (#s <> :d1 AND #s <> :d2))" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values '{":m":{"S":"META"},":d1":{"S":"deleting"},":d2":{"S":"deleted"}}' \
    --select COUNT --query Count --output text
done

# Avatar object count on f (should match the number of avatar objects copied)
aws s3 ls s3://f-voc-raw-data-459119164048-us-east-1/avatars/ | wc -l
```

Then open the `f` site (https://dk44i6tlaf6c2.cloudfront.net), log in as admin,
and confirm the Projects list shows the 11 projects with personas, documents,
and rendered avatars.

---

## Rollback

The target `f` started empty, so rollback is simply deleting what was copied:

```bash
.venv/bin/python scripts/migrate_projects.py \
  --source-prefix d --target-prefix f \
  --account 459119164048 --region us-east-1 \
  --rollback --apply
```

This removes only project items whose `project_id` exists on `d` and the S3
objects under the copied keys — it never touches `f` feedback or anything else.
