/**
 * Workspace layout persistence (IA plan §7, extended in R9): which panels
 * are open, how large, which side they dock on or where they float — per
 * project, in localStorage — plus named layout presets, per project or
 * global. Tier 3 (server-side layouts) swaps the storage behind these
 * functions without touching callers.
 */

export type PanelSide = 'left' | 'right'
export type DockablePanel = 'sidebar' | 'inspector'

export interface FloatPosition {
  x: number
  y: number
}

export interface WorkspaceLayout {
  sidebarOpen: boolean
  inspectorOpen: boolean
  tableOpen: boolean
  sidebarWidth?: number
  inspectorWidth?: number
  drawerHeight?: number
  /** R9: which side a panel docks on. Absent = its default side. */
  sidebarSide?: PanelSide
  inspectorSide?: PanelSide
  /** R9: free-floating position over the map; null/absent = docked. */
  sidebarFloat?: FloatPosition | null
  inspectorFloat?: FloatPosition | null
}

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  sidebarOpen: true,
  inspectorOpen: true,
  tableOpen: false,
}

export const DEFAULT_SIDES: Record<DockablePanel, PanelSide> = {
  sidebar: 'left',
  inspector: 'right',
}

const storageKey = (projectId: string) => `graticule:layout:${projectId}`

export function loadLayout(projectId: string): WorkspaceLayout {
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return { ...DEFAULT_LAYOUT }
    const parsed = JSON.parse(raw) as Partial<WorkspaceLayout>
    return { ...DEFAULT_LAYOUT, ...parsed }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export function saveLayout(projectId: string, layout: WorkspaceLayout): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(layout))
  } catch {
    // Storage full or blocked: layout simply won't persist this session.
  }
}

/** Keep a floating panel reachable: its header must stay inside the stage. */
export function clampFloat(
  position: FloatPosition,
  stage: { width: number; height: number },
  panelWidth: number,
): FloatPosition {
  const margin = 48
  return {
    x: Math.min(Math.max(position.x, margin - panelWidth), Math.max(0, stage.width - margin)),
    y: Math.min(Math.max(position.y, 0), Math.max(0, stage.height - margin)),
  }
}

/* ============================================================
   Named layout presets (R9)
   ============================================================ */

export type PresetScope = 'project' | 'global'

export interface LayoutPreset {
  id: string
  name: string
  scope: PresetScope
  layout: WorkspaceLayout
  savedAt: string
}

const GLOBAL_PRESETS_KEY = 'graticule:layout-presets:global'
const presetsKey = (projectId: string, scope: PresetScope) =>
  scope === 'global' ? GLOBAL_PRESETS_KEY : `graticule:layout-presets:${projectId}`

function readPresets(key: string): LayoutPreset[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is LayoutPreset =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as LayoutPreset).id === 'string' &&
        typeof (entry as LayoutPreset).name === 'string' &&
        typeof (entry as LayoutPreset).layout === 'object',
    )
  } catch {
    return []
  }
}

function writePresets(key: string, presets: LayoutPreset[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(presets))
  } catch {
    // Storage full or blocked: the preset simply won't persist.
  }
}

/** Project presets first, then global ones, each alphabetical. */
export function listPresets(projectId: string): LayoutPreset[] {
  const byName = (a: LayoutPreset, b: LayoutPreset) => a.name.localeCompare(b.name)
  return [
    ...readPresets(presetsKey(projectId, 'project')).sort(byName),
    ...readPresets(GLOBAL_PRESETS_KEY).sort(byName),
  ]
}

/** Create — or update, when a preset of the same name exists in the scope. */
export function savePreset(
  projectId: string,
  name: string,
  scope: PresetScope,
  layout: WorkspaceLayout,
): LayoutPreset {
  const key = presetsKey(projectId, scope)
  const existing = readPresets(key)
  const match = existing.find((preset) => preset.name === name)
  const preset: LayoutPreset = {
    id: match?.id ?? crypto.randomUUID(),
    name,
    scope,
    layout: { ...layout },
    savedAt: new Date().toISOString(),
  }
  writePresets(key, [...existing.filter((entry) => entry.name !== name), preset])
  return preset
}

export function deletePreset(projectId: string, preset: LayoutPreset): void {
  const key = presetsKey(projectId, preset.scope)
  writePresets(
    key,
    readPresets(key).filter((entry) => entry.id !== preset.id),
  )
}
