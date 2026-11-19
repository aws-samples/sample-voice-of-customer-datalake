/**
 * @fileoverview A labelled on/off switch (design system `switch`): a real
 * checkbox with `role="switch"` stays the accessible control, the spans are
 * its visual track and knob. The wrapping label names it.
 * @module components/Switch
 */
const TRACK = 'switch peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50'

export default function Switch({ label, checked, onChange, disabled, describedBy, widthOf }: Readonly<{
  label: string
  checked: boolean
  onChange: (on: boolean) => void
  disabled: boolean
  describedBy?: string
  /** Every label the switch can show ("Live", "Off"): the label keeps the widest one's width in every language, so
   * the controls after it never move when it flips. The extra words are hidden from everyone (`aria-hidden`). */
  widthOf?: readonly string[]
}>) {
  return (
    // The label text wraps beside the track (de "Desktop-Benachrichtigungen" at
    // 390 px / 200 % text pushed the page sideways); the track never shrinks.
    <label className="inline-flex max-w-full items-center gap-3 text-sm text-text">
      <span className="relative inline-flex flex-shrink-0 items-center">
        <input type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled}
          aria-describedby={describedBy} onChange={(e) => { onChange(e.target.checked) }} />
        <span aria-hidden="true" className={checked ? `${TRACK} switch-on` : TRACK}><span className="switch-knob" /></span>
      </span>
      <span className="min-w-0 break-words hyphens-auto" data-testid="switch-label">
        {widthOf === undefined ? label : (
          <span className="inline-grid">
            {widthOf.map((text) => <span key={text} aria-hidden="true" className="invisible col-start-1 row-start-1">{text}</span>)}
            <span className="col-start-1 row-start-1">{label}</span>
          </span>
        )}
      </span>
    </label>
  )
}
