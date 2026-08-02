import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // bench.mjs is a plain Node script run directly with `node`, not part of
  // the Vite/vitest build — it mixes Node globals (process, fetch) with
  // browser globals used inside page.evaluate() callbacks (window,
  // performance), which no single env captures cleanly. It's measurement
  // tooling, not shipped app code, so it's excluded rather than contorted.
  { ignores: ['dist', 'coverage', 'bench/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
