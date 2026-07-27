import { create } from 'zustand'

interface LayerState {
  projectId: string | null
  selectedLayerId: string | null
  selectedFeatureIds: string[]
  truncatedLayerIds: string[]
  setProjectId: (projectId: string | null) => void
  selectLayer: (layerId: string | null) => void
  selectFeatures: (featureIds: string[]) => void
  toggleFeature: (featureId: string) => void
  clearSelection: () => void
  setTruncated: (layerId: string, truncated: boolean) => void
}

/**
 * UI state only. Everything the server owns — the layer list itself — lives
 * in TanStack Query, so there is exactly one source of truth per fact.
 */
export const useLayerStore = create<LayerState>((set) => ({
  projectId: null,
  selectedLayerId: null,
  selectedFeatureIds: [],
  truncatedLayerIds: [],

  setProjectId: (projectId) => set({ projectId }),

  selectLayer: (layerId) =>
    set((state) =>
      state.selectedLayerId === layerId
        ? { selectedLayerId: layerId }
        : { selectedLayerId: layerId, selectedFeatureIds: [] },
    ),

  selectFeatures: (featureIds) => set({ selectedFeatureIds: featureIds }),

  toggleFeature: (featureId) =>
    set((state) => ({
      selectedFeatureIds: state.selectedFeatureIds.includes(featureId)
        ? state.selectedFeatureIds.filter((id) => id !== featureId)
        : [...state.selectedFeatureIds, featureId],
    })),

  clearSelection: () => set({ selectedFeatureIds: [] }),

  setTruncated: (layerId, truncated) =>
    set((state) => {
      const without = state.truncatedLayerIds.filter((id) => id !== layerId)
      return { truncatedLayerIds: truncated ? [...without, layerId] : without }
    }),
}))
