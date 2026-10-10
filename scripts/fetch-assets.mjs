#!/usr/bin/env node
// Downloads every binary asset the app needs into the project folder.
// Node 18+, no dependencies. Run once: `node scripts/fetch-assets.mjs` (add --force to re-download).
//
// Behind a corporate/school proxy: Node's fetch ignores HTTPS_PROXY unless you set
// NODE_USE_ENV_PROXY=1 (Node 22.21+ / 24+). Custom root CA: NODE_EXTRA_CA_CERTS=path.pem

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

// Pinned versions. Bump here, then update ASSET_VERSION in sw.js.
const MEDIAPIPE = '0.10.35';
const INTER = '5.3.0';
const JBMONO = '5.3.0';
const ARCHIVO = '5.3.0';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const npmTarball = (scope, name, version) =>
  `https://registry.npmjs.org/${scope}/${name}/-/${name}-${version}.tgz`;

// [url, { path inside tarball: destination relative to project root }]
const PACKAGES = [
  [
    npmTarball('@mediapipe', 'tasks-vision', MEDIAPIPE),
    {
      'package/vision_bundle.mjs': 'vendor/mediapipe/vision_bundle.mjs',
      'package/wasm/vision_wasm_internal.js': 'vendor/mediapipe/wasm/vision_wasm_internal.js',
      'package/wasm/vision_wasm_internal.wasm': 'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
      'package/wasm/vision_wasm_nosimd_internal.js': 'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js',
      'package/wasm/vision_wasm_nosimd_internal.wasm': 'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
    },
  ],
  [
    npmTarball('@fontsource-variable', 'inter', INTER),
    {
      'package/files/inter-latin-opsz-normal.woff2': 'fonts/inter-latin-opsz-normal.woff2',
      'package/files/inter-cyrillic-opsz-normal.woff2': 'fonts/inter-cyrillic-opsz-normal.woff2',
      'package/LICENSE': 'fonts/LICENSE-Inter.txt',
    },
  ],
  [
    // Wide display face for the MOGGED! band (variable: wdth 62–125, wght 100–900).
    npmTarball('@fontsource-variable', 'archivo', ARCHIVO),
    {
      'package/files/archivo-latin-wdth-normal.woff2': 'fonts/archivo-latin-wdth-normal.woff2',
      'package/LICENSE': 'fonts/LICENSE-Archivo.txt',
    },
  ],
  [
    npmTarball('@fontsource', 'jetbrains-mono', JBMONO),
    {
      'package/files/jetbrains-mono-latin-500-normal.woff2': 'fonts/jetbrains-mono-latin-500-normal.woff2',
      'package/LICENSE': 'fonts/LICENSE-JetBrainsMono.txt',
    },
  ],
];

const FILES = [[MODEL_URL, 'models/face_landmarker.task']];

async function exists(rel) {
  try {
    return (await stat(join(ROOT, rel))).size > 0;
  } catch {
    return false;
  }
}

async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`Failed to download ${url}: ${lastError?.cause?.message || lastError?.message}`);
}

// Minimal tar reader: enough for npm tarballs (ustar + pax path records).
function untar(buffer) {
  const files = new Map();
  let offset = 0;
  let paxPath = null;
  const str = (start, len) => buffer.toString('utf8', start, start + len).replace(/\0.*$/s, '');
  while (offset + 512 <= buffer.length) {
    const header = offset;
    if (buffer[header] === 0) break;
    const size = parseInt(str(header + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(buffer[header + 156] || 48);
    const prefix = str(header + 345, 155);
    let name = str(header, 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = header + 512;
    const data = buffer.subarray(dataStart, dataStart + size);
    if (type === 'x') {
      const match = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
      paxPath = match ? match[1] : null;
    } else {
      if (type === '0' || type === '\0') files.set(paxPath || name, data);
      paxPath = null;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function save(rel, data) {
  const abs = join(ROOT, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
  console.log(`  ${rel}  ${(data.length / 1024).toFixed(0)} KB`);
}

async function main() {
  console.log('mog battle: fetching assets');

  for (const [url, map] of PACKAGES) {
    const wanted = Object.entries(map);
    const missing = [];
    for (const entry of wanted) if (FORCE || !(await exists(entry[1]))) missing.push(entry);
    if (!missing.length) continue;
    console.log(`- ${url}`);
    const files = untar(gunzipSync(await download(url)));
    for (const [from, to] of missing) {
      let data = files.get(from);
      if (!data) throw new Error(`${from} not found in ${url}`);
      // Drop the source map reference so DevTools does not request a missing file.
      if (to.endsWith('.mjs')) data = Buffer.from(data.toString('utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n'));
      await save(to, data);
    }
  }

  for (const [url, to] of FILES) {
    if (!FORCE && (await exists(to))) continue;
    console.log(`- ${url}`);
    await save(to, await download(url));
  }

  await save(
    'vendor/mediapipe/NOTICE.txt',
    Buffer.from(
      `@mediapipe/tasks-vision ${MEDIAPIPE} and face_landmarker.task\n` +
        'Copyright Google LLC. Licensed under the Apache License, Version 2.0.\n' +
        'https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE\n'
    )
  );

  console.log('done');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  console.error('Check the network (school proxies often block storage.googleapis.com) and run again.');
  process.exit(1);
});
