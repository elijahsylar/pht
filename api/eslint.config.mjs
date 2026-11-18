import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Type-aware linting of everything tsconfig.test.json covers: src, tests, dev.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { project: './tsconfig.test.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A leading underscore marks a parameter that has to be there (Express
      // tells an error handler apart by its four arguments).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Express handlers are async functions that catch their own errors and pass them to next().
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],

      // Rules turned off because they only produce noise in this code base:
      // `any` comes in through library types (mysql2 rows, supertest bodies, JSON.parse); input is checked with Zod.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // The in-memory store and the fetch stand-ins are async to match an interface, with nothing to await.
      '@typescript-eslint/require-await': 'off',
      // The fetch stand-ins call String() on a `string | URL | Request` on purpose; they are only given strings and URLs.
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  { files: ['**/*.mjs'], ...tseslint.configs.disableTypeChecked },
);
