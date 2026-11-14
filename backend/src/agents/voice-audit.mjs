import { appendFileSync, readFileSync } from 'node:fs';

// No audio, captions, credentials or API keys. The configured local path is
// inside ignored .tools; tests without that path do not touch the filesystem.
export function recordVoiceSession(config, record) {
  if (config.voiceAuditFile) appendFileSync(config.voiceAuditFile, JSON.stringify(record) + '\n', { mode: 0o600 });
  else if (config.cloud) console.info('voice_session_end', JSON.stringify(record));
}

export function summarizeVoiceAudit(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { confirmed: 0, confirmedSeconds: 0, unconfirmed: [], cancelledBeforeCreation: 0, damagedLines: 0 }; throw error; }
  const sessions = new Map(); let damagedLines = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line), id = record.sessionId || record.openId || record.requestedAt;
      if (!id) continue;
      sessions.set(id, record);
    } catch { damagedLines++; }
  }
  let confirmed = 0, confirmedSeconds = 0, cancelledBeforeCreation = 0; const unconfirmed = [];
  for (const record of sessions.values()) {
    if (record.finalized && record.usageFinal !== false && Number.isFinite(record.seconds)) { confirmed++; confirmedSeconds += record.seconds; }
    else if (record.event === 'closed' && !record.startSent) cancelledBeforeCreation++;
    else unconfirmed.push({ sessionId: record.sessionId, openId: record.openId, activeAt: record.activeAt, reason: record.apiReason || 'no_close_record', closureConfirmed: !!record.finalized });
  }
  return { confirmed, confirmedSeconds, unconfirmed, cancelledBeforeCreation, damagedLines };
}
