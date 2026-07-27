import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LayerMemoryManager } from './LayerMemoryManager'

let now = 0
const clock = () => now

function makeManager(budgetBytes = 1000) {
  now = 0
  return new LayerMemoryManager({ budgetBytes, clock })
}

beforeEach(() => {
  now = 0
})

describe('LayerMemoryManager', () => {
  it('accumulates bytes per layer', () => {
    const manager = makeManager()
    manager.register('a', vi.fn())
    manager.record('a', 100)
    manager.record('a', 50)
    expect(manager.usage()).toEqual([expect.objectContaining({ layerId: 'a', bytes: 150 })])
    expect(manager.totalBytes).toBe(150)
  })

  it('ignores records for unregistered layers', () => {
    const manager = makeManager()
    manager.record('ghost', 100)
    expect(manager.totalBytes).toBe(0)
  })

  it('does nothing while under budget', () => {
    const manager = makeManager(1000)
    manager.register('a', vi.fn())
    manager.record('a', 400)
    expect(manager.enforce()).toEqual([])
  })

  it('evicts the least recently used layer when over budget', () => {
    const manager = makeManager(1000)
    const onEvictA = vi.fn()
    const onEvictB = vi.fn()
    manager.register('a', onEvictA)
    manager.register('b', onEvictB)

    now = 1
    manager.record('a', 600)
    now = 2
    manager.record('b', 600)

    expect(manager.enforce()).toEqual(['a'])
    expect(onEvictA).toHaveBeenCalledOnce()
    expect(onEvictB).not.toHaveBeenCalled()
    expect(manager.totalBytes).toBe(600)
  })

  it('keeps evicting until it is back under budget', () => {
    const manager = makeManager(500)
    for (const id of ['a', 'b', 'c']) manager.register(id, vi.fn())
    now = 1
    manager.record('a', 300)
    now = 2
    manager.record('b', 300)
    now = 3
    manager.record('c', 300)

    expect(manager.enforce()).toEqual(['a', 'b'])
    expect(manager.totalBytes).toBe(300)
  })

  it('never evicts a pinned layer', () => {
    const manager = makeManager(500)
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    manager.setPinned('a', true)
    now = 1
    manager.record('a', 400)
    now = 2
    manager.record('b', 400)

    expect(manager.enforce()).toEqual(['b'])
    expect(manager.totalBytes).toBe(400)
  })

  it('never evicts the most recently touched layer, even unpinned', () => {
    const manager = makeManager(100)
    manager.register('a', vi.fn())
    now = 1
    manager.record('a', 900)
    expect(manager.enforce()).toEqual([])
  })

  it('stops evicting when only pinned layers remain', () => {
    const manager = makeManager(100)
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    manager.setPinned('a', true)
    manager.setPinned('b', true)
    now = 1
    manager.record('a', 500)
    now = 2
    manager.record('b', 500)
    expect(manager.enforce()).toEqual([])
    expect(manager.totalBytes).toBe(1000)
  })

  it('reset zeroes one layer without touching the others', () => {
    const manager = makeManager()
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    manager.record('a', 100)
    manager.record('b', 200)
    manager.reset('a')
    expect(manager.totalBytes).toBe(200)
  })

  it('unregister removes the layer from the accounting', () => {
    const manager = makeManager()
    manager.register('a', vi.fn())
    manager.record('a', 100)
    manager.unregister('a')
    expect(manager.usage()).toEqual([])
    expect(manager.totalBytes).toBe(0)
  })

  it('touch updates recency without adding bytes', () => {
    const manager = makeManager(1000)
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    now = 1
    manager.record('a', 600)
    now = 2
    manager.record('b', 600)
    now = 3
    manager.touch('a') // 'a' is now the newest, so 'b' should go

    expect(manager.enforce()).toEqual(['b'])
  })

  it('usage is sorted by bytes descending', () => {
    const manager = makeManager()
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    manager.record('a', 10)
    manager.record('b', 90)
    expect(manager.usage().map((entry) => entry.layerId)).toEqual(['b', 'a'])
  })
})
