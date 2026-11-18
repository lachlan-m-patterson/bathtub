import test from 'node:test';
import assert from 'node:assert/strict';
import { imageryRequest } from './imagery.js';

test('aerial imagery aligns its crop with DEM cell centres in GDA2020', () => {
  const request = imageryRequest({ cellSize: 4, source: {
    crsWkt: 'LOCAL_CS["GDA2020 / MGA zone 56"]', bounds: [538000,6865000,540000,6867000]
  } });
  const url = new URL(request.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.searchParams.get('bboxSR'), '7856');
  assert.equal(url.searchParams.get('imageSR'), '7856');
  assert.equal(url.searchParams.get('f'), 'image');
  assert.deepEqual(request.offset, [.001,.001]);
  assert.deepEqual(request.repeat, [.998,.998]);
  assert.equal(538000 + request.offset[0] * 2000, 538002);
  assert.equal(538000 + (request.offset[0] + request.repeat[0]) * 2000, 539998);
});

test('imagery is unavailable for unreferenced or incompatible terrain', () => {
  assert.equal(imageryRequest({ cellSize: 4 }), null);
  assert.equal(imageryRequest({ cellSize: 4, source: { crsWkt: 'GDA94', bounds: [1,2,3,4] } }), null);
});

test('the default crop loads the bundled image and other crops use the map service', () => {
  const data = { cellSize: 4, source: { crsWkt: 'GDA2020 / MGA zone 56', bounds: [538000,6865000,540000,6867000] } };
  const localUrl = '/bathtub/assets/tweed-aerial-hash.jpg';
  assert.equal(imageryRequest(data, localUrl).url, localUrl);
  const other = { ...data, source: { ...data.source, bounds: [537000,6865000,539000,6867000] } };
  assert.ok(imageryRequest(other, localUrl).url.startsWith('https://maps.six.nsw.gov.au/'));
});
