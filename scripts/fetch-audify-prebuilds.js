#!/usr/bin/env node
/**
 * fetch-audify-prebuilds.js
 *
 * Downloads audify's prebuilt native binaries for every supported platform
 * from its GitHub releases and lays them out under
 * resources/audify-prebuilds/<platform>-<arch>/build/Release/ — see
 * voice.ts's applyPlatformBinary() for why: a published .vsix is built once
 * on one machine and shipped as-is, so without this, only that one
 * platform's binary (whatever `npm install` fetched locally) ever works for
 * every user, on every OS.
 *
 * Re-run this after bumping audify's version in package.json (keep
 * AUDIFY_VERSION below in sync), or to add another platform to SUPPORTED
 * (also add it to SUPPORTED_PLATFORMS in voice.ts). Uses napi-v8
 * consistently across all platforms — N-API is ABI-stable across Node/
 * Electron versions by design, so one napi version per platform is enough;
 * v8 was chosen as a broadly-compatible middle point (audify publishes v5
 * through v10).
 *
 * Not run automatically by `npm run build`/`package` — these binaries
 * rarely change and are checked into git like any other bundled resource
 * (resources/rasa-agent-template is the same pattern), so normal builds
 * don't need network access to reproduce.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const AUDIFY_VERSION = '1.10.1';
const NAPI_VERSION = 'v8';
const REPO = 'almoghamdani/audify';
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64'];

const destRoot = path.join(__dirname, '..', 'resources', 'audify-prebuilds');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audify-prebuilds-'));

for (const platform of PLATFORMS) {
  const asset = `audify-v${AUDIFY_VERSION}-napi-${NAPI_VERSION}-${platform}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/download/v${AUDIFY_VERSION}/${asset}`;
  const tarPath = path.join(tmpRoot, asset);
  console.log(`Fetching ${platform}...`);
  execFileSync('curl', ['-sL', '-o', tarPath, url], { stdio: 'inherit' });

  const extractDir = path.join(tmpRoot, platform);
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarPath, '-C', extractDir], { stdio: 'inherit' });

  const srcRelease = path.join(extractDir, 'build', 'Release');
  const destRelease = path.join(destRoot, platform, 'build', 'Release');
  fs.rmSync(destRelease, { recursive: true, force: true });
  fs.mkdirSync(destRelease, { recursive: true });
  for (const file of fs.readdirSync(srcRelease)) {
    fs.copyFileSync(path.join(srcRelease, file), path.join(destRelease, file));
  }
  console.log(`  -> ${destRelease}`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`Done. Updated ${PLATFORMS.length} platform(s) under ${destRoot}`);
