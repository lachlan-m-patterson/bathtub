import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeDemo, validateDEM, floodThresholds, sampleFlood } from './model.js';
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
let floodSequence, waterDepths;
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

async function buildTerrain(nextData) {
  $('data-message').textContent = 'Preparing the flood progression…';
  const nextThresholds = floodThresholds(nextData);
  const nextSequence = await prepareFlood(nextData, nextThresholds);
  clearTerrain(); data = nextData; thresholds = nextThresholds;
  floodSequence = nextSequence; waterDepths = new Float32Array(data.elevations.length);
  datum = Math.min(...data.elevations.slice(0, 1));
  for (const value of data.elevations) datum = Math.min(datum, value);
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
    const ax = positions.getX(a), az = positions.getZ(a), ay = positions.getY(a);
    const bx = positions.getX(b), bz = positions.getZ(b), by = positions.getY(b);
    skirt.push(ax,ay,az,bx,by,bz,ax,skirtBottom,az,bx,by,bz,bx,skirtBottom,bz,ax,skirtBottom,az);
  }
  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirt, 3)); skirtGeometry.computeVertexNormals();
  terrainGroup.add(new THREE.Mesh(skirtGeometry, new THREE.MeshStandardMaterial({ color: '#8b9472', roughness: 1, side: THREE.DoubleSide })));
  const base = new THREE.Mesh(new THREE.BoxGeometry((width - 1) * cellSize, extent * .008, (height - 1) * cellSize), new THREE.MeshStandardMaterial({ color: '#6e7b60', roughness: 1 }));
  base.position.y = skirtBottom; terrainGroup.add(base);

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
  addTrees(positions);
  labelPositions = [new THREE.Vector3(-width * cellSize * .28, 65, 20), new THREE.Vector3(width * cellSize * .28, 70, -30)];
  $('river-name').textContent = data.name;
  $('dem-info').textContent = `${width} × ${height} cells / ${cellSize} m DEM / 8× relief`;
  $('timeline').min = data.minLevel; $('timeline').max = data.maxLevel;
  $('min-label').textContent = `${data.minLevel.toFixed(1)} m · Low flow`;
  $('max-label').textContent = `${data.maxLevel.toFixed(1)} m`;
  $('gauge-ticks').replaceChildren();
  for (let step = 0; step <= 7; step++) {
    const tick = document.createElement('div'); tick.className = 'gauge-tick'; tick.style.bottom = `${step / 7 * 100}%`;
    const text = document.createElement('span'); text.textContent = (data.minLevel + step / 7 * (data.maxLevel - data.minLevel)).toFixed(1);
    tick.append(text); $('gauge-ticks').append(tick);
  }
  for (const side of ['west', 'east']) {
    const crest = data.levees?.[side];
    $(`${side}-crest`).textContent = crest === undefined ? 'Unspecified' : `${crest.toFixed(2)} m`;
    $(`${side}-jump`).hidden = crest === undefined;
    $(`${side}-jump`).textContent = `${side === 'west' ? 'West' : 'East'} overtops · ${crest?.toFixed(1)} m`;
    $(`${side}-label`).hidden = !data.synthetic;
  }
  setPlaying(false); setLevel(Math.max(data.minLevel, Math.min(data.maxLevel, 2))); resetView();
  $('data-message').textContent = data.synthetic ? 'Synthetic terrain · illustrative flow' : `Loaded ${data.name}. All processing stays in this browser.`;
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
function setLevel(value) {
  level = THREE.MathUtils.clamp(value, data.minLevel, data.maxLevel);
  sampleFlood(floodSequence, level, waterDepths);
  waterMesh.geometry.attributes.depth.needsUpdate = true;
  $('timeline').value = level; $('level').textContent = level.toFixed(2);
  $('timeline').setAttribute('aria-valuetext', `${level.toFixed(2)} metres above model datum`);
  const progress = (level - data.minLevel) / (data.maxLevel - data.minLevel) * 100;
  $('gauge-fill').style.height = `${progress}%`; $('gauge-marker').style.bottom = `${progress}%`;
  let area = 0, maxDepth = 0;
  for (let i = 0; i < thresholds.length; i++) if (waterDepths[i] > .015) {
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
  $('stage-status').textContent = !data.levees ? 'Connected inundation' : ['Within the channel', 'One levee overtopping', 'Both levees overtopping'][overtopped];
}

$('timeline').addEventListener('input', event => { setPlaying(false); setLevel(Number(event.target.value)); });
$('play').addEventListener('click', () => { if (level >= data.maxLevel) setLevel(data.minLevel); setPlaying(!playing); });
$('restart').addEventListener('click', () => { setPlaying(false); setLevel(data.minLevel); });
$('reset-view').addEventListener('click', resetView);
$('top-view').addEventListener('click', () => { camera.position.set(0, extent * 1.8, 1); controls.target.set(0, 0, 0); controls.update(); });
for (const side of ['west', 'east']) $(`${side}-jump`).addEventListener('click', () => { setPlaying(false); setLevel(data.levees[side] + .08); });
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
  } catch (error) { $('data-message').textContent = `Could not load DEM. ${error.message}`; }
  event.target.disabled = false;
  event.target.value = '';
});
new ResizeObserver(() => {
  const { width, height } = viewport.getBoundingClientRect();
  renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
}).observe(viewport);
// Controls become available once the deterministic flood sequence is ready.
const scenarioControls = [...document.querySelectorAll('button, input, select')];
scenarioControls.forEach(control => { control.disabled = true; });
try {
  await buildTerrain(validateDEM(makeDemo()));
  scenarioControls.forEach(control => { control.disabled = false; });
} catch (error) {
  $('data-message').textContent = error.message;
  throw error;
}
renderer.setAnimationLoop(time => {
  const delta = Math.min((time - lastTime) / 1000, .1); lastTime = time;
  if (playing) {
    setLevel(level + delta * Number($('speed').value) * (data.maxLevel - data.minLevel) / 40);
    if (level >= data.maxLevel) setPlaying(false);
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
