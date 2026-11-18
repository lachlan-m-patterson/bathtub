"""Align the modelled 2022 maxima with the GDA2020 viewer grid.

Model ground is h_Max minus d_Max wherever both rasters report positive depth.
Surveyed terrain is retained outside that extent. Source GeoTIFFs are untouched.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path

import numpy as np
# Prefer rasterio's bundled PROJ database over unrelated system GIS installs.
proj_data = Path(importlib.util.find_spec("rasterio").origin).parent / "proj_data"
if (proj_data / "proj.db").exists():
    os.environ["PROJ_DATA"] = str(proj_data)
    os.environ["PROJ_LIB"] = str(proj_data)
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject

parser = argparse.ArgumentParser()
parser.add_argument("depth", type=Path, help="Maximum depth GeoTIFF (d_Max)")
parser.add_argument("--level", type=Path, required=True, help="Maximum water elevation GeoTIFF (h_Max)")
parser.add_argument("--dem", type=Path, default=Path("public/data/tweed-dem.json"))
parser.add_argument("--output", type=Path, default=Path("scripts/data/tweed-peak-depth.bin"))
args = parser.parse_args()
dem = json.loads(args.dem.read_text(encoding="utf-8"))
bounds, width, height = dem["source"]["bounds"], dem["width"], dem["height"]
if 'GDA2020' not in dem["source"]["crsWkt"]:
    raise ValueError("Expected the supplied GDA2020 DEM")
target_transform = from_bounds(*bounds, width, height)


def read_aligned(path):
    with rasterio.open(path) as source:
        if 'GDA94' not in source.crs.to_wkt():
            raise ValueError(f"Expected the supplied GDA94 flood raster: {path}")
        target = np.full((height, width), -9999, dtype=np.float64)
        # The supplied TIFFs store LOCAL_CS labels, so provide the named EPSG
        # definitions explicitly. Nearest sampling preserves the 4 m maxima.
        reproject(source=rasterio.band(source, 1), destination=target,
                  src_transform=source.transform, src_crs="EPSG:28356",
                  src_nodata=source.nodata, dst_transform=target_transform,
                  dst_crs="EPSG:7856", dst_nodata=-9999,
                  resampling=Resampling.nearest)
        return target


depth = read_aligned(args.depth)
level = read_aligned(args.level)
valid = np.array(dem.get("validMask", [1] * (width * height))).reshape(height, width).astype(bool)
wet = valid & (depth > 0) & (level != -9999)
if np.any(valid & (depth > 0) & (level == -9999)):
    raise ValueError("Positive model depths lack matching water elevations")
peak = np.where(wet, depth, 0).round(3)
if peak.max() > 65.535:
    raise ValueError("Peak depth exceeds millimetre encoding capacity")
survey = np.array(dem["elevations"]).reshape(height, width)
model_ground = np.where(wet, level - peak, survey).round(3)
adjustment = (model_ground - survey)[wet]
report = {
    "sourceDepth": args.depth.name, "sourceLevel": args.level.name,
    "sourceCRS": "EPSG:28356", "targetCRS": "EPSG:7856",
    "resampling": "nearest", "wetCells": int(wet.sum()),
    "wetAreaHectares": float(wet.sum() * dem["cellSize"] ** 2 / 10000),
    "maximumDepth": float(peak.max()),
    "groundAdjustmentMedian": float(np.median(adjustment)),
    "groundAdjustmentMinimum": float(adjustment.min()),
    "groundAdjustmentMaximum": float(adjustment.max()),
    "maximumHeightErrorMetres": float(np.max(np.abs((model_ground + peak - level)[wet]))),
    "interpretation": "Per-cell maximum flood envelope; animation timing is illustrative",
    "terrain": "Model ground h_Max minus d_Max inside the wet envelope; supplied survey DEM outside"
}
dem["modelGround"] = model_ground.ravel().tolist()
dem["peakDepths"] = peak.ravel().tolist()
dem["source"]["peakModel"] = report
args.dem.write_text(json.dumps(dem, separators=(",", ":")), encoding="utf-8")
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_bytes(np.round(peak * 1000).astype("<u2").tobytes())
Path("public/data/peak-validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
