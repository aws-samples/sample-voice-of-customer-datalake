# Kiro design system

The VoC frontend uses the design system of [KiroCrew](https://github.com/kirodotdev/kirocrew) (Apache-2.0): its **Kiro** colour theme in dark and light (plus Nord, Dracula, High contrast and Quick, see [Themes](#themes)), Space Grotesk + JetBrains Mono, lucide icons, the Kiro ghost mark, and KiroCrew's component recipes and motion.

This file is the contract for VoC UI code. When something isn't covered here, look it up in KiroCrew (see [Upstream references](#upstream-references)) and port it the same way.

Ported from KiroCrew `main` at `5bb27bd` (2026-10-04). Colour tokens, status tones, sentiment and the data ramp re-synced against `main` at `acc0809` (2026-10-07); the [labels vs status](#labels-vs-status) rule quotes `main` at `aee520e` (2026-10-09).

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
| `src/index.css` | The Kiro tokens, the Tailwind bridge (`@theme inline`), base styles and every component recipe |
| `src/styles/theme-palettes.css` | The Nord, Dracula, High contrast and Quick palettes, and Quick's component look ([Themes](#themes)) |
| `src/theme/themeCatalog.ts` | The colour theme ids and the `data-theme` value they key on |
| `public/theme-init.js` | Applies the saved theme to `<html>` before first paint |
| `src/theme/themeStore.ts` | Theme preference (system / light / dark), persisted as `voc-theme` |
| `src/theme/useThemeSync.ts` | Keeps `<html>` attributes in step with the store and the OS |
| `src/theme/tones.ts` | The `Tone` type for colour variant props |
| `src/components/ThemeToggle/` | Header button: system → light → dark |
| `src/components/KiroGhost/` | Brand mark (inherits `currentColor`) |
| `src/components/DialogClose/` | Labelled icon-only dialog close button |
| `src/components/Tooltip/` | `Tooltip`, `InfoTip`, `TruncatedText` and `positionFloating` ([Tooltips](#tooltips)) |
| `public/kiro-ghost.svg` | Favicon |
| `src/theme/*.test.ts(x)` | Pin the theme-init ↔ store contract, the layering fixes, the tone contrast and the [labels vs status](#labels-vs-status) rule (`badgeTones.test.ts`) |

## Rules

These are KiroCrew's UI rules (`website/AGENTS.md`, `website/AUTOSDE.yaml`, `website/docs/frontend-conventions.md`) as they apply to VoC. **MUST** rules are expected in review; the *VoC status* column says where VoC deliberately differs today.

| # | Rule | VoC status |
|---|---|---|
| 1 | **MUST** style with semantic tokens (`bg-card`, `text-muted`, `border-border`, `var(--accent)`). **Never** use Tailwind palette classes (`bg-white`, `text-gray-600`, `bg-blue-600`) or hex/rgb literals in app UI. | Enforced by review; the residue grep in [Verifying](#verifying-a-change) must be empty |
| 2 | **MUST** pick colour by **meaning** — accent / ok / warn / danger / info / aim / muted — never by hue. Variant props take a `Tone` (`src/theme/tones.ts`), never `'blue'`/`'green'`. | Adopted |
| 3 | **MUST** use the recipe classes below for buttons, inputs, selects, cards, badges, tabs, dialogs, menus and switches instead of hand-rolling them. | Adopted |
| 4 | **MUST** use `lucide-react` for every icon. Never a hand-rolled inline `<svg viewBox>` (exception: `KiroGhost`). | Adopted |
| 5 | **MUST** give every icon-only button an `aria-label` and a `<Tooltip kind="label">` with the same text. Dialog X buttons use `<DialogClose>`. | Adopted (7.51.01) |
| 6 | **MUST NOT** scale or translate on hover — hover only paints (colour, border, shadow). Press feedback is `active:scale-[0.97]`. | Adopted |
| 7 | A hover state **MUST NOT** reuse the selected-state colour (hover `bg-bg-hover`; selected `nav-active` / `tab-active` / `bg-accent-subtle`). | Adopted |
| 8 | **MUST** keep text ≥ 12px for content; 10–11px only for decorative meta (section labels, counts). KiroCrew additionally bans the `text-xs` class in favour of `text-[12px]`. | `text-xs` (also 12px) is still allowed in VoC |
| 9 | **MUST NOT** use `window.confirm/alert/prompt`; use `ConfirmModal`. | Adopted |
| 10 | **SHOULD** keep at most two buttons in a row; move the rest into a menu. | Not audited |
| 11 | KiroCrew forbids native `<select>`. | **Deviation:** VoC styles native selects with `.select` (no Radix dependency) |
| 12 | KiroCrew uses Framer Motion for enter/exit/layout animation and forbids new CSS `@keyframes`. | **Deviation:** VoC has no Framer; motion is CSS-only via the `--animate-*` tokens. Don't add new keyframes without adding a token |
| 13 | **MUST** keep user-facing strings in i18n catalogs (`public/locales/*`). | Existing VoC rule (`npm run i18n:check`) |
| 14 | **MUST** respect `prefers-reduced-motion` (handled globally — don't override it). | Adopted |
| 15 | **MUST** tone a badge or chip by **meaning**, never to tell labels apart: a descriptive label (category, subcategory, journey stage, persona, dimension value, tag, source, version, count) is `badge-muted`; at most ONE label per row — its primary classification — is `badge-accent`; `ok` / `warn` / `danger` / `info` / `aim` are for **state** only. See [Labels vs status](#labels-vs-status). | Adopted; `theme/badgeTones.test.ts` pins them |
| 16 | **MUST NOT** put `title` on DOM elements (iframe excepted), nor on `Link` / `NavLink`; use `<Tooltip>` ([Tooltips](#tooltips)). A native title waits 1–2 s and never shows on keyboard focus or touch. | Adopted (7.51.01); ESLint `no-restricted-syntax` and `theme/tooltipUsage.test.ts` hold the files still listed in `scripts/audit/allowlists/native_title.json` |

## Themes

The app ships five colour themes, each in a dark and a light mode. A person picks one on `/account` or keeps the workspace default an administrator picked (`src/theme/themeCatalog.ts`); the mode (system / light / dark) is a separate, personal preference.

| Theme | Id | Lives in | Upstream |
|---|---|---|---|
| Kiro (default) | `kiro` | `src/index.css` | KiroCrew's Kiro theme |
| Nord | `nord` | `src/styles/theme-palettes.css` | the Nord palette project, via KiroCrew `website/src/styles/theme-palettes.css` |
| Dracula | `dracula` | `src/styles/theme-palettes.css` | the Dracula palette project, via KiroCrew |
| High contrast | `highcontrast` | `src/styles/theme-palettes.css` | KiroCrew's High Contrast, taken past AA: text ≥ 7:1, focus ring, control edges and chart steps ≥ 4.5:1 |
| Quick | `quick` | `src/styles/theme-palettes.css` (palette + component look) | the Quick design system (ink pill buttons, blue links and focus, violet accent, Inter) |

| Preference | `<html>` attributes |
|---|---|
| `system` | follows `prefers-color-scheme` live |
| `light` | `data-theme="<id>-light" data-color-theme="<id>" data-mode="light" data-mode-pref="light"` |
| `dark` (default) | `data-theme="<id>-dark" data-color-theme="<id>" data-mode="dark" data-mode-pref="dark"` |

- A visitor who has never chosen gets **Kiro Dark** (`DEFAULT_THEME_PREFERENCE` in `themeStore.ts`, mirrored by `DEFAULT_PREF` in `theme-init.js`); a saved choice always wins.
- Tokens are keyed on `data-theme`; `:root` falls back to Kiro Dark. Because `theme-palettes.css` is imported at the top of `index.css` (before that fallback), its blocks are keyed `:root[data-theme="…"]`, one step more specific, and also `[data-theme="…"]`, so a nested element with its own `data-theme` (the theme picker's previews, `components/ThemePicker`) paints that palette.
- Who picks: a platform admin sets the start theme for everyone in Administration → General (`GET` / `PUT /settings/appearance`, the PUT platform-admin-only server-side, checked live: one colour scheme per deployment, [Multi-workspace](multi-workspace.md#per-workspace-configuration)); each person may override it in Account → Preferences, kept in this browser. The cached workspace theme lets `theme-init.js` paint it before the first request.
- The `dark:` variant matches `[data-mode="dark"]`. Prefer tokens; reach for `dark:` only when a value genuinely differs per mode and there is no token for it.
- `theme-init.js` is an external file because the CloudFront CSP is `script-src 'self'` (no inline scripts). Its storage key and attributes are pinned to `themeStore.ts` by `themeInit.test.ts`.
- Print and PDF exports stay on the Kiro light palette whatever the theme (`theme/printPalette.ts`, `pages/Categories/types.ts`).

### What each theme derives

Upstream palettes carry the surfaces, text, borders, accent and status tones. The tokens they lack are derived in the theme's own hues, the way the Kiro blocks derive theirs: `--control-border` (the edge grey moved to ≥ 3:1 on every surface; its hover is `--muted`), `--nav-active-*` (dark: the accent on the `--border` fill; light: the accent 12 % into white with a 35 % edge), `--muted-strong` (between `--muted` and `--text`), the `--chart-1…8` ramp (Kiro's order, accent first, `--muted` at step 6, green and amber last; each ≥ 3.2:1 on `--card`, ≥ 10 ΔE2000 apart), `--sentiment-*` (the status tones) and the `--select-chevron` data URI (in the theme's `--muted`).

### AA adjustments from upstream

A value that missed AA moved in lightness only (OKLCH hue and chroma kept); each block in `theme-palettes.css` lists its moves with the before and after ratio. The ones that matter most:

| Theme | Token | Upstream → VoC | Why |
|---|---|---|---|
| Nord dark | `--danger`, `--bg-hover` | `#bf616a` → `#febabd`; `#434c5e` → `#3f4758` | 1.94:1 on its tint over a hovered row. The hover is a step darker than upstream, so the red keeps more colour; `--ok` / `--info` / `--aim` lighten the same way |
| Nord dark | `--accent-text` | `#88c0d0` → `#a3dcec` | 3.37:1 on the accent tint over a hovered row |
| Nord light | `--ok` / `--warn` / `--danger` / `--info` / `--aim` | `#689d6a` / `#d08770` / `#bf616a` / `#5e81ac` / `#b48ead` → `#316434` / `#894732` / `#953b46` / `#385982` / `#6f4d6a` | 1.9–2.8:1 as text on white; the light fills now carry white text |
| Nord light | `--accent-hover` | `#6d91bc` → `#3c5a85` | darker, not lighter: white text on `#6d91bc` is 3.27:1 |
| Dracula dark | `--danger` / `--aim`, `--bg-hover` | `#ff5555` / `#ff79c6` → `#fdb0aa` / `#fdc6e2`; `#44475a` → `#3e4152` | 2.64 and 3.12:1 on their tints over a hovered row; the hover is a step darker than upstream, so the red keeps more colour |
| Dracula dark | `--accent-hover` | `#d4b0ff` → `#e2c6ff` | upstream is 1.2 ΔE2000 from `--accent`, so hover showed nothing |
| Dracula light | `--ok` / `--danger` / `--info` / `--aim` | `#16a34a` / `#dc2626` / `#0891b2` / `#c026d3` → `#026e2e` / `#bd0011` / `#04657d` / `#9d0cae` | 2.4–3.4:1 on their tints over a hovered row |
| High contrast dark | `--danger` / `--aim` / `--accent-text` | `#ff0000` / `#bf5af2` / `#00d4ff` → `#fdbeb3` / `#ebcffd` / `#85e2fe` | to 7:1 on a hovered row and its tint (pure red cannot reach 7:1 there) |
| High contrast light | every status tone, `--accent-text` | e.g. `#cc0000` → `#800503`, `#007a1e` → `#024a10` | to 7:1 on their tints |
| Quick light | `--link` / `--ok` / `--danger` / `--info` | `#0062d1` / `#037f0c` / `#d91515` / `#0067c7` → `#085fc8` / `#07780e` / `#cc1615` / `#0863be` | 4.1–4.3:1 on their tints over a hovered row |
| Kiro dark | `--accent-hover`; `--muted-strong` | `#9f63ff` → `#7a35e0`; `#8a8592` → `#8f8a97` | white text on a hovered primary button was 3.68:1 (now 6.15:1: the hover darkens, as in Kiro light); `--muted-strong` on a hovered row was 4.23:1 (now 4.52:1) |

Also: `--shadow-sm` is `0 0 #0000` where upstream says `none` (High contrast, Quick), because `none` is invalid inside the `.card` shadow list; High contrast gains a dark-cyan selected-row fill edged in `--accent`.

### Quick component look

Quick is more than a palette. Under `[data-color-theme="quick"]` (the end of `theme-palettes.css`, each rule in the layer of the recipe it adjusts, so a call-site utility still wins):

- **Type**: `--font-body` is Inter (`@fontsource-variable/inter`, OFL); headings keep normal tracking. Every other theme keeps Space Grotesk.
- **Buttons**: every `.btn` is a pill; `.btn-primary` is `--ink` with `--on-ink` text (`--ink-hover` on hover), with no light sweep or accent glow; `.btn-secondary` has an `--ink` edge and text.
- **Focus**: outlines take `--focus` (blue), and `--ring` is `--focus`, so every ring recipe follows; fields drop the accent glow around the ring.
- **Links**: `.link` and markdown links take `--link`, underlined 4px below.
- **Shape and depth**: `--radius-sm` is 4px; shadows are flat (`--shadow-sm` is empty, menus and dialogs a soft `1px 1px 20px` shadow); selected nav items are also bold; the selected tab is strong text over a 2px `--ink` bar.
- Quick's own tokens: `--ink`, `--on-ink`, `--ink-hover`, `--link`, `--focus` (both Quick blocks; no other theme declares them).

### Adding a theme

1. Add its id to `COLOR_THEME_IDS` (`themeCatalog.ts`) and every mirror, each pinned by a test: `public/theme-init.js` (`themeInit.test.ts`), `lambda/shared/appearance.py` (`test_appearance.py`) and the dev mock's `THEME_IDS` in `frontend/mock-appearance.js` (`themeCatalog.test.ts`); also the theme list of `PUT /settings/appearance` in `.kiro/steering/structure.md`.
2. Add `:root[data-theme="<id>-dark"], [data-theme="<id>-dark"]` and the same for `-light` to `theme-palettes.css`, declaring **every** token the Kiro block of that mode declares, and nothing else (a theme's own extra tokens go in `EXTRA_TOKENS` in `theme/themeTokenSet.test.ts`, with a reason).
3. Give it a mark in `components/ThemeMark` (an entry in `STATIC_MARKS`, `data-mark="<id>"`) and a tab icon `public/favicons/<id>.svg` (`themeFavicon`; `themeCatalog.test.ts` fails without the file), its name in `components/ThemePicker/themeNames.ts`, and record the source of any borrowed art or palette in `THIRD-PARTY-LICENSES.md`.
4. Run `npx vitest run src/theme src/components/ThemeMark`: the suites iterate every block (`THEMES` in `src/test/themeTokens.ts`) and check the token set, text and non-text contrast, status tones on their tints, the chart ramp, control borders and the focus ring. When one fails, fix the palette; the thresholds are not negotiable.

## Colour

All values are CSS custom properties in `src/index.css`. Use the **utility** in components, the **variable** in inline styles and SVG.

### Brand

| Role | Utility / variable | Kiro Dark | Kiro Light | Use |
|---|---|---|---|---|
| **Primary** (accent) | `bg-accent` / `--accent` | `#8e48ff` | `#8e48ff` | Primary buttons, active indicators, focus ring, brand glyph |
| Primary hover | `hover:bg-accent-hover` / `--accent-hover` | `#7a35e0` | `#7a35e0` | Hover of solid accent (darker than the accent in both modes: white text on it ≥ 4.5:1) |
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
| `text-muted-strong` | `#8f8a97` | `#4a464f` | Section labels, faint text |

### Borders

| Utility | Dark | Light | Use |
|---|---|---|---|
| `border-border` | `#352f3d` | `#e4e4e7` | Default 1px border, dividers (`divide-border`) |
| `border-border-strong` | `#4a464f` | `#d4d4d8` | Hover border, emphasised edges |
| `border-control-border` | `#77727f` | `#86818e` | The edge that **identifies a form control** (`.input`, `.select`, textarea, checkbox, radio). Not for dividers or cards |
| `border-control-border-hover` | `#938f9b` | `#5e5966` | That edge on hover |

`--border` is a divider, not a field boundary: it is 1.28:1 (dark) / 1.27:1 (light) on the card, and WCAG 1.4.11 asks 3:1 of a boundary that identifies a control. `--control-border` clears 3:1 against every surface a control sits on (`--bg`, `--bg-accent`, `--bg-elevated`/`--card`, `--panel` and the `--bg-hover` row), in both themes:

| Token | Theme | bg | bg-accent | bg-elevated / card | bg-hover | panel |
|---|---|---|---|---|---|---|
| `--control-border` | dark | 3.83 | 3.71 | 3.55 | 3.25 | 3.55 |
| `--control-border` | light | 3.79 | 3.47 | 3.79 | 3.32 | 3.63 |

`theme/controlBorder.test.ts` computes these ratios from index.css (and the hover step's, and the checked `--accent` fill's), so a retune below 3:1 fails the suite. A control's border may only be overridden by a STATE colour at full strength (`border-danger`, `border-warn`, `border-aim`), never by `border-border*` or a tone at an opacity (`border-danger/60`); the same test enforces that.

### Semantic tones (status)

| Tone | Solid / text | Subtle fill | On solid | Dark | Light | Means |
|---|---|---|---|---|---|---|
| `ok` | `text-ok`, `bg-ok` | `bg-ok-subtle` | `text-ok-fg` | `#1bb36b` | `#007038` | Success, positive, active |
| `warn` | `text-warn`, `bg-warn` | `bg-warn-subtle` | `text-warn-fg` | `#e0b94d` | `#6b5900` | Warning, urgent, pending |
| `danger` | `text-danger`, `bg-danger` | `bg-danger-subtle` | `text-danger-fg` | `#ff5f73` | `#bd1c3a` | Error, negative, destructive |
| `info` | `text-info`, `bg-info` | `bg-info-subtle` | — | `#7aa3e6` | `#285092` | Informational **state** (provenance: set by hand, built-in, restored) — never a kind of label |
| `aim` | `text-aim`, `bg-aim` | `bg-aim-subtle` | — | `#c19aff` | `#7337d6` | AI / generated / secondary highlight — not a second accent for labels |
| `accent` | `text-accent-text`, `bg-accent` | `bg-accent-subtle` | `text-accent-fg` | see Brand | | Primary / running |
| `muted` | `text-muted` | `bg-bg-hover` | — | see Text | | Neutral |

**Contrast adjustments vs KiroCrew.** VoC is held to WCAG AA (4.5:1 for text, checked by axe in both themes). Every tone keeps the **hue** of KiroCrew's `kiro-dark` / `kiro-light` block (`website/src/index.css`); where KiroCrew's exact value misses AA on its own tints, only the lightness moves:

| Token | Theme | KiroCrew | VoC | Worst pair, KiroCrew → VoC |
|---|---|---|---|---|
| `--ok` | dark | `#008543` | `#1bb36b` | on `ok-subtle` over a hovered row 2.80 → 4.86 (`--ok-subtle` is KiroCrew's `rgba(0,133,67,.15)`; black `--ok-fg` 7.71) |
| `--danger` | dark | `#f94359` | `#ff5f73` | on its tint over a hovered row 3.79 → 4.53 (`--danger-fg` black) |
| `--info` | dark | `#6f9ae0` | `#7aa3e6` | `badge-info` on a hovered row 4.42 → 4.85 |
| `--accent-text` | dark | `#b07fff` | `#bd8fff` | |
| `--muted-strong` | dark | `#5e5966` | `#8f8a97` | 4.52:1 on a hovered row |
| `--accent-hover` | dark | `#9f63ff` | `#7a35e0` | white text 3.68 → 6.15 |
| `--ok` | light | `#008543` | `#007038` | on its tint over a hovered row 3.56 → 4.61 |
| `--warn` | light | `#a38a00` | `#6b5900` | 2.70 → 5.25 (so `--warn-fg` is white, not KiroCrew's black) |
| `--danger` | light | `#d92544` | `#bd1c3a` | 3.71 → 4.64 (white `--danger-fg` 6.19) |
| `--aim` | light | `#8041e6` | `#7337d6` | 4.10 → 4.76 |
| `--nav-active-bg` | light | `#d8d2e0` | `#ebe5f3` | `#723acc` label 4.45 → 5.34 |

`theme/statusTones.test.ts` computes these from index.css: each tone within 6° of KiroCrew's hue, ≥ 4.5:1 on `--bg`, `--bg-accent`, `--card`, `--bg-hover` and its own tint over the card and over a hovered row, and its `-fg` ≥ 4.5:1 on the solid fill. (Dark `--ok` was once `#22c55e` — the green of KiroCrew's generic `dark` theme, not of Kiro — and that hue pin now catches the mix-up.) When porting a token from upstream, re-check it on its subtle tint, on `bg-bg-accent` **and on `bg-bg-hover`** (badges sit on hovered rows). **Secondary text on a selected (`bg-accent-subtle`) surface uses `text-text`, not `text-muted`**: dark `--muted` is only 4.05:1 there (`VisibilityChoice`, the invite candidate list).

Borders on tinted elements use the tone at 30%: `border-ok/30`, `border-danger/30`, … Opacity modifiers work on every token (`bg-accent/10`, `ring-accent/40`).

### Labels vs status

Colour on a badge or chip carries **meaning**, never identity. KiroCrew's `Badge` (`website/src/components/ui.tsx`) has only status variants — `variant: 'ok' | 'err' | 'warn' | 'aim' | 'muted'` — and its own comment calls it "a non-interactive status label"; there is no variant that means "category" or "which one". Its `SourceBadge` says what happens when labels are coloured by identity: `tone="neutral"` "forces the grey style for every source — used where several of these sit together (the template list) and one coloured chip among grey peers reads as "why is this one different?" rather than as a category." The same convention is written in `website/docs/frontend-conventions.md` › Styling: "state colors are `text-ok` / `text-warn` / `text-danger` / `text-info`, and a running state is `text-accent`."

So, in VoC (rule 15):

| Kind | Examples | Tone |
|---|---|---|
| **Descriptive label** — says *which one* | category, subcategory, journey stage, persona, dimension value, tag, source / channel name, version, count, kind, scope | `badge-muted` |
| **Primary classification** — at most ONE per row | the category on a feedback card, the kind on a memory, the trigger kind on an agent trigger, the page context in the assistant header | `badge-accent` |
| **State** — says *how it is* | sentiment, urgency, redacted / summary only, enabled / disabled, running / completed / failed, pending, current, unsaved, restricted, missing | `ok` · `warn` · `danger` · `accent` (running) · `muted` (inactive) |
| **Informational state** — provenance to notice, not to worry about | "Changed by …" (hand-set category), "built-in", "restored from v3", "proposed", public visibility | `info` |
| **AI / generated** — KiroCrew's meaning of `aim` | an AI-written memory, generated content, a token that may run agents | `aim` |

- `info` is for an informational **state**; it is never the tone of a *kind* of label ("persona", "dimension"). A kind is identity.
- `aim` is AI / generated, not a second accent for labels.
- Several descriptive labels in one row are all grey. They differ by their text, and by an icon where one helps (`Hash` for a tag, `Package` for a product, `UserPen` for a hand-set value) — never by hue.
- A status tone on a row is earned by state and keeps its icon: `SentimentBadge` (`ok` / `danger` / `warn`), Urgent (`badge-warn` + `AlertTriangle`), Redacted / Summary only (`badge-warn` + `ShieldCheck` / `EyeOff`).
- Categorical hues for **data** (the chart ramp, a source stripe on a feed card) are a different channel — see [Sentiment and data visualisation](#sentiment-and-data-visualisation). A label is not data.

**Worked example — the feedback card** (`components/FeedbackCard/FeedbackCard.tsx` `CardTags`, `components/FeedbackDimensions/FeedbackDimensionChips.tsx`, `components/CategoryChangeControl` `ManualCategoryBadge`), 3.14.00 → 3.14.01:

| Label | Without the rule | With the rule |
|---|---|---|
| category | `badge-accent` | `badge-accent` — the one emphasised label |
| "Changed by …" (hand-set category) | `badge-info` | `badge-info` — provenance **state**, kept small as icon (`UserPen`) + text; the previous category and the date stay in its Tooltip (`kind="description"`) |
| subcategory | `badge-aim` | `badge-muted` |
| journey stage | `badge-muted` | `badge-muted` |
| persona | `badge-info` | `badge-muted` |
| dimension (`Product: Mobile app`) | `badge-info` | `badge-muted`; the key stays muted and the value is `text-text`; a hand-set value keeps its Tooltip and the `UserPen` icon |
| tag | `badge-muted` + `Hash` | unchanged |
| sentiment · Urgent · Redacted / Summary only | status tones | unchanged |

With the rule, a card with a subcategory, a persona and two dimensions shows one accent label, grey labels, and colour only where there is state, instead of five labels in four tones. The same applies to the detail page's **Tags & filters** chips (`pages/FeedbackDetail/FeedbackDetail.tsx`: subcategory and persona neutral, the category chip accent), the Problem Analysis `+N` similar-problems count (`badge-muted`), the feedback-form type pill (`badge-muted`), a scraper template's extraction method ("JSON-LD", `badge-muted`) and a company objective's horizon (`badge-muted`). Rows that tone by state keep their tones (`pages/Memory/MemoryCard.tsx`: status by state, kind = the one accent, `aim` only for an AI-written memory; `pages/Connect/TokenList.tsx`; `pages/FeedbackDetail/FeedbackDetailSections.tsx`).

**The rest of the app.** The same rule, where a *kind* would otherwise be painted as if it were a state:

| Surface | Avoid | Use |
|---|---|---|
| document type (`components/DocumentTypeBadge`, the Documents rail, lineage footers, the wizard's document picker, Prioritization rows) | a tone per type — PRD `info`, PR/FAQ `ok`, research `warn`, custom `aim`, report `accent`, prototype `warn` — in three separate maps | one `badge-muted` pill; the type's lucide icon (FileText, Newspaper, Search, FilePen, FileBarChart, Hammer — the same glyphs `NodeTypeIcon` uses) and its text tell them apart |
| source tiles on the Scrapers page (`pages/Scrapers/SourceDialogHeader.tsx` `ToneTile`, `TemplateSelector`, every source dialog header) | a tone per kind of source — paste `warn`, JSON `info`, CSV `ok`, synthetic `aim`, scraper `ok`, app `accent` | every source tile is `accent` (a source is the page's one emphasis); `SourceTone` is `accent \| muted`, and `muted` is the one STATE a tile carries, a paused scraper |
| persona sections (`pages/ProjectDetail/PersonaSections.tsx`, `PersonaSection`) | a tone per section and per chip — identity `aim`, goals `ok`, behaviours and scenario `info`, context `warn`, quotes `accent` | neutral cards, `badge-muted` attribute chips, `text-muted` sub-headings; **Pain points keeps `danger`** because that section *is* negative sentiment — a state |
| project wizards (`components/DataSourceWizard`, `pages/ProjectDetail/Wizards.tsx`, `DocWizard.tsx`) | an `accentColor` per wizard — research amber, documents blue, remix green — on the icon tile, the progress bar, the primary button and the selected filters | one accent `WizardIconTile`, `bg-accent` progress, `btn-primary`; a chosen option or filter is the selected recipe `bg-accent-subtle border-accent` (rule 7), and a suggestion hovers `bg-bg-hover` |
| plugin setup instructions (Settings source card, Scrapers plugin dialog) | the manifest's `setup.color` (iOS blue, Android green, …) tinted the panel | one neutral `bg-bg-accent` panel for every plugin |
| Data Explorer object icons, the Problem Analysis subcategory icon, the Prioritization submissions icon, the owner's crown, the research-note numbers, the team-score numbers (impact `info`, time-to-market `aim`, composite `ok`) | a hue per kind or per axis | `text-muted` icons, `text-text-strong` numbers |

Kept, because they are states: a selected sentiment filter in its sentiment colour; running / completed / failed / pending badges; `badge-info` for built-in, restored-from, older-revision and public; `aim` for AI-generated content (the synthetic generator's note, "Copy to Kiro", an AI-written memory, a token that may run agents) and for the admin role as the elevated privilege; the approval card's `badge-warn` on a **company**-scope memory write (a heads-up, not a kind); the rating star's `warn` where it is a rating; informational `info` callouts (how forms work, read-only notices). `theme/badgeTones.test.ts` pins each surface above.

**How to verify.** `theme/badgeTones.test.ts` reads the feedback surfaces (`FeedbackCard`, `FeedbackDimensionChips`, `FeedbackDetail`, `FeedbackDetailSections`) and fails when a category, subcategory, journey stage, persona, dimension or tag sits in `badge-info` / `badge-aim` (or a hand-rolled `bg-info-subtle` / `bg-aim-subtle` pill), when a card row has more than one `badge-accent`, or when `ManualCategoryBadge` drops its icon or its `info` tone. For any other list, the grep in [Verifying a change](#verifying-a-change) prints every `info` / `aim` pill whose content is a descriptive field.

### Sentiment and data visualisation

KiroCrew separates two kinds of colour in data, and VoC follows it:

- **Meaning → status tones.** Anything good/bad, pass/fail or healthy/at-risk is painted with `ok` / `warn` / `danger` (plus `accent` for "normal / running" and `--muted` for neutral), in charts and in badges alike. Examples in KiroCrew `website/src/`: `components/ContextBar.tsx` (`contextColor`: ≥ 90% `--danger`, ≥ 75% `--warn`, else `--accent`), `pages/TelemetryPanel.tsx` (the same thresholds on gauges), `apps/workflows/WorkflowsRuns.tsx` (run passed `text-ok`, paused `text-warn`, failed `text-danger`), `pages/settings/SlackPanel.tsx` and siblings (connected `--ok`, not connected `--warn`), `pages/ArtifactDetailPage.tsx` (created `--ok`, reverted `--warn`, referenced `--muted`), and pills such as `components/CommentThreads.tsx` (`bg-ok-subtle text-ok`). The rule is stated in `website/docs/frontend-conventions.md` › Styling: state colours are `text-ok` / `text-warn` / `text-danger` / `text-info`, a running state is `text-accent`.
- **Identity → categorical hues.** Data whose colour only says "which one" (a context source, a category) uses a fixed set of hues mixed 74% into the card: `--ctx-src-skill` `#00c48f`, `-memory` `#4aa8ff`, `-history` `#f2c14e`, `-lessons` `#ff9d5c`, `-sys` `#43c9bd`, `-skillidx` `#8f7bff`, `-tool` `#b98cff`, with `--ctx-src-mute` for the long tail, and `--ctx-cat-message: var(--accent)` for the primary series (`website/src/index.css` `:root`, lines ~430–465; used by `website/src/pages/contextSourceColors.ts`). KiroCrew's guidance there: hue is the data channel, mixed into the surface "so it reads as a calm instrument trace … rather than a saturated slop-gradient".

**Sentiment decision: status tones.** Positive / negative / mixed are meaning, not identity, so sentiment stays on `ok` / `danger` / `warn` with `--muted` for neutral, exactly as KiroCrew colours its own good/bad values, and never joins the ramp. (The alternative, putting sentiment on the categorical ramp, would contradict KiroCrew and give "negative" a hue that elsewhere just means "category 3".) The `--sentiment-*` tokens are aliases, so there is one source of truth:

| Variable | Alias of | Dark | Light |
|---|---|---|---|
| `--sentiment-positive` | `--ok` | `#1bb36b` | `#007038` |
| `--sentiment-neutral` | `--muted` | `#938f9b` | `#5e5966` |
| `--sentiment-negative` | `--danger` | `#ff5f73` | `#bd1c3a` |
| `--sentiment-mixed` | `--warn` | `#e0b94d` | `#6b5900` |

On screen use `sentimentCssVar(label)` (`lib/sentiment.ts`; there are no `*-sentiment-*` utilities); `SentimentBadge` (`bg-ok-subtle text-ok`, …) and `MetricCard` take tones. `sentimentHexColor` is for the PDF path only. `theme/statusTones.test.ts` pins the four aliases in both themes and fails if one points at `--chart-*`.

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
| Body, Quick theme | `'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | `@fontsource-variable/inter` (bundled; fetched only while Quick is active) | 100–900 |
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
- **Icon-only buttons:** `.icon-btn` (muted → text on hover); always `aria-label` + `<Tooltip kind="label">` (rule 5).
- **Brand mark:** the active theme's mark, `components/ThemeMark` — `<ThemeMark className="w-7 h-7 text-accent-text" />` in the sidebar (28px), login (48px), the assistant's bubble and panel header; `ThemeMarkIdle` greets an empty conversation and `ThemeMarkThinking` is the assistant's busy indicator. They follow the theme live (`useActiveColorTheme()`):

  | Theme | Mark | Thinking pose |
  |---|---|---|
  | Kiro | the ghost (`KiroGhost`, idle and drift poses from `GhostPoses`) | the drift pose floats |
  | Nord | a six-armed snowflake | floats |
  | Dracula | a bat | floats |
  | High contrast | the half-filled contrast circle, heavy outline | floats |
  | Quick | a four-point spark inspired by Quick, outlined in the brand gradient (in `currentColor` with `onFill`, on the accent launcher) | the spark spins (`animate-mark-spin`) |

  Nord, Dracula and High contrast draw in `currentColor` on a 24-unit grid, so the caller's `text-*` class colours them. The Quick spark takes the `--mark-quick-*` gradient in `styles/theme-marks.css` (lighter in Quick dark, ≥ 3:1 on its navy), never the palette. Every mark is decorative (`aria-hidden`, not focusable, `data-mark="<theme id>"`); the text beside it names the product, and motion stops under `prefers-reduced-motion`.
- **Favicon:** the tab icon follows the theme: `themeFavicon()` (`theme/themeCatalog.ts`) is `public/kiro-ghost.svg` for Kiro and `public/favicons/<id>.svg` for the others, the same shapes in fixed colours that read on light and dark tab bars, with slightly heavier strokes so they hold at 16 px (the Quick one switches its gradient with `prefers-color-scheme`). `theme-init.js` sets index.html's icon link before the tab draws it, and `applyTheme` keeps it in step (pinned by `themeInit.test.ts` and `themeCatalog.test.ts`).
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
| `switch` + `switch-knob` | On/off pill: `w-9 h-5`, `bg-border` → `bg-accent` when `aria-checked="true"` or `switch-on`; white knob slides 16px. Off, the track also draws a 1px inset `--control-border` edge (`box-shadow`, so the knob keeps its 2px inset): the `--border` track alone is 1.27:1 on the light card, and a control's boundary needs 3:1 (WCAG 1.4.11). On, the accent fill is the edge (`theme/controlBorder.test.ts`). A label that flips ("Live" / "Off") passes `widthOf` to `components/Switch` so it keeps the widest word's width and the controls after it never move |
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

`link-quiet` (7.55.01) is the one exception, for a title that is the link of a whole card
and never sits among words: `--text-strong`, no underline at rest, underlined on hover
and on keyboard focus, with the focus ring. WCAG 1.4.1 asks a cue besides colour of a
link *in a block of text*; a card title has no surrounding text to tell it from, and a
purple underlined title made every card read as a sentence of hyperlinks. Make the card
the target with a stretched link (`after:absolute after:inset-0` on the title's link, the
card `relative`) and keep the card's controls (switch, buttons, ⋯) after it in the DOM,
`relative` without a z-index: they paint above the overlay by order, and an open ⋯ menu
is not trapped in a z-index context the next card would cover. The Feedback Forms list
card (`pages/FeedbackForms/FormCard.tsx`) is the pattern. Anywhere a link sits in a
sentence, it is `link`.

### Badges

`badge` + tone: `badge-ok` · `badge-warn` · `badge-danger` · `badge-info` · `badge-aim` · `badge-accent` · `badge-muted`. Pills are `rounded-full px-2 py-0.5 text-xs font-medium`; counts inside use `font-mono`.

The tone is chosen by **meaning** ([Labels vs status](#labels-vs-status)): a descriptive label is `badge-muted`; the row's one primary classification may be `badge-accent`; `badge-ok` / `-warn` / `-danger` are states, `badge-info` an informational state (provenance), `badge-aim` AI / generated. Never pick a tone to tell two labels apart — their text (and an icon) does that. A badge is a non-interactive label: a clickable chip is a `btn btn-secondary btn-sm` or a neutral `bg-bg-hover border border-border rounded-full` button, with the same tone rule.

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

A row of tabs wider than its screen scrolls sideways and says so: `IconTabs`' `scrollLabels` (7.55.01, the form builder's tabs) gives it the `.tab-strip` end fade and the two scroll buttons of `components/TabStrip/` (shared with the run workspace's agent tabs), and scrolls the active tab into view.

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

### Side sheets

`SideSheet` (`components/SideSheet/SideSheet.tsx`, KiroCrew's `SideSheet.tsx` ported onto `ModalShell`) edits one row of a list beside it: People's person editor (7.54.00). It is `ModalShell` with `placement="end"`: the same focus trap, Escape, backdrop, stacking (`z-[70]`) and focus return to the element that opened it, with the panel at the inline end.

```tsx
<SideSheet isOpen onClose={close} title="Edit Ada Lovelace" description="ada@example.com" icon={UserCog}
  footer={<><SavedStatus saved={saved} /><button className="btn btn-danger btn-sm">Delete Ada Lovelace…</button></>}>
  …sections…
</SideSheet>
```

- `.sheet-panel`: full height, the viewport's width below `sm` and `max-w-[30rem]` from it, `border-s` and `shadow-2xl`, sliding in from the end (`animate-slide-in-end`). Its header, body and footer are `dialog-header` / `dialog-body` / `dialog-footer`: only the body scrolls, so the footer stays in view whatever the sheet holds.
- `size="wide"` (`sm:max-w-[44rem]`) holds a document: the document component's `sheet` variant is this sheet ([Documents](#documents): the History's Open and Compare), so the app has one side sheet.
- The title is the sheet's `h2` and its accessible name; the header's `DialogClose` ("Dismiss") closes it. A confirmation opened from inside it (`ConfirmModal`) stacks above it.
- Prefer a sheet to a stepped dialog when the row it edits should stay in view; a sheet whose item is a place is a path (`/admin/people/<username>`), so Back closes it.
- `dismissable={false}` while a save is on its way: Escape, the backdrop and its close button wait. An engineering automation's **Set up drawer** (7.52.00, `pages/Agents/Automations/SetupDrawer.tsx`) is one: numbered steps, its readiness under a heading it focuses when opened from "N to fix", and Save / Save and enable in its footer (the form's submit by its id).

### Saving: one "Saved" per card

Every settings card saves itself: there is no page-level Save. After a save the server accepted, the card says so with `SavedStatus` (`components/SavedStatus/SavedStatus.tsx`): a polite `role="status"`, rendered only while it has something to say (as the app's other status lines), that reads "Saved" (or the card's own words, "Password reset email sent"), and **stays until the card is edited again**, never on a timer. A failed save says why in words (`role="alert"`). A card or sheet whose controls save the moment they change (a switch, a select, a radio group) shows one `SavedStatus` for all of them, beside its foot.

### Menus and popovers

`menu` (container: `rounded-lg border bg-bg-elevated p-1 shadow-lg`, scales in) · `menu-item` (`rounded-md px-3 py-1.5 text-[13px]`, hover `bg-bg-hover`) · `menu-label` · `menu-separator`. Position with utilities (`absolute right-0 top-full mt-1 w-52`).

**A row's actions: `RowActionsMenu`** (`components/RowActionsMenu/`, 7.52.00): the "⋯" `icon-btn` named "Actions for <item>" (its Tooltip the same words), opening a `menu` fixed in a portal (a list card's `overflow-hidden` never clips it), the WAI-ARIA menu button pattern (the first item focused, arrows, Home/End, Escape back to the button, Tab on to the next control). Entries are actions or separators (`rowMenuEntries.ts`; a separator is never first, last or doubled); a destructive one is last, in the danger tone; one that cannot act now stays focusable (`aria-disabled`) with its reason as visible text. `face` makes it a text menu button ("Run another flow ▾"). Automations' rows and an automation's page header use it.

The form builder's ⋯ menus (`pages/FeedbackForms/ui/ActionsMenu.tsx`) and its Add question type menu open the same way (fixed, in a portal, placed by `utils/fixedMenu.ts`, closed when the page scrolls or the window resizes), so a pane that scrolls on its own never clips them (7.55.01). `placeFixedMenu` measures the menu with its scale-in transform turned off, so a tall menu is not placed off by the animation.

**Keep-clear zones** (7.55.01, `components/StickyActionBar/actionBarRegistry.ts`): floating UI keeps clear of what a page registers with `useRegisterKeepClear(ref, { mode })`. `lift` is a sticky action bar (the assistant launcher rises above it; `useRegisterActionBar` is its shorthand); `beside` is a tall pane at the end edge, such as a form's preview, which the launcher stands beside, on its inline-start side, instead of covering its Next. A spot the person dragged the launcher to stays theirs unless it covers a zone. Save bars (`StickyActionBar` `bar`) are an opaque `bg-card`, never `backdrop-blur`: a backdrop filter makes the bar the containing block of a fixed dialog opened from it, and traps the dialog inside the bar.

### Tooltips

One hint for hover and keyboard focus, in place of the native `title` (rule 16), which waits for the browser's own
delay (1–2 s on macOS) and never shows on focus or touch. In `src/components/Tooltip/`:

```tsx
<Tooltip kind="label" content={t('delete')}>
  <button type="button" className="icon-btn" aria-label={t('delete')} onClick={remove}><Trash2 size={16} /></button>
</Tooltip>
<Tooltip kind="description" content={t('changedBy', { user, date })}>
  <span className="badge badge-info"><UserPen size={12} aria-hidden="true" />{t('manual')}</span>
</Tooltip>
```

- **API:** `<Tooltip content kind="label|description" placement="top|start|end">` wraps exactly one element and
  composes its handlers and ref. An empty `content` shows nothing (`content={off ? reason : undefined}`), without
  remounting the trigger.
  - `kind="label"`: the trigger's name, which it already carries (`aria-label`, or `sr-only` text); the bubble is
    `aria-hidden`, so a screen reader does not hear it twice.
  - `kind="description"`: extra information (a date, who changed it, the raw id behind a label); the trigger is
    `aria-describedby` the bubble (`role="tooltip"`), which stays in the page while hidden.
- **Timing** (`tooltipTiming.ts`): shows 80 ms after a mouse rests on the trigger (a pointer that only crosses it opens
  nothing); at once while another tooltip is open or less than 300 ms after one closed (the delay group, moving along
  a toolbar); at once on keyboard focus, the focus a person moves with Tab or an arrow key (`:focus-visible`), not the
  focus a click brings nor the focus a dialog gives its first control as it opens (that tooltip would take the Escape
  meant for the dialog). Hides 100 ms after the pointer leaves trigger and bubble (it is hoverable, WCAG 1.4.13), at
  once on blur or a press. **Escape** closes it without moving focus and goes no further, so the dialog or menu under
  it stays (in a text field the key still reaches the field: an inline rename cancels). One tooltip at a time. Touch never
  opens one: a tap performs the action, and the accessible name is what a touch screen reader hears.
- **Positioning:** the bubble is a `popover="manual"` in the **top layer**, so no ancestor's overflow clips it and no
  z-index competes with it (the layering rule above is untouched); it is portalled to `document.body`, so it never
  becomes a sibling that `space-x-*`, `divide-*` or `last:` count. `positionFloating.ts` places it with
  `@floating-ui/dom` (`vendor-floating` chunk): on the side asked for, **flipped** when there is no room, **shifted** to
  stay 8 px inside the viewport, `start` / `end` by reading direction. It traps no focus.
- **Look:** `.tooltip` = `rounded-md bg-text-strong text-card px-2 py-1 text-[0.75rem] leading-snug shadow-md max-w-64` (12 px, in rem so it scales with the text size),
  inverted in both modes, entering with `animate-fade-in` (reduced motion is handled globally). `theme/tooltip.test.ts`
  pins the recipe and its contrast in every theme.
- **Content rule:** a tooltip is **never the only place important information lives**. A consequence, a mode's meaning
  or why something is off is visible text, or an **InfoTip**. A control that is off and says why in a tooltip uses
  `aria-disabled`, not `disabled`, so it stays focusable (`.btn` and `.icon-btn` style both alike).
- **InfoTip** (a port of KiroCrew's): `<InfoTip text={…} />`, the ⓘ glyph ("More information", described by its text)
  for an explanation that would not fit as visible text. Hover and focus show it like a Tooltip; a click or a tap pins
  it until another click or tap, a press outside, Escape or blur.
- **TruncatedText:** `<TruncatedText as="p" className="truncate …" text={name} />` for text cut by `truncate` or
  `line-clamp-*`: its tooltip shows **only while the text is actually cut**. It is not focusable, so the whole text
  must also be on the item's detail view.
- **Not tooltips** (they stay): an `iframe`'s `title` (its accessible name), SVG `<title>`, and a component's own
  `title` prop (ConfirmModal's, a card's heading).

### Navigation

`.nav-active` marks the selected nav item or list row. Breadcrumbs: muted links with a `ChevronRight` 14 separator, current page `text-text-strong`.

### Markdown

`.md-content` styles rendered markdown: headings, lists with muted markers, accent links, inline code in `bg-bg-hover`/`text-accent-text`, bordered `pre` and tables, and blockquotes with an accent rule. It also styles the canvas's callouts (`[data-callout]`), to-dos (`.contains-task-list`) and raw source (`pre.canvas-raw`, `code.canvas-raw-inline`) in the light reader, so a text reads alike in both engines. `.md-content-compact` is the same recipe a size down for a 360 px panel: 13 px body, h1 15 px, h2 14 px, h3 13 px semibold.

### Documents

**What a document is.** A text is a document when it is Markdown, or versioned, or reviewed or approved by someone other than its writer, or over 4,000 characters. A document uses `DocumentSurface` (`components/Document/`). Everything else is a form field (`.input`), a chat composer or a log.

**One surface, an adapter per feature.** A feature passes a `DocumentAdapter` (`components/Document/types.ts`: permissions, how a version is named, load, save with the version it was made on, rename, conflict and refusal rules); the surface never names a route. Projects documents (`pages/ProjectDetail/documentAdapter.ts`), the review page and History are on it.

| Variant | Use | Layout |
|---|---|---|
| `page` | a document's own page | the page frame: bar, sheet at the reading width or full width, focus view; Contents from three headings |
| `panel` | a 360 px inspector | compact title, the text scrolling inside `max-h-[min(70vh,40rem)]`, `.md-content-compact`, Open full page; edits plain text only |
| `sheet` | a document beside its list or page (the History's Open and Compare) | the app's one side sheet, `SideSheet size="wide"` ([Side sheets](#side-sheets)): its title, the details as its description, the decision or Close in its footer, the body scrolling between |
| `inline` | inside a card or a `<details>` | no chrome |

| Mode | Shows |
|---|---|
| Read | the light reader with **Rendered · Source** (`tabs-track`, `aria-pressed`); Source is the code view |
| Edit | the save row (status, Discard, Save, ⌘/Ctrl+S), the canvas (its chunk loaded on Edit) or, for plain text and prompts, the field with its count; the unsaved-changes guard |
| Compare | `DocumentDiff`: rendered blocks by default, the line diff under Source |

**States.** Loading shows the heading and three `skeleton h-4` lines; an empty text says "Nothing written yet."; a stale save (409) is a `role="alert"` banner with **Compare and merge** (the latest version's changes taken into the draft where they still apply, by Revise's exactly-once rule; a true conflict is shown side by side and never applied), **Load the latest** and **Save mine anyway**, all waiting while a save or a load is on its way; a text past its limit turns its count `text-danger` and Save says why.

**Read-only reasons are visible text, never disabled inputs** (an `info` note with at most one action): `viewer`, `olderVersion` (the version banner: Back to latest, Restore), `managedByTemplate`, `decided`, `proposalOnly`, `editedElsewhere`.

**Safe Markdown.** Every rendered text goes through `components/Document/read/markdownPolicy.ts`: `stored` (links only where the canvas writes them: http(s), mailto, in-app paths; images only from a safe address, never `data:`) and `model` (safe links, no images). Raw HTML is never rendered: it shows as its inert source, as on the canvas. ESLint forbids `rehype-raw` and `dangerouslySetInnerHTML` under `components/Document/**`. An adapter picks its policy (`policy: 'model'` for text an agent wrote: skills, knowledge packs, tenets, run reports, the docs preview; `stored`, the default, otherwise), and a stream that is no document (the run workspace's thread) reads through `MarkdownRead` with `markdownPolicy.model`.

**Agents documents (7.52.00).** One adapter per feature (`pages/Agents/documents/*`, `pages/Agents/Registry/gateBriefAdapter.ts`): a skill version reads as a SKILL.md whose properties are a split front-matter (Compare diffs the bodies; the properties' changes are listed beside it); a proposal opens on its changes, with Accept the one primary; a person's own version is written on the canvas, reviewed as a diff, then proposed (never applied by itself). Tenets compare by id and are never edited (accept or reject with a reason). A prompt that is a field of a larger document (an automation's or a flow step's instructions) is `PromptField` (`components/Document/text/`): the plain-text editor with its count and "Sent to the model as written.", plain text when read only, saved by its parent.

**Code view** (`.code-view`): the text exactly as stored, 12 px mono, decorative line numbers (`aria-hidden`, never selected), Wrap lines, Copy, a named focusable `region`. No syntax highlighting. A SKILL.md's YAML front-matter is split off byte for byte and shown read only as **Properties** (a definition list when every line is a flat `key: value`, else the code view).

**Bundle.** Reading never loads the editor: nothing under `components/Document/{read,text,diff}` and no Agents page imports `@tiptap/*` statically (`src/build/readEngineImports.test.ts`).

### Flow canvas

One canvas and one inspector draw a flow everywhere (`components/WorkflowEditor/FlowCanvas.tsx`, `FlowInspector.tsx`), in `mode` `build` (an administrator edits), `view` (read only: a viewer, an agent's Flow tab, a template preview) or `run` (a run's state, inert: a click selects, never acts). The node language is `nodes/nodeKinds.ts` (pure) and its renderers in `nodes/`.

**Kind is shape plus icon** (never colour alone), each centred in a 220 px column so stored positions never move:

| Kind | Shape | Size | Tile (who acts) |
|---|---|---|---|
| Trigger, End, Stop at PR | pill | 180 × 44 | neutral |
| Agent, Team (a board) | rounded card, `rounded-lg`, a round avatar with the role's glyph | 220 × 88 | `aim` |
| Gate | elongated hexagon (clip-path; the outer layer is the outline) | 220 × 76 | strong neutral |
| Calls a flow | stacked card: two sheets at 4 and 8 px | 220 × 88 | neutral |
| A person decides | pill with a `warn` diamond holding `Hand` | 200 × 52 | `warn` |
| Platform step (map, reduce, memory) | square-cornered card, `rounded-sm` | 200 × 56 | neutral |

- **Tone says who acts, never which kind**, on the icon tile only: `aim` where a model does the step, `warn` where a person must, neutral where the platform does. The tile never changes with a run's state (a gate's shield shows its verdict, the one exception).
- **Four channels that never share one line:** state is the outline (`data-state`: running 2 px `--accent`, waiting 2 px `--warn`, paused dashed `--warn`, failed 2 px `--danger`, planned dashed, skipped dotted `--border-strong`) and a 20 px corner badge (icon and words); selection is the `--accent-subtle` fill (plus a 2 px accent outline unless a state holds it); focus is the `--ring` at 3 px on the React Flow wrapper; hover is an outline step (`--control-border-hover`). "You are here" and "Stopped here" are tags above the node, never a ring. Nothing is dimmed by opacity.
- **Outlines, arrows and handles' rings are `--control-border`**, 3:1 or more on the canvas and on a node in every theme (`theme/canvasContrast.test.ts`); handles look 10 px with a 24 px target. A gate's GO and NO-GO are two source handles at a quarter and three quarters of its bottom edge, each with its word, so the verdict is set by where you drag (the arrow's `label`, `pass` / `fail`).
- **The minimap** fills by kind while building or viewing (agents `--aim`, gates `--text-strong`, decisions `--warn`, the rest `--muted`) and by state in a run; it adds nothing the canvas does not show.
- **The stacked sheets are the one exception to "shadows are for things that float"**: a shape, not elevation, and no `--shadow-*` token (Quick's flat shadows leave it).
- **The inspector** keeps **In this flow** (the step's own fields: inputs while building, a definition list otherwise, never disabled inputs) apart from **From the card** (always read only: a `bg-bg-accent` panel with a lock). It is a 360 px docked column from `lg` and the app's `SideSheet` below it; Escape closes it and returns focus to the step. The palette is grouped by kind, each row a 20 × 14 mini shape (`.voc-mini-shape-*`), its hints visible text; a drag shows the node it makes (`NodePreview`).

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
| Name an icon button, or add a date or an id on hover and focus | `Tooltip` (`kind="label"` / `kind="description"`) |
| Explain something that would not fit as visible text | `InfoTip` |
| Text that may be cut | `TruncatedText` |
| Edit one row of a list beside it | `SideSheet` |
| Status | `badge` + a status tone (`ok` / `warn` / `danger` / `info` / `aim`) |
| Name, kind or value (a label) | `badge badge-muted`; the row's one primary classification `badge badge-accent` |

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
| Tooltip | 80 ms in (0 ms in a group), 100 ms out, instant on focus; `animate-fade-in` ([Tooltips](#tooltips)) |
| Side sheet entrance | `animate-slide-in-end` (.24s, house easing, from 100% to 0 along the inline axis) |
| Content entrance | `animate-rise` (.35s, 8px up) |
| Loading | `skeleton` (pulse) · `animate-spin` spinners in `border-accent` |
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

- Icon-only buttons need `aria-label` and a `<Tooltip kind="label">`; dialog X buttons use `<DialogClose>` ("Dismiss", so it never collides with a footer "Close"/"Cancel").
- A tooltip is never the only place important information lives: a consequence, a mode's meaning or why a control is off is visible text or an `InfoTip`, and an explained control that is off is `aria-disabled` (focusable), not `disabled` ([Tooltips](#tooltips)).
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
# Identity-coloured labels (must print nothing): an info / aim pill whose content, within the next
# three lines, is a descriptive field — see "Labels vs status". theme/badgeTones.test.ts is the gate
# for the feedback surfaces; this covers every other list.
grep -rnE -A3 "badge-(info|aim)|bg-(info|aim)-subtle" src --include='*.tsx' | grep -v '\.test\.' | grep -E "\.(category|subcategory|journey_stage|persona_name|source_platform|tags)\b|chip\.(label|value)|\{tag\}"
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
| Badges are status-only; labels among peers go grey (`Badge` variants, `SourceBadge` `tone="neutral"`) | [`website/src/components/ui.tsx`](https://github.com/kirodotdev/kirocrew/blob/main/website/src/components/ui.tsx), [`website/docs/frontend-conventions.md`](https://github.com/kirodotdev/kirocrew/blob/main/website/docs/frontend-conventions.md) › Styling |
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
