import { useState, useSyncExternalStore } from 'react'
import { MOTION_STORAGE_KEY } from './motionConfig'

const QUERY = '(prefers-reduced-motion: reduce)'
function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(QUERY)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}
function snapshot() {
  return window.matchMedia?.(QUERY).matches ?? false
}
function loadPreference() {
  try {
    return localStorage.getItem(MOTION_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function useReducedMotion() {
  const systemReduced = useSyncExternalStore(subscribe, snapshot, () => false)
  const [manualReduced, setManualReduced] = useState(loadPreference)
  function toggle() {
    const next = !manualReduced
    setManualReduced(next)
    try {
      localStorage.setItem(MOTION_STORAGE_KEY, String(next))
    } catch {
      /* Preference still works for this session. */
    }
  }
  return { reducedMotion: systemReduced || manualReduced, manualReduced, systemReduced, toggle }
}
