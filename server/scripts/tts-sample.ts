/**
 * Generates 16 kHz mono WAV test clips with Gemini text-to-speech, so the live pipeline can be tested
 * with real Hindi, English and code-mixed speech without a microphone.
 *
 *   npx tsx scripts/tts-sample.ts out.wav "Kal ki meeting 10 baje hai" [--voice Kore] [--model gemini-3.8-flash-tts]
 *
 * Reads GEMINI_API_KEY from server/.env. Uses the Interactions API (POST /v1beta/interactions),
 * asking for headerless 16-bit PCM at 24 kHz, then resampling to 16 kHz.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [out, text] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!out || !text) {
  console.error('usage: tsx scripts/tts-sample.ts <out.wav> "<text>" [--voice name] [--model name]');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set (server/.env)');
  process.exit(1);
}

const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
  body: JSON.stringify({
    model: flag('model') ?? 'gemini-3.8-flash-tts',
    input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
    generation_config: { speech_config: [{ voice: flag('voice') ?? 'Kore' }] },
  }),
});
const body = (await res.json()) as {
  error?: { message: string };
  steps?: { type: string; content?: { type: string; data?: string }[] }[];
};
if (!res.ok) {
  console.error(`TTS failed (${res.status}): ${body.error?.message ?? 'unknown error'}`);
  process.exit(1);
}
const audio = body.steps
  ?.filter((s) => s.type === 'model_output')
  .flatMap((s) => s.content ?? [])
  .filter((c) => c.type === 'audio' && c.data)
  .pop();
if (!audio?.data) {
  console.error('No audio in the response');
  process.exit(1);
}
const src = Buffer.from(audio.data, 'base64');

// 24 kHz -> 16 kHz, linear interpolation.
const inSamples = Math.floor(src.length / 2);
const outSamples = Math.floor((inSamples * 2) / 3);
const pcm = Buffer.alloc(outSamples * 2);
for (let i = 0; i < outSamples; i++) {
  const pos = i * 1.5;
  const j = Math.floor(pos);
  const a = src.readInt16LE(Math.min(j, inSamples - 1) * 2);
  const b = src.readInt16LE(Math.min(j + 1, inSamples - 1) * 2);
  pcm.writeInt16LE(Math.round(a + (b - a) * (pos - j)), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`Wrote ${out}: ${(pcm.length / 32000).toFixed(1)} s`);
