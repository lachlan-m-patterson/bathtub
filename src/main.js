import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateDEM, floodThresholds, sampleFlood, stageAtTime, waterSurfaceElevations } from './model.js';
import { imageryRequest } from './imagery.js';
import { waterVertexShader, waterFragmentShader } from './water-shaders.js';
import aerialImageUrl from './assets/tweed-aerial.jpg';
import './style.css';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#E9EDE4');
const camera = new THREE.PerspectiveCamera(38, 1, 1, 12000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor('#E9EDE4');
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.append(renderer.domElement);
renderer.domElement.setAttribute('aria-label', '3D DEM terrain with a river, levees and flood water');
renderer.domElement.setAttribute('role', 'img');
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
scene.add(new THREE.HemisphereLight('#fffef0', '#607654', 2.3));
const sun = new THREE.DirectionalLight('#fff4d8', 3.1);
sun.position.set(-300, 600, 200); scene.add(sun);
const terrainGroup = new THREE.Group(); scene.add(terrainGroup);
// LiDAR building boxes live outside terrainGroup so DEM rebuilds keep them.
const buildingGroup = new THREE.Group(); buildingGroup.visible = false; scene.add(buildingGroup);
let buildingOrigin = null, buildingsEnabled = true;
const verticalScale = 1.5;
let data, thresholds, waterMaterial, waterMesh, level = 2, playing = false, extent = 800, datum = 0;
let floodSequence, waterDepths, waterSurfaces, eventTime = 0;
let timelineStops = [];
let terrainMesh, terrainMaterial, aerialMaterial, imageryTexture, imageryController;
let shorelineField, shorelineTexture;
let aerialEnabled = true, smoothEdges = true;
let labelPositions = [];
let lastTime = performance.now();

function terrainHeight(value) { return (value - datum) * verticalScale; }
function clearTerrain() {
  imageryController?.abort();
  imageryTexture?.dispose();
  shorelineTexture?.dispose();
  if (terrainMaterial && terrainMesh?.material !== terrainMaterial) terrainMaterial.dispose();
  if (aerialMaterial && terrainMesh?.material !== aerialMaterial) aerialMaterial.dispose();
  aerialMaterial = null; imageryTexture = null;
  $('imagery-credit').hidden = true;
  for (const child of [...terrainGroup.children]) {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
    else child.material?.dispose();
    terrainGroup.remove(child);
  }
}

function prepareFlood(dem, thresholds) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./flood-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.sequence);
    };
    worker.onerror = () => {
      worker.terminate(); reject(new Error('Flood preparation failed. Reload to retry.'));
    };
    worker.postMessage({ dem, thresholds });
  });
}

