import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { deleteFeature, getAttributes, getFields, updateFeature } from '../../api/features'
import type { AttributeFilter } from '../../api/types'

const PAGE_SIZE = 50

export function useAttributes(layerId: string | null) {
  const queryClient = useQueryClient()
  const [pageNumber, setPage] = useState(1)
  const [sortBy, setSortBy] = useState<string | undefined>()
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')
  const [filters, setFilters] = useState<AttributeFilter[]>([])

  const fields = useQuery({
    queryKey: ['fields', layerId],
    queryFn: () => getFields(layerId!),
    enabled: Boolean(layerId),
  })

  const attributesKey = ['attributes', layerId, pageNumber, sortBy, sortOrder, filters] as const
  const page = useQuery({
    queryKey: attributesKey,
    queryFn: () =>
      getAttributes(layerId!, {
        page: pageNumber,
        pageSize: PAGE_SIZE,
        sortBy,
        sortOrder,
        filters,
      }),
    enabled: Boolean(layerId),
    // Keep showing the previous page while a sort/page change refetches, so
    // the table never unmounts (and never flashes empty) between pages.
    placeholderData: keepPreviousData,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['attributes', layerId] })
  }

  const saveCell = useMutation({
    mutationFn: ({
      featureId,
      column,
      value,
    }: {
      featureId: string
      column: string
      value: unknown
    }) => updateFeature(layerId!, featureId, { properties: { [column]: value } }),
    onSuccess: invalidate,
  })

  const removeRow = useMutation({
    mutationFn: (featureId: string) => deleteFeature(layerId!, featureId),
    onSuccess: invalidate,
  })

  const setSort = (column: string) => {
    if (column === sortBy) {
      setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(column)
      setSortOrder('asc')
    }
    setPage(1)
  }

  return {
    fields: fields.data,
    page: page.data,
    isLoading: fields.isLoading || page.isLoading,
    error: (fields.error ?? page.error) as Error | null,
    pageNumber,
    pageSize: PAGE_SIZE,
    sortBy,
    sortOrder,
    setPage,
    setSort,
    setFilters,
    saveCell,
    removeRow,
  }
}
