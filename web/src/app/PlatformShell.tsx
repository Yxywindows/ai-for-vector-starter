import { Outlet } from 'react-router'

/** Content only. Shared ExperienceRoot owns navigation; the map keeps its own shell. */
export function PlatformShell() {
  return (
    <main className="platform__content" tabIndex={-1}>
      <Outlet />
    </main>
  )
}