async function buildTerrain(nextData, preparedSequence) {
  $('data-message').textContent = 'Preparing the flood progression…';
  $('loading-message').hidden = false;
  $('loading-message').textContent = 'Preparing the flood progression…';
  const nextThresholds = floodThresholds(nextData);
  const nextSequence = preparedSequence ?? await prepareFlood(nextData, nextThresholds);
  clearTerrain(); data = nextData; thresholds = nextThresholds;
  floodSequence = nextSequence; waterDepths = new Float32Array(data.elevations.length);
  waterSurfaces = new Float32Array(data.elevations.length);
  datum = Infinity;
  const elevations = data.modelGround ?? data.elevations;
  for (let i = 0; i < data.elevations.length; i++) {
    if (!data.validMask || data.validMask[i]) datum = Math.min(datum, elevations[i]);
  }
  const { width, height, cellSize } = data;
  extent = Math.max(width, height) * cellSize;
  const geometry = new THREE.PlaneGeometry((width - 1) * cellSize, (height - 1) * cellSize, width - 1, height - 1);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(width * height * 3);
  const green = new THREE.Color('#A5B198'), high = new THREE.Color('#DADBD0'), channel = new THREE.Color('#397B80'), tan = new THREE.Color('#c9b981');
  const color = new THREE.Color();
  for (let i = 0; i < elevations.length; i++) {
    positions.setY(i, terrainHeight(elevations[i]));
    color.copy(green).lerp(high, THREE.MathUtils.clamp((elevations[i] - data.minLevel) / (data.maxLevel + 8 - data.minLevel), 0, 1));
    if (thresholds[i] <= data.minLevel + .5) color.copy(channel);
    if (data.synthetic) {
      const row = Math.floor(i / width), z = row / (height - 1);
      const center = 80 + 13 * Math.sin(z * 7 - 1) + 5 * Math.sin(z * 14);
      if (Math.abs(Math.abs(i % width - center) - 13.5) < 3.5) color.copy(tan);
    }
    const texture = 0.97 + 0.035 * Math.sin(i * 31.7);
    color.multiplyScalar(texture).toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (data.validMask) {
    const indices = geometry.index.array;
    const validTriangles = [];
    for (let i = 0; i < indices.length; i += 3) {
      if (data.validMask[indices[i]] && data.validMask[indices[i + 1]] && data.validMask[indices[i + 2]]) {
        validTriangles.push(indices[i], indices[i + 1], indices[i + 2]);
      }
    }
    geometry.setIndex(validTriangles);
  }
  geometry.computeVertexNormals();
  terrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
  terrainMesh = new THREE.Mesh(geometry, terrainMaterial);
  terrainGroup.add(terrainMesh);
  // A skirt exposes the DEM as a terrain block.
  const edge = [];
  for (let x = 0; x < width; x++) edge.push(x);
  for (let y = 1; y < height; y++) edge.push(y * width + width - 1);
  for (let x = width - 2; x >= 0; x--) edge.push((height - 1) * width + x);
  for (let y = height - 2; y > 0; y--) edge.push(y * width);
  const skirt = [], skirtBottom = -extent * .035;
  for (let j = 0; j < edge.length; j++) {
    const a = edge[j], b = edge[(j + 1) % edge.length];
    if (data.validMask && (!data.validMask[a] || !data.validMask[b])) continue;
    const ax = positions.getX(a), az = positions.getZ(a), ay = positions.getY(a);
    const bx = positions.getX(b), bz = positions.getZ(b), by = positions.getY(b);
    skirt.push(ax,ay,az,bx,by,bz,ax,skirtBottom,az,bx,by,bz,bx,skirtBottom,bz,ax,skirtBottom,az);
  }
  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirt, 3)); skirtGeometry.computeVertexNormals();
  terrainGroup.add(new THREE.Mesh(skirtGeometry, new THREE.MeshStandardMaterial({ color: '#8b9472', roughness: 1, side: THREE.DoubleSide })));
  const base = new THREE.Mesh(new THREE.BoxGeometry((width - 1) * cellSize, extent * .008, (height - 1) * cellSize), new THREE.MeshStandardMaterial({ color: '#6e7b60', roughness: 1 }));
  base.position.y = skirtBottom;
  if (!data.validMask || data.validMask.every(Boolean)) terrainGroup.add(base);
  else { base.geometry.dispose(); base.material.dispose(); }

  // Water is extended under dry banks and clipped at the terrain intersection.
  const waterGeometry = geometry.clone();
  waterGeometry.setAttribute('surface', new THREE.BufferAttribute(waterSurfaces, 1).setUsage(THREE.DynamicDrawUsage));
  shorelineField = new Float32Array(elevations.length);
  shorelineTexture = new THREE.DataTexture(shorelineField, width, height, THREE.RedFormat, THREE.FloatType);
  shorelineTexture.minFilter = THREE.NearestFilter;
  shorelineTexture.magFilter = THREE.NearestFilter;
  waterMaterial = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 }, datum: { value: datum }, verticalScale: { value: verticalScale },
      shorelineDepth: { value: shorelineTexture }, gridSize: { value: new THREE.Vector2(width, height) },
      smoothShoreline: { value: smoothEdges ? 1 : 0 }
    },
    vertexShader: waterVertexShader,
    fragmentShader: waterFragmentShader,
    transparent: true, side: THREE.DoubleSide, depthWrite: false
  });
  waterMesh = new THREE.Mesh(waterGeometry, waterMaterial); waterMesh.frustumCulled = false; waterMesh.renderOrder = 2; terrainGroup.add(waterMesh);
  if (data.synthetic) addTrees(positions);
  labelPositions = [new THREE.Vector3(-width * cellSize * .28, 65, 20), new THREE.Vector3(width * cellSize * .28, 70, -30)];
  $('river-name').textContent = data.name;
  $('dem-info').textContent = `${width} × ${height} cells / ${cellSize} m DEM / ${verticalScale}× relief`;
  $('timeline').min = floodSequence.start; $('timeline').max = floodSequence.end;
  $('min-label').textContent = data.hydrograph ? formatEventTime(floodSequence.start, false) : `${data.minLevel.toFixed(1)} m`;
  $('max-label').textContent = data.hydrograph ? formatEventTime(floodSequence.end, false) : `${data.maxLevel.toFixed(1)} m`;
  $('datum-label').textContent = data.hydrograph ? 'above Australian Height Datum · approximate gauge trace' : 'above model datum';
  $('scene-title').textContent = data.hydrograph ? '2022 flood reconstruction' : 'River flood explorer';
  document.querySelector('.aside-top .muted').hidden = !data.hydrograph;
  $('scene-description').textContent = data.hydrograph ? 'Tweed River at Murwillumbah' : 'A river, two levees, and the land beyond.';
  document.querySelector('.gauge-card .eyebrow').textContent = data.hydrograph ? 'Gauge level' : 'Water level';
  $('hydrograph-panel').hidden = !data.hydrograph;
  $('survey-note').hidden = !data.source;
  $('survey-note').textContent = data.source ? `${data.source.resolutionMetres ?? 'Unknown'} m source DEM averaged to ${cellSize} m. Negative elevations retained. ${data.verticalDatum ?? 'Vertical datum unspecified.'}` : '';
  if (data.source?.peakModel) $('survey-note').textContent = '4 m terrain. Inside the flood envelope, ground is derived from h_Max − d_Max so both supplied maximum heights and depths agree. Survey terrain is retained outside.';
  document.querySelector('.basins').hidden = !data.levees;
  $('levee-legend').hidden = !data.synthetic;
  $('gauge-ticks').replaceChildren();
  for (let step = 0; step <= 7; step++) {
    const tick = document.createElement('div'); tick.className = 'gauge-tick'; tick.style.bottom = `${step / 7 * 100}%`;
    const text = document.createElement('span'); text.textContent = (data.minLevel + step / 7 * (data.maxLevel - data.minLevel)).toFixed(1);
    tick.append(text); $('gauge-ticks').append(tick);
  }
  for (const side of ['west', 'east']) {
    const crest = data.levees?.[side];
    $(`${side}-crest`).textContent = crest === undefined ? 'Unspecified' : `${crest.toFixed(2)} m`;
    $(`${side}-jump`).hidden = !data.hydrograph && crest === undefined;
    $(`${side}-jump`).textContent = `${side === 'west' ? 'West' : 'East'} overtops · ${crest?.toFixed(1)} m`;
    $(`${side}-label`).hidden = !data.synthetic;
  }
  timelineStops = [data.levees?.west + .08, data.levees?.east + .08];
  if (data.hydrograph) {
    const points = data.hydrograph.points;
    const peak = points.reduce((best, point) => point[1] > best[1] ? point : best);
    const firstPeak = points.find((point, i) => i > 0 && i < points.length - 1 && point[1] > points[i - 1][1] && point[1] >= points[i + 1][1]);
    timelineStops = [firstPeak?.[0] ?? 0, peak[0]];
    $('west-jump').textContent = 'First peak';
    $('east-jump').textContent = data.peakDepths ? 'Maximum flood envelope' : `Flood peak ~${peak[1].toFixed(2)} m`;
  }
  placeBuildings();
  setPlaying(false); setTime(floodSequence.start); resetView();
  $('loading-message').hidden = true;
  $('imagery-toggle').hidden = !imageryRequest(data, aerialImageUrl);
  if (imageryRequest(data, aerialImageUrl) && aerialEnabled) void loadImagery(data);
  $('data-message').textContent = data.peakDepths ? 'Maximum extent, depth and height from supplied model rasters. Event timing is interpolated from the approximate gauge trace.' : data.hydrograph ? 'Gauge trace approximated from supplied Figure C1. Flood extent and timing are illustrative.' : data.synthetic ? 'Synthetic terrain · illustrative flow' : `Loaded ${data.name}. All processing stays in this browser.`;
}

