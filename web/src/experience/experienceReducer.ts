import { featureForPath } from './featureRegistry'
import type { FeatureId } from './featureRegistry'

export type ExperiencePhase =
  'idle' | 'focusing' | 'preview' | 'expanding' | 'navigating' | 'active' | 'returning'
export interface RouteSnapshot {
  key: string
  pathname: string
}
export interface ExperienceState {
  route: RouteSnapshot
  phase: ExperiencePhase
  selectedFeature: FeatureId | null
  transitionId: number
  returnFocus: FeatureId | null
}
export type ExperienceEvent =
  | { type: 'ROUTE_CHANGED'; route: RouteSnapshot }
  | { type: 'SELECT'; feature: FeatureId; reduced: boolean }
  | { type: 'EXPAND'; reduced: boolean }
  | { type: 'CANCEL' }
  | { type: 'RETURN' }
  | { type: 'FINISH'; transitionId: number }

export function initialExperienceState(route: RouteSnapshot): ExperienceState {
  return {
    route,
    phase: route.pathname === '/' ? 'idle' : 'active',
    selectedFeature: featureForPath(route.pathname)?.id ?? null,
    transitionId: 0,
    returnFocus: null,
  }
}

export function experienceReducer(state: ExperienceState, event: ExperienceEvent): ExperienceState {
  switch (event.type) {
    case 'ROUTE_CHANGED': {
      if (event.route.key === state.route.key && event.route.pathname === state.route.pathname)
        return state
      const home = event.route.pathname === '/'
      return {
        ...state,
        route: event.route,
        phase: home ? (state.phase === 'returning' ? 'returning' : 'idle') : 'active',
        selectedFeature: home ? null : (featureForPath(event.route.pathname)?.id ?? null),
        returnFocus: home ? (state.selectedFeature ?? state.returnFocus) : null,
        transitionId: state.transitionId + 1,
      }
    }
    case 'SELECT':
      if (state.route.pathname !== '/') return state
      return {
        ...state,
        selectedFeature: event.feature,
        returnFocus: event.feature,
        phase: event.reduced ? 'preview' : 'focusing',
        transitionId: state.transitionId + 1,
      }
    case 'EXPAND':
      if (state.phase !== 'preview' || !state.selectedFeature) return state
      return {
        ...state,
        phase: event.reduced ? 'navigating' : 'expanding',
        transitionId: state.transitionId + 1,
      }
    case 'CANCEL':
      if (state.route.pathname !== '/' || state.phase === 'idle') return state
      return {
        ...state,
        phase: 'idle',
        selectedFeature: null,
        transitionId: state.transitionId + 1,
      }
    case 'RETURN':
      return {
        ...state,
        phase: 'returning',
        returnFocus: state.selectedFeature,
        transitionId: state.transitionId + 1,
      }
    case 'FINISH':
      if (event.transitionId !== state.transitionId) return state
      if (state.phase === 'focusing') return { ...state, phase: 'preview' }
      if (state.phase === 'expanding') return { ...state, phase: 'navigating' }
      if (state.phase === 'returning' && state.route.pathname === '/')
        return { ...state, phase: 'idle' }
      return state
  }
}
