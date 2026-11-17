import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemo, validateDEM, floodThresholds } from './model.js';

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
