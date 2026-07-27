export function moveItem<T>(items: T[], from: number, to: number): T[] {
  const last = items.length - 1
  const source = Math.min(Math.max(from, 0), last)
  const target = Math.min(Math.max(to, 0), last)
  if (source === target) return [...items]

  const next = [...items]
  const [moved] = next.splice(source, 1)
  next.splice(target, 0, moved as T)
  return next
}
