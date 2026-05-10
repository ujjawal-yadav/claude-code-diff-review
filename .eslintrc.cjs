module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: ['dist', 'node_modules', '*.cjs', '*.mjs'],
  rules: {
    'no-eval': 'error',
    'no-implied-eval': 'error',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.object.name='child_process'][callee.property.name='exec']",
        message: 'child_process.exec with user input is forbidden. Use execFile with array args.',
      },
      {
        selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
        message: 'dangerouslySetInnerHTML is forbidden in webview code (TRD §14.3).',
      },
    ],
  },
};
