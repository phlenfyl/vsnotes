#!/usr/bin/env node
/**
 * splice-voice-into-vsix.js
 *
 * A .vsix is just a zip whose contents live under an extension/ folder.
 * `vsce package` (run with --no-dependencies, from the "package" script)
 * builds a clean one via its normal git-tracked-files pass, but never
 * includes node_modules — and turning its own npm-dependency-detection
 * pass on to get audify included duplicates every one of those files
 * (same relative path listed twice, "case insensitive path" error) in
 * this npm-workspaces monorepo. Root cause not fully pinned down; rather
 * than fight vsce's dependency walker further, this appends the already
 * vendored node_modules/{audify,bindings,file-uri-to-path} (see
 * `vendor:voice` in package.json) into the finished .vsix directly with
 * the system `zip` binary, under the same extension/node_modules/ path a
 * real dependency-detected package would have used.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const vsixPath = process.argv[2];
if (!vsixPath || !fs.existsSync(vsixPath)) {
  console.error('Usage: splice-voice-into-vsix.js <path-to-vsix>');
  process.exit(1);
}

const extensionDir = path.resolve(__dirname, '..');
const absVsix = path.resolve(extensionDir, vsixPath);
const pkgs = ['audify', 'bindings', 'file-uri-to-path'];

for (const pkg of pkgs) {
  const dir = path.join(extensionDir, 'node_modules', pkg);
  if (!fs.existsSync(dir)) {
    console.error(`Missing node_modules/${pkg} — run "npm run vendor:voice" first.`);
    process.exit(1);
  }
}

// zip -r needs relative paths staged so the archive's internal path is
// "extension/node_modules/<pkg>/..." — running it from extensionDir/..
// with "extension/node_modules/<pkg>" as the target gives exactly that.
const workDir = path.dirname(extensionDir);
const relPaths = pkgs.map((pkg) => path.join(path.basename(extensionDir), 'node_modules', pkg));

execFileSync('zip', ['-r', absVsix, ...relPaths], { cwd: workDir, stdio: 'inherit' });
console.log(`Spliced ${pkgs.join(', ')} into ${vsixPath}`);
