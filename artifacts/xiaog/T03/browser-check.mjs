import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(new URL('../../../web/package.json', import.meta.url))
const { chromium } = require('playwright')
const root = path.dirname(fileURLToPath(import.meta.url))
const run = path.join(root, 'qa', new Date().toISOString().replace(/[:.]/g, '-'))
await mkdir(run, { recursive: true })
const report = { baseUrl: 'http://127.0.0.1:18403', run, mockRequests: false, checks: [], pageErrors: [], apiFailures: [], screenshots: [] }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => report.pageErrors.push(error.message))
page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) report.apiFailures.push({ url: r.url(), status: r.status() }) })
const requests = []
page.on('request', (r) => requests.push(r.url()))
const featureNav = (name) => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true })
const phase = (value) => page.locator(`.experience[data-phase="${value}"]`).waitFor()
const shoot = async (name) => { const target = path.join(run, `${name}.png`); await page.screenshot({ path: target, fullPage: true }); report.screenshots.push(target) }
const pass = (name, details = null) => report.checks.push({ name, status: 'passed', details })

try {
  await page.goto(report.baseUrl)
  await page.getByRole('heading', { name: '与小G一起，探索空间。' }).waitFor()
  assert.equal(await page.locator('canvas').count(), 0)
  assert.equal(requests.some((url) => url.includes('/src/App.tsx') || url.includes('/src/map/MapCanvas.tsx')), false)
  pass('Home does not load map engine or claim a 3D model')
  await shoot('01-home-desktop')

  const features = [['项目空间', '/projects'], ['数据资源', '/data'], ['空间分析', '/analysis'], ['任务进度', '/tasks'], ['导出交付', '/exports'], ['平台概览', '/overview']]
  for (const [label, route] of features) {
    await featureNav(label).click()
    await phase('preview')
    assert.equal(new URL(page.url()).pathname, '/')
    await page.getByTestId('feature-preview').getByRole('heading', { name: label }).waitFor()
    if (route === '/analysis') await shoot('02-analysis-preview')
    await page.getByRole('link', { name: '展开工作台', exact: true }).click()
    await page.waitForURL(`**${route}`)
    await phase('active')
    assert.equal(await featureNav(label).getAttribute('aria-current'), 'page')
    assert.equal(await page.locator('.platform__content').count(), 1)
    await page.goBack()
    await phase('idle')
    assert.equal(new URL(page.url()).pathname, '/')
    await page.goForward()
    await phase('active')
    assert.equal(new URL(page.url()).pathname, route)
    await page.getByRole('link', { name: '返回主舞台', exact: true }).last().click()
    await phase('idle')
    assert.equal(await featureNav(label).evaluate((el) => el === document.activeElement), true)
    pass(`Preview → ${route} → history → home with focus`)
  }

  await featureNav('项目空间').click()
  await phase('preview')
  await page.getByRole('link', { name: '展开工作台', exact: true }).click()
  await featureNav('数据资源').click()
  await phase('preview')
  await page.waitForTimeout(650)
  assert.equal(new URL(page.url()).pathname, '/')
  await page.getByTestId('feature-preview').getByRole('heading', { name: '数据资源' }).waitFor()
  await page.getByRole('link', { name: '展开工作台', exact: true }).click()
  await page.keyboard.press('Escape')
  await phase('idle')
  await page.waitForTimeout(650)
  assert.equal(new URL(page.url()).pathname, '/')
  pass('Latest intention cancels stale expansion; Escape prevents later navigation')

  const [popup] = await Promise.all([context.waitForEvent('page'), featureNav('空间分析').click({ modifiers: ['Control'] })])
  await popup.waitForURL('**/analysis')
  assert.equal(new URL(page.url()).pathname, '/')
  assert.equal(await page.getByTestId('feature-preview').count(), 0)
  await popup.close()
  pass('Ctrl-click preserves native new-tab navigation')

  await page.getByRole('button', { name: '减少动态', exact: true }).click()
  await page.reload()
  assert.equal(await page.locator('.experience').getAttribute('data-reduced-motion'), 'true')
  await featureNav('任务进度').focus()
  await page.keyboard.press('Enter')
  await phase('preview')
  await page.getByRole('link', { name: '展开工作台', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.waitForURL('**/tasks')
  pass('Manual reduced motion persists; keyboard flow works')
  await page.evaluate(() => localStorage.removeItem('graticule:experience:reduce-motion'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(report.baseUrl)
  assert.equal(await page.getByRole('button', { name: '减少动态 · 跟随系统' }).isDisabled(), true)
  pass('OS reduced-motion preference honored')
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  for (const [width, height] of [[1920, 1080], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.goto(report.baseUrl)
    await featureNav('空间分析').click()
    await phase('preview')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.getByRole('link', { name: '展开工作台', exact: true }).scrollIntoViewIfNeeded()
    await shoot(`03-preview-${width}x${height}`)
    await page.getByRole('link', { name: '展开工作台', exact: true }).click()
    await page.waitForURL('**/analysis')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await shoot(`04-platform-${width}x${height}`)
    pass(`Responsive preview and real platform ${width}x${height}`)
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  const projectId = '18cb3488-119b-4d8d-958f-e20a0a70d0ae'
  const response = await page.request.get(`${report.baseUrl}/api/v1/projects/${projectId}`)
  assert.equal(response.status(), 200)
  const project = await response.json()
  await page.goto(`${report.baseUrl}/projects/${projectId}`)
  await page.getByRole('heading', { name: 'Walkthrough', exact: true }).waitFor()
  await page.reload()
  await page.getByRole('heading', { name: 'Walkthrough', exact: true }).waitFor()
  pass('Real project deep link and refresh')
  if (project.layers?.[0]) {
    await page.goto(`${report.baseUrl}/data/${project.layers[0].id}/schema`)
    await phase('active')
    assert.equal(await featureNav('数据资源').getAttribute('aria-current'), 'page')
    await shoot('05-dataset-deep-link')
    pass('Real dataset schema deep link')
  }
  await page.goto(`${report.baseUrl}/projects/${projectId}/map?view=2/0/0`)
  await page.locator('.ol-viewport').waitFor()
  assert.equal(await page.locator('.experience').getAttribute('data-mode'), 'workspace')
  assert.equal(await page.getByRole('navigation', { name: '主导航' }).count(), 0)
  await shoot('06-map-deep-link')
  pass('Real map lazy load, own chrome, direct URL')
  await page.getByRole('link', { name: '返回主舞台', exact: true }).click()
  await phase('idle')
  assert.equal(await page.getByRole('link', { name: '地图工作区', exact: true }).getAttribute('href'), `/projects/${projectId}/map`)
  pass('Last-project map shortcut preserved')
  await page.setViewportSize({ width: 390, height: 844 })
  await shoot('07-mobile-with-map-shortcut')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(report.pageErrors.length, 0)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack
  await shoot('failure')
  process.exitCode = 1
} finally {
  report.browserVersion = browser.version()
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(JSON.stringify(report, null, 2))
}
