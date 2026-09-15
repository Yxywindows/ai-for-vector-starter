import { createContext, useContext, useEffect, useReducer, useRef } from 'react'
import type { Dispatch, MouseEvent } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router'
import { Monogram } from '../app/BrandMark'
import { experienceReducer, initialExperienceState } from './experienceReducer'
import type { ExperienceEvent, ExperienceState } from './experienceReducer'
import { FEATURES, getFeature, isWorkspacePath } from './featureRegistry'
import type { FeatureId } from './featureRegistry'
import { MOTION } from './motionConfig'
import { useReducedMotion } from './useReducedMotion'
import { ExperienceStage } from './ui/ExperienceStage'
import { FeatureIcon } from './ui/FeatureIcon'
import './experience.css'

interface ExperienceContextValue {
  state: ExperienceState
  dispatch: Dispatch<ExperienceEvent>
  reducedMotion: boolean
}
const ExperienceContext = createContext<ExperienceContextValue | null>(null)

function readLastProject(): string | null {
  try {
    return localStorage.getItem('graticule:lastProject') || null
  } catch {
    return null
  }
}

/** The later scene reads presentation state here; business data stays with Router/Query. */
export function useExperience() {
  const context = useContext(ExperienceContext)
  if (!context) throw new Error('useExperience requires ExperienceRoot')
  return context
}

export function isPlainNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!event.currentTarget.target || event.currentTarget.target === '_self')
  )
}

export function ExperienceRoot() {
  const location = useLocation()
  const navigate = useNavigate()
  const route = { key: location.key, pathname: location.pathname }
  const [state, dispatch] = useReducer(experienceReducer, route, initialExperienceState)
  // Reconcile before rendering children, without keying/remounting Outlet.
  if (state.route.key !== route.key || state.route.pathname !== route.pathname) {
    dispatch({ type: 'ROUTE_CHANGED', route })
  }
  const { reducedMotion, manualReduced, systemReduced, toggle } = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const navigatedTransition = useRef<string | null>(null)
  const home = location.pathname === '/'
  const workspace = isWorkspacePath(location.pathname)
  const selected = state.selectedFeature ? getFeature(state.selectedFeature) : null
  const lastProject = readLastProject()

  useEffect(() => {
    const duration =
      state.phase === 'focusing'
        ? MOTION.focusMs
        : state.phase === 'expanding'
          ? MOTION.expandMs
          : state.phase === 'returning' && home
            ? MOTION.returnMs
            : null
    if (duration === null) return
    const timer = window.setTimeout(
      () => dispatch({ type: 'FINISH', transitionId: state.transitionId }),
      reducedMotion ? 0 : duration,
    )
    return () => window.clearTimeout(timer)
  }, [state.phase, state.transitionId, home, reducedMotion])

  useEffect(() => {
    if (!home || state.phase !== 'navigating' || !state.selectedFeature) return
    const token = `${state.route.key}:${state.transitionId}`
    if (navigatedTransition.current === token) return
    navigatedTransition.current = token
    void navigate(getFeature(state.selectedFeature).href)
  }, [home, state.phase, state.selectedFeature, state.route.key, state.transitionId, navigate])

  useEffect(() => {
    if (!home || state.phase === 'idle') return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')
      )
        return
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      dispatch({ type: 'CANCEL' })
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [home, state.phase])

  useEffect(() => {
    if (home && state.phase === 'idle' && state.returnFocus) {
      rootRef.current
        ?.querySelector<HTMLAnchorElement>(`[data-feature-id="${state.returnFocus}"]`)
        ?.focus()
    }
  }, [home, state.phase, state.returnFocus])

  useEffect(() => {
    if (home || workspace) return
    const heading = rootRef.current?.querySelector<HTMLElement>('.platform__content h1')
    const target = heading ?? rootRef.current?.querySelector<HTMLElement>('.platform__content')
    if (target) {
      target.tabIndex = -1
      target.focus({ preventScroll: true })
    }
  }, [location.pathname, home, workspace])

  function selectFeature(event: MouseEvent<HTMLAnchorElement>, feature: FeatureId) {
    if (!home || !isPlainNavigation(event)) return
    event.preventDefault()
    dispatch({ type: 'SELECT', feature, reduced: reducedMotion })
  }
  function expand(event: MouseEvent<HTMLAnchorElement>) {
    if (!isPlainNavigation(event)) return
    event.preventDefault()
    dispatch({ type: 'EXPAND', reduced: reducedMotion })
  }
  function returnHome(event: MouseEvent<HTMLAnchorElement>) {
    if (!isPlainNavigation(event)) return
    if (home) {
      event.preventDefault()
      dispatch({ type: 'CANCEL' })
    } else {
      dispatch({ type: 'RETURN' })
    }
  }

  return (
    <ExperienceContext.Provider value={{ state, dispatch, reducedMotion }}>
      <div
        ref={rootRef}
        className="experience"
        data-mode={workspace ? 'workspace' : home ? 'stage' : 'platform'}
        data-phase={state.phase}
        data-reduced-motion={reducedMotion}
      >
        {!workspace && (
          <>
            <header className="experience__topbar">
              <Link
                to="/"
                className="experience__brand"
                onClick={returnHome}
                aria-label="返回主舞台"
              >
                <span className="experience__brand-mark">
                  <Monogram />
                </span>
                <span className="experience__brand-copy">
                  <span className="experience__brand-name">小G · 空间探索</span>
                  <span className="experience__brand-subtitle">GRATICULE</span>
                </span>
              </Link>
              <div className="experience__tools">
                {lastProject && (
                  <Link
                    className="experience__home"
                    to={`/projects/${encodeURIComponent(lastProject)}/map`}
                  >
                    地图工作区
                  </Link>
                )}
                {!home && (
                  <Link to="/" className="experience__home" onClick={returnHome}>
                    返回主舞台
                  </Link>
                )}
                <button
                  type="button"
                  className="experience__motion"
                  onClick={toggle}
                  aria-pressed={manualReduced || systemReduced}
                  disabled={systemReduced}
                  title={systemReduced ? '已遵循系统的减少动态设置' : '减少持续运动与页面转场'}
                >
                  {systemReduced
                    ? '减少动态 · 跟随系统'
                    : reducedMotion
                      ? '减少动态 · 已开启'
                      : '减少动态'}
                </button>
              </div>
            </header>
            <nav className="experience__rail" aria-label="主导航">
              {FEATURES.map((feature, index) => (
                <Link
                  key={feature.id}
                  to={feature.href}
                  className="experience__nav"
                  data-feature-id={feature.id}
                  data-selected={selected?.id === feature.id}
                  aria-current={!home && selected?.id === feature.id ? 'page' : undefined}
                  onClick={(event) => selectFeature(event, feature.id)}
                >
                  <span className="experience__nav-index" aria-hidden="true">
                    0{index + 1}
                  </span>
                  <FeatureIcon id={feature.id} />
                  <span className="experience__nav-label">{feature.label}</span>
                </Link>
              ))}
            </nav>
          </>
        )}
        <div className="experience__content">
          {home && (
            <ExperienceStage
              feature={selected}
              phase={state.phase}
              onExpand={expand}
              onCancel={() => dispatch({ type: 'CANCEL' })}
            />
          )}
          <Outlet />
        </div>
      </div>
    </ExperienceContext.Provider>
  )
}
