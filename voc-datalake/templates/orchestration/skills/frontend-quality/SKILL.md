---
name: frontend-quality
description: "Checks frontend design and code quality in React, Next.js, Vue or Svelte: AI visual slop, div soup, Tailwind bloat, WCAG 2.2 accessibility, Core Web Vitals (LCP, INP, CLS), design-system violations. Read it when writing or reviewing UI components; not for backend-only changes."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/frontend-quality"
license: MIT
adapted: "The spec-loader and preset step reads DESIGN.md and DESIGN.web.md with read_file. Tools run through run on the changed files with the repository's installed binaries (no npx fetch: no network); tools that need a running URL or a browser (axe-core CLI, Lighthouse) are a person's or the repository's own test setup. Fixes are the builder's, within its change; reviewers write findings; description reworded for Claude 5.5 skill discovery"
---

Audit the frontend design and code quality of the files your task names (a reviewer: the files the patch changes).

Default: `**/*.{tsx,jsx,vue,svelte,html,css,scss}` (exclude node_modules, dist, build, .next, out).

## Step 0: Load Project Specs

Read with `read_file`, in order, the files the repository has:

1. `DESIGN.md` at project root (brand tokens, do's/don'ts)
2. `DESIGN.web.md` at project root (breakpoints, component specs, focus, motion)
3. If neither: the built-in heuristics below.

When reporting findings, cite tokens by path: `{colors.primary}` not `#FF9900`. Anchor severity to the design file:
a hex color flagged as "generic gradient" is only MUST if it is not resolvable to a `{colors.*}` token. Without a
design file, fall back to the built-in heuristics below.

## Step 1: Detect Stack and Tools

Read `package.json`, framework configs (next.config.*, vite.config.*). Run the tools the repository installs (with
`run`, from `node_modules/.bin/`, on the files you changed or the patch changes):

| Tool | Command |
|---|---|
| jsx-a11y | `eslint --rule '{"jsx-a11y/alt-text": "error"}' <paths>` |
| stylelint | `stylelint <changed .css files>` |
| html-validate | `html-validate <paths>` |
| size-limit | `size-limit` (requires .size-limit.json and a build) |
| tailwindcss | `eslint --rule '{"tailwindcss/no-contradicting-classname": "error"}' <paths>` |
| axe-core | through the repository's own component tests (`jest-axe`, `vitest-axe`), if it has them; the axe CLI scans a running URL, which is a person's check |

`npx` fetching a tool needs the network, which the sandbox does not have: a tool the repository does not install is
not run, and your finish says so.

## Step 2: Scan Patterns

Full pattern explanations with code examples: `references/patterns.md`.
Anti-slop design system rules with bad/good comparisons: `references/anti-slop-design.md`.

### AI Visual Slop (10 patterns)

AI tools produce "distributional convergence": the same card-heavy, shadow-laden, gradient-bright aesthetic. Detect and replace with data-dense, high-contrast design.

| # | Pattern | Grep For | Severity |
|---|---------|----------|----------|
| 1 | Card syndrome | `rounded-lg shadow`, `MuiCard`, `Card` wrappers > 5 per view | MUST |
| 2 | Shadow overuse | `boxShadow`, `shadow-md`, `shadow-lg` on non-elevated elements | MUST |
| 3 | Generic gradients | `linear-gradient` with purple/blue defaults, `bg-gradient-to-` | SHOULD |
| 4 | Fat border radius | `borderRadius: 16`, `rounded-2xl`, `rounded-3xl` on data containers | SHOULD |
| 5 | Low data density | Metric cards with single value + label + icon + large padding | MUST |
| 6 | Missing tabular-nums | Numeric displays without `font-variant-numeric: tabular-nums` | SHOULD |
| 7 | Heavy chrome | Thick borders (> 1px), colored backgrounds on data containers | SHOULD |
| 8 | Inconsistent type scale | > 4 font sizes in one view, no clear hierarchy | SHOULD |
| 9 | Default component libs | Unstyled MUI/Bootstrap/Chakra with default spacing and elevation | SHOULD |
| 10 | Missing monospace data | Latency, throughput, percentages in proportional fonts | SHOULD |

### Typography and Data Display (5 patterns)

| # | Pattern | Grep For | Severity |
|---|---------|----------|----------|
| 11 | No monospace for metrics | Numbers, latency, throughput in sans-serif body font | SHOULD |
| 12 | Missing design tokens | > 10 unique hardcoded hex colors (`#[0-9a-f]{3,8}`) | SHOULD |
| 13 | Inconsistent spacing | Non-scale values (13px, 17px, 22px) | NIT |
| 14 | Hero section syndrome | Stock copy: "Transform", "All-in-one" + gradient | NIT |
| 15 | Font weight overuse | Bold on everything, no weight hierarchy (300/400/500/600) | SHOULD |

### CSS and Markup Slop (7 patterns)

| # | Pattern | Grep For | Severity |
|---|---------|----------|----------|
| 16 | Div soup | `<div>` nesting > 6 levels, `<div onClick` | SHOULD |
| 17 | Tailwind class overload | > 12 utility classes on one element | SHOULD |
| 18 | !important overuse | > 3 `!important` declarations | SHOULD |
| 19 | Mixed styling | Inline + utilities + modules in same component | SHOULD |
| 20 | Unused CSS | Selectors matching no elements | NIT |
| 21 | Inconsistent units | Mixed px/rem/em without system | NIT |
| 22 | Z-index wars | `z-index: 9999` or higher | SHOULD |

