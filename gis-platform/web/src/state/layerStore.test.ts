import { beforeEach, describe, expect, it } from 'vitest'

import { useLayerStore } from './layerStore'

const reset = () =>
  useLayerStore.setState({
    projectId: null,
    selectedLayerId: null,
    selectedFeatureIds: [],
    truncatedLayerIds: [],
  })

beforeEach(reset)

describe('layerStore', () => {
  it('selecting a layer clears the feature selection', () => {
    useLayerStore.getState().selectFeatures(['1', '2'])
    useLayerStore.getState().selectLayer('layer-a')
    expect(useLayerStore.getState().selectedLayerId).toBe('layer-a')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual([])
  })

  it('re-selecting the same layer keeps the feature selection', () => {
    useLayerStore.getState().selectLayer('layer-a')
    useLayerStore.getState().selectFeatures(['1'])
    useLayerStore.getState().selectLayer('layer-a')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual(['1'])
  })

  it('toggleFeature adds then removes', () => {
    useLayerStore.getState().toggleFeature('7')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual(['7'])
    useLayerStore.getState().toggleFeature('7')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual([])
  })

  it('setTruncated records and clears per layer without duplicates', () => {
    useLayerStore.getState().setTruncated('a', true)
    useLayerStore.getState().setTruncated('a', true)
    expect(useLayerStore.getState().truncatedLayerIds).toEqual(['a'])
    useLayerStore.getState().setTruncated('a', false)
    expect(useLayerStore.getState().truncatedLayerIds).toEqual([])
  })

  it('clearSelection clears features but keeps the active layer', () => {
    useLayerStore.getState().selectLayer('layer-a')
    useLayerStore.getState().selectFeatures(['1'])
    useLayerStore.getState().clearSelection()
    expect(useLayerStore.getState().selectedLayerId).toBe('layer-a')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual([])
  })
})
