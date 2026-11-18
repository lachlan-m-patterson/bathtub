import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { waterSurfaceElevations } from './model.js';

test('published maximum frame reproduces the prepared raster depths and heights', () => {
  const dem = JSON.parse(readFileSync(new URL('../public/data/tweed-dem.json', import.meta.url)));
  const metadata = JSON.parse(readFileSync(new URL('../public/data/tweed-flood.json', import.meta.url)));
  const bytes = gunzipSync(readFileSync(new URL('../public/data/tweed-flood.bin.gz', import.meta.url)));
  const count = dem.elevations.length;
  assert.equal(bytes.length, metadata.frameCount * count * 2);
  const depths = new Float32Array(count);
  for (let i = 0; i < count; i++) depths[i] = bytes.readUInt16LE((metadata.peakFrame * count + i) * 2) / 1000;
  const surfaces = waterSurfaceElevations(dem, depths, new Float32Array(count));
  let wetCells = 0;
  for (let i = 0; i < count; i++) {
    assert.ok(Math.abs(depths[i] - dem.peakDepths[i]) < .001, `Depth mismatch at ${i}`);
    if (depths[i] > .015) {
      wetCells++;
      assert.ok(Math.abs(surfaces[i] - (dem.modelGround[i] + dem.peakDepths[i])) < .001, `Height mismatch at ${i}`);
    }
  }
  assert.equal(wetCells, dem.source.peakModel.wetCells);
});
