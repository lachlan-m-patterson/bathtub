import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { validateDEM, createFloodSequence } from '../src/model.js';

const dem = JSON.parse(await readFile('public/data/tweed-dem.json', 'utf8'));
dem.hydrograph = JSON.parse(await readFile('public/data/hydrograph.json', 'utf8'));
validateDEM(dem);
console.time('Flood preparation');
const sequence = createFloodSequence(dem, undefined, { frameCount: 181 });
console.timeEnd('Flood preparation');
// Millimetre depth encoding keeps the static deployment comfortably below 100 MB.
const bytes = Buffer.alloc(sequence.frames.length * dem.elevations.length * 2);
let offset = 0;
for (const frame of sequence.frames) {
  for (const depth of frame) {
    if (!Number.isFinite(depth) || depth < -0.001 || depth > 65.535) throw new Error(`Unencodable depth ${depth}`);
    bytes.writeUInt16LE(Math.max(0, Math.round(depth * 1000)), offset);
    offset += 2;
  }
}
const compressed = gzipSync(bytes, { level: 9 });
await writeFile('public/data/tweed-flood.bin.gz', compressed);
await writeFile('public/data/tweed-flood.json', JSON.stringify({
  start: sequence.start, end: sequence.end, frameCount: sequence.frames.length,
  cellCount: dem.elevations.length, encoding: 'uint16-le-mm',
  compression: 'gzip', uncompressedBytes: bytes.length,
  source: 'Illustrative routing driven by approximately traced recorded hydrograph',
  simulationSeconds: 480
}, null, 2));
console.log(`Saved ${compressed.length} compressed bytes (${bytes.length} decoded) for ${sequence.frames.length} frames`);
