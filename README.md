# Bathtub

An embeddable Three.js view of the Tweed River at Murwillumbah, using the supplied terrain and bathymetry DEM and an approximate trace of the recorded 2022 gauge hydrograph. Play or scrub 24 February through 3 March, including rising water, gradual spill and recession. Playback takes 90 seconds at 1×.

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

`scripts/prepare-dem.py` averages this crop to a 250 × 250 grid with 8 m cells, preserving negative elevations. The resulting elevation range is approximately −14.054 to 72.911 m. Resampling smooths narrow levees and other small terrain features. Validity is stored separately from elevations, so NoData is never treated as a deep channel. This selected crop has full coverage.

The river boundary is extracted as the largest connected terrain component at or below the initial 0.35 m gauge stage. One gauge stage is imposed throughout that channel, with no longitudinal water-surface slope. This boundary extraction is an approximation and is recorded in the dataset metadata.

To regenerate assets, install Python packages `rasterio` and `numpy`, then run these commands from the project folder, substituting the TIFF location.

```sh
python scripts/prepare-dem.py "PATH/TO/dem_seamless.tif"
node scripts/prepare-flood.js
npm test
npm run build
```

`public/data/hydrograph.json` contains editable `[hours since chart start, level in mAHD]` points traced from the black recorded series in the supplied image. Times preserve the chart's printed clock values. The image does not specify a timezone. Replace those points with a measured series when available, then rerun `node scripts/prepare-flood.js`.

## Import and export

Export DEM downloads the current terrain, validity mask, source metadata and hydrograph as JSON. Load DEM validates this format and computes a replacement event in a Web Worker. The original synthetic generator remains in `src/model.js` for tests and alternative examples.

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

Rows run south and columns east in the prepared raster. The scene uses local coordinates and 8× vertical exaggeration. The real terrain displays its surveyed landforms, without decorative trees or synthetic levee labels.

## Flood behaviour

A local surface-water routing model moves water between four neighbouring cells according to water-surface head differences. Each step limits outflow to the donor cell's available water. Water crosses a levee only when its local surface exceeds the next terrain elevation, then runs down the slope and spreads over the basin. Closed raster boundaries retain water. River seeds and the initially connected wet channel supply the rising river boundary.

The default event is precomputed as 181 hourly snapshots and stored as little-endian unsigned 16-bit depths in millimetres. Playback interpolates adjacent snapshots. Backwards scrubbing revisits cached states, while forward playback includes the receding gauge stage and retained water behind terrain barriers. Imports are computed in a Web Worker.

The 180-hour chart event is compressed to 480 solver seconds using uncalibrated routing parameters. The displayed dates locate the gauge trace; inundation arrival times and extent are illustrative. The model omits momentum, rainfall and infiltration. Closed crop edges and missing-data boundaries retain water. Water can drain through the prescribed river channel as its stage falls.

The water mesh follows local terrain elevation plus depth, producing a sloping spill and shallow advancing front. The gauge shows the imposed river boundary level, while basin surfaces can remain lower. Levee status indicates whether the river boundary exceeds the supplied crest metadata. Local water may arrive later. Metrics use simulated depths above 0.015 m, including the channel. Maximum depth is measured across those wet cells.

## Size

The published site is approximately 25 MB, including the DEM, gauge trace and 22.6 MB of precomputed flood depths. Source and deployable assets remain below 100 MB. Build output and installed dependencies are excluded from Git. Google Fonts are optional and system fallback fonts are available.
