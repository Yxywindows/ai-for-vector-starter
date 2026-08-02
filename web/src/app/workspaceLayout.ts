/**
 * Workspace layout persistence (IA plan §7): which panels are open and how
 * large, per project, in localStorage. Tier 3 (server-side layouts) swaps
 * the storage behind these two functions without touching callers.
 */

export interface WorkspaceLayout {
  sidebarOpen: boolean
  inspectorOpen: boolean
  tableOpen: boolean
  sidebarWidth?: number
  inspectorWidth?: number
  drawerHeight?: number
}

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  sidebarOpen: true,
  inspectorOpen: true,
  tableOpen: false,
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
