import { fileURLToPath } from 'node:url';
import { summarizeVoiceAudit } from '../src/agents/voice-audit.mjs';

const summary = summarizeVoiceAudit(fileURLToPath(new URL('../../.tools/voice-sessions.jsonl', import.meta.url)));
console.log(`Confirmed sessions: ${summary.confirmed}; final voice duration: ${summary.confirmedSeconds.toFixed(1)} seconds.`);
console.log(`Cancelled before creating an API session: ${summary.cancelledBeforeCreation}.`);
console.log(`Sessions with unconfirmed closure or final usage: ${summary.unconfirmed.length}.`);
for (const record of summary.unconfirmed) console.log(JSON.stringify(record));
if (summary.damagedLines) console.log(`Incomplete audit lines: ${summary.damagedLines}.`);
console.log('Backend agent token charges are separate. Unconfirmed records do not establish zero additional billing.');
