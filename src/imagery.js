const service = 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/export';

export function imageryRequest(data) {
  const bounds = data.source?.bounds;
  if (!data.source?.crsWkt?.includes('GDA2020') || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return null;
  const [left, bottom, right, top] = bounds;
  if (right <= left || top <= bottom) return null;
  const params = new URLSearchParams({
    bbox: bounds.join(','), bboxSR: '7856', imageSR: '7856',
    size: '4096,4096', format: 'jpg', f: 'image'
  });
  // Raster geometry ends at cell centres; export imagery spans the outer bounds.
  const insetX = data.cellSize / (right - left) / 2;
  const insetY = data.cellSize / (top - bottom) / 2;
  return { url: `${service}?${params}`, offset: [insetX, insetY], repeat: [1 - 2 * insetX, 1 - 2 * insetY] };
}
