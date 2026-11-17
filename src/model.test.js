import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemo, validateDEM, floodThresholds, createFloodSequence, sampleFlood } from './model.js';

test('a low basin remains disconnected until its enclosing barrier overtops', () => {
  const dem = { name: 'Barrier', width: 5, height: 3, cellSize: 1, minLevel: 0, maxLevel: 10,
    elevations: [0,5,1,1,1, 0,5,1,1,1, 0,5,1,1,1], riverSeeds: [0,5,10] };
  const threshold = floodThresholds(validateDEM(dem));
  assert.equal(threshold[7], 5);
  assert.equal(threshold[5], 0);
  assert.equal(threshold[14], 5);
});
test('water finds the lowest available spill path', () => {
  const dem = { name: 'Spill', width: 3, height: 3, cellSize: 1, minLevel: 0, maxLevel: 10,
    elevations: [0,6,1, 0,4,1, 0,8,1], riverSeeds: [0] };
  const threshold = floodThresholds(dem);
  assert.equal(threshold[2], 4);
  assert.equal(threshold[8], 4);
});
test('synthetic basins connect at distinct levee elevations', () => {
  const dem = validateDEM(makeDemo());
  const threshold = floodThresholds(dem);
  const west = threshold[100 * dem.width + 45], east = threshold[100 * dem.width + 125];
  assert.ok(west >= 4.19 && west < 4.23, `West opens at ${west}`);
  assert.ok(east >= 6.09 && east < 6.13, `East opens at ${east}`);
});
test('invalid rasters fail before replacing the active scene', () => {
  assert.throws(() => validateDEM({ ...makeDemo(), elevations: [0] }), /one finite elevation/);
  assert.throws(() => validateDEM({ ...makeDemo(), riverSeeds: [-1] }), /valid river cell/);
});

test('spill advances gradually into both basins and scrubbing reproduces it', () => {
  const dem = makeDemo();
  const sequence = createFloodSequence(dem);
  const depths = new Float32Array(dem.elevations.length);
  function basinCounts(level) {
    sampleFlood(sequence, level, depths);
    let west = 0, east = 0;
    for (let i = 0; i < depths.length; i++) {
      assert.ok(Number.isFinite(depths[i]) && depths[i] >= -1e-6);
      const z = Math.floor(i / dem.width) / (dem.height - 1);
      const center = 80 + 13 * Math.sin(z * 7 - 1) + 5 * Math.sin(z * 14);
      const offset = i % dem.width - center;
      if (depths[i] > .015 && offset < -18) west++;
      if (depths[i] > .015 && offset > 18) east++;
    }
    return { west, east };
  }
  assert.deepEqual(basinCounts(4.2), { west: 0, east: 0 });
  const early = basinCounts(5);
  const later = basinCounts(6);
  assert.ok(early.west > 0 && later.west > early.west * 2);
  assert.equal(later.east, 0);
  const final = basinCounts(8);
  assert.ok(final.east > 0 && final.west > later.west);
  assert.deepEqual(basinCounts(5), early);
});
