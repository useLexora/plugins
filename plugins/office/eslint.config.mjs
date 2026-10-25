import js from '@eslint/js'
import ts from 'typescript-eslint'
export default ts.config(
  { ignores: ['src/lexora.d.ts', 'src/create-univer.ts', 'generated/**', 'vendor/**', 'artifacts/**', 'dist/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { languageOptions: { globals: { self: 'readonly', document: 'readonly', window: 'readonly', crypto: 'readonly', fetch: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', queueMicrotask: 'readonly', Worker: 'readonly', MessageEvent: 'readonly', URL: 'readonly', TextEncoder: 'readonly', Buffer: 'readonly', NodeJS: 'readonly' } }, rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'no-control-regex': 'off', 'no-undef': 'off' } },
)
