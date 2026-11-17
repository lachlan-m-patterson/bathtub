# Bathtub

An interactive Three.js river flood demo using a generated DEM. Orbit the landscape, scrub the flood level, or play a 40-second rising-water sequence. The vertical gauge and inundation metrics update with the water surface. West and east levees have different crest elevations.

## Run locally

Use Node.js 24 or later.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. To check and build the static site, run `npm test` and `npm run build`. `npm run preview` serves the production build.

## GitHub Pages

The repository includes a Pages deployment workflow. Create an empty GitHub repository, add its URL as `origin`, and push `main`.

```sh
git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
git push -u origin main
```

In the repository's Settings → Pages, select **GitHub Actions** as the source. The included workflow builds and deploys `dist/`. Relative asset paths support repository subpaths. GitHub repository creation and remote publication are left for the repository owner.

## StoryMaps embed

The root page is the embed view, containing the landscape, scenario panel and timeline. It fills the iframe viewport on desktop. Narrow screens stack the controls and allow vertical scrolling. The scenario panel scrolls independently when space is limited or model details are expanded.

After deployment, use the public HTTPS GitHub Pages URL in a StoryMaps embed block. This iframe example uses a 760 px height, which can be adjusted for the story layout.

```html
<iframe
  src="https://YOUR-USER.github.io/YOUR-REPO/"
  title="Interactive river flood explorer"
  width="100%"
  height="760"
  style="border: 0;"
  loading="lazy"
  allowfullscreen
></iframe>
```

The localhost URL is for local preview. Story readers need the published HTTPS URL.

## Replacing the terrain

The app generates a deterministic 161 × 193 raster at 4 m spacing in `src/model.js`. Export DEM downloads the full example as JSON. Load DEM accepts the same format, validates it and rebuilds the scene. Processing is local to the browser.

Required JSON fields

| Field | Meaning |
| --- | --- |
| `name` | Display name |
| `width`, `height` | Integer raster dimensions, at least 3 each, up to 250,000 cells total |
| `cellSize` | Square cell spacing in metres |
| `elevations` | Flat row-major array of elevations in metres, all using one vertical datum |
| `riverSeeds` | Array of row-major indices inside the river channel |
| `minLevel`, `maxLevel` | Slider limits in metres using the same vertical datum |
| `levees` | Optional object with `west` and `east` crest elevations for the UI |

For a real DEM, reproject to a metric CRS, crop and resample to a square grid, fill or crop NoData, and convert the elevation raster to this JSON structure. Supply channel seeds from a river mask or drainage extraction. Embedded levees must be resolved by the DEM. The example river and levees are synthetic, with the channel carved into the generated elevations. A real-data hydrology extraction and GeoTIFF ingestion pipeline can be added later.

Rows increase along the scene's positive Z direction and columns along positive X. Geometry is centred locally, with 8× vertical exaggeration. Geographic coordinates are not currently displayed. Optional crest metadata describes the UI markers, while actual inundation is always computed from the raster.

## Flood behaviour

A local surface-water routing model moves water between four neighbouring cells according to water-surface head differences. Each step limits outflow to the donor cell's available water. Water crosses a levee only when its local surface exceeds the next terrain elevation, then runs down the slope and spreads over the basin. Closed raster boundaries retain water. River seeds and the initially connected wet channel supply the rising river boundary.

The flood sequence is computed in a Web Worker and cached in memory. Playback and scrubbing interpolate the same snapshots, including backwards scrubbing. Playback speed changes presentation speed. The 40-second animation shows 160 illustrative model seconds. Flow parameters are uncalibrated and omit momentum, rainfall and infiltration. Scrubbing backwards revisits the recorded rising event. It does not simulate a receding river.

The water mesh follows local terrain elevation plus depth, producing a sloping spill and shallow advancing front. The gauge shows the imposed river boundary level, while basin surfaces can remain lower. Levee status indicates whether the river boundary exceeds the supplied crest metadata. Local water may arrive later. Metrics use simulated depths above 0.015 m, including the channel. Maximum depth is measured across those wet cells.

## Size

The DEM is generated in code and requires no imagery or GIS download. The deployable site and tracked source are well below 100 MB. Build output and installed dependencies are excluded from Git. Google Fonts are optional and system fallback fonts are available.
