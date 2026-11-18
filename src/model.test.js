import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemo, validateDEM, floodThresholds, createFloodSequence, sampleFlood, stageAtTime, waterSurfaceElevations } from './model.js';

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

test('negative bathymetry and recession retain distinct event states', () => {
  const dem = validateDEM({ name: 'Tidal channel', width: 5, height: 3, cellSize: 4,
    minLevel: 0, maxLevel: 4, riverSeeds: [5],
    elevations: [5,5,5,5,5, -2,1,0,0,5, 5,5,5,5,5],
    hydrograph: { start: '2022-02-24T00:00:00', points: [[0,.35],[5,3],[10,.35]] }
  });
  assert.equal(stageAtTime(dem, 0), .35);
  assert.equal(stageAtTime(dem, 5), 3);
  assert.ok(Math.abs(stageAtTime(dem, 7.5) - 1.675) < 1e-9);
  const sequence = createFloodSequence(dem);
  const first = sampleFlood(sequence, 0, new Float32Array(15));
  const last = sampleFlood(sequence, 10, new Float32Array(15));
  assert.ok(Math.abs(first[5] - 2.35) < 1e-5);
  assert.ok(Math.abs(last[5] - 2.35) < 1e-5);
  assert.equal(first[7], 0);
  assert.ok(last[7] > .35, 'water remains behind the ridge during recession');
  assert.deepEqual(sampleFlood(sequence, 0, new Float32Array(15)), first);
});

test('NoData cells neither seed nor transmit flood water', () => {
  const dem = { name: 'Coverage gap', width: 3, height: 3, cellSize: 4,
    minLevel: 0, maxLevel: 2, riverSeeds: [0],
    elevations: [-2,0,-2,-2,0,-2,-2,0,-2], validMask: [1,0,1,1,0,1,1,0,1]
  };
  const thresholds = floodThresholds(validateDEM(dem));
  assert.equal(thresholds[2], Infinity);
  const sequence = createFloodSequence(dem, thresholds);
  assert.equal(sequence.frames.at(-1)[2], 0);
  assert.equal(sequence.frames.at(-1)[1], 0);
  assert.throws(() => validateDEM({ ...dem, riverSeeds: [1] }), /valid terrain/);
});

test('hydrograph times and levels are validated', () => {
  const dem = makeDemo();
  assert.throws(() => validateDEM({ ...dem, hydrograph: { start: '2022-02-24', points: [[0,1],[0,2]] } }), /increasing hours/);
  assert.throws(() => validateDEM({ ...dem, hydrograph: { start: '2022-02-24', points: [[0,1],[2,9]] } }), /gauge range/);
});

test('a high dry river bank cannot pull the water surface upwards', () => {
  const data = { width: 3, height: 3, elevations: [20,20,20, -2,-2,-2, -3,-3,-3] };
  const depths = new Float32Array([0,0,0, 4,4,4, 0,0,0]);
  const surface = waterSurfaceElevations(data, depths, new Float32Array(9));
  assert.equal(surface[1], 2, 'extend the 2 m water surface beneath the high bank');
  assert.equal(surface[4], 2, 'preserve the simulated wet surface');
  assert.ok(surface[7] < -3, 'keep a lower but unreached dry cell below its terrain');
  // Along the bank triangle, surface remains level and crosses the sloping ground.
  assert.equal((surface[1] + surface[4]) / 2, 2);
});

test('shoreline extrapolation excludes masked neighbours', () => {
  const data = { width: 3, height: 3, elevations: Array(9).fill(1), validMask: [0,1,1,1,1,1,1,1,1] };
  const depths = new Float32Array([50,0,0,0,0,0,0,0,0]);
  const surface = waterSurfaceElevations(data, depths, new Float32Array(9));
  assert.ok(surface[4] < 1);
});

test('peak-anchored sequence reproduces the peak raster and respects sills', async () => {
  const { createPeakAnchoredSequence } = await import('./model.js');
  // River | sill (shallow at peak) | basin (deep at peak)
  const dem = { name: 'Peak', width: 3, height: 1, cellSize: 1, minLevel: 0, maxLevel: 10,
    elevations: [0, 3, 1], riverSeeds: [0],
    hydrograph: { start: '2022-01-01', points: [[0, 1], [1, 4], [2, 1]] } };
  const peak = [4, 1, 3];
  const { frames } = createPeakAnchoredSequence(dem, peak, { frameCount: 5 });
  assert.deepEqual([...frames[2]], peak);
  // Rising: stage 2.5 is below the 3 m sill, so the basin is still dry.
  assert.equal(frames[1][2], 0);
  assert.equal(frames[1][0], 2.5);
  // Falling: the basin keeps water at the sill level (surface 3, ground 1).
  assert.equal(frames[3][2], 2);
  assert.equal(frames[3][1], 0);
});
