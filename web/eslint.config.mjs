import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Type-aware linting of what tsconfig.json covers (src, vite.config.ts), and
// plain linting of the Playwright scripts in dev/.
export default tseslint.config(
  // dist: build output. public/vendor: 98.css as shipped by its author. dev/screenshots: walkthrough output.
  { ignores: ['dist/', 'node_modules/', 'public/vendor/', 'dev/screenshots/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A leading underscore marks a parameter that has to be there.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // DOM event listeners are async functions that handle their own errors.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // A caught value is passed on as it was caught.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }],

      // Rules turned off because they only produce noise in this code base:
      // `any` comes in through JSON.parse and caught values in the tests; API responses are typed at the client.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // The fetch mocks in the tests are async to match fetch, with nothing to await.
      '@typescript-eslint/require-await': 'off',
      // Objects here are built by factory functions from closures; no method reads `this`.
      '@typescript-eslint/unbound-method': 'off',
      // String() is used on purpose where a union includes an object (DOM prop values, event targets, fetch input).
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    // Node scripts; their page.evaluate callbacks run in the browser.
    files: ['**/*.mjs', 'vite.config.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  { files: ['**/*.mjs'], ...tseslint.configs.disableTypeChecked },
);
