# Bathtub

An embeddable Three.js view of the Tweed River at Murwillumbah, using the supplied terrain and bathymetry DEM and an approximate trace of the recorded 2022 gauge hydrograph. Play or scrub 24 February through 3 March, including rising water, gradual spill and recession. Playback takes 45 seconds at 1×.

The gauge trace is manually approximated from the supplied Figure C1 image, with a peak around 6.23 mAHD. It is not a downloaded gauge dataset. The TIFF does not identify its vertical datum, so alignment to AHD is assumed and disclosed in the app. Flood extent and timing remain illustrative and uncalibrated.

## Run locally

Use Node.js 24 or later.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. To check and build the static site, run `npm test` and `npm run build`. `npm run preview` serves the production build.

## GitHub Pages

The repository is connected to `https://github.com/lachlan-m-patterson/bathtub`. Pushes to `main` run tests, build and deploy through the included Pages workflow.

```sh
git add .
git commit -m "Describe the changes"
git push
```

Live site — https://lachlan-m-patterson.github.io/bathtub/

## StoryMaps embed

The root page is the embed view, containing the landscape, scenario panel and timeline. It fills the iframe viewport on desktop. Narrow screens stack the controls and allow vertical scrolling. The scenario panel scrolls independently when space is limited or model details are expanded.

After deployment, use the public HTTPS GitHub Pages URL in a StoryMaps embed block. This iframe example uses a 760 px height, which can be adjusted for the story layout.

```html
<iframe
  src="https://lachlan-m-patterson.github.io/bathtub/"
  title="Interactive river flood explorer"
  width="100%"
  height="760"
  style="border: 0;"
  loading="lazy"
  allowfullscreen
></iframe>
```

The localhost URL is for local preview. Story readers need the published HTTPS URL.

## Terrain and gauge preparation

The source `dem_seamless.tif` has 1 m pixels, a 4 km square extent and substantial NoData outside its principal land coverage. Its coordinate-system label is GDA2020 / MGA zone 56, stored as a local CRS. The prepared view selects the land-and-river square bounded by eastings 538000–540000 and northings 6865000–6867000. The original TIFF remains at its supplied location.

`scripts/prepare-dem.py` averages this crop to a 500 × 500 grid with 4 m cells, preserving negative elevations. The resulting elevation range is approximately −14.371 to 73.329 m. Resampling smooths narrow levees and other small terrain features. Validity is stored separately from elevations, so NoData is never treated as a deep channel. This selected crop has full coverage.

The river boundary is extracted as the largest connected terrain component at or below the initial 0.35 m gauge stage. One gauge stage is imposed throughout that channel, with no longitudinal water-surface slope. This boundary extraction is an approximation and is recorded in the dataset metadata.

To regenerate assets, install Python packages `rasterio` and `numpy`, then run these commands from the project folder, substituting the TIFF location.

```sh
python scripts/prepare-dem.py "PATH/TO/dem_seamless.tif"
python scripts/prepare-peak.py "PATH/TO/Tweed_001_2022_d_Max_cog.tif" --level "PATH/TO/Tweed_001_2022_h_Max_cog.tif"
node scripts/prepare-flood.js
npm test
npm run build
```

`public/data/hydrograph.json` contains editable `[hours since chart start, level in mAHD]` points traced from the black recorded series in the supplied image. Times preserve the chart's printed clock values. The image does not specify a timezone. Replace those points with a measured series when available, then rerun `node scripts/prepare-flood.js`.

## Import and export

The original synthetic generator remains in `src/model.js` for tests and alternative examples.

| Field | Meaning |
| --- | --- |
| `name` | Display name |
| `width`, `height` | Raster dimensions, at least 3 each, up to 250,000 cells total |
| `cellSize` | Square cell spacing in metres |
| `elevations` | Finite row-major elevations in metres; negative values are supported |
| `validMask` | Optional row-major 0/1 array; 0 excludes a cell from rendering and routing |
| `riverSeeds` | Indices of valid river cells |
| `minLevel`, `maxLevel` | Gauge display limits in the same vertical datum |
| `hydrograph` | Optional object containing `start` and increasing `[hour, level]` pairs starting at hour zero |
| `levees` | Optional `west` and `east` crest metadata for synthetic examples |

Rows run south and columns east in the prepared raster. The scene uses local coordinates and 1.5× vertical exaggeration. The real terrain displays its surveyed landforms, without decorative trees or synthetic levee labels.

## Flood behaviour

The default maximum flood envelope uses both `Tweed_001_2022_d_Max` (depth) and `Tweed_001_2022_h_Max` (water elevation). `scripts/prepare-peak.py` interprets their GDA94 / MGA zone 56 labels as EPSG:28356 and reprojects to the DEM's GDA2020 / MGA zone 56 grid (EPSG:7856), using nearest-neighbour sampling to retain the 4 m model results. The datum shift near the crop centre is about 0.58 m east and 1.38 m north.

