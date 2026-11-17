import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { validateDEM, floodThresholds, sampleFlood, stageAtTime } from './model.js';
import './style.css';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9eee3');
const camera = new THREE.PerspectiveCamera(38, 1, 1, 12000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor('#e9eee3');
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
const verticalScale = 8;
let data, thresholds, waterMaterial, waterMesh, level = 2, playing = false, extent = 800, datum = 0;
let floodSequence, waterDepths, eventTime = 0;
let timelineStops = [];
let labelPositions = [];
let lastTime = performance.now();

function terrainHeight(value) { return (value - datum) * verticalScale; }
function clearTerrain() {
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
  datum = Infinity;
  for (let i = 0; i < data.elevations.length; i++) {
    if (!data.validMask || data.validMask[i]) datum = Math.min(datum, data.elevations[i]);
  }
  const { width, height, cellSize, elevations } = data;
  extent = Math.max(width, height) * cellSize;
  const geometry = new THREE.PlaneGeometry((width - 1) * cellSize, (height - 1) * cellSize, width - 1, height - 1);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(width * height * 3);
  const green = new THREE.Color('#91a568'), high = new THREE.Color('#c1c596'), channel = new THREE.Color('#7a9172'), tan = new THREE.Color('#c9b981');
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
  terrainGroup.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
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

  // A shared surface follows local water depth down the levee and across land.
  const waterGeometry = geometry.clone();
  waterGeometry.setAttribute('depth', new THREE.BufferAttribute(waterDepths, 1).setUsage(THREE.DynamicDrawUsage));
  waterMaterial = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: `attribute float depth; varying float vDepth; varying vec2 vPosition;
      void main(){vDepth=depth; vPosition=position.xz; vec3 p=position; p.y+=depth*8.0+0.12; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
    fragmentShader: `uniform float time; varying float vDepth; varying vec2 vPosition;
      void main(){if(vDepth<=0.015) discard;
      float ripple=sin(vPosition.x*.12+vPosition.y*.08-time*1.5)*sin(vPosition.y*.19-time)*.025;
      vec3 c=mix(vec3(.36,.72,.73),vec3(.12,.43,.51),clamp(vDepth/4.0,0.0,1.0));
      float edge=1.0-smoothstep(.015,.12,vDepth);
      gl_FragColor=vec4(c+ripple+edge*.08,.9);}`,
    transparent: true, side: THREE.DoubleSide, depthWrite: false
  });
  waterMesh = new THREE.Mesh(waterGeometry, waterMaterial); waterMesh.frustumCulled = false; waterMesh.renderOrder = 2; terrainGroup.add(waterMesh);
  if (data.synthetic) addTrees(positions);
  labelPositions = [new THREE.Vector3(-width * cellSize * .28, 65, 20), new THREE.Vector3(width * cellSize * .28, 70, -30)];
  $('river-name').textContent = data.name;
  $('dem-info').textContent = `${width} × ${height} cells / ${cellSize} m DEM / 8× relief`;
  $('timeline').min = floodSequence.start; $('timeline').max = floodSequence.end;
  $('min-label').textContent = data.hydrograph ? formatEventTime(floodSequence.start, false) : `${data.minLevel.toFixed(1)} m`;
  $('max-label').textContent = data.hydrograph ? formatEventTime(floodSequence.end, false) : `${data.maxLevel.toFixed(1)} m`;
  $('datum-label').textContent = data.hydrograph ? 'mAHD · approximate gauge reading' : 'above model datum';
  $('scene-description').textContent = data.hydrograph ? 'Murwillumbah · terrain and river bathymetry' : 'A river, two levees, and the land beyond.';
  $('hydrograph-panel').hidden = !data.hydrograph;
  $('survey-note').hidden = !data.source;
  $('survey-note').textContent = data.source ? `${data.source.resolutionMetres ?? 'Unknown'} m source DEM averaged to ${cellSize} m. Negative elevations retained. ${data.verticalDatum ?? 'Vertical datum unspecified.'}` : '';
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
    $('east-jump').textContent = `Flood peak ~${peak[1].toFixed(2)} m`;
  }
  setPlaying(false); setTime(floodSequence.start); resetView();
  $('loading-message').hidden = true;
  $('data-message').textContent = data.hydrograph ? 'Gauge trace approximated from supplied Figure C1. Flood extent and timing are illustrative.' : data.synthetic ? 'Synthetic terrain · illustrative flow' : `Loaded ${data.name}. All processing stays in this browser.`;
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
    ctx.fillStyle = '#71816e'; ctx.fillText(String(stage), 6, y(stage) + 3);
  }
  ctx.strokeStyle = '#328c9b'; ctx.lineWidth = 2; ctx.beginPath();
  data.hydrograph.points.forEach(([hour, stage], index) => {
    if (index === 0) ctx.moveTo(x(hour), y(stage)); else ctx.lineTo(x(hour), y(stage));
  });
  ctx.stroke();
  ctx.strokeStyle = '#315b48'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(eventTime), top); ctx.lineTo(x(eventTime), bottom); ctx.stroke();
  ctx.fillStyle = '#315b48'; ctx.beginPath(); ctx.arc(x(eventTime), y(level), 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#71816e'; ctx.fillText(formatEventTime(0, false), left, height - 3); ctx.fillText(formatEventTime(floodSequence.end, false), right - 36, height - 3);
  canvas.setAttribute('aria-label', `Approximate recorded gauge hydrograph. ${formatEventTime(eventTime)}, ${level.toFixed(2)} metres AHD.`);
}
function setTime(value) {
  eventTime = THREE.MathUtils.clamp(value, floodSequence.start, floodSequence.end);
  level = stageAtTime(data, eventTime);
  sampleFlood(floodSequence, eventTime, waterDepths);
  waterMesh.geometry.attributes.depth.needsUpdate = true;
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
    const response = await fetch(`${import.meta.env.BASE_URL}data/${path}`);
    if (!response.ok) throw new Error(`Could not load ${path}. Reload to retry.`);
    return response;
  };
  $('data-message').textContent = 'Loading terrain and flood event…';
  const [dem, hydrograph, metadata, binary] = await Promise.all([
    fetchData('tweed-dem.json').then(response => response.json()),
    fetchData('hydrograph.json').then(response => response.json()),
    fetchData('tweed-flood.json').then(response => response.json()),
    fetchData('tweed-flood.bin').then(response => response.arrayBuffer())
  ]);
  dem.hydrograph = hydrograph;
  if (metadata.cellCount !== dem.width * dem.height || binary.byteLength !== metadata.frameCount * metadata.cellCount * 2) throw new Error('Flood data does not match the terrain. Reload to retry.');
  const frames = Array.from({ length: metadata.frameCount }, (_, index) => new Uint16Array(binary, index * metadata.cellCount * 2, metadata.cellCount));
  await buildTerrain(validateDEM(dem), { frames, start: metadata.start, end: metadata.end, depthScale: .001 });
  scenarioControls.forEach(control => { control.disabled = false; });
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
