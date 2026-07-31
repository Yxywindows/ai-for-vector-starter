/**
 * The editable attribute table for an import draft.
 *
 * ag-grid Community supplies virtualisation, sorting, filtering and column
 * resizing. Everything policy-shaped -- what an empty cell means, how a
 * nested value is edited, which values refuse to commit -- lives here, so it
 * matches the server's rules rather than the grid's defaults.
 *
 * This does not replace `features/attributes/AttributeTable.tsx`, which serves
 * persisted layers. Only the draft is rendered here.
 */

import {
  AllCommunityModule,
  type ColDef,
  type ICellRendererParams,
  type IRowNode,
  ModuleRegistry,
  type ValueSetterParams,
} from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { DraftColumn, DraftFeature } from './parseGeoJson'
import { coerceCellInput } from './validation'

ModuleRegistry.registerModules([AllCommunityModule])

export interface DraftGridProps {
  columns: DraftColumn[]
  features: DraftFeature[]
  selectedIds: string[]
  search: string
  /** Keyed `${featureId}:${column}`. */
  cellErrors: Record<string, string>
  onSelectionChange: (ids: string[]) => void
  onCellEdit: (featureId: string, column: string, value: unknown) => void
  onCellError: (featureId: string, column: string, message: string | null) => void
}

interface Row {
  id: string
  properties: Record<string, unknown>
}

/**
 * Stock Community editors, chosen per inferred type. Everything hands back a
 * string (or a boolean) and `valueSetter` does the typing, so there is exactly
 * one place where a value is converted -- and it is the one that mirrors the
 * server.
 */
const EDITORS: Record<DraftColumn['type'], string> = {
  text: 'agTextCellEditor',
  number: 'agTextCellEditor',
  date: 'agTextCellEditor',
  boolean: 'agCheckboxCellEditor',
  json: 'agLargeTextCellEditor',
}

