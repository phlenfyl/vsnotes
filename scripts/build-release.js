// Release build: bundles the extension with the Google OAuth credentials
// baked in from the environment, so a packaged .vsix can talk to Google
// Tasks without the values ever living in source control.
//
//   NOTEVS_GOOGLE_CLIENT_ID=... NOTEVS_GOOGLE_CLIENT_SECRET=... npm run build:release
//
// Both are optional — omit them and you get the same bundle `npm run build`
// produces, with Google Tasks simply unconfigured.
const esbuild = require('esbuild');

const define = {};
for (const name of ['NOTEVS_GOOGLE_CLIENT_ID', 'NOTEVS_GOOGLE_CLIENT_SECRET']) {
  define[`process.env.${name}`] = JSON.stringify(process.env[name] ?? '');
}

esbuild.buildSync({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', 'audify'],
  format: 'cjs',
  platform: 'node',
  define,
});

esbuild.buildSync({
  entryPoints: ['src/mcpBridge.ts'],
  bundle: true,
  outfile: 'dist/mcp-bridge.cjs',
  format: 'cjs',
  platform: 'node',
});

const injected = Object.keys(define).filter((k) => define[k] !== '""');
console.log(`dist/ built${injected.length ? ' with Google OAuth credentials injected' : ' (no Google OAuth credentials in env)'}`);
