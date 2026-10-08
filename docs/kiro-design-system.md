# Kiro design system

The VoC frontend uses the design system of [KiroCrew](https://github.com/kirodotdev/kirocrew) (Apache-2.0): its **Kiro** colour theme in dark and light, Space Grotesk + JetBrains Mono, lucide icons, the Kiro ghost mark, and KiroCrew's component recipes and motion.

This file is the contract for VoC UI code. When something isn't covered here, look it up in KiroCrew (see [Upstream references](#upstream-references)) and port it the same way.

Ported from KiroCrew `main` at `5bb27bd` (2026-10-04). Colour tokens, status tones, sentiment and the data ramp re-synced against `main` at `acc0809` (2026-10-07).

## Contents

- [Where it lives](#where-it-lives)
- [Rules](#rules)
- [Themes](#themes)
- [Colour](#colour)
- [Typography](#typography)
- [Spacing, layout and density](#spacing-layout-and-density)
- [Radius, borders, elevation, layering](#radius-borders-elevation-layering)
- [Icons and brand](#icons-and-brand)
- [Components](#components)
- [Micro-interactions and motion](#micro-interactions-and-motion)
- [Charts](#charts)
- [Accessibility](#accessibility)
- [Out of scope](#out-of-scope)
- [Upstream references](#upstream-references)

## Where it lives

| Path (in `voc-datalake/frontend/`) | Role |
|---|---|
| `src/index.css` | All tokens, the Tailwind bridge (`@theme inline`), base styles and every component recipe |
| `public/theme-init.js` | Applies the saved theme to `<html>` before first paint |
| `src/theme/themeStore.ts` | Theme preference (system / light / dark), persisted as `voc-theme` |
| `src/theme/useThemeSync.ts` | Keeps `<html>` attributes in step with the store and the OS |
| `src/theme/tones.ts` | The `Tone` type for colour variant props |
| `src/components/ThemeToggle/` | Header button: system → light → dark |
| `src/components/KiroGhost/` | Brand mark (inherits `currentColor`) |
| `src/components/DialogClose/` | Labelled icon-only dialog close button |
| `public/kiro-ghost.svg` | Favicon |
| `src/theme/*.test.ts(x)` | Pin the theme-init ↔ store contract and the layering fixes |

## Rules

These are KiroCrew's UI rules (`website/AGENTS.md`, `website/AUTOSDE.yaml`, `website/docs/frontend-conventions.md`) as they apply to VoC. **MUST** rules are expected in review; the *VoC status* column says where VoC deliberately differs today.

| # | Rule | VoC status |
|---|---|---|
| 1 | **MUST** style with semantic tokens (`bg-card`, `text-muted`, `border-border`, `var(--accent)`). **Never** use Tailwind palette classes (`bg-white`, `text-gray-600`, `bg-blue-600`) or hex/rgb literals in app UI. | Enforced by review; the residue grep in [Verifying](#verifying-a-change) must be empty |
| 2 | **MUST** pick colour by **meaning** — accent / ok / warn / danger / info / aim / muted — never by hue. Variant props take a `Tone` (`src/theme/tones.ts`), never `'blue'`/`'green'`. | Adopted |
| 3 | **MUST** use the recipe classes below for buttons, inputs, selects, cards, badges, tabs, dialogs, menus and switches instead of hand-rolling them. | Adopted |
| 4 | **MUST** use `lucide-react` for every icon. Never a hand-rolled inline `<svg viewBox>` (exception: `KiroGhost`). | Adopted |
| 5 | **MUST** give every icon-only button an `aria-label` (and `title`). Dialog X buttons use `<DialogClose>`. | Adopted |
| 6 | **MUST NOT** scale or translate on hover — hover only paints (colour, border, shadow). Press feedback is `active:scale-[0.97]`. | Adopted |
| 7 | A hover state **MUST NOT** reuse the selected-state colour (hover `bg-bg-hover`; selected `nav-active` / `tab-active` / `bg-accent-subtle`). | Adopted |
| 8 | **MUST** keep text ≥ 12px for content; 10–11px only for decorative meta (section labels, counts). KiroCrew additionally bans the `text-xs` class in favour of `text-[12px]`. | `text-xs` (also 12px) is still allowed in VoC |
| 9 | **MUST NOT** use `window.confirm/alert/prompt`; use `ConfirmModal`. | Adopted |
| 10 | **SHOULD** keep at most two buttons in a row; move the rest into a menu. | Not audited |
| 11 | KiroCrew forbids native `<select>`. | **Deviation:** VoC styles native selects with `.select` (no Radix dependency) |
| 12 | KiroCrew uses Framer Motion for enter/exit/layout animation and forbids new CSS `@keyframes`. | **Deviation:** VoC has no Framer; motion is CSS-only via the `--animate-*` tokens. Don't add new keyframes without adding a token |
| 13 | **MUST** keep user-facing strings in i18n catalogs (`public/locales/*`). | Existing VoC rule (`npm run i18n:check`) |
| 14 | **MUST** respect `prefers-reduced-motion` (handled globally — don't override it). | Adopted |

## Themes

| Preference | `<html>` attributes |
|---|---|
| `system` | follows `prefers-color-scheme` live |
| `light` | `data-theme="kiro-light" data-mode="light" data-mode-pref="light"` |
| `dark` (default) | `data-theme="kiro-dark" data-mode="dark" data-mode-pref="dark"` |

- A visitor who has never chosen gets **Kiro Dark** (`DEFAULT_THEME_PREFERENCE` in `themeStore.ts`, mirrored by `DEFAULT_PREF` in `theme-init.js`); a saved choice always wins.
- Tokens are keyed on `data-theme`; `:root` falls back to Kiro Dark.
- The `dark:` variant matches `[data-mode="dark"]`. Prefer tokens; reach for `dark:` only when a value genuinely differs per mode and there is no token for it.
- `theme-init.js` is an external file because the CloudFront CSP is `script-src 'self'` (no inline scripts). Its storage key and attributes are pinned to `themeStore.ts` by `themeInit.test.ts`.
- KiroCrew ships ~18 colour families (emerald, nord, dracula, …). VoC ships only **Kiro**. To add another, copy its `[data-theme="<name>-dark|light"]` block from KiroCrew `website/src/index.css`, extend `themeAttribute()` and `theme-init.js`, and add a picker.

## Colour

All values are CSS custom properties in `src/index.css`. Use the **utility** in components, the **variable** in inline styles and SVG.

### Brand

| Role | Utility / variable | Kiro Dark | Kiro Light | Use |
|---|---|---|---|---|
| **Primary** (accent) | `bg-accent` / `--accent` | `#8e48ff` | `#8e48ff` | Primary buttons, active indicators, focus ring, brand glyph |
| Primary hover | `hover:bg-accent-hover` / `--accent-hover` | `#9f63ff` | `#7a35e0` | Hover of solid accent |
| On primary | `text-accent-fg` / `--accent-fg` | `#ffffff` | `#ffffff` | Text/icons on solid accent |
| Primary text | `text-accent-text` / `--accent-text` | `#bd8fff` | `#723acc` | Accent-coloured **text** and links on surfaces (contrast-safe) |
| Primary subtle | `bg-accent-subtle` / `--accent-subtle` | `rgba(178,127,255,.16)` | `rgba(142,72,255,.12)` | Tinted fills, selected rows, avatars |
| Primary glow | `--accent-glow` | `rgba(142,72,255,.3)` | `rgba(142,72,255,.15)` | Hover glow on primary buttons |
| Focus ring | `ring-ring` / `--ring` | `#8e48ff` | `#8e48ff` | Focus border |
| **Secondary** (aim) | `text-aim` / `bg-aim-subtle` | `#c19aff` / `rgba(193,154,255,.15)` | `#7337d6` / `rgba(115,55,214,.12)` | AI / generated content, secondary highlights distinct from primary |
| Selected nav | `.nav-active` (`--nav-active-bg/-text/-border`) | `#352f3d` / `#c19aff` / `#4a464f` | `#ebe5f3` / `#723acc` / `#c4bcd0` | Selected nav item / list row |

KiroCrew has no "secondary" button colour: a **secondary action** is the neutral bordered button (`btn btn-secondary`), and **secondary emphasis** is `aim`.

### Surfaces (back to front)

| Utility | Variable | Dark | Light | Use |
|---|---|---|---|---|
| `bg-bg` | `--bg` | `#19161d` | `#ffffff` | Page background |
| `bg-bg-accent` | `--bg-accent` | `#1c1922` | `#f5f5f5` | Subtle sections, table headers, dialog footers, code blocks |
| `bg-panel` | `--panel` | `#211d25` | `#fafafa` | Sidebar rail (dark: same as the card, as in KiroCrew `kiro-dark`) |
| `bg-card` | `--card` | `#211d25` | `#ffffff` | Cards, dialogs |
| `bg-bg-elevated` | `--bg-elevated` | `#211d25` | `#ffffff` | Inputs, selects, menus, tab tracks |
| `bg-bg-hover` | `--bg-hover` | `#28242e` | `#f0f0f0` | Hover fill, neutral chips, skeletons |
| `bg-panel-strong` | `--panel-strong` | `#28242e` | `#f5f5f5` | Strong neutral fill |
| `bg-overlay` | `--overlay` | `rgba(10,8,12,.6)` | `rgba(25,22,29,.4)` | Modal/drawer backdrop |
| — | `--chrome` | `rgba(25,22,29,.95)` | `rgba(255,255,255,.95)` | Frosted header (`.chrome-glass`) |
| — | `--card-hl` | `rgba(255,255,255,.04)` | `rgba(0,0,0,.03)` | 1px inner top highlight on cards |

In Kiro Light `--card` equals `--bg`, so cards **must** keep their border.

### Text

| Utility | Dark | Light | Use |
|---|---|---|---|
| `text-text-strong` | `#f2f1f4` | `#19161d` | Headings, values, emphasised text |
| `text-text` | `#dcdadf` | `#4a464f` | Body text |
| `text-muted` | `#938f9b` | `#5e5966` | Secondary text, meta, idle icons, placeholders |
| `text-muted-strong` | `#8a8592` | `#4a464f` | Section labels, faint text |

### Borders

| Utility | Dark | Light | Use |
|---|---|---|---|
| `border-border` | `#352f3d` | `#e4e4e7` | Default 1px border, dividers (`divide-border`) |
| `border-border-strong` | `#4a464f` | `#d4d4d8` | Hover border, emphasised edges |
| `border-border-hover` | `#5e5966` | `#a1a1aa` | Strongest neutral edge |
| `border-control-border` | `#77727f` | `#86818e` | The edge that **identifies a form control** (`.input`, `.select`, textarea, checkbox, radio). Not for dividers or cards |
| `border-control-border-hover` | `#938f9b` | `#5e5966` | That edge on hover |

`--border` is a divider, not a field boundary: it is 1.28:1 (dark) / 1.27:1 (light) on the card, and WCAG 1.4.11 asks 3:1 of a boundary that identifies a control. `--control-border` clears 3:1 against every surface a control sits on (`--bg`, `--bg-accent`, `--bg-elevated`/`--card`, `--panel`, `--panel-strong` and the `--bg-hover` row), in both themes:

| Token | Theme | bg | bg-accent | bg-elevated / card | bg-hover | panel | panel-strong |
|---|---|---|---|---|---|---|---|
| `--control-border` | dark | 3.83 | 3.71 | 3.55 | 3.25 | 3.55 | 3.25 |
| `--control-border` | light | 3.79 | 3.47 | 3.79 | 3.32 | 3.63 | 3.47 |

`theme/controlBorder.test.ts` computes these ratios from index.css (and the hover step's, and the checked `--accent` fill's), so a retune below 3:1 fails the suite. A control's border may only be overridden by a STATE colour at full strength (`border-danger`, `border-warn`, `border-aim`), never by `border-border*` or a tone at an opacity (`border-danger/60`); the same test enforces that.

### Semantic tones (status)

| Tone | Solid / text | Subtle fill | On solid | Dark | Light | Means |
|---|---|---|---|---|---|---|
| `ok` | `text-ok`, `bg-ok` | `bg-ok-subtle` | `text-ok-fg` | `#1bb36b` | `#007038` | Success, positive, active |
| `warn` | `text-warn`, `bg-warn` | `bg-warn-subtle` | `text-warn-fg` | `#e0b94d` | `#6b5900` | Warning, urgent, pending |
| `danger` | `text-danger`, `bg-danger` | `bg-danger-subtle` | `text-danger-fg` | `#ff5f73` | `#bd1c3a` | Error, negative, destructive |
| `info` | `text-info`, `bg-info` | `bg-info-subtle` | `text-info-fg` | `#7aa3e6` | `#285092` | Informational (not primary) |
| `aim` | `text-aim`, `bg-aim` | `bg-aim-subtle` | `text-aim-fg` | `#c19aff` | `#7337d6` | AI / generated / secondary highlight |
| `accent` | `text-accent-text`, `bg-accent` | `bg-accent-subtle` | `text-accent-fg` | see Brand | | Primary / running |
| `muted` | `text-muted` | `bg-bg-hover` | — | see Text | | Neutral |

**Contrast adjustments vs KiroCrew.** VoC is held to WCAG AA (4.5:1 for text, checked by axe in both themes). Every tone keeps the **hue** of KiroCrew's `kiro-dark` / `kiro-light` block (`website/src/index.css`); where KiroCrew's exact value misses AA on its own tints, only the lightness moves:

| Token | Theme | KiroCrew | VoC | Worst pair, KiroCrew → VoC |
|---|---|---|---|---|
| `--ok` | dark | `#008543` | `#1bb36b` | on `ok-subtle` over a hovered row 2.80 → 4.86 (`--ok-subtle` is KiroCrew's `rgba(0,133,67,.15)`; black `--ok-fg` 7.71) |
| `--danger` | dark | `#f94359` | `#ff5f73` | on its tint over a hovered row 3.79 → 4.53 (`--danger-fg` black) |
| `--info` | dark | `#6f9ae0` | `#7aa3e6` | `badge-info` on a hovered row 4.42 → 4.85 |
| `--accent-text` | dark | `#b07fff` | `#bd8fff` | |
| `--muted-strong` | dark | `#5e5966` | `#8a8592` | |
| `--ok` | light | `#008543` | `#007038` | on its tint over a hovered row 3.56 → 4.61 |
| `--warn` | light | `#a38a00` | `#6b5900` | 2.70 → 5.25 (so `--warn-fg` is white, not KiroCrew's black) |
| `--danger` | light | `#d92544` | `#bd1c3a` | 3.71 → 4.64 (white `--danger-fg` 6.19) |
| `--aim` | light | `#8041e6` | `#7337d6` | 4.10 → 4.76 |
| `--nav-active-bg` | light | `#d8d2e0` | `#ebe5f3` | `#723acc` label 4.45 → 5.34 |

`theme/statusTones.test.ts` computes these from index.css: each tone within 6° of KiroCrew's hue, ≥ 4.5:1 on `--bg`, `--bg-accent`, `--card`, `--bg-hover` and its own tint over the card and over a hovered row, and its `-fg` ≥ 4.5:1 on the solid fill. (Dark `--ok` was once `#22c55e` — the green of KiroCrew's generic `dark` theme, not of Kiro — and that hue pin now catches the mix-up.) When porting a token from upstream, re-check it on its subtle tint, on `bg-bg-accent` **and on `bg-bg-hover`** (badges sit on hovered rows). **Secondary text on a selected (`bg-accent-subtle`) surface uses `text-text`, not `text-muted`**: dark `--muted` is only 4.05:1 there (`VisibilityChoice`, the invite candidate list).

Borders on tinted elements use the tone at 30%: `border-ok/30`, `border-danger/30`, … Opacity modifiers work on every token (`bg-accent/10`, `ring-accent/40`).

### Sentiment and data visualisation

KiroCrew separates two kinds of colour in data, and VoC follows it:

- **Meaning → status tones.** Anything good/bad, pass/fail or healthy/at-risk is painted with `ok` / `warn` / `danger` (plus `accent` for "normal / running" and `--muted` for neutral), in charts and in badges alike. Examples in KiroCrew `website/src/`: `components/ContextBar.tsx` (`contextColor`: ≥ 90% `--danger`, ≥ 75% `--warn`, else `--accent`), `pages/TelemetryPanel.tsx` (the same thresholds on gauges), `apps/workflows/WorkflowsRuns.tsx` (run passed `text-ok`, paused `text-warn`, failed `text-danger`), `pages/settings/SlackPanel.tsx` and siblings (connected `--ok`, not connected `--warn`), `pages/ArtifactDetailPage.tsx` (created `--ok`, reverted `--warn`, referenced `--muted`), and pills such as `components/CommentThreads.tsx` (`bg-ok-subtle text-ok`). The rule is stated in `website/docs/frontend-conventions.md` › Styling: state colours are `text-ok` / `text-warn` / `text-danger` / `text-info`, a running state is `text-accent`.
- **Identity → categorical hues.** Data whose colour only says "which one" (a context source, a category) uses a fixed set of hues mixed 74% into the card: `--ctx-src-skill` `#00c48f`, `-memory` `#4aa8ff`, `-history` `#f2c14e`, `-lessons` `#ff9d5c`, `-sys` `#43c9bd`, `-skillidx` `#8f7bff`, `-tool` `#b98cff`, with `--ctx-src-mute` for the long tail, and `--ctx-cat-message: var(--accent)` for the primary series (`website/src/index.css` `:root`, lines ~430–465; used by `website/src/pages/contextSourceColors.ts`). KiroCrew's guidance there: hue is the data channel, mixed into the surface "so it reads as a calm instrument trace … rather than a saturated slop-gradient".

**Sentiment decision: status tones.** Positive / negative / mixed are meaning, not identity, so sentiment stays on `ok` / `danger` / `warn` with `--muted` for neutral, exactly as KiroCrew colours its own good/bad values, and never joins the ramp. (The alternative, putting sentiment on the categorical ramp, would contradict KiroCrew and give "negative" a hue that elsewhere just means "category 3".) The `--sentiment-*` tokens are aliases, so there is one source of truth:

| Variable / utility | Alias of | Dark | Light |
|---|---|---|---|
| `--sentiment-positive` / `*-sentiment-positive` | `--ok` | `#1bb36b` | `#007038` |
| `--sentiment-neutral` | `--muted` | `#938f9b` | `#5e5966` |
| `--sentiment-negative` | `--danger` | `#ff5f73` | `#bd1c3a` |
| `--sentiment-mixed` | `--warn` | `#e0b94d` | `#6b5900` |

On screen use `sentimentCssVar(label)` (`lib/sentiment.ts`) or the `text-sentiment-*` utilities; `SentimentBadge` (`bg-ok-subtle text-ok`, …) and `MetricCard` take tones. `sentimentHexColor` is for the PDF path only. `theme/statusTones.test.ts` pins the four aliases in both themes and fails if one points at `--chart-*`.

**The data ramp** (`--chart-1` … `--chart-8`, utilities `bg-chart-N` / `border-chart-N`) is KiroCrew's categorical set. **Dark** uses KiroCrew's recipe exactly — `color-mix(in srgb, <hue> 74%, var(--card))`, precomputed to hex. **Light** keeps each hue but darkens it toward black (HSL hue unchanged) to the first step ≥ 3.2:1, because KiroCrew's 74%-into-white mixes are only 1.5–2.3:1 on the white card, below the 3:1 [WCAG 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) asks of bars, lines and swatches. The one hue KiroCrew's set has that VoC drops is `-skillidx` `#8f7bff`: it is 7.7 ΔE2000 from `-tool` (indistinguishable), and the accent step takes its place.

| Step | KiroCrew source | Kiro Dark | on card | Kiro Light | on card |
|---|---|---|---|---|---|
| `--chart-1` | `--ctx-cat-message` = accent (dark: KiroCrew's kiro-dark accent tint `#b07fff`) — first series | `#b07fff` | 5.78 | `#8e48ff` | 4.64 |
| `--chart-2` | `--ctx-src-memory` `#4aa8ff` (blue) | `#3f84c6` | 4.20 | `#4194e0` | 3.21 |
| `--chart-3` | `--ctx-src-sys` `#43c9bd` (teal) | `#3a9c95` | 5.03 | `#359f95` | 3.21 |
| `--chart-4` | `--ctx-src-lessons` `#ff9d5c` (orange) | `#c57c4e` | 5.02 | `#c97c49` | 3.25 |
| `--chart-5` | `--ctx-src-tool` `#b98cff` (violet) | `#916fc6` | 4.18 | `#a37be0` | 3.25 |
| `--chart-6` | **neutral** = `--muted` (KiroCrew's remainder fill, e.g. `TokenDailyChart` cache-read) | `#938f9b` | 5.24 | `#5e5966` | 6.78 |
| `--chart-7` | `--ctx-src-skill` `#00c48f` (green) | `#099973` | 4.59 | `#00a377` | 3.23 |
| `--chart-8` | `--ctx-src-history` `#f2c14e` (amber) | `#bc9643` | 5.98 | `#ae8b38` | 3.21 |
| `--chart-grid` | `--border` | `#352f3d` | — | `#e4e4e7` | — |

Order is a VoC choice: KiroCrew keys hues by source, not rank. The accent leads (as KiroCrew's primary series does), and green and amber come **last** so a short category list never reads as a row of ok / warn statuses. Closest pair: 10.3 ΔE2000 dark (steps 1–5), 10.9 light (3–7).

**Ramp steps are fills, never text.** Light steps sit at 3.2:1, under the 4.5:1 text floor, so there is no `text-chart-*` in app UI (the previous VoC-only purple→pink ramp was text-grade; that is the trade for KiroCrew's hues). Label a bar with `text-text` next to a swatch. `theme/chartRamp.test.ts` pins: every step ≥ 3:1 on `--card`; every pair ≥ 10 ΔE2000; dark steps equal KiroCrew's 74% mix of the hues above; light steps within 3° of those hues; step 1 = the accent; `--chart-6` = `--muted`; no `text-chart-*` utility in `src/**/*.tsx`. Colour is still never the only cue: category bars carry their name and value, the Dashboard charts are single-series, and teal / green (steps 3 and 7) are close for deuteranopes.

**Categories.** `categoryChartSteps(rankedNames)` (`pages/Categories/types.ts`) gives every category in a ranked list (largest first, ties by name) its ramp step: names from the shipped taxonomies keep a **fixed** step on every page; every other name takes the next chromatic step not already used in that list, **by rank**, so the same ordered list always gets the same colours. `other`, and any name after the seven chromatic steps are spent, is the neutral `--chart-6`. (Before, every non-taxonomy name was grey, and on production every category is custom — design audit D-14.) Paint with `chartStepVar(step)` on screen; `CategoryData.color` carries `chartStepPrintHex(step)` — the **Kiro Light** hex of the same step — for the print/PDF export only (the print window has no app stylesheet). `types.test.ts` pins that mirror to the `[data-theme="kiro-light"]` block. Each distribution row shows a legend swatch in its bar's colour next to the name and count; the bar is `aria-hidden`, so colour is never the only cue.

### Mapping from Tailwind palette classes

| Old | New |
|---|---|
| `bg-white` (card / modal) · (input / menu) | `bg-card` · `bg-bg-elevated` |
| `bg-gray-50` · `bg-gray-100` / `hover:bg-gray-*` | `bg-bg-accent` · `bg-bg-hover` |
| `text-gray-900/800` · `700/600` · `500/400` · `300` | `text-text-strong` · `text-text` · `text-muted` · `text-muted-strong` |
| `border-gray-100/200` · `300/400` | `border-border` · `border-border-strong` |
| `bg-blue-600 text-white hover:bg-blue-700` | `btn btn-primary` |
| `bg-blue-50`, `text-blue-600` (primary) | `bg-accent-subtle`, `text-accent-text` |
| `green-*` · `amber/yellow/orange-*` · `red-*` | `ok` · `warn` · `danger` |
| `blue/sky/cyan-*` (informational) · `purple/violet-*` (AI) | `info` · `aim` |
| `bg-black/50` overlay | `bg-overlay backdrop-blur-sm` |
| multi-hue gradients | solid `bg-accent` or `bg-accent-subtle` |
| chart series / category hexes (`#3b82f6`, `#ef4444`, Tailwind-500 "one hue per category") | `var(--chart-1)` … `var(--chart-8)`; categories via `categoryChartSteps` + `chartStepVar` |
| `green/red/yellow` for sentiment | `--sentiment-positive/-negative/-mixed` (= `ok` / `danger` / `warn`), neutral `--muted` |

## Typography

| Family | Stack | Loaded from | Weights |
|---|---|---|---|
| Body (`font-sans`, `font-body`) | `'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | `@fontsource/space-grotesk` (bundled; CSP `font-src 'self'`) | 400 500 600 700 |
| Mono (`font-mono`) | `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace` | `@fontsource/jetbrains-mono` | 400 500 |

Base: `body { font: 400 .875rem/1.55 }` — **14px** body, antialiased, headings `letter-spacing: -0.01em` in `text-text-strong`.

| Role | Classes |
|---|---|
| Page title | `text-2xl font-bold tracking-tight text-text-strong` |
| Page subtitle | `text-sm text-muted mt-1` |
| Card / section title | `text-sm font-semibold tracking-tight text-text-strong` (larger cards: `text-base`/`text-lg font-semibold`) |
| Dialog title | `.dialog-title` (15px semibold) |
| Body | `text-sm text-text` |
| Dense UI (buttons, nav, menu items, labels) | `text-[13px]` |
| Meta / captions / badges / tabs | `text-[12px]` (`text-xs`) |
| Section label (sidebar groups, stat labels) | `text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong` · stat label `uppercase tracking-[.04em]` |
| Brand wordmark | `text-[13px] font-bold tracking-[.14em] uppercase` |
| Numbers, ids, counts, code | `font-mono` |
| Rendered markdown | `.md-content` |

## Spacing, layout and density

Spacing uses the Tailwind 4px scale; there are no spacing tokens.

| Element | Value |
|---|---|
| App shell | Sidebar rail + main column (`app-ambient h-screen flex`) |
| Sidebar rail | `w-[236px]` expanded, `lg:w-[74px]` collapsed, `bg-panel border-r`, 150ms width transition, items `px-3` |
| Nav item | `rounded-md py-2 px-3 gap-2.5 text-sm font-medium`, 16px icon; active `.nav-active`; idle `text-muted hover:text-text hover:bg-bg-hover` |
| Header | `.chrome-glass border-b px-4 sm:px-6 py-3`; time-range picker only on time-scoped routes (Dashboard, Categories, Problems, Chat, Data Explorer), theme toggle at the right |
| Page body | `p-4 sm:p-6` |
| Card | `.card` → `p-5`; compact cards `p-4`; stacked sections `space-y-4 sm:space-y-6` |
| Stat grid | `grid gap-3 sm:gap-4` (KiroCrew: `gap-3.5 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]`) |
| Controls | inputs/selects `px-3 py-2` (`select-sm`: `py-1 pl-2.5`); buttons `px-3.5 py-2` (`btn-sm`: `px-2.5 py-1`) |
| Dialog | header/footer `px-5 py-3`, body `px-5 py-4`; widths `max-w-md` (forms) … `max-w-4xl` (editors), `max-h-[90vh]` |
| Gaps | icon + label `gap-1.5`–`gap-2`; button rows `gap-2`; KiroCrew caps a row at two buttons |
| Breakpoints | `sm` (640) and `lg` (1024) for the shell; `md` (768) is KiroCrew's main narrow/desktop split |

## Radius, borders, elevation, layering

| Token | Value | Use |
|---|---|---|
| `rounded-sm` / `--radius-sm` | 6px | Inline code, small chips |
| `rounded-md` / `--radius-md` | 8px | Buttons, inputs, selects, tabs, nav items, menu items |
| `rounded-lg` / `--radius-lg` | 12px | Cards, menus, tab tracks |
| `rounded-xl` / `--radius-xl` | 16px | Dialogs |
| `rounded-full` | — | Badges, switches, avatars |

| Shadow | Dark | Light | Use |
|---|---|---|---|
| `shadow-sm` | `0 1px 2px rgba(0,0,0,.3)` | `0 1px 2px rgba(0,0,0,.06)` | Cards (plus `inset 0 1px 0 var(--card-hl)`), active tab |
| `shadow-md` | `0 4px 12px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.02)` | `0 4px 12px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.04)` | Hovered stat cards |
| `shadow-lg` | `0 12px 28px rgba(0,0,0,.45)` | `0 12px 28px rgba(0,0,0,.12)` | Menus, popovers |
| `shadow-2xl` | Tailwind default | | Dialogs |

Borders separate surfaces; shadows are reserved for things that float.

Layering: page content has **no z-index**. The sidebar `<aside>` is `z-50` (it only overlaps content when it slides in on mobile, over the `z-40` backdrop); the assistant launcher and floating panel are `z-50`, the fullscreen assistant `z-[60]`. `ModalShell` dialogs are **`z-[70]`** so an `aria-modal` dialog covers all of them — at `z-50` the launcher, later in the DOM, painted over the backdrop and stayed clickable (pinned by `designSystemCss.test.ts`). Menus are `z-20`–`z-50`. Don't put a z-index on `<main>` or the shell — it creates a stacking context that traps page modals under the sidebar (pinned by `designSystemCss.test.ts`). KiroCrew's own literals are `z-[100]`/`z-[101]` for dialogs and `z-[9999]` for portalled menus.

## Icons and brand

- **Library:** `lucide-react`, default stroke (2). Colour comes from `currentColor`: put `text-muted` / `text-accent` on the icon or its parent.
- **Sizes:** 16 nav, toolbars and icon buttons · 14 inline with text, tabs and menu items · 12–13 inside badges and meta · 18–20 empty states and feature tiles · 24 metric tiles.
- **Icon-only buttons:** `.icon-btn` (muted → text on hover); always `aria-label` + `title`.
- **Brand mark:** `<KiroGhost className="w-7 h-7 text-accent-text" />` — sidebar (28px), login (48px) and favicon (`public/kiro-ghost.svg`, accent stroke). Upstream also has 8 ghost poses (`website/src/assets/ghost-poses/pose-1..8.svg`) for empty states and loaders, not ported yet.
- **Theme toggle icons:** `Monitor` (system) · `Sun` (light) · `Moon` (dark).

## Components

All recipes are plain classes in `src/index.css` `@layer components`, so callers add layout utilities next to them (`className="btn btn-primary w-full"`). Don't add colour classes on top of a recipe.

### Buttons

| Class | Look | Use |
|---|---|---|
| `btn` | 13px medium, `rounded-md`, 1px border, transparent | Base (always combine with a variant) |
| `btn-primary` | Solid accent, white text, hover `accent-hover` + accent glow, sweep highlight | The main action (one per area) |
| `btn-secondary` | `bg-bg-elevated` + border | Secondary action, Cancel |
| `btn-ghost` | Borderless muted, hover fill | Tertiary / toolbar text buttons |
| `btn-danger` | Outlined, danger text, hover `danger-subtle` | Destructive, non-final |
| `btn-danger-solid` | Solid danger | Final destructive confirm |
| `btn-sm` | `px-2.5 py-1 text-[12px]` | Compact rows |
| `icon-btn` | `p-1.5 rounded-md text-muted` | Icon-only |

Disabled: `opacity-40`, no press scale.

### Form controls

| Class | Use |
|---|---|
| `input` | Text inputs and textareas: `bg-bg-elevated border border-control-border rounded-md px-3 py-2 text-sm`, hover `border-control-border-hover`, focus ring glow |
| `select` / `select-sm` | Native `<select>` with a theme-aware chevron (`--select-chevron`); same `--control-border` edge as `input` |
| `focus-ring` | The 2px `--ring` outline (offset 2px) on `:focus-visible` for any non-text-field focusable. Never a tint alone: the `--accent-subtle` glow is 1.28:1 on the card |
| `switch` + `switch-knob` | On/off pill: `w-9 h-5`, `bg-border` → `bg-accent` when `aria-checked="true"` or `switch-on`; white knob slides 16px |
| `range` (+ `range-unscored`) | Native `<input type="range">`: thin `bg-border` track, 18px accent thumb with a card-coloured ring, `h-8` hit area; `range-unscored` = hollow muted thumb for "not chosen yet" |
| Checkboxes / radios | Every `<input type="checkbox">` / `"radio"` is drawn by the base layer (no class needed): 16px box, 1px `--control-border` edge, `rounded-sm` (radio round), filled `--accent` with an `--accent-fg` lucide check when checked; `accent-danger` fills `--danger` for a destructive choice. The UA box ignores CSS borders, hence `appearance: none`. Do not add `border-border*` to them |

### Surfaces

| Class | Use |
|---|---|
| `card` | `bg-card border rounded-lg p-5 shadow-sm` with an inner highlight |
| `stat-accent` | On a card: 2px accent gradient line fades in at the top on hover |
| `skeleton` | `bg-bg-hover animate-pulse rounded-md` |
| `chrome-glass` | Frosted translucent chrome (`blur(18px) saturate(1.8)`) |
| `app-ambient` | Shell wrapper: faint fixed accent washes behind the app |

### Links

`link` on every text link (`<a>`, `<Link>`) and link-styled button: `--accent-text`
colour **and** an underline at rest (1px, offset 2px, thicker on hover), focus ring on
`:focus-visible`. Never `text-accent-text hover:underline`: an underline that appears
only on hover leaves colour as the only cue at rest, which fails WCAG 1.4.1 (axe
`link-in-text-block`). `src/theme/linkStyle.test.ts` bans that spelling. Rendered
markdown gets the same treatment from `.md-content a`.

### Badges

`badge` + tone: `badge-ok` · `badge-warn` · `badge-danger` · `badge-info` · `badge-aim` · `badge-accent` · `badge-muted`. Pills are `rounded-full px-2 py-0.5 text-xs font-medium`; counts inside use `font-mono`.

### Tabs (segmented pill)

```tsx
<div className="tabs-rail">                      {/* optional row with a bottom hairline */}
  <div className="tabs-track">
    <button className={clsx('tab', active && 'tab-active')}>
      <Icon size={14} /> Label <span className="font-mono">(2)</span>
    </button>
  </div>
</div>
```

The track is `rounded-lg border bg-bg-elevated p-0.5`. Segments are `rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted`. The active segment is a raised card (`bg-card border shadow-sm text-accent-text`); `aria-selected="true"` also activates it. Use the same recipe for segmented filters (grid/list, sort, range pickers).

### Dialogs

```tsx
<div className="dialog-overlay flex items-center justify-center p-4">
  <div className="dialog-panel w-full max-w-2xl max-h-[90vh]">
    <div className="dialog-header justify-between">
      <div><h2 className="dialog-title">Title</h2><p className="dialog-description">Hint</p></div>
      <DialogClose onClick={onClose} />
    </div>
    <div className="dialog-body">…</div>
    <div className="dialog-footer">
      <button className="btn btn-secondary">Cancel</button>
      <button className="btn btn-primary">Save</button>
    </div>
  </div>
</div>
```

- Overlay: `fixed inset-0 z-50 bg-overlay backdrop-blur-md`, fades in. Panel: `rounded-xl border bg-card shadow-2xl`, scales in.
- Prefer `ModalShell` (focus trap, Escape, stacking); it applies `dialog-overlay`/`dialog-panel` itself, and callers pass width via `panelClassName`.
- Confirmations use `ConfirmModal` (title, description, footer with `btn-danger-solid` or `btn-primary`).
- Don't invent a header or footer for a dialog that has none.

### Menus and popovers

`menu` (container: `rounded-lg border bg-bg-elevated p-1 shadow-lg`, scales in) · `menu-item` (`rounded-md px-3 py-1.5 text-[13px]`, hover `bg-bg-hover`) · `menu-label` · `menu-separator`. Position with utilities (`absolute right-0 top-full mt-1 w-52`).

### Navigation

`.nav-active` marks the selected nav item or list row. Breadcrumbs: muted links with a `ChevronRight` 14 separator, current page `text-text-strong`.

### Markdown

`.md-content` styles rendered markdown: headings, lists with muted markers, accent links, inline code in `bg-bg-hover`/`text-accent-text`, bordered `pre` and tables, and blockquotes with an accent rule.

### Choosing a component

| Need | Use |
|---|---|
| Switch between views | Tabs (`tabs-track`) |
| Filter between 2–5 options | Tabs recipe as a segmented control |
| Choose among many options | `select` |
| On/off setting | `switch` |
| Multiple independent booleans | Checkboxes |
| Actions on an item | `menu` from an `icon-btn` |
| Confirm a destructive action | `ConfirmModal` |
| Status | `badge` + tone |

## Micro-interactions and motion

House easing: **`cubic-bezier(.16, 1, .3, 1)`** (fast out, soft settle). Durations stay short: 75ms press, 150–200ms colour, 200–350ms entrances.

| Interaction | Implementation |
|---|---|
| Button / icon press | `active:scale-[0.97] active:duration-75` |
| Hover | Paint only: `bg-bg-hover`, `border-border-strong`, `text-text`; `transition-colors`/`transition-all` |
| Primary hover | `--accent-hover` + `box-shadow: 0 0 12px var(--accent-glow)` |
| Primary sweep | `btn-sweep`: a 15% white gradient slides across in .5s on hover |
| Stat card hover | `stat-accent` top line fades in (.3s); KiroCrew also lifts the border to `border-strong` + `shadow-md` |
| Focus | Every control: `:focus-visible` 2px `--ring` outline, offset 2px (`.focus-ring`, `.link`, `.tab`, `.switch`, the `.range` thumb, React Flow nodes; `.menu-item` insets it, offset -2px). Text fields (`.input`/`.select`): `border-ring` + a 1px inset `--ring` outline (survives `border-*` utilities) + the `0 0 0 3px var(--accent-subtle)` glow. `--ring` clears 3:1 on every surface in both themes (`theme/focusRing.test.ts`); a tint alone is never a focus state |
| Theme change | `body` cross-fades background and colour over .25s |
| Dialog / menu entrance | `animate-scale-in` (.2s, scale .92 → 1); overlay `animate-fade-in` (.15s) |
| Content entrance | `animate-rise` (.35s, 8px up), `animate-slide-up` (.3s, 12px), `animate-slide-in-left/right` |
| Loading | `skeleton` (pulse) · `animate-spin` spinners in `border-accent` |
| Live / breathing indicator | `animate-dot-breathe` (2s) |
| Switch | Track `transition-colors`, knob `transition-transform` |
| Slider | Thumb scales 1.1 while pressed; focus shows a 4px `--accent-subtle` halo |
| Sidebar collapse | Width transition, 150ms |

`@media (prefers-reduced-motion: reduce)` collapses every animation and transition to 0.01ms globally.

KiroCrew also uses Framer Motion springs (`stiffness 500, damping 35`): a sliding tab indicator (`layoutId`) and modal scale-in. VoC has no Framer, so tabs switch instantly. If Framer is ever added, use that spring.

## Charts

Recharts props accept CSS variables, so charts follow the theme automatically:

```tsx
<CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
<XAxis tick={{ fill: 'var(--muted)', fontSize: 12 }} stroke="var(--border)" />
<Line stroke="var(--chart-1)" />
<Bar fill="var(--chart-2)" />
<Cell fill={chartStepVar(steps.get(category.name) ?? NEUTRAL_CHART_STEP)} />  {/* steps = categoryChartSteps(ranked names) */}
<Cell fill={sentimentCssVar(label)} />                {/* sentiment: status tones, never the ramp */}
<Pie stroke="var(--card)" />                           {/* slice gaps match the card */}
<Tooltip contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }} cursor={{ fill: 'var(--bg-hover)' }} />
```

Rules:

- **Series** take `--chart-1` → `--chart-8` in order; one series per chart uses `--chart-1`. Never pick a hue "because it looks like" the thing plotted (no green for revenue, no red for errors in a series) — a value that IS good/bad goes on the status tones instead (KiroCrew's `contextColor` pattern: thresholds → `--warn` / `--danger`, otherwise `--accent`).
- **Categories** always go through `categoryChartSteps` over the WHOLE ranked list (not the visible slice), so a known category keeps its colour on every page and a custom one keeps its colour for the same ranking. `--chart-6` is the grey for "other" / remainder.
- **Sentiment** always uses `sentimentCssVar` / `--sentiment-*` (status tones). The only non-ramp colours allowed in a chart are those four, `--warn` for urgency markers and `--danger` for errors.
- **Ramp steps are fills** (`fill`, `stroke`, `bg-chart-N`, `border-chart-N`), never text colour.
- **Legend swatches** are `w-2 h-2 rounded-full` spans with `style={{ backgroundColor }}` set to the same variable as the slice/bar; put the label in `text-text` and counts in `font-mono text-muted`.
- **Print/PDF** never sees CSS variables: pass `chartStepPrintHex` / `sentimentHexColor` through the data (`CategoryData.color`, `SentimentData.color`) and keep those renderers out of scope.

## Accessibility

- Icon-only buttons need `aria-label` (and `title`); dialog X buttons use `<DialogClose>` ("Dismiss", so it never collides with a footer "Close"/"Cancel").
- Dialogs: focus trap and Escape via `ModalShell`.
- Switches keep the real control: an sr-only checkbox or `role="switch" aria-checked`.
- Colour is never the only signal: pair tones with text or an icon (e.g. "Urgent" badge + `AlertTriangle`).
- Contrast: put accent-coloured **text** in `text-accent-text`, not `text-accent`. Raw `#8e48ff` is for fills, icons and rings.
- Motion: global reduced-motion handling. Don't use `!important` animations that bypass it.

## Out of scope

These keep their own hard-coded colours on purpose:

- Print/PDF renderers (`utils/printUtils.ts`, `*PDFContent.tsx`, `PersonaPDFSections.tsx`): paper stays light.
- The customer's embeddable feedback-form themes (`pages/FeedbackForms/formTemplates.ts`, per-form colours and their live preview).
- QR codes (white background for scannability).
- Generated prototype HTML.
- User-chosen data colours and plugin manifest colours.

## Verifying a change

From `voc-datalake/frontend`:

```bash
npx eslint . --max-warnings 0 && npx tsc -b --noEmit && npx vitest --run
# Palette residue in app UI (must print nothing except the out-of-scope files above)
grep -rnE "(bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder|shadow)(-[lrtbxy])?-(white|black|gray|slate|zinc|neutral|blue|indigo|purple|violet|green|emerald|red|rose|amber|yellow|orange|sky|cyan|teal|pink)(-[0-9]+)?\b" src --include='*.tsx' --include='*.ts' | grep -v '\.test\.'
```

Then check the change visually in **both** themes (header toggle, or set the OS appearance).

## Upstream references

Look in the KiroCrew repo for new components and future examples. Paths are relative to <https://github.com/kirodotdev/kirocrew/tree/main>.

| Topic | Upstream path |
|---|---|
| All theme tokens (every colour family), focus, scrollbars, glass, effects | [`website/src/index.css`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/index.css) — Kiro blocks: `[data-theme="kiro-dark"]`, `[data-theme="kiro-light"]` |
| Tailwind bridge, animation tokens and keyframes | [`website/src/tailwind-theme.css`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/tailwind-theme.css) |
| Core primitives (Card, Btn, SendBtn, IconButton, Input, SearchInput, Badge, StatCard, Skeleton, EmptyState, PageHeader, Toggle, Slider, Checkbox) | [`website/src/components/ui.tsx`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/components/ui.tsx) |
| Radix wrappers (dialog, dropdown-menu, context-menu, select, popover, tabs, table, progress) and the tab recipe | [`website/src/components/ui/`](https://github.com/kirodotdev/kirocrew/tree/main/website/src/components/ui) — tabs: `ui/tabsPill.ts` |
| Higher-level components (Modal, ConfirmDialog, SegmentedControl, Tablist, InfoTip, ErrorNotice, SideSheet, SimpleSelect, SearchableSelect, Clickable) | [`website/src/components/`](https://github.com/kirodotdev/kirocrew/tree/main/website/src/components) |
| Theme runtime (theme list, data-theme application, system mode) | [`website/src/hooks/useTheme.tsx`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/hooks/useTheme.tsx) |
| Rail widths and layout constants | [`website/src/hooks/useRailWidth.ts`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/hooks/useRailWidth.ts), [`website/src/components/layout.ts`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/components/layout.ts) |
| UI rules for agents and reviewers | [`website/AGENTS.md`](https://github.com/kirodotdev/kirocrew/blob/main/website/AGENTS.md), [`website/AUTOSDE.yaml`](https://github.com/kirodotdev/kirocrew/blob/main/website/AUTOSDE.yaml) |
| Styling, animation, typography and switcher conventions | [`website/docs/frontend-conventions.md`](https://github.com/kirodotdev/kirocrew/blob/main/website/docs/frontend-conventions.md) |
| Page composition, PageHeader, cards, stat rows, "do not" list | [`website/docs/page-layout.md`](https://github.com/kirodotdev/kirocrew/blob/main/website/docs/page-layout.md) |
| Theming contract (adding a colour role, fonts, checkers) | [`website/docs/theming-contract.md`](https://github.com/kirodotdev/kirocrew/blob/main/website/docs/theming-contract.md) |
| Categorical data hues (`--ctx-src-*`, `--ctx-cat-*`, the `--ctx-k*` grey ramp) and their use | [`website/src/index.css`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/index.css) `:root` (context-breakdown block), [`website/src/pages/contextSourceColors.ts`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/pages/contextSourceColors.ts) |
| Status tones for good/bad values in charts and badges | [`website/src/components/ContextBar.tsx`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/components/ContextBar.tsx), [`website/src/pages/TelemetryPanel.tsx`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/pages/TelemetryPanel.tsx), [`website/src/apps/workflows/WorkflowsRuns.tsx`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/apps/workflows/WorkflowsRuns.tsx), [`website/src/pages/ArtifactDetailPage.tsx`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/pages/ArtifactDetailPage.tsx), [`website/src/pages/overview/TokenDailyChart.tsx`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/pages/overview/TokenDailyChart.tsx) |
| Narrow-viewport rules | [`website/docs/narrow-viewport.md`](https://github.com/kirodotdev/kirocrew/blob/main/website/docs/narrow-viewport.md) |
| Lint enforcement (raw colours, unknown classes, native select ban) | [`website/eslint.config.js`](https://github.com/kirodotdev/kirocrew/blob/main/website/eslint.config.js) |
| Brand art: ghost mark, ghost poses, channel logos | [`website/src/assets/`](https://github.com/kirodotdev/kirocrew/tree/main/website/src/assets) |
| Living examples (Storybook; `npm run storybook` in `website/`, port 6006) | [`website/src/stories/`](https://github.com/kirodotdev/kirocrew/tree/main/website/src/stories) — Badge, Btn, EmptyState, PageHeader, SegmentedControl, Slider, Toggle |

### Porting something new from KiroCrew

1. Find the component in `website/src/components/ui.tsx` or `ui/`, or the pattern in a page that uses it.
2. Copy its class recipe. If it repeats, add it to `src/index.css` `@layer components` under a KiroCrew-style name.
3. Map any upstream token VoC lacks: add it to **both** Kiro blocks in `src/index.css` and to the `@theme inline` bridge.
4. Replace Framer Motion with the nearest `--animate-*` token, and Radix with native elements unless a dependency is agreed.
5. Document it in the [Components](#components) section of this file.
