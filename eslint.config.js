// @ts-check
import js from '@eslint/js'
import globals from 'globals'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'data/**', '.evalite/**', '**/.mastra/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Nada de PII en logs: console solo en CLIs y spikes, que lo habilitan localmente.
      'no-console': 'error',
    },
  },
  // Tamaño, complejidad y duplicación. La duplicación entre archivos la mide `pnpm dup` (jscpd).
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { sonarjs },
    rules: {
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
      'sonarjs/cognitive-complexity': ['warn', 15],
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/no-duplicate-string': ['warn', { threshold: 4 }],
      'sonarjs/no-identical-expressions': 'error',
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-duplicated-branches': 'warn',
      'sonarjs/no-collapsible-if': 'warn',
    },
  },
  {
    // Tests, esquema de la BD y fixtures son largos o repetitivos por naturaleza; spikes es código
    // desechable de investigación (docs/00-brief.md), no se mantiene.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.eval.ts', 'packages/db/src/schema.ts', 'spikes/**'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      complexity: 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/no-identical-functions': 'off',
    },
  },
  {
    // Un componente React es declarativo: su longitud es JSX, no lógica. La complejidad sí se mide.
    files: ['**/*.tsx'],
    rules: { 'max-lines-per-function': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
)