### Accessibility (10 patterns, WCAG 2.2)

| # | Pattern | Grep For | Severity |
|---|---------|----------|----------|
| 23 | Missing alt text | `<img` without `alt` or alt="image" | MUST |
| 24 | Missing ARIA labels | `<button><svg` without `aria-label` | MUST |
| 25 | Poor color contrast | `text-gray-400` on `bg-white`, light text on light bg | MUST |
| 26 | Missing focus indicators | `outline: none` without `focus-visible` | MUST |
| 27 | Missing skip navigation | No skip-to-content link | SHOULD |
| 28 | Form inputs without labels | `<input` with only `placeholder` | MUST |
| 29 | Missing heading hierarchy | h1 then h3, multiple h1 per page | SHOULD |
| 30 | Non-interactive click handlers | `<div onClick`, `<span onClick` | MUST |
| 37 | Target size below 24x24px | Icon buttons/links with `w-4 h-4`, `p-1` and no spacing | SHOULD |
| 38 | Password managers blocked | `autocomplete="off"` on login/password fields | MUST |

Patterns 37-38 cover WCAG 2.2 (W3C Recommendation, October 2023) additions: 2.5.8 Target Size (Minimum) and 3.3.8 Accessible Authentication (Minimum). WCAG 2.2 adds criteria on top of 2.1; it does not change the 2.1 contrast thresholds below.

### Performance (7 patterns, Core Web Vitals)

| # | Pattern | Grep For | Severity |
|---|---------|----------|----------|
| 31 | Unoptimized images | `<img` without `loading="lazy"`, no dimensions | SHOULD |
| 32 | Bundle bloat | Full `lodash`, `moment` in package.json | SHOULD |
| 33 | No code splitting | No `React.lazy`, `next/dynamic`, `import()` | SHOULD |
| 34 | Render-blocking | `<script` without `defer`/`async` in `<head>` | SHOULD |
| 35 | Missing loading states | `if (loading) return null` | NIT |
| 36 | Layout shift (CLS) | Images/embeds without explicit dimensions | SHOULD |
| 39 | Slow interaction response (INP) | Heavy synchronous work in click/input handlers, no `useTransition`/debounce | SHOULD |

Core Web Vitals as of March 2024: **LCP** (Largest Contentful Paint, target <= 2.5s), **INP** (Interaction to Next Paint, target <= 200ms, replaced First Input Delay), **CLS** (Cumulative Layout Shift, target <= 0.1). Measure with Lighthouse or the Chrome DevTools Performance panel on a running build (a person's measurement: it
needs a browser and a URL); INP cannot be measured from a lab run with no real interaction, use field data (CrUX, `web-vitals` library) to confirm.

## Step 3: Report

A reviewer writes each issue as a finding (`write_findings`); a builder puts the summary in its finish.

```
## Frontend Quality Audit: X issues (Y critical, Z recommendations)

### Summary
| Category | Issues |
|---|---|
| AI Visual Slop | X |
| Typography/Data | X |
| CSS/Markup | X |
| Accessibility | X |
| Performance | X |

### Findings
| # | Pattern | Category | File:Line | Severity | Description |
|---|---------|----------|-----------|----------|-------------|
```

### Severity Guide

| MUST (legal/UX risk) | SHOULD (quality) | NIT (polish) |
|---|---|---|
| Card syndrome (> 5/view) | Generic gradients | Spacing inconsistency |
| Shadow on non-elevated | Fat border radius | Class ordering |
| Low data density | Missing monospace data | Unit mixing |
| Missing alt text | No design tokens | Border radius variety |
| No focus indicators | Default component libs | Font weight hierarchy |
| Click on non-interactive | Missing tabular-nums | |

## Step 4: Fix (the builder, within its change)

1. **Fix** all MUST items in the components your change touches (accessibility violations are legal risk, visual slop is brand risk)
2. Replace card wrappers with `border-bottom` dividers or `border-white/5` subtle separators
3. Replace heavy shadows with `none` or `0 1px 2px rgba(0,0,0,0.1)` max
4. Add `font-variant-numeric: tabular-nums` to all metric containers
5. Add monospace font stack for data: `'JetBrains Mono', 'Fira Code', 'SF Mono', monospace`
6. Reduce border-radius: 6-8px for containers, 4px for inputs, 20px only for pills
7. **Skip** visual patterns matching an intentional design system
8. **Verify** with the repository's accessibility tests after fixes (and name an axe scan of the running page for a
   person)

## Tool Reference

Installing a tool is a dependency change: decide it before your first command (`install_dependencies` runs once,
first), and only when the task asks for it.

| Tool | Install | Detects |
|---|---|---|
| axe-core | `npm i -D @axe-core/cli` | WCAG 2.1 violations |
| eslint-plugin-jsx-a11y | `npm i -D eslint-plugin-jsx-a11y` | JSX accessibility |
| stylelint | `npm i -D stylelint` | CSS quality |
| html-validate | `npm i -D html-validate` | Semantic HTML, ARIA |
| size-limit | `npm i -D size-limit` | Bundle size budgets |
| Lighthouse | a person's run against a URL | Performance, a11y, SEO |

### Bundle Analysis
- `webpack-bundle-analyzer stats.json`: visualize bundled modules (where the repository installs it)
- `esbuild-visualizer`: tree view of bundle contents (likewise)
