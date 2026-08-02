/**
 * The draft's own OpenLayers map.
 *
 * A second Map instance rather than the app's: the draft has no layer id, so
 * it cannot participate in layerStore, featureLoader or the memory manager,
 * all of which key on a persisted layer. Isolation is also what makes cancel
 * free -- nothing to unwind on the main map.
 *
 * A malformed geometry is skipped rather than thrown: one bad feature must not
 * blank the preview the user needs in order to find and fix it.
 */

import type Feature from 'ol/Feature'
import OlMap from 'ol/Map'
import View from 'ol/View'
import GeoJSON from 'ol/format/GeoJSON'
import VectorLayer from 'ol/layer/Vector'
import { fromLonLat } from 'ol/proj'
import VectorSource from 'ol/source/Vector'
import { Circle, Fill, Stroke, Style } from 'ol/style'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { DraftFeature } from './parseGeoJson'

const FEATURE_ID = 'draftId'

/* Theme colors (bathymetric teal / contour brown), mirrored from index.css. */
const BASE_STYLE = new Style({
  image: new Circle({ radius: 5, fill: new Fill({ color: '#16655a' }) }),
  stroke: new Stroke({ color: '#16655a', width: 2 }),
  fill: new Fill({ color: 'rgba(22, 101, 90, 0.15)' }),
})

const SELECTED_STYLE = new Style({
  image: new Circle({
    radius: 7,
    fill: new Fill({ color: '#9a5b22' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
  stroke: new Stroke({ color: '#9a5b22', width: 3 }),
  fill: new Fill({ color: 'rgba(154, 91, 34, 0.2)' }),
})

interface PreviewMapProps {
  features: DraftFeature[]
  selectedIds: string[]
  maxRendered: number
  onSelect: (featureIds: string[]) => void
}

export function PreviewMap({ features, selectedIds, maxRendered, onSelect }: PreviewMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const [map] = useState(
    () => new OlMap({ view: new View({ center: fromLonLat([0, 0]), zoom: 2 }), layers: [] }),
  )
  const sourceRef = useRef(new VectorSource())

  // Selection is read through a ref inside the style function, so the layer is
  // built once instead of being rebuilt on every selection change. The ref is
  // synced in the selection effect below, before the repaint it triggers.
  const selectedIdsRef = useRef(selectedIds)

  const withGeometry = useMemo(
    () => features.filter((feature) => feature.geometry !== null),
    [features],
  )
  const rendered = useMemo(() => withGeometry.slice(0, maxRendered), [withGeometry, maxRendered])

  // Attach the map to its container once the element exists.
  useEffect(() => {
    if (!container.current) return
    map.setTarget(container.current)
    const layer = new VectorLayer({
      source: sourceRef.current,
      style: (feature) =>
        selectedIdsRef.current.includes(String(feature.get(FEATURE_ID)))
          ? SELECTED_STYLE
          : BASE_STYLE,
    })
    map.addLayer(layer)
    return () => {
      map.setTarget(undefined)
      map.removeLayer(layer)
    }
  }, [map])

  useEffect(() => {
    const format = new GeoJSON({ featureProjection: 'EPSG:3857' })
    const source = sourceRef.current
    source.clear()

    const olFeatures: Feature[] = []
    for (const draft of rendered) {
      try {
        const olFeature = format.readFeature({
          type: 'Feature',
          geometry: draft.geometry,
          properties: { [FEATURE_ID]: draft.id },
        }) as Feature
        olFeature.set(FEATURE_ID, draft.id)
        olFeatures.push(olFeature)
      } catch {
        // Malformed geometry: the validation summary already reports it, and
        // skipping keeps the rest of the preview usable.
      }
    }
    source.addFeatures(olFeatures)

    if (olFeatures.length > 0) {
      const extent = source.getExtent()
      if (extent && extent.every(Number.isFinite)) {
        map.getView().fit(extent, { padding: [24, 24, 24, 24], maxZoom: 12, duration: 0 })
      }
    }
  }, [rendered, map])

  // Repaint when selection changes; the style function reads the ref.
  useEffect(() => {
    selectedIdsRef.current = selectedIds
    sourceRef.current.changed()
    if (selectedIds.length === 0) return
    const target = sourceRef.current
      .getFeatures()
      .find((feature) => String(feature.get(FEATURE_ID)) === selectedIds[0])
    const geometry = target?.getGeometry()
    if (geometry) {
      map
        .getView()
        .fit(geometry.getExtent(), { padding: [60, 60, 60, 60], maxZoom: 14, duration: 0 })
    }
  }, [selectedIds, map])

  useEffect(() => {
    const handleClick = (event: { pixel: number[] }) => {
      const hit = map.forEachFeatureAtPixel(event.pixel, (feature) => feature)
      onSelect(hit ? [String((hit as Feature).get(FEATURE_ID))] : [])
    }
    map.on('click', handleClick as never)
    return () => map.un('click', handleClick as never)
  }, [map, onSelect])

  const truncated = withGeometry.length > rendered.length

  return (
    <div className="preview-map">
      <div
        className="preview-map__canvas"
        ref={container}
        role="region"
        aria-label="Import preview map"
      />
      {truncated ? (
        <p className="preview-map__note">
          Showing {rendered.length} of {withGeometry.length} features on the map. All features will
          be imported.
        </p>
      ) : null}
    </div>
  )
}
