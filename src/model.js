// Row-major raster, square cells, metres for both horizontal and vertical units.
export function makeDemo() {
  const width = 161, height = 193, cellSize = 4;
  const elevations = [], riverSeeds = [];
  for (let row = 0; row < height; row++) {
    const z = row / (height - 1);
    const center = 80 + 13 * Math.sin(z * 7 - 1) + 5 * Math.sin(z * 14);
    for (let col = 0; col < width; col++) {
      const d = col - center;
      const basin = 2.3 + 0.5 * Math.sin(z * 11) + 0.35 * Math.cos(col * 0.12);
      let elevation = basin + 8 * Math.pow(Math.max(0, (Math.abs(d) - 38) / 40), 2);
      if (Math.abs(d) < 10) elevation = 0.45 + 0.65 * Math.pow(Math.abs(d) / 10, 2) + 0.12 * Math.sin(z * 9);
      const crest = d < 0 ? 4.2 + 1.1 * Math.pow(Math.sin((z - 0.36) * 4), 2) : 6.1 + 0.9 * Math.pow(Math.sin((z - 0.66) * 4), 2);
      if (Math.abs(d) >= 10 && Math.abs(d) <= 17) elevation = Math.max(elevation, crest - Math.max(0, Math.abs(Math.abs(d) - 13.5) - 1.2) * 0.7);
      // Elevated end caps prevent a shortcut around either levee.
      if ((row < 5 || row > height - 6) && Math.abs(d) > 10) elevation = Math.max(elevation, 9);
      elevations.push(Number(elevation.toFixed(3)));
      if (Math.abs(d) < 1) riverSeeds.push(row * width + col);
    }
  }
  return { name: 'Willow River', width, height, cellSize, elevations, riverSeeds, minLevel: 1, maxLevel: 8, levees: { west: 4.2, east: 6.1 }, synthetic: true };
}

export function validateDEM(data) {
  if (!data || !Number.isInteger(data.width) || !Number.isInteger(data.height) || data.width < 3 || data.height < 3 || data.width * data.height > 250000) throw new Error('DEM dimensions must be at least 3 × 3 and at most 250,000 cells.');
  if (!Number.isFinite(data.cellSize) || data.cellSize <= 0) throw new Error('cellSize must be a positive number in metres.');
  if (!Array.isArray(data.elevations) || data.elevations.length !== data.width * data.height || !data.elevations.every(Number.isFinite)) throw new Error('Supply one finite elevation per cell. Fill or crop NoData cells first.');
  if (!Array.isArray(data.riverSeeds) || !data.riverSeeds.length || !data.riverSeeds.every(i => Number.isInteger(i) && i >= 0 && i < data.elevations.length)) throw new Error('riverSeeds must contain valid river cell indices.');
  if (!Number.isFinite(data.minLevel) || !Number.isFinite(data.maxLevel) || data.maxLevel <= data.minLevel) throw new Error('Supply minLevel and maxLevel in elevation metres, with maxLevel greater than minLevel.');
  if (typeof data.name !== 'string' || !data.name.trim()) throw new Error('Supply a dataset name.');
  if (data.levees && !['west', 'east'].every(side => Number.isFinite(data.levees[side]))) throw new Error('Optional levees must contain numeric west and east crest elevations.');
  return data;
}

// Minimax Dijkstra: each cell opens at the lowest barrier along any path
// from a river seed. Four neighbours avoid diagonal leaks through levees.
export function floodThresholds(data) {
  const { width, height, elevations, riverSeeds } = data;
  const thresholds = new Float64Array(elevations.length).fill(Infinity);
  const heap = [];
  function push(index, level) {
    let pos = heap.length;
    heap.push({ index, level });
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (heap[parent].level <= level) break;
      heap[pos] = heap[parent]; pos = parent;
    }
    heap[pos] = { index, level };
  }
  function pop() {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
      let pos = 0;
      while (pos * 2 + 1 < heap.length) {
        let child = pos * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].level < heap[child].level) child++;
        if (last.level <= heap[child].level) break;
        heap[pos] = heap[child]; pos = child;
      }
      heap[pos] = last;
    }
    return first;
  }
  for (const index of riverSeeds) {
    if (thresholds[index] !== Infinity) continue;
    thresholds[index] = elevations[index]; push(index, elevations[index]);
  }
  while (heap.length) {
    const { index, level } = pop();
    if (level !== thresholds[index]) continue;
    const col = index % width, row = Math.floor(index / width);
    const neighbours = [];
    if (col > 0) neighbours.push(index - 1);
    if (col < width - 1) neighbours.push(index + 1);
    if (row > 0) neighbours.push(index - width);
    if (row < height - 1) neighbours.push(index + width);
    for (const next of neighbours) {
      const candidate = Math.max(level, elevations[next]);
      if (candidate < thresholds[next]) { thresholds[next] = candidate; push(next, candidate); }
    }
  }
  return thresholds;
}

