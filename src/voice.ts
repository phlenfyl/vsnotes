/**
 * voice.ts
 * Push-to-talk voice for the NoteVs Agent panel (agentPanel.ts).
 *
 * VS Code webviews cannot capture the microphone — Chromium's
 * getUserMedia()/SpeechRecognition are hard-blocked by VS Code's own
 * permissions policy with no opt-in flag (confirmed via
 * microsoft/vscode#113916, still open as microsoft/vscode#250568 as of
 * 2025). Audio *playback* in a webview is unaffected — only mic input is
 * blocked. So recording has to happen in the extension host process
 * (plain Node, no browser sandbox) via a native audio I/O binding, not in
 * the webview's JS. `audify` (RtAudio bindings, prebuilt N-API binaries —
 * no local sox/ffmpeg install required) is what a comparable community
 * extension (Erriccc/claude-code-voice) uses for exactly this reason.
 *
 * Speech-to-text and text-to-speech both go through Groq — the account
 * already has a GROQ_API_KEY set up for the LLM, and Groq happens to also
 * serve Whisper (STT, generous free tier) and Orpheus TTS on the same key,
 * so no new provider signup is needed. This intentionally does NOT use
 * Rasa's own browser_audio voice-stream channel: that needs a Rasa Pro
 * license issued after 3.11 with the voice feature scope (unverified for
 * this account) plus a websocket streaming protocol. Doing STT/TTS as two
 * plain REST calls around the existing text webhook (see handleUserText in
 * agentPanel.ts) reuses everything already built and working.
 */

// Loaded lazily inside start(), not at module scope: this is a native
// binary (see file header) that may not be present in every install (e.g.
// a packaging gap, or an unsupported platform/arch). A top-level `import`
// would run `require('audify')` the moment this file is first loaded —
// which happens during extension activation, since agentPanel.ts imports
// it unconditionally — and a missing/broken native module would then take
// down the *entire* extension (notes, everything), not just voice. Lazy
// loading confines that failure to start(), which already reports it back
// to the webview as a normal "couldn't access the microphone" message.
import type { RtAudio as RtAudioType } from 'audify';

const SAMPLE_RATE = 16000; // Whisper's native rate; avoids server-side resampling.
const CHANNELS = 1;

function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28); // byte rate
  header.writeUInt16LE(CHANNELS * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

export class VoiceRecorder {
  private rtAudio: RtAudioType | null = null;
  private chunks: Buffer[] = [];

  isRecording(): boolean {
    return this.rtAudio !== null;
  }

  start(): void {
    if (this.rtAudio) { return; }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const audify: { RtAudio: new () => RtAudioType; RtAudioFormat: Record<string, number> } = require('audify');
    const rt = new audify.RtAudio();
    this.chunks = [];
    rt.openStream(
      null,
      { deviceId: rt.getDefaultInputDevice(), nChannels: CHANNELS },
      audify.RtAudioFormat.RTAUDIO_SINT16,
      SAMPLE_RATE,
      1024,
      'notevs-agent-mic',
      (data: Buffer) => { this.chunks.push(Buffer.from(data)); },
      null,
    );
    rt.start();
    this.rtAudio = rt;
  }

  // Returns undefined if nothing was ever recording, or if the recording
  // was effectively silent (a mis-tap) — not worth a round-trip to Groq.
  stop(): Buffer | undefined {
    if (!this.rtAudio) { return undefined; }
    const rt = this.rtAudio;
    this.rtAudio = null;
    try {
      rt.stop();
      rt.closeStream();
    } catch {
      // best-effort teardown — a stream already in a bad state shouldn't
      // stop us from returning whatever audio we did capture
    }
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    const minBytes = SAMPLE_RATE * CHANNELS * 2 * 0.2; // ~200ms floor
    if (pcm.length < minBytes) { return undefined; }
    return pcmToWav(pcm);
  }
}

export async function transcribeAudio(wav: Buffer, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'text');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Groq transcription failed: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text.trim();
}

// Returns a data: URI (audio/wav) ready to hand straight to an <audio> tag
// in the webview — playback isn't blocked the way mic capture is, so this
// can go directly to the webview rather than through another native step.
export async function synthesizeSpeech(text: string, apiKey: string): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'canopylabs/orpheus-v1-english',
      input: text.slice(0, 2000), // keep TTS cost/latency bounded for a long reply
      voice: 'austin',
      response_format: 'wav',
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq speech synthesis failed: ${res.status} ${await res.text()}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}
