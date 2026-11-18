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
  if (!Array.isArray(data.elevations) || data.elevations.length !== data.width * data.height || !data.elevations.every(Number.isFinite)) throw new Error('Supply one finite elevation per cell. Use validMask to exclude NoData.');
  if (data.validMask && (!Array.isArray(data.validMask) || data.validMask.length !== data.elevations.length || !data.validMask.every(value => value === 0 || value === 1))) throw new Error('validMask must contain one 0 or 1 per cell.');
  if (!Array.isArray(data.riverSeeds) || !data.riverSeeds.length || !data.riverSeeds.every(i => Number.isInteger(i) && i >= 0 && i < data.elevations.length)) throw new Error('riverSeeds must contain valid river cell indices.');
  if (!Number.isFinite(data.minLevel) || !Number.isFinite(data.maxLevel) || data.maxLevel <= data.minLevel) throw new Error('Supply minLevel and maxLevel in elevation metres, with maxLevel greater than minLevel.');
  if (typeof data.name !== 'string' || !data.name.trim()) throw new Error('Supply a dataset name.');
  if (data.levees && !['west', 'east'].every(side => Number.isFinite(data.levees[side]))) throw new Error('Optional levees must contain numeric west and east crest elevations.');
  if (data.validMask && data.riverSeeds.some(i => !data.validMask[i])) throw new Error('River seeds must be inside valid terrain.');
  if (data.hydrograph) {
    const points = data.hydrograph.points;
    if (!Array.isArray(points) || points.length < 2 || !points.every((point, index) =>
      Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) &&
      point[0] >= 0 && point[1] >= data.minLevel && point[1] <= data.maxLevel &&
      (index === 0 ? point[0] === 0 : point[0] > points[index - 1][0]))) throw new Error('Hydrograph points must have increasing hours from zero and levels inside the gauge range.');
    if (!Number.isFinite(Date.parse(data.hydrograph.start))) throw new Error('Supply a valid hydrograph start date.');
  }
  return data;
}

export function stageAtTime(data, time) {
  if (!data.hydrograph) return Math.max(data.minLevel, Math.min(data.maxLevel, time));
  const points = data.hydrograph.points;
  if (time <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (time <= points[i][0]) {
      const [start, low] = points[i - 1], [end, high] = points[i];
      return low + (high - low) * (time - start) / (end - start);
    }
  }
  return points.at(-1)[1];
}

// Minimax Dijkstra: each cell opens at the lowest barrier along any path
// from a river seed. Four neighbours avoid diagonal leaks through levees.
// Optional costs and mask replace the elevations and validMask.
export function floodThresholds(data, elevations = data.elevations, validMask = data.validMask) {
  const { width, height, riverSeeds } = data;
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
      if (validMask && !validMask[next]) continue;
      const candidate = Math.max(level, elevations[next]);
      if (candidate < thresholds[next]) { thresholds[next] = candidate; push(next, candidate); }
    }
  }
  return thresholds;
}

