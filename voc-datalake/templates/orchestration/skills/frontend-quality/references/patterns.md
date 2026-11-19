# Frontend Quality Pattern Reference

Detailed patterns with code examples. Referenced from SKILL.md.
For anti-slop design system rules, see: anti-slop-design.md

## AI Visual Slop (10 patterns)

### 1. Card Syndrome
```tsx
// SLOP: every piece of content is a shadowed card
<Card sx={{ p: 3, borderRadius: 3, boxShadow: '0 4px 24px rgba(0,0,0,0.4)' }}>
  <Typography variant="caption">Latency</Typography>
  <Typography variant="h4">12ms</Typography>
</Card>

// FIX: border-bottom divider, monospace data, no wrapper
<Box sx={{ display: 'flex', justifyContent: 'space-between', py: 1.5, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
  <Typography sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>Latency</Typography>
  <Typography sx={{ fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>12ms</Typography>
</Box>
```
Grep: `rounded-lg shadow`, `MuiCard`, `<Card` frequency. > 5 identical card wrappers per view = card syndrome.

### 2. Shadow Overuse
```css
/* SLOP: shadow on data containers */
.card { box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
.stat { box-shadow: 0 2px 8px rgba(0,0,0,0.2); }

/* FIX: shadows reserved for overlays only */
.card { box-shadow: none; border-bottom: 1px solid rgba(255,255,255,0.05); }
.modal { box-shadow: 0 8px 32px rgba(0,0,0,0.5); } /* overlays OK */
```
Shadow on non-elevated elements (cards, stats, rows) = slop.

### 3. Generic Gradient Backgrounds
```css
/* SLOP: AI default gradients */
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
background: linear-gradient(to right, #6366f1, #8b5cf6);
```
Not slop if using brand tokens for a specific marketing hero.

### 4. Fat Border Radius
```css
/* SLOP */ border-radius: 16px; /* on data containers */
/* FIX  */ border-radius: 8px;  /* containers */
/* FIX  */ border-radius: 6px;  /* buttons, inputs */
/* FIX  */ border-radius: 4px;  /* data containers, tables */
```

### 5. Low Data Density
```tsx
// SLOP: one metric per card with icon, wastes screen space
<Grid container spacing={3}>
  {metrics.map(m => (
    <Grid item xs={3}>
      <Card sx={{ p: 3, textAlign: 'center' }}>
        <m.Icon sx={{ fontSize: 40, mb: 1 }} />
        <Typography variant="body2">{m.label}</Typography>
        <Typography variant="h4">{m.value}</Typography>
      </Card>
    </Grid>
  ))}
</Grid>

// FIX: compact inline row, all metrics visible at once
<Box sx={{ display: 'flex', gap: 4, py: 1.5, fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
  <Box><Typography sx={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>p50</Typography> 12ms</Box>
  <Box><Typography sx={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>p95</Typography> 18ms</Box>
  <Box><Typography sx={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>GPU</Typography> 42%</Box>
  <Box><Typography sx={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>req/s</Typography> 850</Box>
</Box>
```

### 6. Missing tabular-nums
Numbers without tabular-nums jitter on every update. All numeric displays (latency, throughput, confidence, counts) need `font-variant-numeric: tabular-nums`.

### 7. Heavy Chrome
```tsx
// SLOP: thick colored borders, heavy background fills
<Card sx={{ border: '2px solid #6366f1', bgcolor: 'rgba(99,102,241,0.1)' }}>

// FIX: subtle separator, transparent background
<Box sx={{ borderBottom: '1px solid rgba(255,255,255,0.05)', py: 1.5 }}>
```

### 8. Inconsistent Type Scale
> 4 font sizes in one view with no clear hierarchy. Fix: use 4 sizes max (12, 13, 16, 20).

### 9. Default Component Libraries
Unstyled MUI/Bootstrap/Chakra components with factory spacing and elevation.
Override every default: shadow, border-radius, padding, typography.

### 10. Missing Monospace Data
Latency, throughput, percentages displayed in proportional body font. Fix: monospace font stack for all technical data.

## Typography and Data Display (5 patterns)

### 11-15. See anti-slop-design.md for full typography rules, color system, and spacing scale.

## CSS and Markup Slop (7 patterns)

### 16. Div Soup
```html
<!-- SLOP -->
<div class="header"><div class="nav"><div class="nav-item"><div class="link">Home</div></div></div></div>
<!-- FIX -->
<header><nav><a href="/">Home</a></nav></header>
```
Nesting > 6 levels of divs. `<div>` where `<header>/<nav>/<main>/<button>/<a>` fits.

### 17. Tailwind Class Overload
> 12 utility classes on one element. Extract to component or `@apply`.

