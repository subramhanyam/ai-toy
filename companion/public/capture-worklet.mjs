import { MuLawCapture } from './audio-codec.mjs';
class Capture extends AudioWorkletProcessor {
  constructor() {
    super(); this.capture = new MuLawCapture(sampleRate); this.active = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') { this.capture.reset(); this.active = true; }
      if (data.type === 'stop') { this.active = false; this.port.postMessage({ type: 'flushed' }); }
    };
  }
  process(inputs) {
    if (this.active && inputs[0]?.[0]) this.capture.push(inputs[0][0], bytes => this.port.postMessage({ type: 'audio', bytes }, [bytes.buffer]));
    return true;
  }
}
registerProcessor('usb-capture', Capture);
