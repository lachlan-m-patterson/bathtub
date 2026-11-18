"""Clip the modelled 2022 peak depth raster to the viewer's DEM grid.

Run with Python, rasterio and numpy installed. Inputs remain untouched.
The 4 m model grid aligns with the 4 m DEM, so cells are read without resampling.
Output: uint16 little-endian millimetres, row-major, 0 where dry.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds

parser = argparse.ArgumentParser()
parser.add_argument("depth", type=Path, help="Peak depth GeoTIFF (d_Max)")
parser.add_argument("--level", type=Path, help="Peak water level GeoTIFF (h_Max), used only as a check")
parser.add_argument("--dem", type=Path, default=Path("public/data/tweed-dem.json"))
parser.add_argument("--output", type=Path, default=Path("scripts/data/tweed-peak-depth.bin"))
args = parser.parse_args()

dem = json.loads(args.dem.read_text(encoding="utf-8"))
bounds, width, height = dem["source"]["bounds"], dem["width"], dem["height"]

def read(path):
    with rasterio.open(path) as source:
        window = from_bounds(*bounds, source.transform)
        if (window.width, window.height) != (width, height) or window.col_off % 1 or window.row_off % 1:
            raise ValueError(f"{path.name} does not align with the {width} x {height} DEM grid")
        return source.read(1, window=window.round_offsets().round_lengths(), masked=True)

depth = read(args.depth)
peak = np.where(np.ma.getmaskarray(depth), 0, depth.filled(0)).clip(0, 65.535)
elevations = np.array(dem["elevations"]).reshape(height, width)
report = {"wetFraction": float((peak > 0).mean()), "maxDepth": float(peak.max())}
if args.level:
    ground = (read(args.level) - depth)[peak > 0]
    report["groundMinusDemMedian"] = float(np.ma.median(ground - elevations[peak > 0]))
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_bytes(np.round(peak * 1000).astype("<u2").tobytes())
print(json.dumps({"output": str(args.output), **report}))
