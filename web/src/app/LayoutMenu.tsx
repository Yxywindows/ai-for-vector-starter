import { useEffect, useRef, useState } from 'react'

import {
  DEFAULT_LAYOUT,
  deletePreset,
  listPresets,
  savePreset,
  type LayoutPreset,
  type WorkspaceLayout,
} from './workspaceLayout'

interface LayoutMenuProps {
  projectId: string
  layout: WorkspaceLayout
  onApply: (layout: WorkspaceLayout) => void
}

/**
 * Named workspace layouts (R9). Save the current arrangement under a
 * name — for this project or for every project — apply one later,
 * delete the stale ones, or reset to the built-in default.
 */
export function LayoutMenu({ projectId, layout, onApply }: LayoutMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [presets, setPresets] = useState<LayoutPreset[]>([])
  const [name, setName] = useState('')
  const [global, setGlobal] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const openMenu = () => {
    setPresets(listPresets(projectId))
    setMenuOpen((current) => !current)
  }

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [menuOpen])

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    savePreset(projectId, trimmed, global ? 'global' : 'project', layout)
    setPresets(listPresets(projectId))
    setName('')
  }

  const remove = (preset: LayoutPreset) => {
    deletePreset(projectId, preset)
    setPresets(listPresets(projectId))
  }

  return (
    <div className="layout-menu" ref={rootRef}>
      <button
        type="button"
        className="icon-btn layout-menu__trigger"
        aria-haspopup="true"
        aria-expanded={menuOpen}
        aria-label="Workspace layouts"
        title="Workspace layouts"
        onClick={openMenu}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" />
          <line x1="5.5" y1="2" x2="5.5" y2="12" stroke="currentColor" />
          <line x1="5.5" y1="7.5" x2="12.5" y2="7.5" stroke="currentColor" />
        </svg>
      </button>

      {menuOpen ? (
        <div className="layout-menu__popover" role="dialog" aria-label="Workspace layouts">
          {presets.length === 0 ? (
            <p className="layout-menu__empty">No saved layouts yet.</p>
          ) : (
            <ul className="layout-menu__list">
              {presets.map((preset) => (
                <li key={`${preset.scope}:${preset.id}`} className="layout-menu__row">
                  <button
                    type="button"
                    className="layout-menu__apply"
                    onClick={() => {
                      onApply({ ...DEFAULT_LAYOUT, ...preset.layout })
                      setMenuOpen(false)
                    }}
                  >
                    {preset.name}
                    {preset.scope === 'global' ? (
                      <span className="layout-menu__scope">all projects</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--panel"
                    aria-label={`Delete layout ${preset.name}`}
                    title="Delete"
                    onClick={() => remove(preset)}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2.5 2.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="layout-menu__save"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <input
              type="text"
              aria-label="Layout name"
              placeholder="Save current as…"
              maxLength={40}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <label className="layout-menu__global">
              <input
                type="checkbox"
                checked={global}
                onChange={(event) => setGlobal(event.target.checked)}
              />
              all projects
            </label>
            <button type="submit" disabled={!name.trim()}>
              Save
            </button>
          </form>

          <button
            type="button"
            className="layout-menu__reset"
            onClick={() => {
              onApply({ ...DEFAULT_LAYOUT })
              setMenuOpen(false)
            }}
          >
            Reset to default layout
          </button>
        </div>
      ) : null}
    </div>
  )
}