The survey ground and flood-model ground differ locally. Within positive-depth cells, the rendered ground is derived from h_Max minus d_Max. The original survey elevations remain in `elevations` and are used outside the modelled wet extent. `modelGround` and `peakDepths` are also included in DEM exports so reimporting preserves the maximum envelope. This terrain adjustment has a median of +0.048 m and ranges from −5.646 to +5.056 m in this crop. It makes the displayed water heights and depths consistent with both supplied model rasters.

The aligned envelope has 169,988 wet cells (271.9808 ha before half-width display boundary weighting), with maximum depth 19.252 m. `public/data/peak-validation.json` records source names, CRS alignment and numerical checks. The published binary's peak frame is regression-tested against the prepared model data to within 1 mm.

Maximum rasters record each cell's maximum over the event, which need not occur simultaneously. The viewer shows this envelope at the gauge's highest point for comparison. It is labelled **Maximum flood envelope**.

Between frames, each wet cell's water surface sits below its peak surface by the gauge's distance below its 6.23 mAHD peak, so the modelled water-surface slope is kept throughout. A cell joins only once a path of wet cells connects it to the river (a minimax pass over peak depth), so basins behind levees fill when the falling-offset surface clears their sill. As the river recedes, connected basins hold water at their sill level; drainage through floodgates and pumps is not represented. Wet peak cells with no wet path to the river (about 15,000 cells of local ponding) rise with the river.

The default event is precomputed as 181 hourly snapshots and stored as gzip-compressed little-endian unsigned 16-bit depths in millimetres. The browser decompresses the snapshots locally. Playback interpolates adjacent snapshots. Backwards scrubbing revisits cached states, while forward playback includes the receding gauge stage and retained water behind terrain barriers. Imports are computed in a Web Worker.

The displayed dates locate the gauge trace. Maximum extent, depths and heights come from the flood model; timing before and after the peak is an interpolation from the gauge, not model output.

The wet water mesh follows simulated water-surface elevations. At dry banks, neighbouring wet surfaces extend beneath the terrain and are clipped at the shoreline, preventing dry bank vertices from lifting water into spikes. Shallow advancing fronts remain tied to the simulated wet cells. The gauge shows the imposed river boundary level, while basin surfaces can remain lower. Levee status indicates whether the river boundary exceeds the supplied crest metadata. Local water may arrive later. Metrics use simulated depths above 0.015 m, including the channel. Maximum depth is measured across those wet cells.

## Aerial imagery and shoreline appearance

The default view uses a bundled 4096 × 4096 JPEG exported from NSW Spatial Services' public NSW Imagery map service in GDA2020 / MGA zone 56, with the same bounds as the terrain. Vite publishes it as a content-hashed asset alongside the application. UV offsets align the image with DEM cell centres. The aerial image is draped over the 3D ground and has approximately 0.5 m pixel spacing over this crop. Capture date is unverified, so it is labelled reference imagery. Source attribution is displayed in the viewer. [NSW imagery service](https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer)

The bundled imagery adds about 5.2 MB to the site and loads from GitHub Pages. Other imported GDA2020 crops can request imagery from the public map service. A terrain view and retry control are available. The aerial/terrain toggle preserves the current event position and camera view.

Smooth edges uses bounded cubic interpolation of the shoreline depth field, screen-space antialiasing and shallow-water transparency. It trims and feathers the rendered edge within the original wet surface. This is a display treatment; stored flood depths, maximum surfaces and metrics still use the supplied raster data. Use the Smooth edges / Raw edges toggle to compare. Water colours and ripple contrast are subdued to suit aerial imagery.

## Buildings

`public/data/buildings.glb` holds 1,424 LiDAR-derived building boxes as one instanced unit box (`EXT_mesh_gpu_instancing`). `public/data/georeference.json` places them: model (0, 0, 0) is 539000 E, 6866000 N, 5 m elevation in GDA2020 / MGA zone 56, with +X east, +Y up and +Z grid south. The viewer offsets the group from the DEM bounds centre. Base elevations take the terrain's vertical exaggeration so buildings stay on the ground, but building heights are drawn at true scale. Box heights are LiDAR roof-top heights (median 5.9 m for houses), so pitched-roof houses look bulkier than they are. Building bases sit a median 0.7 m below the 4 m averaged DEM, which keeps them grounded on slopes. The LiDAR vertical datum is undeclared and assumed to match the DEM. The **Buildings** button hides them, and they appear only when the loaded DEM covers the georeference origin.

## Size

The published site is approximately 36.4 MB, including the DEM, gauge trace and 25.6 MB of precomputed flood depths. Source TIFFs are excluded from Git; the clipped peak depth raster (`scripts/data/tweed-peak-depth.bin`, 0.5 MB) is kept for regeneration. Source and deployable assets remain below 100 MB. Build output and installed dependencies are excluded from Git. Google Fonts are optional and system fallback fonts are available.
