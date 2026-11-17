"""Prepare the supplied Murwillumbah GeoTIFF for the static viewer.

Run with Python, rasterio and numpy installed. The input remains untouched.
"""
import argparse
from collections import deque
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("--output", type=Path, default=Path("public/data/tweed-dem.json"))
parser.add_argument("--cell-size", type=int, default=4)
args = parser.parse_args()
bounds = [538000, 6865000, 540000, 6867000]
cell_size = args.cell_size
if cell_size < 4 or 2000 % cell_size:
    raise ValueError("Cell size must divide 2000 and be at least 4 metres")
width = height = 2000 // cell_size
with rasterio.open(args.source) as source:
    window = from_bounds(*bounds, source.transform)
    raster = source.read(1, window=window, out_shape=(height, width),
                         masked=True, resampling=Resampling.average)
    # Require a majority of actual source coverage in each reduced cell.
    coverage = source.read_masks(1, window=window, out_shape=(height, width),
                                 resampling=Resampling.average)
    valid = (~np.ma.getmaskarray(raster)) & (coverage >= 128)
    elevations = np.where(valid, raster.filled(0), 0).astype(np.float64).round(3)
    crs = source.crs.to_wkt()

# The largest low-elevation connected component supplies the river boundary.
# NoData is excluded, including its numeric -9999 sentinel.
wet = valid & (elevations <= 0.35)
visited = np.zeros(wet.shape, dtype=bool)
largest = []
for row, col in zip(*np.where(wet)):
    if visited[row, col]:
        continue
    queue = deque([(int(row), int(col))])
    visited[row, col] = True
    component = []
    while queue:
        y, x = queue.popleft()
        component.append(y * width + x)
        for ny, nx in ((y-1, x), (y+1, x), (y, x-1), (y, x+1)):
            if 0 <= ny < height and 0 <= nx < width and wet[ny, nx] and not visited[ny, nx]:
                visited[ny, nx] = True
                queue.append((ny, nx))
    if len(component) > len(largest):
        largest = component

data = {
    "name": "Tweed River · Murwillumbah", "width": width, "height": height,
    "cellSize": cell_size, "elevations": elevations.ravel().tolist(),
    "validMask": valid.ravel().astype(int).tolist(), "riverSeeds": largest,
    "minLevel": 0, "maxLevel": 7, "synthetic": False,
    "verticalDatum": "Assumed AHD · TIFF datum unconfirmed",
    "source": {"file": args.source.name, "resolutionMetres": 1,
               "crsWkt": crs, "bounds": bounds, "resampling": f"{cell_size} m area average; majority valid coverage",
               "verticalDatumConfirmed": False,
               "riverBoundary": "Largest connected component at or below 0.35 m"}
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
print(json.dumps({"output": str(args.output), "validCells": int(valid.sum()),
                  "riverCells": len(largest), "minimum": float(elevations[valid].min()),
                  "maximum": float(elevations[valid].max()), "bytes": args.output.stat().st_size}))
