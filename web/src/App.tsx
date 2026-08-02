import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { getProject } from './api/layers'
import { AppShell, type ResizablePanel } from './app/AppShell'
import { ProjectSwitcher } from './app/ProjectSwitcher'
import { loadLayout, saveLayout, type WorkspaceLayout } from './app/workspaceLayout'
import { AttributeTable } from './features/attributes/AttributeTable'
import { EditToolbar } from './features/editing/EditToolbar'
import { LayerPanel } from './features/layers/LayerPanel'
import { MemoryPanel } from './features/memory/MemoryPanel'
import { StyleEditor } from './features/styling/StyleEditor'
import { IdentifyPopup } from './map/IdentifyPopup'
import { MapCanvas } from './map/MapCanvas'
import { MapProvider, useMap } from './map/MapProvider'
import { StatusBar } from './map/StatusBar'
import { WorkspaceSync, parseSelParam, parseViewParam } from './map/WorkspaceSync'
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
  const [, setSearchParams] = useSearchParams()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: Boolean(projectId),
  })

  // URL state is read once, at mount: after that the workspace *writes* the
  // URL (WorkspaceSync) rather than reacting to it.
  const [initialUrl] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return {
      view: parseViewParam(params.get('view')),
      sel: parseSelParam(params.get('sel')),
      drawer: params.get('drawer') === '1',
    }
  })

  const [layout, setLayout] = useState<WorkspaceLayout>(() => {
    const stored = loadLayout(projectId ?? '')
    return initialUrl.drawer ? { ...stored, tableOpen: true } : stored
  })

  useEffect(() => {
    if (projectId) saveLayout(projectId, layout)
  }, [projectId, layout])

  const { manager, usage, totalBytes, budgetBytes } = useLayerMemory()
  const selectedLayerId = useLayerStore((state) => state.selectedLayerId)

  useEffect(() => {
    useLayerStore.getState().setProjectId(projectId ?? null)
    // The platform rail's "Open map workspace" jump target.
    if (projectId) localStorage.setItem('graticule:lastProject', projectId)
  }, [projectId])

  // Restore the URL's selection once, as soon as the workspace mounts.
  useEffect(() => {
    if (!initialUrl.sel) return
    const store = useLayerStore.getState()
    store.selectLayer(initialUrl.sel.layerId)
    if (initialUrl.sel.featureIds.length > 0) store.selectFeatures(initialUrl.sel.featureIds)
  }, [initialUrl])

  const writeDrawerParam = useCallback(
    (open: boolean) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (open) next.set('drawer', '1')
          else next.delete('drawer')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // Selecting a layer is a request to inspect it: bring the drawer up.
  useEffect(
    () =>
      useLayerStore.subscribe((state, previous) => {
        if (state.selectedLayerId && state.selectedLayerId !== previous.selectedLayerId) {
          setLayout((current) =>
            current.tableOpen ? current : { ...current, tableOpen: true },
          )
          writeDrawerParam(true)
        }
      }),
    [writeDrawerParam],
  )

  // Leaving the workspace returns the memory it borrowed: every layer's
  // cached features and tiles are dropped (IA acceptance §9.4).
  useEffect(
    () => () => {
      manager.clearAll()
    },
    [manager],
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

  const onPanelResize = useCallback((panel: ResizablePanel, pixels: number) => {
    const keys: Record<ResizablePanel, 'sidebarWidth' | 'inspectorWidth' | 'drawerHeight'> = {
      sidebar: 'sidebarWidth',
      inspector: 'inspectorWidth',
      drawer: 'drawerHeight',
    }
    const key = keys[panel]
    setLayout((current) => {
      const previous = current[key]
      if (previous !== undefined && Math.abs(previous - pixels) <= 2) return current
      return { ...current, [key]: pixels }
    })
  }, [])

  // Side effects stay OUT of updaters — StrictMode double-invokes them
  // (the useImportDraft lesson). The closure value is current for a user
  // click; concurrent toggles in one tick don't exist for a button.
  const tableOpen = layout.tableOpen
  const toggleTable = useCallback(() => {
    setLayout((current) => ({ ...current, tableOpen: !current.tableOpen }))
    writeDrawerParam(!tableOpen)
  }, [tableOpen, writeDrawerParam])

  const layers = useMemo(() => project.data?.layers ?? [], [project.data])
  const view = project.data?.view
  const names = useMemo(() => new Map(layers.map((layer) => [layer.id, layer.name])), [layers])
  const selectedLayer = layers.find((layer) => layer.id === selectedLayerId)

  const center = initialUrl.view?.center ?? view?.center ?? [0, 0]
  const zoom = initialUrl.view?.zoom ?? view?.zoom ?? 2

  return (
    <MapProvider center={center} zoom={zoom}>
      <SelectionSync />
      {projectId ? <WorkspaceSync projectId={projectId} /> : null}
      <AppShell
        context={projectId ? <ProjectSwitcher projectId={projectId} /> : null}
        status={<StatusBar layerCount={layers.length} />}
        layout={layout}
        onToggleSidebar={() =>
          setLayout((current) => ({ ...current, sidebarOpen: !current.sidebarOpen }))
        }
        onToggleInspector={() =>
          setLayout((current) => ({ ...current, inspectorOpen: !current.inspectorOpen }))
        }
        onToggleTable={toggleTable}
        onPanelResize={onPanelResize}
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