### 18. !important Overuse
> 3 `!important` declarations = broken specificity.

### 19. Mixed Styling Approaches
Inline styles + utilities + CSS modules in same component. Pick one per project.

### 20. Unused CSS
Selectors matching no elements. Tool: PurgeCSS, Tailwind purge.

### 21. Inconsistent Units
Mix `px`/`rem`/`em`/`vh`/`%` without system. Guide: `rem` for fonts/spacing, `px` for borders/shadows, `%`/`fr` for layouts.

### 22. Z-Index Wars
```css
/* SLOP */ z-index: 9999; z-index: 10000;
/* FIX  */ --z-dropdown: 100; --z-modal: 200; --z-toast: 300;
```

## Accessibility (8 patterns)

### 23. Missing Alt Text
```html
<!-- SLOP --> <img src="hero.jpg"> / <img alt="image">
<!-- FIX  --> <img src="hero.jpg" alt="Team collaborating on whiteboard">
```

### 24. Missing ARIA Labels
```html
<!-- SLOP --> <button><svg>...</svg></button>
<!-- FIX  --> <button aria-label="Close menu"><svg>...</svg></button>
```

### 25. Poor Color Contrast
WCAG AA: 4.5:1 normal text, 3:1 large text, 3:1 UI components.
Common fail: `text-gray-400` on `bg-white`, light text on medium backgrounds.

### 26. Missing Focus Indicators
```css
/* SLOP */ *:focus { outline: none; }
/* FIX  */ *:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
```

### 27. Missing Skip Navigation
```html
<a href="#main-content" class="sr-only focus:not-sr-only">Skip to content</a>
```

### 28. Form Inputs Without Labels
```html
<!-- SLOP --> <input placeholder="Email address">
<!-- FIX  --> <label for="email">Email</label><input id="email" placeholder="you@example.com">
```

### 29. Missing Heading Hierarchy
Skipping levels (h1 then h3). Multiple h1 per page.

### 30. Non-Interactive Click Handlers
```jsx
// SLOP: <div onClick={handleClick}>
// FIX:  <button onClick={handleClick}>
```

### 37. Target Size Below 24x24px (WCAG 2.2, 2.5.8)
```jsx
// SLOP: icon button with no effective tap target
<button className="w-4 h-4 p-0"><TrashIcon /></button>
// FIX: pad to a 24x24px (ideally 44x44px) hit area
<button className="w-10 h-10 flex items-center justify-center"><TrashIcon /></button>
```
Exceptions in the spec: inline links in text, targets with an equivalent control nearby, and targets the author cannot resize (user agent default).

### 38. Accessible Authentication Blocked (WCAG 2.2, 3.3.8)
```html
<!-- SLOP: blocks password manager autofill and paste -->
<input type="password" autocomplete="off" onpaste="return false">
<!-- FIX: let the browser and password manager help -->
<input type="password" autocomplete="current-password">
```
Cognitive function tests (remember a password, solve a puzzle) cannot be the only way to authenticate unless an alternative exists (autofill, paste, "show password", passkey/OAuth).

## Performance (7 patterns, Core Web Vitals)

### 39. Slow Interaction Response (INP)
```jsx
// SLOP: synchronous heavy work blocks the main thread on every keystroke
function onChange(e) { setResults(expensiveFilter(allRows, e.target.value)); }

// FIX: debounce or yield with useTransition so typing stays responsive
function onChange(e) {
  const value = e.target.value;
  startTransition(() => setResults(expensiveFilter(allRows, value)));
}
```
INP (Interaction to Next Paint) replaced First Input Delay as a Core Web Vital in March 2024. Target: <= 200ms for the 75th percentile of interactions, measured from field data, not a single lab run.

### 31. Unoptimized Images
```html
<!-- SLOP --> <img src="photo.png">
<!-- FIX  --> <img src="photo.webp" loading="lazy" decoding="async" width="800" height="600" alt="...">
```

### 32. Bundle Bloat
```js
// SLOP: imports entire lodash (70KB)
import _ from 'lodash';
// FIX
import debounce from 'lodash/debounce';
```
Flag: `moment` (use date-fns/dayjs), full `lodash` (use lodash-es).

### 33. No Code Splitting
No `React.lazy()`, `next/dynamic`, or `import()` for routes/heavy features.

### 34. Render-Blocking Resources
CSS/JS in `<head>` without `async`/`defer`.

### 35. Missing Loading States
`if (loading) return null;` instead of skeleton/spinner.

### 36. Layout Shift (CLS)
Images/embeds without explicit dimensions.
```html
<!-- FIX --> <img width="800" height="600">
<!-- FIX --> <div style="aspect-ratio: 16/9"><iframe>...</iframe></div>
```
