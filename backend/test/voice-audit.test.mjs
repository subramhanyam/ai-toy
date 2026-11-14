import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordVoiceSession, summarizeVoiceAudit } from '../src/agents/voice-audit.mjs';

test('audit preserves crash evidence and counts only final usage once per session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-report-')), file = join(dir, 'audit.jsonl');
  try {
    const config = { voiceAuditFile: file };
    recordVoiceSession(config, { event: 'started', sessionId: 'crashed', activeAt: '2026-11-15T00:00:00Z' });
    recordVoiceSession(config, { event: 'started', sessionId: 'ended' });
    recordVoiceSession(config, { event: 'closed', sessionId: 'ended', finalized: true, usageFinal: true, seconds: 5, startSent: true });
    recordVoiceSession(config, { event: 'closed', sessionId: 'ended', finalized: true, usageFinal: true, seconds: 5, startSent: true });
    recordVoiceSession(config, { event: 'closed', sessionId: 'unknown', finalized: false, seconds: 3, startSent: true });
    recordVoiceSession(config, { event: 'closed', openId: 'cancelled', finalized: false, startSent: false });
    appendFileSync(file, '{interrupted write');
    const summary = summarizeVoiceAudit(file);
    assert.equal(summary.confirmed, 1); assert.equal(summary.confirmedSeconds, 5);
    assert.equal(summary.unconfirmed.length, 2); assert.ok(summary.unconfirmed.some(r => r.sessionId === 'crashed'));
    assert.equal(summary.cancelledBeforeCreation, 1); assert.equal(summary.damagedLines, 1);
    writeFileSync(file, ''); assert.equal(summarizeVoiceAudit(file).confirmed, 0);
  } finally { unlinkSync(file); rmdirSync(dir); }
});
