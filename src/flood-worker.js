import { createFloodSequence, createPeakAnchoredSequence } from './model.js';

self.onmessage = ({ data }) => {
  try {
    const sequence = data.dem.peakDepths
      ? createPeakAnchoredSequence(data.dem, data.dem.peakDepths)
      : createFloodSequence(data.dem, data.thresholds);
    self.postMessage({ sequence }, sequence.frames.map(frame => frame.buffer));
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
