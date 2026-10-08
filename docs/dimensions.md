# Dimensions, tags and channels

Categories answer "what is this feedback about". **Dimensions** answer "where does it
come from": which product, which module, which kind of user (customer or partner), or any
other axis an admin defines. **Tags** are free labels. **Channel** is the sub-source a
record already names (for example `email` or `chat` inside one CSV import). You can filter
feedback, metrics, the AI assistant and the MCP server by all three.

## The model

An admin defines up to 10 dimensions in **Settings → Dimensions**. The definitions are
stored in `voc-aggregates` as `pk=SETTINGS#dimensions, sk=config`:

```json
{
  "dimensions": [
    {"key": "product", "label": "Product", "infer": true,
     "values": [{"name": "app"}, {"name": "web"}]},
    {"key": "module", "label": "Module", "parent": "product", "infer": true,
     "values": [{"name": "billing", "parent_value": "app"}, {"name": "checkout", "parent_value": "web"}]},
    {"key": "user_type", "label": "User type", "infer": false,
     "values": [{"name": "customer"}, {"name": "partner"}]}
  ],
  "updated_at": "…", "updated_by": "…"
}
```

| Rule | Limit |
|---|---|
| Dimensions | ≤ 10 |
| `key` | `^[a-z][a-z0-9_]{0,31}$`, unique. Must not be a reserved name: `category`, `subcategory`, `source`, `channel`, `tag`, `tags`, `sentiment`, `urgency`, `days`, `limit`, `offset`, `q` |
| `label` / `description` | ≤ 64 / ≤ 300 characters |
| Values per dimension | ≤ 200. A value `name` matches `^[^\s#,:]{1,64}$` and is unique within its dimension |
| `parent` | Another dimension that has no parent of its own (one level of nesting) |
| `parent_value` | Must name a value of the parent dimension |
| `infer` | Default `true`. The model may fill this dimension in when nothing else sets it |

Validation lives in `lambda/shared/dimension_config.py`.

## Where a value comes from

Each feedback item stores `dimensions: {key: value}` and records where every value came
from in `dimension_sources: {key: origin}`. The processor resolves each key separately, and
the first source in this list that supplies a value wins:

| Order | Origin | Where the value comes from |
|---|---|---|
| 1 | `source` | The ingested message: a CSV column mapped to `dimension:<key>`, a JSON upload's `dimensions`, a form embed's `dimensions` option. Then, for keys still unset, the message's `metadata` (and `metadata.custom_fields`) entries whose key equals a configured dimension key and whose value is allowed — so an unmapped CSV column named `product` feeds the `product` dimension. Explicit `dimensions` win over metadata |
| 2 | `profile` | The source profile's `dimension_defaults` (see [source-policies.md](source-policies.md)) |
| 3 | `category` | The category's `product`, when a dimension keyed `product` exists and that value is allowed |
| 4 | `ai` | The model's output, only for dimensions with `infer: true` |

Two later writers also set origins: `manual` (an edit through `PUT /feedback/{id}/dimensions`)
and `reprocess` (`POST /settings/categories/reprocess` with `mode: 'dimensions'`). A
reprocess re-infers AI dimensions only. It never overwrites a key whose origin is `source`,
`profile` or `manual`.

Every candidate goes through `resolve_dimensions`, which drops unknown keys and disallowed
values, and drops a child value whose `parent_value` does not match the resolved parent.

**Tags** on an item are the union of the message's tags and the profile's tags, at most 20.
Each tag is ≤ 64 characters with no `#`, `,` or `:`, de-duplicated, and keeps its case.
**Stored tag counters are lower-cased**, so `VIP` and `vip` count as one tag.

**Channel** is the item's `source_channel`. A CSV column named `source` or `source_channel`
still maps to it automatically.

## Filters

Every list, search, urgent and entities route, and every `/metrics/*` view (`summary`,
`sentiment`, `categories`, `sources`, `personas`, `dimensions`, `github`), takes these
filters, next to `source` (`/metrics/github` is GitHub Issues only and ignores `source`):

| Parameter | Matches |
|---|---|
| `channel=<source_channel>` | Exact match |
| `tag=<tag>` | Item `tags` contains it, ignoring case |
| `dims=<key>:<value>[,<key>:<value>…]` | Every pair must match (AND), ≤ 10 pairs. A malformed value answers 400 |

These are post-query filters: like `sentiment`, they force the item-scan path.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/settings/dimensions` | `{dimensions, updated_at}`. Any signed-in user |
| PUT | `/settings/dimensions` | Admin. Body `{dimensions}` → `{success: true, dimensions}`; 400 when invalid |
| PUT | `/feedback/{id}/dimensions` | Body `{dimensions?: {key: value\|null}, tags?: [str]}`. Sets origin `manual`; `null` removes the key. 400 unknown key or value, 404 not visible, 409 concurrent change |
| GET | `/metrics/dimensions?key=<dim>` | Also takes `days`, `date_basis`, `source`, `channel`, `dims`, `tag`. Returns `{key, period_days, is_partial, values: {<value>: {count, positive, negative, neutral, mixed}}, unassigned}` |
| GET | `/feedback/entities` | Adds `channels: {ch: n}`, `tags: {tag: n}` (top 50) and `dimensions: {key: {value: n}}` **inside `entities`**, next to `sources` |
| POST | `/settings/categories/reprocess` | `mode: 'dimensions'` re-infers AI dimensions only |

The aggregator also keeps a daily per-channel counter, `METRIC#daily_channel#<channel>`
(metric_type `channel`), next to the per-source one.

## Setting values at ingestion

- **CSV upload** (`POST /scrapers/manual/csv-upload`):
  - `column_map: {<header>: <target>}`, where a target is `text`, `id`, `rating`, `date`,
    `author`, `title`, `url`, `channel`, `tags`, `metadata`, `ignore` or `dimension:<key>`.
  - A `tags` column is split on commas or semicolons.
  - Headers that are neither mapped nor auto-detected go to `metadata`. Nothing is dropped
    silently.
- **JSON upload**: items accept `dimensions` and `tags`; the body accepts `source_id`.
- **Feedback forms and scrapers**: the config takes `dimension_defaults` and `tags`. A form
  embed can also pass a `dimensions` object, but only for keys the form has no
  `dimension_defaults` for: the form's own defaults win (the embed is public page code).

## AI assistant and MCP

- **Assistant:**
  - `list_dimensions` reads the definitions.
  - `search_feedback`, `list_feedback`, `get_urgent_feedback` and `get_entities` take
    `channel`, `tag` and `dims` (an object, `{"product": "app"}`).
  - `get_metrics` takes `metric: "dimensions"` with a `key`, and applies `source` and the
    same filters to every metric (`github` takes the filters but not `source`).
- **MCP** ([mcp.md](mcp.md)): `list_dimensions` reads the definitions. `search_feedback` and
  `get_metrics` take `source`, `channel`, `tag` and `dims` (on every metrics view), and
  `get_metrics` has `view: "dimensions"` with a `key`.
