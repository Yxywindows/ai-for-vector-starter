import type { ImageTile } from 'ol'
import type { FeatureLike } from 'ol/Feature'
import type VectorTile from 'ol/VectorTile'
import type { Extent } from 'ol/extent'
import type Projection from 'ol/proj/Projection'
import type VectorTileSource from 'ol/source/VectorTile'
import type XYZ from 'ol/source/XYZ'

import type { LayerMemoryManager } from './LayerMemoryManager'

/**
 * Replace a raster source's tile loader with one that fetches the PNG itself,
 * measures the blob, and hands the bytes to the tile via an object URL. The
 * default loader sets `img.src` directly, which gives no size information at
 * all — this is the only place the real byte count is observable.
 */
export function instrumentTileSource(
  source: XYZ,
  layerId: string,
  manager: LayerMemoryManager,
): void {
  source.setTileLoadFunction((tile, src) => {
    const image = (tile as ImageTile).getImage() as HTMLImageElement
    fetch(src)
      .then((response) => (response.ok ? response.blob() : Promise.reject(response.status)))
      .then((blob) => {
        manager.record(layerId, blob.size)
        const objectUrl = URL.createObjectURL(blob)
        image.onload = () => URL.revokeObjectURL(objectUrl)
        image.onerror = () => URL.revokeObjectURL(objectUrl)
        image.src = objectUrl
      })
      .catch(() => {
        // A 204 (empty tile) or a network failure: leave the tile blank.
        image.src = ''
      })
  })
}

/** Same idea for MVT: measure the protobuf before handing it to the format. */
export function instrumentVectorTileSource(
  source: VectorTileSource,
  layerId: string,
  manager: LayerMemoryManager,
): void {
  source.setTileLoadFunction((tile, url) => {
    const vectorTile = tile as VectorTile<FeatureLike>
    vectorTile.setLoader((extent: Extent, _resolution: number, projection: Projection) => {
      fetch(url)
        .then((response) =>
          response.ok ? response.arrayBuffer() : Promise.reject(response.status),
        )
        .then((buffer) => {
          manager.record(layerId, buffer.byteLength)
          const format = vectorTile.getFormat()
          vectorTile.setFeatures(
            format.readFeatures(buffer, { extent, featureProjection: projection }),
          )
        })
        .catch(() => vectorTile.setFeatures([]))
    })
  })
}
