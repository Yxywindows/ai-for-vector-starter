import { useEffect, useRef, useState } from 'react'

import { useMap } from '../MapProvider'
import { applyMapboxBasemap, releaseMapboxBasemap } from './mapboxLayer'
import { MAPBOX_THEMES, getMapboxToken, themeById, type BasemapTheme } from './themes'

/** Bridges the chosen theme into the OpenLayers map, and out again. */
export function MapboxBasemap({
  themeId,
  onBroken,
}: {
  themeId: string | null
  onBroken: (theme: BasemapTheme) => void
}) {
  const map = useMap()
  const token = getMapboxToken()

  useEffect(() => {
    if (!map) return
    applyMapboxBasemap(map, themeById(themeId), token, { onBroken })
  }, [map, themeId, token, onBroken])

  // Leaving the workspace releases the tiles with the layer (§R10).
  useEffect(() => {
    if (!map) return
    return () => releaseMapboxBasemap(map)
  }, [map])

  return null
}

function Swatch({ theme }: { theme: BasemapTheme }) {
  const [ground, water, accent] = theme.preview
  return (
    <span className="basemap-swatch" aria-hidden="true" style={{ filter: theme.filter }}>
      <span style={{ background: ground }} />
      <span style={{ background: water }} />
      <span style={{ background: accent }} />
    </span>
  )
}

interface BasemapSelectorProps {
  value: string | null
  onChange: (themeId: string | null) => void
  /** A broken-theme note to show until the next choice. */
  notice?: string | null
}

/**
 * Compact collapsible basemap picker (R10), floating over the map.
 * Collapsed it names the current theme; expanded it offers the project
 * basemap plus the eight Mapbox themes. Without a token the Mapbox rows
 * stay visible but disabled, saying exactly what is missing.
 */
export function BasemapSelector({ value, onChange, notice }: BasemapSelectorProps) {
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const token = getMapboxToken()
  const current = themeById(value)

  useEffect(() => {
    if (!expanded) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [expanded])

  const choose = (themeId: string | null) => {
    onChange(themeId)
    setExpanded(false)
  }

  return (
    <div className="basemap-selector" ref={rootRef}>
      {expanded ? (
        <div className="basemap-selector__panel" role="dialog" aria-label="Basemap themes">
          <button
            type="button"
            className="basemap-selector__option"
            aria-pressed={value === null}
            onClick={() => choose(null)}
          >
            <span className="basemap-swatch" aria-hidden="true">
              <span style={{ background: 'var(--panel-raised)' }} />
              <span style={{ background: 'var(--line)' }} />
              <span style={{ background: 'var(--ink-faint)' }} />
            </span>
            <span className="basemap-selector__name">Project basemap</span>
          </button>

          {MAPBOX_THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className="basemap-selector__option"
              aria-pressed={value === theme.id}
              disabled={!token}
              title={theme.description}
              onClick={() => choose(theme.id)}
            >
              <Swatch theme={theme} />
              <span className="basemap-selector__name">{theme.name}</span>
            </button>
          ))}

          {!token ? (
            <p className="basemap-selector__note">
              Mapbox themes need <code>VITE_MAPBOX_ACCESS_TOKEN</code> in{' '}
              <code>web/.env.local</code>.
            </p>
          ) : null}
          {notice ? (
            <p className="basemap-selector__note" role="status">
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        className="basemap-selector__trigger"
        aria-haspopup="true"
        aria-expanded={expanded}
        aria-label="Basemap"
        title="Basemap"
        onClick={() => setExpanded((open) => !open)}
      >
        {current ? <Swatch theme={current} /> : null}
        <span>{current ? current.name : 'Basemap'}</span>
      </button>
    </div>
  )
}
