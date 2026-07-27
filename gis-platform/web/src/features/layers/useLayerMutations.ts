import { useMutation, useQueryClient } from '@tanstack/react-query'

import {
  deleteLayer,
  importRaster,
  importVector,
  registerPostgisTable,
  reorderLayers,
  updateLayer,
} from '../../api/layers'
import type { StyleSpec } from '../../api/types'

export function useLayerMutations(projectId: string) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
  }

  const setVisible = useMutation({
    mutationFn: ({ layerId, visible }: { layerId: string; visible: boolean }) =>
      updateLayer(layerId, { visible }),
    onSuccess: invalidate,
  })

  const setOpacity = useMutation({
    mutationFn: ({ layerId, opacity }: { layerId: string; opacity: number }) =>
      updateLayer(layerId, { opacity }),
    onSuccess: invalidate,
  })

  const rename = useMutation({
    mutationFn: ({ layerId, name }: { layerId: string; name: string }) =>
      updateLayer(layerId, { name }),
    onSuccess: invalidate,
  })

  const setStyle = useMutation({
    mutationFn: ({ layerId, style }: { layerId: string; style: StyleSpec }) =>
      updateLayer(layerId, { style }),
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: (layerId: string) => deleteLayer(layerId),
    onSuccess: invalidate,
  })

  const reorder = useMutation({
    mutationFn: (layerIds: string[]) => reorderLayers(projectId, layerIds),
    onSuccess: invalidate,
  })

  const importFile = useMutation({
    mutationFn: ({ file, name }: { file: File; name?: string }) => {
      const isRaster = /\.(tif|tiff|vrt|img|jp2)$/i.test(file.name)
      return isRaster ? importRaster(projectId, file, name) : importVector(projectId, file, name)
    },
    onSuccess: invalidate,
  })

  const addPostgisTable = useMutation({
    mutationFn: (body: {
      schemaName: string
      tableName: string
      geometryColumn: string
      idColumn: string
      name: string
    }) => registerPostgisTable(projectId, body),
    onSuccess: invalidate,
  })

  return { setVisible, setOpacity, rename, setStyle, remove, reorder, importFile, addPostgisTable }
}
