import { createFloodSequence } from './model.js';

self.onmessage = ({ data }) => {
  try {
    const sequence = createFloodSequence(data.dem, data.thresholds);
    self.postMessage({ sequence }, sequence.frames.map(frame => frame.buffer));
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
