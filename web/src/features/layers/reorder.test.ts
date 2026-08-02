import { describe, expect, it } from 'vitest'

import { moveItem } from './reorder'

describe('moveItem', () => {
  it('moves an item down', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
  })

  it('moves an item up', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('is a no-op when from equals to', () => {
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input', () => {
    const input = ['a', 'b', 'c']
    moveItem(input, 0, 2)
    expect(input).toEqual(['a', 'b', 'c'])
  })

  it('clamps out-of-range indices instead of producing holes', () => {
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a'])
    expect(moveItem(['a', 'b'], -5, 1)).toEqual(['b', 'a'])
  })
})
