/** T04 uses the same timing contract for the model; T03 supplies DOM-only transitions. */
export const MOTION = {
  focusMs: 550,
  expandMs: 500,
  returnMs: 400,
  idleSpeed: { min: 0.25, max: 0.65, periodSeconds: 8 },
} as const

export const MOTION_STORAGE_KEY = 'graticule:experience:reduce-motion'
