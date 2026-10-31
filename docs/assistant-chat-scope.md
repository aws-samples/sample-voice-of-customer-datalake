# Assistant chat scope: the filter panel and the filter floor

The filters a user has on screen limit what the AI assistant reads. They act as a **floor**: the
assistant can narrow within them, but it never reads feedback outside them. This applies to the
filters of the Categories and Problem Analysis pages, and to the filter panel on the AI Chat page
(`/chat`). The design comes from PR #429 by @aws-bryan.

## The filter panel on /chat

The panel sits above the composer on `/chat`. It is collapsed by default; its header is one button
(Enter or Space opens it) and shows:

- the number of filters set, or "All feedback";
- a live count of the reviews the scope matches in the time window ("1,247 reviews"; "12+ reviews"
  when the window could not be read in full, so the count is a lower bound);
- a non-blocking warning when the scope matches more than **1,000** reviews: the assistant then
  reads at most 1,000 per search and leaves the rest out, so narrowing the filters gives a complete
  answer.

Inside, the panel offers the time range (the same picker and setting the other pages use), source,
sentiment, rating (at least / at most N stars), channel, tag, "Urgent only" and categories (several
at once). The choices list what the time window holds (`GET /feedback/entities`).

The scope belongs to one conversation and lives in the browser tab's memory: a new conversation,
or a reload, starts with no filters. It is sent with every turn of that conversation.

The count is read from `GET /metrics/sentiment`, the existing count route that takes every filter
the panel offers. A sentiment filter reads its bucket, and several categories are one call (`category=a,b` is any
of them). No new API route was added. A Usefulness filter set on Categories or Problem Analysis is part
of the floor (`unrated` = a review without a band); the panel itself has no Usefulness control yet.

## The wire contract

Every run carries the page the user is on (`forwardedProps.page`). On Categories and Problem
Analysis, `page.filters` holds the page's URL filters. A run from `/chat` also carries
`forwardedProps.scope`:

```json
{ "scope": { "filters": { "category": "delivery,billing", "urgent": "1" }, "limit": 1000 } }
```

- `filters` uses the same keys and spelling as `page.filters` (`PAGE_FILTER_KEYS`: `q`, `category`,
  `subcategory`, `source`, `sentiment`, `usefulness`, `rating`, `rating_dir`, `urgent`, `channel`, `dims`, `tag`;
  each value a string of at most 200 characters). A comma list (`category=a,b`) means any of the
  values, as on the Categories page. `dims` is `key:value,…` with `key:a|b` for either value and
  `~unset` for no value.
- `limit` caps how many matching reviews one feedback read may use: 1 to 1,000, default 1,000. A
  scope without `limit` (what the SPA sends) gets the default.
- The time window is not part of the scope. It stays `forwardedProps.days` and `dateBasis`, and
  the tools' own `days` argument may still name another window ("the last 90 days").

The schemas are `pageFiltersSchema` and `chatScopeSchema` in
`voc-datalake/lambda/stream/src/assistant/contract.ts`, mirrored in
`voc-datalake/frontend/src/assistant/contract.ts` (the lockstep test compares them). The SPA sends
`scope` only from `/chat`; a scope the contract would refuse is left out instead of failing the run.

## How the tools apply the floor

The stream Lambda intersects `page.filters` and `scope.filters` into one floor
(`assistant/tools/server/feedback-floor.ts`): lists and dimension values are intersected, the
tighter rating bound wins, urgent applies if either sets it. `resolved` and `similarity` are not
part of the floor: they change how Problem Analysis groups reviews, not which reviews it reads.

- **search_feedback** reads rows itself and requires every row to pass the floor AND the model's
  arguments. An argument outside the floor (`source="s3_import"` when the user picked two other
  sources) matches nothing; the result says which argument was outside the user's filters, so the
  model can tell the user. An id lookup of a review outside the floor is not shown. With a scope,
  the matches are capped at `limit` (newest first) and the result says how many matched.
- **list_feedback, get_urgent_feedback, get_entities, get_metrics** call the metrics API, whose
  parameters take one value each. Without a model argument the floor's value is sent; a model
  argument inside the floor narrows; one outside it answers an empty result without calling the
  API. When the floor allows several values of a parameter, the tool asks the model to call it once
  per value. When the floor holds a filter the route cannot apply (subcategory and search text on
  every one of them; category and sentiment on `get_entities` and most metrics), the tool refuses
  and points to `search_feedback`, rather than read past the user's filters. `list_feedback` stops
  paging at the scope's `limit`.
- With no page filters and no scope, every tool behaves as before.

The caller's category and source access is applied as well, as before (`GET /feedback/access`); the
floor only narrows further.

The filter values are user data. They appear in the `<context>` block of the user turn ("Filters
set on the page" and "Filters set in the chat filter panel"), never in the system prompt; the system
prompt only says that the tools apply them.
