import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import { getProject, listProjects } from './api/layers'
import { AppShell } from './app/AppShell'
import { LayerPanel } from './features/layers/LayerPanel'
import { MemoryPanel } from './features/memory/MemoryPanel'
import { MapCanvas } from './map/MapCanvas'
import { MapProvider } from './map/MapProvider'
import type { LayerFactoryDeps } from './map/layerFactory'
import { useLayerMemory } from './map/memory/useLayerMemory'
import { useLayerStore } from './state/layerStore'

export function App() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const projectId = projects.data?.[0]?.id
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: Boolean(projectId),
  })

  const { manager, usage, totalBytes, budgetBytes } = useLayerMemory()
  const selectedLayerId = useLayerStore((state) => state.selectedLayerId)

  useEffect(() => {
    useLayerStore.getState().setProjectId(projectId ?? null)
  }, [projectId])

  useEffect(() => {
    if (!selectedLayerId) return
    manager.setPinned(selectedLayerId, true)
    return () => manager.setPinned(selectedLayerId, false)
  }, [manager, selectedLayerId])

  const deps = useMemo<LayerFactoryDeps>(
    () => ({
      memory: manager,
      onFeatureBytes: (layerId, bytes) => manager.record(layerId, bytes),
      onTruncated: (layerId, truncated) =>
        useLayerStore.getState().setTruncated(layerId, truncated),
    }),
    [manager],
  )

  const layers = useMemo(() => project.data?.layers ?? [], [project.data])
  const view = project.data?.view
  const names = useMemo(() => new Map(layers.map((layer) => [layer.id, layer.name])), [layers])

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
        map={<MapCanvas layers={layers} deps={deps} />}
        bottom={<div style={{ padding: 12 }}>Attribute table goes here</div>}
        inspector={
          <MemoryPanel
            usage={usage}
            totalBytes={totalBytes}
            budgetBytes={budgetBytes}
            names={names}
          />
        }
      />
    </MapProvider>
  )
}