function addTrees(positions) {
  const sites = [];
  for (let i = 0; i < data.elevations.length; i += 37) {
    if (data.elevations[i] > data.maxLevel + .6 && data.elevations[i] < data.maxLevel + 8) sites.push(i);
  }
  const treeGeometry = new THREE.ConeGeometry(data.cellSize * 1.3, data.cellSize * 4.7, 5);
  const trees = new THREE.InstancedMesh(treeGeometry, new THREE.MeshStandardMaterial({ color: '#536d47', roughness: 1 }), sites.length);
  const transform = new THREE.Object3D();
  sites.forEach((index, i) => {
    transform.position.set(positions.getX(index), positions.getY(index) + data.cellSize * 2, positions.getZ(index));
    transform.rotation.y = index; transform.scale.setScalar(.7 + .3 * Math.abs(Math.sin(index))); transform.updateMatrix(); trees.setMatrixAt(i, transform.matrix);
  }); terrainGroup.add(trees);
}

function resetView() {
  camera.position.set(extent * .92, extent * .91, extent * 1.13);
  controls.target.set(0, extent * .04, 0); controls.minDistance = extent * .35; controls.maxDistance = extent * 4;
  camera.near = extent / 1000; camera.far = extent * 20; camera.updateProjectionMatrix(); controls.update();
}

