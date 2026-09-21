# HTML Prototype Generator — Skill

## Purpose

From the PRD, PRFAQ, and Research document, create a clickable click-dummy as a **single index.html file**. Quick-and-dirty, but presentable — for colleagues and stakeholders.

---

## Input

| Document | What it contributes |
|----------|-----------------|
| **PRD** | Features, user stories, navigation structure, acceptance criteria |
| **PRFAQ** | Value proposition, headlines, customer benefits, CTA |
| **Research doc** | Problem context, personas, key quotes |

---

## What the prototype contains

Everything in ONE `index.html` file (no build, no dependencies):

1. **Navigation / App Shell** — sidebar or top-nav based on PRD features
2. **Screens / Pages** — one "screen" per feature (via CSS show/hide or JS tabs)
3. **Hero/Landing** — from the PRFAQ: headline, subheadline, CTA button
4. **Feature Sections** — per PRD feature: title, description, mock UI
5. **Key Data** — from Research: persona quotes, problem statements as context
6. **Interaction** — clickable navigation between screens (no backend, visual only)

## Technical Constraints

- **Single file** — EVERYTHING in one index.html (CSS inline, JS inline)
- **No dependencies** — no CDN, no framework, no build
- **Responsive** — Tailwind-style utility classes (inline, no external lib)
- **Modern look** — clean UI with system fonts, good spacing, cards
- **Clickable** — navigation works, tabs switch, buttons show states

## Prompt Template

### System Prompt
```
You are an experienced UI/UX prototyper. You create a functional click-dummy as a single HTML file.

Rules:
- EVERYTHING in one file (HTML + CSS + JS inline)
- No external dependencies
- Modern, clean design (system fonts, good spacing, cards)
- Navigation elements are clickable and switch content
- Data is realistic (from the PRD/PRFAQ, not Lorem Ipsum)
- Mobile-responsive layout
- Dark/Light mode support (prefers-color-scheme)
```

### User Prompt Template
```
Create a clickable HTML prototype based on these documents:

## PRFAQ (Value Proposition & Messaging)
{prfaq_content}

## PRD (Features & Requirements)
{prd_content}

## Research (Context & Personas)
{research_content}

---

Create a SINGLE index.html file that contains:

1. **App Shell**: navigation (sidebar or top-nav) with all features as menu items
2. **Landing/Hero**: headline and subheadline from the PRFAQ
3. **Feature Screens**: a dedicated "page" for each P0 feature from the PRD
   - Feature title
   - Short description
   - Mock UI (forms, lists, cards, charts — matching the feature)
   - Placeholder data that looks realistic
4. **Footer**: problem statement + a persona quote from the Research

Make the navigation clickable (JavaScript show/hide of the sections).
Use a modern card-based layout.
Add realistic placeholder data (no Lorem Ipsum).

Output: ONLY the HTML file, no surrounding Markdown.
```

---

## Flow

1. **Load documents** — read PRD, PRFAQ, Research from the Knowledge Base
2. **Extract features** — all P0/P1 features from the PRD
3. **Generate HTML** — produce the entire file in one prompt
4. **Save** — as `index.html` in the artifacts
5. **Open** — in a Session Tab for immediate preview

## Output

- **File:** `knowledge-base/projects/[project]/prototype/index.html`
- **Open:** `open_in_session_tab` for a live preview in the browser
- **Share:** the user can send the single file to colleagues via email/Slack

## Quality Criteria

| Criterion | Must |
|-----------|:----:|
| Single file, no build | ✅ |
| Navigation clickable | ✅ |
| All P0 features as screens | ✅ |
| Realistic data (not Lorem) | ✅ |
| Responsive layout | ✅ |
| Under 15KB file size | Nice-to-have |
| Animations/transitions | Nice-to-have |
