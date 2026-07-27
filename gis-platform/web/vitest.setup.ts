import '@testing-library/jest-dom/vitest'

// jsdom has no ResizeObserver; OpenLayers' Map constructor requires one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