function applyImagery() {
  const visible = aerialEnabled && aerialMaterial;
  terrainMesh.material = visible ? aerialMaterial : terrainMaterial;
  $('imagery-toggle').textContent = visible ? 'Aerial imagery' : 'Terrain view';
  $('imagery-toggle').setAttribute('aria-pressed', visible ? 'true' : 'false');
  $('imagery-toggle').title = 'Switch between aerial imagery and terrain';
  $('imagery-credit').hidden = !visible;
}

async function loadImagery(requestedData) {
  const request = imageryRequest(requestedData, aerialImageUrl);
  if (!request) return;
  imageryController?.abort();
  const controller = new AbortController();
  imageryController = controller;
  $('imagery-toggle').textContent = 'Loading imagery…';
  const timeout = setTimeout(() => controller.abort(), 45000);
  let objectUrl;
  try {
    const response = await fetch(request.url, { signal: controller.signal });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Imagery unavailable');
    objectUrl = URL.createObjectURL(await response.blob());
    const texture = await new THREE.TextureLoader().loadAsync(objectUrl);
    if (data !== requestedData || imageryController !== controller) { texture.dispose(); return; }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.offset.set(...request.offset); texture.repeat.set(...request.repeat);
    imageryTexture = texture;
    aerialMaterial = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    applyImagery();
  } catch {
    if (data === requestedData && imageryController === controller) {
      $('imagery-toggle').textContent = 'Retry aerial imagery';
      $('imagery-toggle').setAttribute('aria-pressed', 'false');
      $('imagery-toggle').title = 'The aerial image could not be loaded. Terrain view is active. Click to retry.';
    }
  } finally {
    clearTimeout(timeout);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

// Model (0,0,0) is the georeference origin; the scene centre is the DEM bounds centre.
// Only the vertical axis carries the relief exaggeration, matching the terrain.
function placeBuildings() {
  const bounds = data?.source?.bounds;
  const [east, north, elevation] = buildingOrigin ?? [];
  const covers = bounds && buildingOrigin && east >= bounds[0] && east <= bounds[2] && north >= bounds[1] && north <= bounds[3];
  $('buildings-toggle').hidden = !covers;
  buildingGroup.visible = Boolean(covers && buildingsEnabled);
  if (!covers) return;
  buildingGroup.position.set(east - (bounds[0] + bounds[2]) / 2, (elevation - datum) * verticalScale, (bounds[1] + bounds[3]) / 2 - north);
}
async function loadBuildings(fetchData) {
  const [georeference, glb] = await Promise.all([
    fetchData('georeference.json').then(response => response.json()),
    fetchData('buildings.glb').then(response => response.arrayBuffer())
  ]);
  if (georeference.working_crs?.epsg !== 7856) throw new Error('Buildings are not in GDA2020 / MGA zone 56.');
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  // Exaggerate only each base elevation so buildings sit on the scaled terrain;
  // building heights stay true to scale.
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), size = new THREE.Vector3();
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    object.material = new THREE.MeshStandardMaterial({ color: '#ECE9DF', roughness: .9 });
    object.frustumCulled = false;
    if (!object.isInstancedMesh) return;
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, matrix);
      matrix.decompose(position, rotation, size);
      position.y *= verticalScale;
      object.setMatrixAt(i, matrix.compose(position, rotation, size));
    }
    object.instanceMatrix.needsUpdate = true;
  });
  buildingGroup.add(gltf.scene);
  buildingOrigin = georeference.origin.working_easting_northing_elevation;
  placeBuildings();
}
$('buildings-toggle').addEventListener('click', () => {
  buildingsEnabled = !buildingsEnabled;
  $('buildings-toggle').setAttribute('aria-pressed', String(buildingsEnabled));
  placeBuildings();
});
$('imagery-toggle').addEventListener('click', () => {
  if (!aerialMaterial) { aerialEnabled = true; void loadImagery(data); return; }
  aerialEnabled = !aerialEnabled;
  applyImagery();
});
$('smooth-toggle').addEventListener('click', () => {
  smoothEdges = !smoothEdges;
  waterMaterial.uniforms.smoothShoreline.value = smoothEdges ? 1 : 0;
  $('smooth-toggle').setAttribute('aria-pressed', String(smoothEdges));
  $('smooth-toggle').textContent = smoothEdges ? 'Smooth edges' : 'Raw edges';
});
function setPlaying(value) {
  playing = value; $('play').textContent = value ? 'Ⅱ' : '▶'; $('play').setAttribute('aria-label', value ? 'Pause flood animation' : 'Play flood animation');
}
function formatEventTime(hour, includeClock = true) {
  // UTC here preserves the chart's printed clock times without inferring a zone.
  const start = data.hydrograph.start.slice(0, 19).replace(/Z$/, '') + 'Z';
  const clock = includeClock ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {};
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', ...clock, timeZone: 'UTC' })
    .format(new Date(Date.parse(start) + hour * 3600000));
}
function drawHydrograph() {
  if (!data?.hydrograph) return;
  const canvas = $('hydrograph');
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(devicePixelRatio, 2);
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  const left = 25, right = width - 12, top = 12, bottom = height - 20;
  const x = hour => left + hour / floodSequence.end * (right - left);
  const y = stage => bottom - (stage - data.minLevel) / (data.maxLevel - data.minLevel) * (bottom - top);
  ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
  for (const stage of [0, 3, 6]) {
    ctx.strokeStyle = '#dce2d5'; ctx.beginPath(); ctx.moveTo(left, y(stage)); ctx.lineTo(right, y(stage)); ctx.stroke();
    ctx.fillStyle = '#405454'; ctx.fillText(String(stage), 6, y(stage) + 3);
  }
  ctx.strokeStyle = '#397B80'; ctx.lineWidth = 2; ctx.beginPath();
  data.hydrograph.points.forEach(([hour, stage], index) => {
    if (index === 0) ctx.moveTo(x(hour), y(stage)); else ctx.lineTo(x(hour), y(stage));
  });
  ctx.stroke();
  ctx.strokeStyle = '#285843'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(eventTime), top); ctx.lineTo(x(eventTime), bottom); ctx.stroke();
  ctx.fillStyle = '#285843'; ctx.beginPath(); ctx.arc(x(eventTime), y(level), 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#405454'; ctx.fillText(formatEventTime(0, false), left, height - 3); ctx.fillText(formatEventTime(floodSequence.end, false), right - 36, height - 3);
  canvas.setAttribute('aria-label', `Approximate recorded gauge hydrograph. ${formatEventTime(eventTime)}, ${level.toFixed(2)} metres AHD.`);
}
function setTime(value) {
  eventTime = THREE.MathUtils.clamp(value, floodSequence.start, floodSequence.end);
  level = stageAtTime(data, eventTime);
  sampleFlood(floodSequence, eventTime, waterDepths);
  waterSurfaceElevations(data, waterDepths, waterSurfaces);
  waterMesh.geometry.attributes.surface.needsUpdate = true;
  const ground = data.modelGround ?? data.elevations;
  for (let i = 0; i < shorelineField.length; i++) shorelineField[i] = waterSurfaces[i] - ground[i];
  shorelineTexture.needsUpdate = true;
  $('timeline').value = eventTime; $('level').textContent = level.toFixed(2);
  $('timeline').setAttribute('aria-valuetext', data.hydrograph ? `${formatEventTime(eventTime)}, approximately ${level.toFixed(2)} metres AHD` : `${level.toFixed(2)} metres above model datum`);
  $('event-time').textContent = data.hydrograph ? formatEventTime(eventTime) : 'Follow the rising water';
  drawHydrograph();
  const progress = (level - data.minLevel) / (data.maxLevel - data.minLevel) * 100;
  $('gauge-fill').style.height = `${progress}%`; $('gauge-marker').style.bottom = `${progress}%`;
  let area = 0, maxDepth = 0;
  for (let i = 0; i < thresholds.length; i++) if (waterDepths[i] > .015 && (!data.validMask || data.validMask[i])) {
    const col = i % data.width, row = Math.floor(i / data.width);
    const edgeFactor = (col === 0 || col === data.width - 1 ? .5 : 1) * (row === 0 || row === data.height - 1 ? .5 : 1);
    area += data.cellSize ** 2 * edgeFactor; maxDepth = Math.max(maxDepth, waterDepths[i]);
  }
  $('area').textContent = (area / 10000).toFixed(2); $('depth').textContent = maxDepth.toFixed(2);
  let overtopped = 0;
  for (const side of ['west','east']) {
    const crest = data.levees?.[side];
    const open = crest !== undefined && level > crest;
    $(`${side}-state`).textContent = crest === undefined ? 'Unknown' : open ? 'Overtopping' : 'Holding';
    $(`${side}-state`).classList.toggle('overtopped', open);
    if (open) overtopped++;
  }
  $('stage-status').textContent = data.hydrograph ? (eventTime >= floodSequence.end ? 'End of event' : stageAtTime(data, eventTime + .05) >= level ? 'River rising' : 'River receding') : !data.levees ? 'Connected inundation' : ['Within the channel', 'One levee overtopping', 'Both levees overtopping'][overtopped];
}

