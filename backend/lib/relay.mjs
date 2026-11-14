import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';

export class LocalRelay extends EventEmitter {
  ready = Promise.resolve();
  async control(message) { this.emit('control', message); }
  async event(message) { this.emit('event', message); }
  async close() {}
}

export class RedisRelay extends EventEmitter {
  constructor(url, token) {
    super();
    const prefix = 'esp32-ws:' + createHash('sha256').update(token).digest('hex').slice(0, 20);
    this.commands = prefix + ':commands'; this.events = prefix + ':events';
    const options = { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false,
      retryStrategy: attempt => Math.min(attempt * 500, 5000) };
    this.pub = new Redis(url, options); this.sub = new Redis(url, options);
    for (const client of [this.pub, this.sub]) {
      client.on('error', () => {}); // Never log connection URLs containing credentials.
      client.on('close', () => this.emit('unavailable'));
    }
    this.sub.on('message', (channel, text) => {
      try { this.emit(channel === this.commands ? 'control' : 'event', JSON.parse(text)); } catch {}
    });
    this.ready = this.connect();
    this.ready.catch(() => {});
  }
  async connect() {
    await Promise.all([this.pub.connect(), this.sub.connect()]);
    await this.sub.subscribe(this.commands, this.events);
  }
  async publish(channel, message) {
    await this.ready;
    if (this.pub.status !== 'ready' || this.sub.status !== 'ready') throw Error('Relay unavailable');
    await this.pub.publish(channel, JSON.stringify(message));
  }
  control(message) { return this.publish(this.commands, message); }
  event(message) { return this.publish(this.events, message); }
  async close() { this.pub.disconnect(); this.sub.disconnect(); }
}