/** Display text for a cell. Distinguishes absent (blank) from explicit null. */
function display(value: unknown): string {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Renders a cell's display value.
 *
 * The `data-testid` is set on `params.eGridCell` -- the wrapper ag-grid owns
 * for the lifetime of the cell -- rather than on a node this component
 * renders. ag-grid unmounts the renderer's own markup the moment editing
 * starts (it is replaced by the cell editor), so a testid placed on our own
 * span would vanish mid-edit; `eGridCell` is also the element ag-grid applies
 * `cellClass` to, so this keeps "find the cell" and "read its error class"
 * pointed at the same node.
 */
function DraftCell({ params, testId }: { params: ICellRendererParams<Row>; testId: string }) {
  useEffect(() => {
    params.eGridCell.setAttribute('data-testid', testId)
  }, [params.eGridCell, testId])
  return <>{display(params.value)}</>
}

export function DraftGrid({
  columns,
  features,
  selectedIds,
  search,
  cellErrors,
  onSelectionChange,
  onCellEdit,
  onCellError,
}: DraftGridProps) {
  const gridRef = useRef<AgGridReact<Row>>(null)

  const rows = useMemo<Row[]>(
    () => features.map((feature) => ({ id: feature.id, properties: feature.properties })),
    [features],
  )

  const buildSetter = useCallback(
    (column: DraftColumn) => (params: ValueSetterParams<Row>) => {
      const raw = params.newValue
      const text = raw === null || raw === undefined ? '' : String(raw)
      const outcome =
        column.type === 'json' && typeof raw === 'object' && raw !== null
          ? { ok: true as const, value: raw }
          : coerceCellInput(text, column.type)

      if (!outcome.ok) {
        onCellError(params.data.id, column.name, outcome.message)
        return false // ag-grid keeps the prior value
      }
      onCellError(params.data.id, column.name, null)
      onCellEdit(params.data.id, column.name, outcome.value)
      return true
    },
    [onCellEdit, onCellError],
  )

  const columnDefs = useMemo<ColDef<Row>[]>(() => {
    const checkbox: ColDef<Row> = {
      colId: '__select__',
      headerName: '',
      width: 44,
      pinned: 'left',
      checkboxSelection: true,
      headerCheckboxSelection: true,
      sortable: false,
      filter: false,
      resizable: false,
      editable: false,
    }

    const rest = columns.map<ColDef<Row>>((column) => ({
      colId: column.name,
      headerName: column.mixed ? `${column.name} (mixed)` : column.name,
      field: `properties.${column.name}` as never,
      flex: 1,
      minWidth: 140,
      sortable: true,
      filter: true,
      resizable: true,
      editable: true,
      cellEditor: EDITORS[column.type],
      // Deliberately NOT `cellEditorPopup: true`. A popup editor is a
      // portal ag-grid appends to `popupParent` (here, document.body) --
      // outside the cell's own DOM subtree, by design, so it can escape a
      // scrolling/overflow-clipped grid body. `agLargeTextCellEditor` still
      // renders the textarea the spec wants either way; keeping it inline
      // means the editor stays a descendant of the cell, which is what lets
      // callers (including this component's own tests) find "the editor for
      // this cell" by querying within the cell.
      // useFormatter makes the editor open on `display(value)` -- compact JSON
      // -- instead of "[object Object]", which is what a raw object stringifies to.
      cellEditorParams:
        column.type === 'json'
          ? { useFormatter: true, maxLength: 100_000, rows: 8, cols: 60 }
          : undefined,
      valueGetter: (params) => params.data?.properties[column.name],
      valueFormatter: (params) => display(params.value),
      valueSetter: buildSetter(column),
      cellClass: (params) =>
        cellErrors[`${params.data?.id}:${column.name}`]
          ? 'draft-grid__cell draft-grid__cell--error'
          : 'draft-grid__cell',
      cellRenderer: (params: ICellRendererParams<Row>) => (
        <DraftCell params={params} testId={`cell-${params.data?.id}-${column.name}`} />
      ),
      tooltipValueGetter: (params) => cellErrors[`${params.data?.id}:${column.name}`] ?? undefined,
    }))

    return [checkbox, ...rest]
  }, [columns, cellErrors, buildSetter])

  const handleSelection = useCallback(() => {
    const selected = gridRef.current?.api.getSelectedRows() ?? []
    onSelectionChange(selected.map((row) => row.id))
  }, [onSelectionChange])

  // Keeps the grid's selection in sync with the controlled `selectedIds`
  // prop. A checkbox click flows *out* through `onSelectionChange`; this
  // effect is the reverse direction -- an external change to `selectedIds`
  // (a "select all" action elsewhere, an undo, ...) that the grid did not
  // originate. It only touches nodes whose selection state actually differs
  // from what the prop asks for, so the `selectionChanged` event this
  // provokes reports back exactly `selectedIds`; the next run of this effect
  // then finds nothing left to change and does not call the API again --
  // this is what keeps it from looping under StrictMode's double-invoked
  // effects or a parent that re-renders with a new-but-equal array.
  useEffect(() => {
    const api = gridRef.current?.api
    if (!api) return
    const wanted = new Set(selectedIds)
    const toSelect: IRowNode<Row>[] = []
    const toDeselect: IRowNode<Row>[] = []
    api.forEachNode((node) => {
      const shouldBeSelected = node.data ? wanted.has(node.data.id) : false
      if (shouldBeSelected !== node.isSelected()) {
        ;(shouldBeSelected ? toSelect : toDeselect).push(node)
      }
    })
    if (toSelect.length > 0) api.setNodesSelected({ nodes: toSelect, newValue: true })
    if (toDeselect.length > 0) api.setNodesSelected({ nodes: toDeselect, newValue: false })
  }, [selectedIds, rows])

  return (
    <div className="draft-grid">
      <AgGridReact<Row>
        ref={gridRef}
        rowData={rows}
        columnDefs={columnDefs}
        getRowId={(params) => params.data.id}
        quickFilterText={search}
        rowSelection={{ mode: 'multiRow' }}
        onSelectionChanged={handleSelection}
        stopEditingWhenCellsLoseFocus
        // Virtualisation is ag-grid's default; stated here so it is not
        // silently disabled by a future config change.
        suppressColumnVirtualisation={false}
        domLayout="normal"
        // Anchor popups (e.g. a column's filter menu) to the document body
        // instead of the grid's own wrapper. This is ag-grid's own
        // recommended fix for popups getting clipped by a scrollable/
        // overflow-hidden ancestor -- this grid sits inside exactly that
        // kind of panel layout. It also sidesteps a jsdom gap: jsdom's
        // `offsetParent` always returns null (layout is unimplemented), and
        // ag-grid's popup positioning falls back to `popupParent.offsetParent`
        // whenever the parent's computed `position` isn't already
        // non-static, which crashes under test unless the parent is `body`.
        popupParent={document.body}
      />
    </div>
  )
}
