import { useQuery } from '@tanstack/react-query'

import { getProject, listProjects } from './api/layers'
import { AppShell } from './app/AppShell'
import { MapCanvas } from './map/MapCanvas'
import { MapProvider } from './map/MapProvider'

export function App() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const projectId = projects.data?.[0]?.id
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: Boolean(projectId),
  })

  const layers = project.data?.layers ?? []
  const view = project.data?.view

  return (
    <MapProvider center={view?.center ?? [0, 0]} zoom={view?.zoom ?? 2}>
      <AppShell
        sidebar={<div style={{ padding: 12 }}>{layers.length} layers</div>}
        map={<MapCanvas layers={layers} />}
        bottom={<div style={{ padding: 12 }}>Attribute table goes here</div>}
      />
    </MapProvider>
  )
}
