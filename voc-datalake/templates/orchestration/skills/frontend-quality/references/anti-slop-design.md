# Anti-Slop Design System Reference

Detailed rules for detecting and fixing AI-generated UI patterns. Referenced from SKILL.md.

## The Problem: Distributional Convergence

AI tools converge on the same aesthetic: rounded cards, drop shadows, purple-blue gradients, low data density. This generic look signals "AI-built" to experienced designers and engineers. Professional tools (Vercel, Linear, Raycast, Datadog) use a different vocabulary.

## Design Vocabulary

### Professional Tool Aesthetic
- Dark mode default (#0A0A0A, #0E1116, not gray-800 or gray-900)
- Grayscale hierarchy with color reserved for status and interaction
- High data density: metrics, tables, and lists, not card grids
- Monospaced numbers with `tabular-nums` for alignment
- Minimal chrome: thin borders (1px, rgba(255,255,255,0.05)), no shadows on data
- Typography hierarchy through weight and size, not color and decoration

### AI Slop Aesthetic (avoid)
- Card soup: every piece of content wrapped in rounded-lg shadow-md
- Heavy elevation: boxShadow on data containers, multiple shadow layers
- Fat borders: 2px+ colored borders, high-contrast border colors
- Low density: one metric per card with icon + label + value
- Component library defaults: MUI Card, Bootstrap card, unstyled Chakra

## Pattern Details with Code Examples

### 1. Card Syndrome
```tsx
// SLOP: every metric is a card with shadow
<Card sx={{ p: 3, borderRadius: 3, boxShadow: '0 4px 24px rgba(0,0,0,0.4)' }}>
  <Typography variant="caption">Latency</Typography>
  <Typography variant="h4">12ms</Typography>
</Card>

// FIX: borderless row with monospace data
<div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
  <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>Latency</span>
  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontVariantNumeric: 'tabular-nums', fontSize: '13px' }}>12ms</span>
</div>
```

### 2. Shadow Overuse
```css
/* SLOP: same shadow on every element */
.card { box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
.button { box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
.header { box-shadow: 0 1px 4px rgba(0,0,0,0.1); }

/* FIX: shadows only for overlays (modals, dropdowns, tooltips) */
.card { box-shadow: none; border-bottom: 1px solid rgba(255,255,255,0.05); }
.modal { box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
```

### 5. Low Data Density
```tsx
// SLOP: 4 cards for 4 numbers, each with icon + label + value + padding
<Grid container spacing={3}>
  {metrics.map(m => (
    <Grid item xs={3}>
      <Card sx={{ p: 3, textAlign: 'center' }}>
        <m.Icon sx={{ fontSize: 40, color: 'primary.main', mb: 1 }} />
        <Typography variant="body2" color="text.secondary">{m.label}</Typography>
        <Typography variant="h4">{m.value}</Typography>
      </Card>
    </Grid>
  ))}
</Grid>

// FIX: compact inline row with monospace values
<div style={{ display: 'flex', gap: '32px', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', fontFamily: 'JetBrains Mono, monospace', fontVariantNumeric: 'tabular-nums', fontSize: '13px' }}>
  <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>p50</span> 12ms</div>
  <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>p95</span> 18ms</div>
  <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>GPU</span> 42%</div>
  <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>req/s</span> 850</div>
</div>
```

### 6. Missing tabular-nums
```css
/* Numbers without tabular-nums jitter when values update */
/* SLOP */ .metric { font-family: Inter, sans-serif; }
/* FIX  */ .metric { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }
```

### 7. Heavy Chrome
```tsx
// SLOP: thick colored borders, heavy backgrounds
<Card sx={{ border: '2px solid #6366f1', bgcolor: 'rgba(99,102,241,0.1)', borderRadius: 3 }}>

// FIX: minimal separator, no background fill
<Box sx={{ borderBottom: '1px solid rgba(255,255,255,0.05)', py: 1.5 }}>
```

### 10. Missing Monospace Data
```tsx
// SLOP: latency in body font
<Typography variant="h5">12.4ms</Typography>

// FIX: monospace with tabular-nums
<Typography sx={{ fontFamily: '"JetBrains Mono", monospace', fontVariantNumeric: 'tabular-nums' }}>
  12.4ms
</Typography>
```

## Typography Rules

| Element | Font | Weight | Size |
|---|---|---|---|
| Page title | Inter, Geist Sans | 600 | 20-24px |
| Section heading | Inter, Geist Sans | 500 | 16-18px |
| Body text | Inter, Geist Sans | 400 | 14px |
| Labels/captions | Inter, Geist Sans | 400 | 12-13px, 50% opacity |
| Metrics/numbers | JetBrains Mono, Fira Code | 400-500 | 13-16px |
| Code/technical | JetBrains Mono, Fira Code | 400 | 13px |

## Color Rules

- **Background**: #0A0A0A or #0E1116 (not gray-800/gray-900)
- **Surface**: rgba(255,255,255,0.03) - barely visible elevation
- **Borders**: rgba(255,255,255,0.05) - 5% white, max
- **Text primary**: rgba(255,255,255,0.9)
- **Text secondary**: rgba(255,255,255,0.5)
- **Text tertiary**: rgba(255,255,255,0.3)
- **Accent (status only)**: emerald for success, amber for warning, red for error, blue for active/info
- **Brand accent**: one color, used sparingly (buttons, active states, links)

## Tufte Rule

Maximize data-to-ink ratio. For each visual element, ask: "Does removing this lose information?"

Remove if answer is no:
- Background fills on data containers
- Borders on all four sides (use border-bottom only)
- Icons next to labels (the label is the icon)
- Shadow on cards that sit on the same surface
- Rounded corners > 8px on data containers
- Gradient backgrounds behind text

## Border Radius Scale

| Element | Radius |
|---|---|
| Buttons, inputs | 6px |
| Cards, containers | 8px |
| Modals, dialogs | 12px |
| Pills, tags, chips | 9999px |
| Data containers | 0px or 4px |

## Button Rules

- Height: 32-36px (compact), 40px max
- Padding: 8px 12px (compact), 12px 16px max
- Font size: 13px, weight 500
- Primary: solid background, no shadow
- Secondary: transparent + border (1px rgba(255,255,255,0.1))
- Ghost: transparent, hover:bg-white/5
