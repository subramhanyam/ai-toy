import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMuLaw, decodeMuLaw, MuLawCapture, fromBase64, toBase64 } from '../public/audio-codec.mjs';

test('G.711 mu-law silence, known values, signs and bounded speech quantization', () => {
  assert.equal(encodeMuLaw(0), 255); assert.equal(decodeMuLaw(255), 0);
  assert.equal(decodeMuLaw(0), -32124 / 32768);
  assert.equal(decodeMuLaw(128), 32124 / 32768);
  for (const sample of [-0.9, -0.1, -0.01, 0, 0.01, 0.1, 0.9]) assert.ok(Math.abs(sample - decodeMuLaw(encodeMuLaw(sample))) < 0.035);
  const data = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromBase64(toBase64(data)), data);
});

test('capture resamples 44.1/48 kHz into ordered 20 ms frames with no rate drift', () => {
  for (const rate of [44100, 48000]) {
    const capture = new MuLawCapture(rate), frames = [];
    const input = Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / rate));
    for (let offset = 0; offset < input.length; offset += 128) capture.push(input.subarray(offset, offset + 128), frame => frames.push(frame));
    assert.equal(frames.length, 50); assert.ok(frames.every(frame => frame.length === 160));
    const decoded = frames.flatMap(frame => Array.from(frame, decodeMuLaw));
    let crossings = 0; for (let n = 1; n < decoded.length; n++) if (decoded[n - 1] < 0 && decoded[n] >= 0) crossings++;
    assert.ok(crossings >= 438 && crossings <= 441);
    capture.reset(); assert.equal(capture.frame.length, 0);
  }
});