// Conservative, local surface-water routing with a prescribed river boundary.
// Each step limits total outflow to the donor's available water. Closed raster
// edges retain water. Parameters are illustrative and are not calibrated.
export function createFloodSequence(data, thresholds = floodThresholds(data)) {
  const count = data.elevations.length;
  const reservoir = new Uint8Array(count);
  for (let i = 0; i < count; i++) reservoir[i] = thresholds[i] <= data.minLevel ? 1 : 0;
  for (const index of data.riverSeeds) reservoir[index] = 1;
  let depths = new Float32Array(count);
  let next = new Float32Array(count);
  const frameCount = Math.max(20, Math.min(161, Math.floor(32000000 / (count * 4))));
  const frames = [];
  const duration = 160;
  const frameDuration = duration / (frameCount - 1);
  const substeps = Math.ceil(frameDuration / .025);
  const dt = frameDuration / substeps;
  const neighbours = new Int32Array(4);
  const rates = new Float64Array(4);
  function setRiver(stage) {
    for (let i = 0; i < count; i++) if (reservoir[i]) depths[i] = Math.max(0, stage - data.elevations[i]);
  }
  setRiver(data.minLevel);
  frames.push(depths.slice());
  for (let frame = 1; frame < frameCount; frame++) {
    for (let step = 1; step <= substeps; step++) {
      const progress = (frame - 1 + step / substeps) / (frameCount - 1);
      const stage = data.minLevel + progress * (data.maxLevel - data.minLevel);
      setRiver(stage);
      next.set(depths);
      for (let i = 0; i < count; i++) {
        if (depths[i] <= 0) continue;
        const col = i % data.width;
        neighbours[0] = col > 0 ? i - 1 : -1;
        neighbours[1] = col < data.width - 1 ? i + 1 : -1;
        neighbours[2] = i >= data.width ? i - data.width : -1;
        neighbours[3] = i < count - data.width ? i + data.width : -1;
        const surface = data.elevations[i] + depths[i];
        let total = 0;
        for (let edge = 0; edge < 4; edge++) {
          const j = neighbours[edge];
          const head = j < 0 ? 0 : Math.max(0, surface - Math.max(data.elevations[i], data.elevations[j] + depths[j]));
          rates[edge] = head ** 1.5;
          total += rates[edge];
        }
        if (total === 0) continue;
        const scale = Math.min(depths[i] / total, dt * 16 / data.cellSize);
        for (let edge = 0; edge < 4; edge++) {
          if (rates[edge] === 0) continue;
          const flow = rates[edge] * scale;
          next[i] -= flow;
          next[neighbours[edge]] += flow;
        }
      }
      [depths, next] = [next, depths];
      setRiver(stage);
    }
    frames.push(depths.slice());
  }
  return { frames, minLevel: data.minLevel, maxLevel: data.maxLevel };
}

export function sampleFlood(sequence, level, output) {
  const position = Math.max(0, Math.min(1, (level - sequence.minLevel) / (sequence.maxLevel - sequence.minLevel))) * (sequence.frames.length - 1);
  const before = Math.floor(position), after = Math.min(before + 1, sequence.frames.length - 1);
  const fraction = position - before;
  for (let i = 0; i < output.length; i++) {
    output[i] = sequence.frames[before][i] * (1 - fraction) + sequence.frames[after][i] * fraction;
  }
  return output;
}