$('timeline').addEventListener('input', event => { setPlaying(false); setTime(Number(event.target.value)); });
$('play').addEventListener('click', () => { if (eventTime >= floodSequence.end) setTime(floodSequence.start); setPlaying(!playing); });
$('restart').addEventListener('click', () => { setPlaying(false); setTime(floodSequence.start); });
$('reset-view').addEventListener('click', resetView);
$('top-view').addEventListener('click', () => { camera.position.set(0, extent * 1.8, 1); controls.target.set(0, 0, 0); controls.update(); });
['west', 'east'].forEach((side, index) => $(`${side}-jump`).addEventListener('click', () => { setPlaying(false); setTime(timelineStops[index]); }));
$('export-dem').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'river-dem.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('import-dem').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  event.target.disabled = true;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Use a DEM JSON file smaller than 20 MB.');
    const imported = validateDEM(JSON.parse(await file.text()));
    imported.synthetic = false;
    await buildTerrain(imported);
  } catch (error) {
    $('data-message').textContent = `Could not load DEM. ${error.message}`;
    $('loading-message').hidden = true;
  }
  event.target.disabled = false;
  event.target.value = '';
});
new ResizeObserver(() => {
  const { width, height } = viewport.getBoundingClientRect();
  renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
}).observe(viewport);
new ResizeObserver(drawHydrograph).observe($('hydrograph'));
// Controls become available once the deterministic flood sequence is ready.
const scenarioControls = [...document.querySelectorAll('button, input, select')];
scenarioControls.forEach(control => { control.disabled = true; });
try {
  const fetchData = async path => {
    const response = await fetch(`${import.meta.env.BASE_URL}data/${path}?v=peak-height-depth-2022`);
    if (!response.ok) throw new Error(`Could not load ${path}. Reload to retry.`);
    return response;
  };
  $('data-message').textContent = 'Loading terrain and flood event…';
  const [dem, hydrograph, metadata, compressed] = await Promise.all([
    fetchData('tweed-dem.json').then(response => response.json()),
    fetchData('hydrograph.json').then(response => response.json()),
    fetchData('tweed-flood.json').then(response => response.json()),
    fetchData('tweed-flood.bin.gz').then(response => response.arrayBuffer())
  ]);
  dem.hydrograph = hydrograph;
  // Some hosts decompress gzip responses automatically; support either form.
  const signature = new Uint8Array(compressed, 0, Math.min(2, compressed.byteLength));
  const binary = signature[0] === 0x1f && signature[1] === 0x8b
    ? await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    : compressed;
  if (metadata.cellCount !== dem.width * dem.height || binary.byteLength !== metadata.frameCount * metadata.cellCount * 2) throw new Error('Flood data does not match the terrain. Reload to retry.');
  const frames = Array.from({ length: metadata.frameCount }, (_, index) => new Uint16Array(binary, index * metadata.cellCount * 2, metadata.cellCount));
  await buildTerrain(validateDEM(dem), { frames, start: metadata.start, end: metadata.end, depthScale: .001 });
  scenarioControls.forEach(control => { control.disabled = false; });
  // Buildings are optional; the flood view stays usable if they fail.
  loadBuildings(fetchData).catch(error => console.warn('Buildings unavailable:', error));
} catch (error) {
  $('data-message').textContent = error.message;
  $('loading-message').textContent = error.message;
  throw error;
}
renderer.setAnimationLoop(time => {
  const delta = Math.min((time - lastTime) / 1000, .1); lastTime = time;
  if (playing) {
    setTime(eventTime + delta * Number($('speed').value) * (floodSequence.end - floodSequence.start) / (data.hydrograph ? 90 : 40));
    if (eventTime >= floodSequence.end) setPlaying(false);
  }
  waterMaterial.uniforms.time.value = time / 1000; controls.update();
  labelPositions.forEach((position, index) => {
    const projected = position.clone().project(camera);
    const label = $(index === 0 ? 'west-label' : 'east-label');
    label.style.left = `${(projected.x * .5 + .5) * viewport.clientWidth}px`;
    label.style.top = `${(-projected.y * .5 + .5) * viewport.clientHeight}px`;
    label.style.visibility = Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || projected.z > 1 ? 'hidden' : 'visible';
  });
  renderer.render(scene, camera);
});
