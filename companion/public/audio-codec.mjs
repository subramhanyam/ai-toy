export function encodeMuLaw(sample) {
  let pcm = Math.max(-32635, Math.min(32635, Math.round(sample * 32768)));
  const sign = pcm < 0 ? 0x80 : 0;
  if (pcm < 0) pcm = -pcm;
  pcm += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(pcm & mask); mask >>= 1) exponent--;
  return (~(sign | (exponent << 4) | ((pcm >> (exponent + 3)) & 15))) & 255;
}
export function decodeMuLaw(value) {
  const u = (~value) & 255;
  const pcm = (((u & 15) << 3) + 0x84) << ((u >> 4) & 7);
  return ((u & 0x80) ? (0x84 - pcm) : (pcm - 0x84)) / 32768;
}
export function toBase64(bytes) {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function fromBase64(text) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }

// Integrate across sample boundaries, preserving rate even at 44.1 kHz.
export class MuLawCapture {
  constructor(rate) { this.ratio = rate / 8000; this.reset(); }
  reset() { this.weight = 0; this.sum = 0; this.frame = []; }
  push(samples, emit) {
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const weight = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * weight; this.weight += weight; remaining -= weight;
        if (this.weight >= this.ratio - 1e-8) {
          this.frame.push(encodeMuLaw(this.sum / this.ratio)); this.weight = 0; this.sum = 0;
          if (this.frame.length === 160) { emit(Uint8Array.from(this.frame)); this.frame = []; }
        }
      }
    }
  }
}
