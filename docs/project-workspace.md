# Project Workspace

The Projects workspace turns customer feedback into research artifacts, lets teams compare concrete artifact combinations, and exposes selected data to external agents through read-only MCP credentials.

## Workflow

1. Create a project and select the feedback window and filters that ground it.
2. Generate or import personas and run research.
3. Create PRDs, PR/FAQs, product reports, and prototypes from project context.
4. Review each artifact's provenance and revisions in the Documents tab.
5. Compose project artifacts into Prioritization rows and collect ballots.
6. Export selected content or create an MCP credential for an external agent.

Long-running research, persona, document, merge, and prototype operations run as background jobs. Their status appears in the project. The `list_jobs` MCP tool returns only the newest 50 jobs and has no continuation token or partial-result flag.

## Managed Document Versions

PRDs, PR/FAQs, and prototypes are version-managed. Documents with the same type and base title form a persistent series named `Title (v1)`, `Title (v2)`, and so on.

- A retry of the same job returns the already allocated document instead of creating another version.
- Deleting a document does not reuse its version number. Allocation history remains so a delayed retry cannot recreate deleted work under a new version.
- Legacy managed documents are assigned stable identities when read and persisted before a new version is allocated.
- Revision metadata identifies the prototype being revised and the feedback that drove the revision.
- Derivation metadata identifies source documents and whether the generator used all selected inputs.

Version counters and allocation-history records are platform-managed. Do not delete rows under the `DOCUMENT_VERSIONS#PROJECT#<id>` partition; see [Data Lake Structure](data-lake-structure.md#projects-table).

## Prioritization Rows

A Prioritization row is a concrete set of scorable documents from one project, not a moving pointer to “the latest” artifacts.

- Any authenticated reviewer can compose another row from a project's scorable documents.
- A row can be recomposed only before its first value-bearing ballot. A stamp-only/all-null save does not freeze it. Once a score lands, the selected document IDs stay fixed so later regeneration cannot change what reviewers scored.
- Admin deletion is available only when the row is not the project's sole default row and has at most 98 ballots. The server deletes an eligible row and those ballots atomically. A room session can accept up to 200 ballots, so a larger row must be retained; the delete endpoint refuses it rather than partially cleaning it up.
- Room voting creates a time-limited session and QR code so participants can score from their own devices.
- Lineage indicators distinguish a coherent document chain, missing lineage, and cross-generation selections.
- A frozen row may be marked stale when a strictly newer, non-contradictory combination of the same document types exists. This is advice, not a gate: the row remains visible and scorable.

When a frozen row is stale, add a new row for the newer combination instead of mutating the row whose ballots describe the older artifacts.

## MCP Access

Open a project and select **Export / MCP Access**. The page provides a ready-to-copy `mcp.json` snippet and lets an authenticated user mint or revoke credentials.

### Create a credential

1. Enter a descriptive token name.
2. Select at least one domain scope:
   - `feedback:read` — feedback verbatims, lists, similarity, urgent items, and facets.
   - `metrics:read` — dashboard summaries and metric breakdowns.
   - `projects:read` — project metadata, personas, and background jobs.
3. Choose read reach:
   - `workspace` — all projects plus the workspace-wide feedback and metrics corpus.
   - `project-set` — only the projects recorded on the credential. Because feedback and metrics have no project dimension, workspace-shaped tools are refused for this reach rather than leaking the whole corpus.
4. Choose an expiry of 30, 90, or 365 days, or explicitly choose no expiry.
5. Generate the token and copy it immediately. The plaintext token is shown once; stored token rows contain only its digest.
6. Copy the generated configuration into the MCP client and replace `<YOUR_API_TOKEN>`.

A generated configuration has this shape; use the UI-provided endpoint rather than constructing it by hand:

```json
{
  "mcpServers": {
    "voc-datalake": {
      "url": "https://<api-id>.execute-api.<region>.amazonaws.com/v1/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_API_TOKEN>"
      }
    }
  }
}
```

Revoke a credential from the same page when it is no longer needed. Reissue credentials created before domain scopes and read reach were introduced. Missing or malformed scopes grant nothing, while a row with valid scopes but no reach is interpreted as `workspace` for backward compatibility.

### Read-only tool catalogue

`tools/list` is filtered by the credential's scopes and reach, so clients see only tools they can call.

| Tool | Purpose |
|------|---------|
| `search_feedback` | Search feedback text with optional filters |
| `list_feedback` | Page through filtered feedback with partial-window metadata |
| `get_feedback_detail` | Read one feedback item |
| `get_similar_feedback` | Find same-category neighbours |
| `list_urgent_feedback` | Read a bounded page of high-urgency feedback |
| `list_feedback_facets` | Count categories and recurring problem summaries |
| `get_metrics_summary` | Read totals, sentiment, urgent count, and daily series |
| `get_metrics_breakdown` | Break metrics down by sentiment, category, source, or persona |
| `get_project` | Read project metadata and artifact titles |
| `list_personas` | Read the personas of one project |
| `list_jobs` | Read the newest 50 background jobs of one project; no continuation |

The server is read-only. Completeness metadata is tool-specific: feedback and metrics tools expose the partial-window fields their underlying routes provide, while `list_jobs` exposes no truncation field. For that tool, `count: 50` can mean “at least 50,” not a complete job history.
