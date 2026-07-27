import { useQuery } from '@tanstack/react-query'

import { listProjects } from './api/layers'
import { AppShell } from './app/AppShell'

export function App() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })

  return (
    <AppShell
      sidebar={<div style={{ padding: 12 }}>Projects: {projects.data?.length ?? '…'}</div>}
      map={<div style={{ padding: 12 }}>Map goes here</div>}
      bottom={<div style={{ padding: 12 }}>Attribute table goes here</div>}
    />
  )
}
