# Current-Product Map — Skill (Signal Analyzer)

## Purpose

Describe what the existing product does today, read from its codebase, so the
signals and the prototype are grounded in the real product. This is a
product-level map, not reverse engineering: architecture, code structure, and
technical debt stay with AI-DLC Reverse Engineering, which runs at Inception.

## When to Use

- The working folder is, or contains, the product's own repository.
- Run it as pre-work before the engagement day, with the engineering lead, in
  about an hour. It can also run at the start of Signals.

Skip it when there is no related codebase (greenfield) or in Amazon Quick. A
missing map never blocks the workshop or the Handoff.

## Rules

1. **Read only.** Search and read the code. Never edit, build, or run it.
2. **Product language.** Describe features, users, and data the way a product
   owner would. No class names, frameworks, or diagrams of components.
3. **Cite locations.** Every feature or integration names the folder or file
   it was found in, so the team can check it.
4. **Unknowns stay unknown.** When the code does not show something, write
   "Not visible in the code" instead of guessing.
5. **No secrets.** Never copy keys, connection strings, or customer data from
   the repository into the map.

## Prompt

```
You are a product analyst reading a codebase to explain what the product does
today. Search the repository; do not read every file. Report, in product
language, with a code location for each item:

1. Features: what a user can do today, grouped by user journey
2. Users and roles the product distinguishes
3. Data the product holds about its customers (categories, not values)
4. Integrations: external systems and services it calls or receives from
5. Visible limits: features that are flagged off, stubbed, or marked TODO
6. Areas the signals point at: for each top theme in the Signal Analysis
   Report, where the related feature lives, or "Not visible in the code"
```

## Output

`discovery/[project]/signals/current-product-map.md` with the six sections
above and a `## Sources` list of the repository paths read.
