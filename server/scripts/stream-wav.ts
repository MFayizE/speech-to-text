/**
 * Streams a 16 kHz mono 16-bit WAV file to /ws/transcribe at real-time pace and prints what comes back.
 * Handy for testing providers without a browser or mic.
 *
 *   npx tsx scripts/stream-wav.ts sample.wav [--provider whisper] [--lang hi-IN,en-IN] [--url ws://localhost:8080/ws/transcribe]
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!file) {
  console.error('usage: tsx scripts/stream-wav.ts <file.wav> [--provider name] [--lang codes] [--url ws://...]');
  process.exit(1);
}

const wav = readFileSync(file);
// Find the "data" chunk instead of assuming a 44-byte header.
let offset = 12;
while (offset < wav.length - 8 && wav.toString('ascii', offset, offset + 4) !== 'data') {
  offset += 8 + wav.readUInt32LE(offset + 4);
}
const sampleRate = wav.readUInt32LE(24);
const channels = wav.readUInt16LE(22);
if (sampleRate !== 16000 || channels !== 1) {
  console.error(`Expected 16 kHz mono, got ${sampleRate} Hz x ${channels}`);
  process.exit(1);
}
const pcm = wav.subarray(offset + 8);

const ws = new WebSocket(flag('url') ?? 'ws://localhost:8080/ws/transcribe');
const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'start', provider: flag('provider'), languageCodes: flag('lang')?.split(',') ?? [] }));
});

ws.on('message', async (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'ready') {
    console.log(`[${t()}] ready (${msg.provider})`);
    const chunk = 3200; // 100 ms
    for (let i = 0; i < pcm.length; i += chunk) {
      ws.send(pcm.subarray(i, i + chunk));
      await new Promise((r) => setTimeout(r, 100));
    }
    // A second of silence, like a speaker pausing, then stop.
    for (let i = 0; i < 10; i++) {
      ws.send(Buffer.alloc(3200));
      await new Promise((r) => setTimeout(r, 100));
    }
    ws.send(JSON.stringify({ type: 'stop' }));
  } else if (msg.type === 'partial') {
    console.log(`[${t()}] partial: ${msg.text}`);
  } else if (msg.type === 'final') {
    console.log(`[${t()}] FINAL:   ${msg.text}`);
  } else if (msg.type === 'saved') {
    console.log(`[${t()}] saved #${msg.transcription.id}: ${msg.transcription.text}`);
    ws.close();
  } else {
    console.log(`[${t()}]`, msg);
    if (msg.type === 'empty') ws.close();
  }
});
ws.on('close', () => process.exit(0));
