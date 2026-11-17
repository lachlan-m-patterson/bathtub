import { readFile, writeFile } from 'node:fs/promises';
import { validateDEM, createFloodSequence } from '../src/model.js';

const dem = JSON.parse(await readFile('public/data/tweed-dem.json', 'utf8'));
dem.hydrograph = JSON.parse(await readFile('public/data/hydrograph.json', 'utf8'));
validateDEM(dem);
console.time('Flood preparation');
const sequence = createFloodSequence(dem);
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
await writeFile('public/data/tweed-flood.bin', bytes);
await writeFile('public/data/tweed-flood.json', JSON.stringify({
  start: sequence.start, end: sequence.end, frameCount: sequence.frames.length,
  cellCount: dem.elevations.length, encoding: 'uint16-le-mm',
  source: 'Illustrative routing driven by approximately traced recorded hydrograph',
  simulationSeconds: 480
}, null, 2));
console.log(`Saved ${bytes.length} bytes for ${sequence.frames.length} frames`);
