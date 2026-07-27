import type { ReactNode } from 'react'

interface AppShellProps {
  sidebar: ReactNode
  map: ReactNode
  bottom: ReactNode
  inspector?: ReactNode
}

export function AppShell({ sidebar, map, bottom, inspector }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">{sidebar}</aside>
      <main className="app-shell__main">
        <div className="app-shell__map">{map}</div>
        <div className="app-shell__bottom">{bottom}</div>
      </main>
      {inspector ? <aside className="app-shell__inspector">{inspector}</aside> : null}
    </div>
  )
}