// Conservative, local surface-water routing with a prescribed river boundary.
// Each step limits total outflow to the donor's available water. Closed raster
// edges retain water. Parameters are illustrative and are not calibrated.
export function createFloodSequence(data, thresholds = floodThresholds(data), options = {}) {
  const count = data.elevations.length;
  const start = data.hydrograph ? 0 : data.minLevel;
  const end = data.hydrograph ? data.hydrograph.points.at(-1)[0] : data.maxLevel;
  const initialStage = stageAtTime(data, start);
  const reservoir = new Uint8Array(count);
  for (let i = 0; i < count; i++) reservoir[i] = thresholds[i] <= initialStage ? 1 : 0;
  for (const index of data.riverSeeds) reservoir[index] = 1;
  let depths = new Float32Array(count);
  let next = new Float32Array(count);
  const frameCount = options.frameCount ?? Math.max(20, Math.min(data.hydrograph ? 181 : 161, Math.floor(48000000 / (count * 4))));
  const frames = [];
  const duration = data.hydrograph ? 480 : 160;
  const frameDuration = duration / (frameCount - 1);
  const substeps = Math.ceil(frameDuration / .025);
  const dt = frameDuration / substeps;
  const neighbours = new Int32Array(4);
  const rates = new Float64Array(4);
  function setRiver(stage) {
    for (let i = 0; i < count; i++) if (reservoir[i]) depths[i] = Math.max(0, stage - data.elevations[i]);
  }
  setRiver(initialStage);
  frames.push(depths.slice());
  for (let frame = 1; frame < frameCount; frame++) {
    for (let step = 1; step <= substeps; step++) {
      const progress = (frame - 1 + step / substeps) / (frameCount - 1);
      const stage = stageAtTime(data, start + progress * (end - start));
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
          const head = j < 0 || (data.validMask && !data.validMask[j]) ? 0 : Math.max(0, surface - Math.max(data.elevations[i], data.elevations[j] + depths[j]));
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
  return { frames, start, end };
}

// Animate a modelled peak-depth raster with the gauge hydrograph. Each wet
// cell's surface sits (peak stage - gauge stage) below its peak surface. A cell
// joins once a wet path connects it to the river (minimax on -peakDepth), then
// holds water at its sill when the river falls. The peak frame equals the raster.
export function createPeakAnchoredSequence(data, peakDepths, options = {}) {
  const count = data.elevations.length;
  if (!data.hydrograph || peakDepths.length !== count) throw new Error('Supply a hydrograph and one peak depth per cell.');
  const costs = new Float64Array(count), wet = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    wet[i] = peakDepths[i] > 0 && (!data.validMask || data.validMask[i]) ? 1 : 0;
    costs[i] = wet[i] ? -peakDepths[i] : Infinity;
  }
  const seeds = data.riverSeeds.filter(i => wet[i]);
  if (!seeds.length) throw new Error('No river seed is wet in the peak raster.');
  const arrival = floodThresholds({ ...data, riverSeeds: seeds }, costs, wet);
  // Wet patches with no path to the river (local ponding) fill in step with the river.
  const fallbackArrival = -Math.max(...data.hydrograph.points.map(point => point[1]));
  let ponded = 0;
  for (let i = 0; i < count; i++) if (wet[i] && arrival[i] === Infinity) { arrival[i] = Math.max(costs[i], fallbackArrival); ponded++; }
  const points = data.hydrograph.points;
  const start = 0, end = points.at(-1)[0];
  const peakStage = Math.max(...points.map(point => point[1]));
  const frameCount = options.frameCount ?? 181;
  const frames = [];
  let reached = -Infinity;
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = stageAtTime(data, start + frame * (end - start) / (frameCount - 1)) - peakStage;
    reached = Math.max(reached, offset);
    const depths = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      if (!wet[i] || arrival[i] > reached) continue;
      depths[i] = Math.max(0, peakDepths[i] + Math.max(offset, arrival[i]));
    }
    frames.push(depths);
  }
  return { frames, start, end, ponded, peakStage };
}

export function sampleFlood(sequence, time, output) {
  const position = Math.max(0, Math.min(1, (time - sequence.start) / (sequence.end - sequence.start))) * (sequence.frames.length - 1);
  const before = Math.floor(position), after = Math.min(before + 1, sequence.frames.length - 1);
  const fraction = position - before;
  for (let i = 0; i < output.length; i++) {
    output[i] = (sequence.frames[before][i] * (1 - fraction) + sequence.frames[after][i] * fraction) * (sequence.depthScale ?? 1);
  }
  return output;
}

// Extend the nearby wet surface under dry banks, then clip it against terrain
// in the shader. Dry bank elevations must not lift the water into triangles.
export function waterSurfaceElevations(data, depths, output) {
  const { width, height, elevations, validMask } = data;
  for (let i = 0; i < depths.length; i++) {
    if (depths[i] > .015 && (!validMask || validMask[i])) {
      output[i] = elevations[i] + depths[i];
      continue;
    }
    const row = Math.floor(i / width), col = i % width;
    let total = 0, count = 0;
    for (let y = Math.max(0, row - 1); y <= Math.min(height - 1, row + 1); y++) {
      for (let x = Math.max(0, col - 1); x <= Math.min(width - 1, col + 1); x++) {
        const neighbour = y * width + x;
        if (depths[neighbour] > .015 && (!validMask || validMask[neighbour])) {
          total += elevations[neighbour] + depths[neighbour];
          count++;
        }
      }
    }
    output[i] = count ? Math.min(elevations[i] - .015, total / count) : elevations[i] - .015;
  }
  return output;
}
