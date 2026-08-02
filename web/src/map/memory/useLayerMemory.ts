import { useCallback, useEffect, useState } from 'react'

import { LayerMemoryManager, type LayerUsage } from './LayerMemoryManager'

const ENFORCE_INTERVAL_MS = 2000

export function useLayerMemory() {
  const [manager] = useState(() => new LayerMemoryManager())

  const [usage, setUsage] = useState<LayerUsage[]>([])
  const [totalBytes, setTotalBytes] = useState(0)

  const refresh = useCallback(() => {
    manager.enforce()
    setUsage(manager.usage())
    setTotalBytes(manager.totalBytes)
  }, [manager])

  useEffect(() => {
    const timer = window.setInterval(refresh, ENFORCE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  return { manager, usage, totalBytes, budgetBytes: manager.budgetBytes, refresh }
}
