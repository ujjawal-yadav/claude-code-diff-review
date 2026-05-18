import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const sharedDefine = {
  'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
};

/**
 * Two bundles:
 *  - extension: Node.js, CJS, `vscode` external. Single file. Optimised for fast cold start.
 *  - webview:   IIFE, target chrome108 (matches VS Code 1.85+ webview), no splitting.
 *
 * Both are minified in production builds.
 */
const extensionBuild = {
  entryPoints: [resolve(__dirname, 'src/extension.ts')],
  outfile:     resolve(__dirname, 'dist/extension.js'),
  bundle:      true,
  platform:    'node',
  format:      'cjs',
  target:      'node18',
  // `vscode` is provided by the host. `@anthropic-ai/sdk` is left external
  // so it loads lazily via require() on first chat, instead of being parsed
  // as part of the activation bundle. Cuts cold-start parse time meaningfully.
  external:    ['vscode', '@anthropic-ai/sdk'],
  sourcemap:   watch ? 'inline' : 'external',
  minify:      !watch,
  treeShaking: true,
  define:      sharedDefine,
  logLevel:    'info',
};

const sharedWebviewOpts = {
  bundle:      true,
  platform:    'browser',
  format:      'iife',
  target:      ['chrome108'],
  splitting:   false,
  sourcemap:   watch ? 'inline' : 'external',
  minify:      !watch,
  treeShaking: true,
  // Match tsconfig.webview.json's `jsx: "react-jsx"`. Without this esbuild
  // emits `React.createElement(...)` and crashes at runtime with
  // "React is not defined" because we never explicitly import React.
  jsx:           'automatic',
  jsxImportSource: 'react',
  loader: { '.css': 'css' },
  define: {
    ...sharedDefine,
    'global':               'globalThis',
    'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
    'process.platform':     JSON.stringify('browser'),
  },
  // Some unified / rehype dependencies touch `process.env` at evaluation
  // time. The banner provides a minimal browser-safe `process` so module
  // top-level code doesn't throw `ReferenceError: process is not defined`.
  banner: {
    js: 'var process=(typeof globalThis!=="undefined"&&globalThis.process)||{env:{},platform:"browser",cwd:function(){return"/";}};',
  },
  logLevel: 'info',
};

const webviewBuild = {
  ...sharedWebviewOpts,
  entryPoints: [resolve(__dirname, 'webview/index.tsx')],
  outfile:     resolve(__dirname, 'dist/webview/index.js'),
};

// Phase α M9.2.8: dedicated History panel bundle. Separate entry +
// output so the review panel and history panel each load only what they
// need.
const historyWebviewBuild = {
  ...sharedWebviewOpts,
  entryPoints: [resolve(__dirname, 'webview/history/index.tsx')],
  outfile:     resolve(__dirname, 'dist/webview/history/index.js'),
};

async function run() {
  if (watch) {
    const ext = await context(extensionBuild);
    const wv  = await context(webviewBuild);
    const hv  = await context(historyWebviewBuild);
    await Promise.all([ext.watch(), wv.watch(), hv.watch()]);
    console.log('[esbuild] watching…');
  } else {
    await Promise.all([
      build(extensionBuild),
      build(webviewBuild),
      build(historyWebviewBuild),
    ]);
    console.log('[esbuild] build complete');
  }
}

run().catch((err) => {
  console.error('[esbuild] failed:', err);
  process.exit(1);
});
