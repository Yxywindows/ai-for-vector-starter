import '@testing-library/jest-dom/vitest'

// jsdom has no ResizeObserver; OpenLayers' Map constructor requires one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

// jsdom cannot resolve a calc() expression that reads a custom property set
// via *inline* style on the same element (e.g.
// `--x: 49px; height: calc(var(--x, 0px) + 0px)`): its font-size resolver
// assumes the calc expression always resolves to a plain length, then
// destructures a regex match that comes back null and throws
// "object null is not iterable". ag-grid's Theming API (ag-grid-community
// 36) sets exactly this pattern on internal layout/spacer elements, so any
// `getComputedStyle` call on -- or an ancestor query that walks through --
// an ag-grid-rendered tree can crash outside of our control (e.g.
// `@testing-library/dom`'s accessible-role queries, which check
// `getComputedStyle(el).display` on every ancestor). This is a jsdom
// limitation, not a real "hidden" element, so on that specific failure we
// fall back to a real (detached) element's style declaration -- `display`
// on it reads as `''`, which callers correctly treat as visible.
const realGetComputedStyle = window.getComputedStyle.bind(window)
window.getComputedStyle = (element: Element, pseudoElt?: string | null) => {
  try {
    return realGetComputedStyle(element, pseudoElt)
  } catch (error) {
    if (error instanceof TypeError) {
      return document.createElement('div').style as unknown as CSSStyleDeclaration
    }
    throw error
  }
}
