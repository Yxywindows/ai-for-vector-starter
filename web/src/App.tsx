import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'

import { getProject } from './api/layers'
import { AppShell } from './app/AppShell'
import { ProjectSwitcher } from './app/ProjectSwitcher'
import { AttributeTable } from './features/attributes/AttributeTable'
import { EditToolbar } from './features/editing/EditToolbar'
import { LayerPanel } from './features/layers/LayerPanel'
import { MemoryPanel } from './features/memory/MemoryPanel'
import { StyleEditor } from './features/styling/StyleEditor'
import { IdentifyPopup } from './map/IdentifyPopup'
import { MapCanvas } from './map/MapCanvas'
import { MapProvider, useMap } from './map/MapProvider'
import { StatusBar } from './map/StatusBar'
import type { LayerFactoryDeps } from './map/layerFactory'
import { useLayerMemory } from './map/memory/useLayerMemory'
import { highlightFeatures } from './map/selection'
import { useLayerStore } from './state/layerStore'

/** Mirrors the store's feature selection onto the map as a feature property. */
function SelectionSync() {
  const map = useMap()
  const selectedLayerId = useLayerStore((state) => state.selectedLayerId)
  const selectedFeatureIds = useLayerStore((state) => state.selectedFeatureIds)

  useEffect(() => {
    if (map && selectedLayerId) highlightFeatures(map, selectedLayerId, selectedFeatureIds)
  }, [map, selectedLayerId, selectedFeatureIds])

  return null
}

export function App() {
  // The project is route state, not store state: /projects/:projectId/map.
  const { projectId } = useParams<{ projectId: string }>()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: Boolean(projectId),
  })

  const { manager, usage, totalBytes, budgetBytes } = useLayerMemory()
  const selectedLayerId = useLayerStore((state) => state.selectedLayerId)
  const [tableOpen, setTableOpen] = useState(false)

  useEffect(() => {
    useLayerStore.getState().setProjectId(projectId ?? null)
  }, [projectId])

  // Selecting a layer is a request to inspect it: bring the drawer up.
  useEffect(
    () =>
      useLayerStore.subscribe((state, previous) => {
        if (state.selectedLayerId && state.selectedLayerId !== previous.selectedLayerId) {
          setTableOpen(true)
        }
      }),
    [],
  )

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
  const selectedLayer = layers.find((layer) => layer.id === selectedLayerId)

  return (
    <MapProvider center={view?.center ?? [0, 0]} zoom={view?.zoom ?? 2}>
      <SelectionSync />
      <AppShell
        context={projectId ? <ProjectSwitcher projectId={projectId} /> : null}
        status={<StatusBar layerCount={layers.length} />}
        tableOpen={tableOpen}
        onToggleTable={() => setTableOpen((open) => !open)}
        sidebar={
          projectId ? (
            <LayerPanel projectId={projectId} layers={layers} />
          ) : (
            <div style={{ padding: 12 }}>Loading projects…</div>
          )
        }
        map={
          <>
            <EditToolbar layer={selectedLayer ?? null} />
            <MapCanvas layers={layers} deps={deps} />
            <IdentifyPopup names={names} />
          </>
        }
        bottom={<AttributeTable layerId={selectedLayerId} />}
        inspector={
          <>
            {projectId && selectedLayer ? (
              <StyleEditor key={selectedLayer.id} projectId={projectId} layer={selectedLayer} />
            ) : null}
            <MemoryPanel
              usage={usage}
              totalBytes={totalBytes}
              budgetBytes={budgetBytes}
              names={names}
            />
          </>
        }
      />
    </MapProvider>
  )
}
