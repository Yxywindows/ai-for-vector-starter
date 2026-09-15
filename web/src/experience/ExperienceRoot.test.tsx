import { StrictMode, useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformShell } from '../app/PlatformShell'
import { ExperienceRoot } from './ExperienceRoot'
import { FEATURES } from './featureRegistry'
import { MOTION, MOTION_STORAGE_KEY } from './motionConfig'

function renderExperience(initial = '/') {
  const mounted = vi.fn()
  function Page({ title }: { title: string }) {
    const navigate = useNavigate()
    useEffect(() => {
      mounted()
    }, [])
    return (
      <>
        <h1>{title}</h1>
        <input aria-label="page draft" />
        <button onClick={() => void navigate('?view=2/0/0', { replace: true })}>Write view</button>
      </>
    )
  }
  const router = createMemoryRouter(
    [
      {
        element: <ExperienceRoot />,
        children: [
          { path: '/', element: null },
          {
            element: <PlatformShell />,
            children: FEATURES.map((f) => ({
              path: `${f.href}/*`,
              element: <Page title={`${f.label}内容`} />,
            })),
          },
        ],
      },
    ],
    { initialEntries: [initial] },
  )
  const result = render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
  return { ...result, router, mounted }
}
const rail = () => within(screen.getByRole('navigation', { name: '主导航' }))
async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ExperienceRoot', () => {
  it('selects a preview without navigation, expands once, and returns focus', async () => {
    const { router } = renderExperience()
    fireEvent.click(rail().getByRole('link', { name: /项目空间/ }))
    expect(router.state.location.pathname).toBe('/')
    await tick(MOTION.focusMs)
    expect(screen.getByTestId('feature-preview')).toHaveTextContent('项目空间')
    fireEvent.click(screen.getByRole('link', { name: /展开工作台/ }))
    await tick(MOTION.expandMs)
    expect(router.state.location.pathname).toBe('/projects')
    expect(screen.getByRole('heading', { name: '项目空间内容' })).toHaveFocus()
    fireEvent.click(screen.getAllByRole('link', { name: '返回主舞台' })[0]!)
    await tick(MOTION.returnMs)
    expect(router.state.location.pathname).toBe('/')
    expect(rail().getByRole('link', { name: /项目空间/ })).toHaveFocus()
    await act(async () => {
      await router.navigate(-1)
    })
    expect(router.state.location.pathname).toBe('/projects')
    await act(async () => {
      await router.navigate(-1)
    })
    expect(router.state.location.pathname).toBe('/')
  })
  it('latest feature wins during expansion and obsolete timers cannot navigate', async () => {
    const { router } = renderExperience()
    fireEvent.click(rail().getByRole('link', { name: /项目空间/ }))
    await tick(MOTION.focusMs)
    fireEvent.click(screen.getByRole('link', { name: /展开工作台/ }))
    await tick(100)
    fireEvent.click(rail().getByRole('link', { name: /数据资源/ }))
    await tick(MOTION.focusMs)
    expect(router.state.location.pathname).toBe('/')
    expect(screen.getByTestId('feature-preview')).toHaveTextContent('数据资源')
    fireEvent.click(screen.getByRole('link', { name: /展开工作台/ }))
    await tick(MOTION.expandMs)
    expect(router.state.location.pathname).toBe('/data')
  })
  it('Escape cancels pending expansion and restores focus', async () => {
    const { router } = renderExperience()
    fireEvent.click(rail().getByRole('link', { name: /任务进度/ }))
    await tick(MOTION.focusMs)
    fireEvent.click(screen.getByRole('link', { name: /展开工作台/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await tick(MOTION.expandMs)
    expect(router.state.location.pathname).toBe('/')
    expect(screen.queryByTestId('feature-preview')).toBeNull()
    expect(rail().getByRole('link', { name: /任务进度/ })).toHaveFocus()
  })
  it('does not intercept modified links and supports immediate reduced motion', async () => {
    const { router } = renderExperience()
    const anchor = rail().getByRole('link', { name: /空间分析/ })
    fireEvent.click(anchor, { ctrlKey: true })
    expect(anchor).toHaveAttribute('href', '/analysis')
    expect(screen.queryByTestId('feature-preview')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '减少动态' }))
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe('true')
    fireEvent.click(anchor)
    fireEvent.click(screen.getByRole('link', { name: /展开工作台/ }))
    await tick(0)
    expect(router.state.location.pathname).toBe('/analysis')
  })
  it('direct URLs start active and query updates preserve the mounted page and draft', async () => {
    const { router, mounted } = renderExperience('/projects/p1')
    expect(screen.queryByTestId('stage-placeholder')).toBeNull()
    const before = mounted.mock.calls.length
    fireEvent.change(screen.getByRole('textbox', { name: 'page draft' }), {
      target: { value: 'unsaved' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Write view' }))
    await tick(0)
    expect(router.state.location.search).toBe('?view=2/0/0')
    expect(mounted.mock.calls.length).toBe(before)
    expect(screen.getByRole('textbox', { name: 'page draft' })).toHaveValue('unsaved')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(router.state.location.pathname).toBe('/projects/p1')
  })
  it('external navigation invalidates the pending timer', async () => {
    const { router } = renderExperience()
    fireEvent.click(rail().getByRole('link', { name: /项目空间/ }))
    await tick(MOTION.focusMs)
    fireEvent.click(screen.getByRole('link', { name: /展开工作台/ }))
    await act(async () => {
      await router.navigate('/exports')
    })
    await tick(MOTION.expandMs * 2)
    expect(router.state.location.pathname).toBe('/exports')
  })
})
