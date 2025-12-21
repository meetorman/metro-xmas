import fs from 'fs';
import path from 'path';

const outDir = path.join(process.cwd(), 'public', 'sfx');
fs.mkdirSync(outDir, { recursive: true });

const SAMPLE_RATE = 44100;

function clamp16(x) {
  return Math.max(-32768, Math.min(32767, x | 0));
}

function writeWav16Mono(filePath, samples) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM
  buffer.writeUInt16LE(1, 20); // audio format PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let o = 44;
  for (const s of samples) {
    buffer.writeInt16LE(clamp16(s), o);
    o += 2;
  }

  fs.writeFileSync(filePath, buffer);
}

function env(i, n, attack = 0.01, release = 0.06) {
  const t = i / SAMPLE_RATE;
  const dur = n / SAMPLE_RATE;
  const a = Math.min(1, t / attack);
  const r = Math.min(1, Math.max(0, (dur - t) / release));
  return Math.min(a, r);
}

function synthTone({ freq, durSec, wave = 'sine', gain = 0.35 }) {
  const n = Math.max(1, Math.floor(durSec * SAMPLE_RATE));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const phase = (2 * Math.PI * freq * i) / SAMPLE_RATE;
    let x = 0;
    if (wave === 'sine') x = Math.sin(phase);
    if (wave === 'square') x = Math.sign(Math.sin(phase));
    if (wave === 'saw') x = 2 * ((freq * i / SAMPLE_RATE) % 1) - 1;
    if (wave === 'tri') x = 2 * Math.abs(2 * ((freq * i / SAMPLE_RATE) % 1) - 1) - 1;

    const e = env(i, n, 0.01, 0.07);
    out[i] = clamp16(x * e * gain * 32767);
  }
  return out;
}

function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Int16Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function silence(sec) {
  return new Int16Array(Math.floor(sec * SAMPLE_RATE));
}

// buzzer: two short saw-ish tones
const buzzer = concat(
  synthTone({ freq: 220, durSec: 0.14, wave: 'saw', gain: 0.40 }),
  silence(0.06),
  synthTone({ freq: 180, durSec: 0.16, wave: 'saw', gain: 0.40 })
);

// correct: two bright triangle tones
const correct = concat(
  synthTone({ freq: 523.25, durSec: 0.12, wave: 'tri', gain: 0.28 }),
  silence(0.03),
  synthTone({ freq: 659.25, durSec: 0.14, wave: 'tri', gain: 0.28 })
);

// wrong: two low square tones
const wrong = concat(
  synthTone({ freq: 196, durSec: 0.18, wave: 'square', gain: 0.22 }),
  silence(0.04),
  synthTone({ freq: 164.81, durSec: 0.22, wave: 'square', gain: 0.22 })
);

// tick: very short sine blip
const tick = synthTone({ freq: 880, durSec: 0.04, wave: 'sine', gain: 0.12 });

writeWav16Mono(path.join(outDir, 'buzzer.wav'), buzzer);
writeWav16Mono(path.join(outDir, 'correct.wav'), correct);
writeWav16Mono(path.join(outDir, 'wrong.wav'), wrong);
writeWav16Mono(path.join(outDir, 'tick.wav'), tick);

console.log('Generated sfx wavs in', outDir);


