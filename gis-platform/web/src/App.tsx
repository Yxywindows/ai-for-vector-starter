import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

import { getProject, listProjects } from './api/layers'
import { AppShell } from './app/AppShell'
import { LayerPanel } from './features/layers/LayerPanel'
import { MapCanvas } from './map/MapCanvas'
import { MapProvider } from './map/MapProvider'
import { useLayerStore } from './state/layerStore'

export function App() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const projectId = projects.data?.[0]?.id
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: Boolean(projectId),
  })

  useEffect(() => {
    useLayerStore.getState().setProjectId(projectId ?? null)
  }, [projectId])

  const layers = project.data?.layers ?? []
  const view = project.data?.view

  return (
    <MapProvider center={view?.center ?? [0, 0]} zoom={view?.zoom ?? 2}>
      <AppShell
        sidebar={
          projectId ? (
            <LayerPanel projectId={projectId} layers={layers} />
          ) : (
            <div style={{ padding: 12 }}>Loading projects…</div>
          )
        }
        map={<MapCanvas layers={layers} />}
        bottom={<div style={{ padding: 12 }}>Attribute table goes here</div>}
      />
    </MapProvider>
  )
}
