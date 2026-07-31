import { useState } from 'react'

import type { ColumnInfo } from '../../api/types'
import { useLayerStore } from '../../state/layerStore'
import { coerceValue, formatValue } from './coerce'
import { useAttributes } from './useAttributes'

interface AttributeTableProps {
  layerId: string | null
}

interface EditingCell {
  featureId: string
  column: string
  draft: string
}

export function AttributeTable({ layerId }: AttributeTableProps) {
  const selectedLayerId = useLayerStore((state) => state.selectedLayerId)
  const effectiveLayerId = layerId ?? selectedLayerId
  const selectFeatures = useLayerStore((state) => state.selectFeatures)
  const selectedFeatureIds = useLayerStore((state) => state.selectedFeatureIds)

  const table = useAttributes(effectiveLayerId)
  const [editing, setEditing] = useState<EditingCell | null>(null)
  const [cellError, setCellError] = useState<string | null>(null)

  if (!effectiveLayerId) {
    return <p className="attribute-table__empty">Select a layer to see its attributes.</p>
  }
  if (table.isLoading) return <p className="attribute-table__empty">Loading…</p>
  if (table.error) return <p role="alert">{table.error.message}</p>
  if (!table.fields || !table.page) return null

  const byName = new globalThis.Map<string, ColumnInfo>(
    table.fields.fields.map((field) => [field.name, field]),
  )
  const idColumn = table.fields.idColumn
  const totalPages = Math.max(1, Math.ceil(table.page.total / table.pageSize))

  const commit = () => {
    if (!editing) return
    const column = byName.get(editing.column)
    if (!column) return
    try {
      const value = coerceValue(editing.draft, column.dataType)
      setCellError(null)
      table.saveCell.mutate({ featureId: editing.featureId, column: editing.column, value })
      setEditing(null)
    } catch (error) {
      setCellError((error as Error).message)
    }
  }

  return (
    <div className="attribute-table">
      <header className="attribute-table__header">
        <span>{table.page.total} features</span>
        <span>
          <button
            type="button"
            disabled={table.pageNumber <= 1}
            onClick={() => table.setPage(table.pageNumber - 1)}
          >
            ‹
          </button>
          Page {table.pageNumber} / {totalPages}
          <button
            type="button"
            disabled={table.pageNumber >= totalPages}
            onClick={() => table.setPage(table.pageNumber + 1)}
          >
            ›
          </button>
        </span>
      </header>

      {cellError ? <p role="alert">{cellError}</p> : null}

      <table>
        <thead>
          <tr>
            {table.page.columns.map((column) => (
              <th
                key={column}
                scope="col"
                onClick={() => table.setSort(column)}
                aria-sort={
                  table.sortBy === column
                    ? table.sortOrder === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                {column}
              </th>
            ))}
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {table.page.rows.map((row) => {
            const featureId = String(row[idColumn])
            const selected = selectedFeatureIds.includes(featureId)
            return (
              <tr
                key={featureId}
                className={selected ? 'is-selected' : undefined}
                onClick={() => selectFeatures([featureId])}
              >
                {table.page!.columns.map((column) => {
                  const isEditing = editing?.featureId === featureId && editing.column === column
                  const editable = byName.get(column)?.editable ?? false
                  return (
                    <td
                      key={column}
                      data-testid={`cell-${featureId}-${column}`}
                      onDoubleClick={() => {
                        if (!editable) return
                        setCellError(null)
                        setEditing({ featureId, column, draft: formatValue(row[column]) })
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          type="text"
                          value={editing.draft}
                          onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
                          onBlur={commit}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commit()
                            if (event.key === 'Escape') {
                              setEditing(null)
                              setCellError(null)
                            }
                          }}
                        />
                      ) : (
                        formatValue(row[column])
                      )}
                    </td>
                  )
                })}
                <td>
                  <button
                    type="button"
                    aria-label={`Delete feature ${featureId}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      table.removeRow.mutate(featureId)
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
