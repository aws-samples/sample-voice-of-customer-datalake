/**
 * @fileoverview The chrome every Dashboard card shares: one title style, one padding.
 * @module pages/Dashboard/DashboardCard
 */
import type { ReactNode } from 'react'

export default function DashboardCard({ title, icon, children }: Readonly<{ title: ReactNode; icon?: ReactNode; children: ReactNode }>) {
  return (
    <section className="card min-w-0">
      <h2 className="text-base sm:text-lg font-semibold tracking-tight text-text-strong mb-3 sm:mb-4 flex items-center gap-2">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  )
}
