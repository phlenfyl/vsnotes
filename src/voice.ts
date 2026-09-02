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
import * as fs from 'fs';
import * as path from 'path';

// audify ships prebuilt binaries per platform+arch (via `prebuild-install`
// at normal `npm install` time), but a published .vsix is pre-built once on
// one machine and shipped as-is — end users never run `npm install`, so
// whichever single platform happened to build the .vsix is the only one
// that ever worked (confirmed: this shipped as darwin-arm64-only through
// 0.18.0). resources/audify-prebuilds/<platform>-<arch>/build/Release/
// bundles the other platforms' prebuilt binaries (downloaded from audify's
// own GitHub releases, napi-v8 — N-API is ABI-stable across Node/Electron
// versions by design, so one napi version per platform is enough) — this
// copies the one matching the current machine into node_modules/audify's
// own build/Release/ (where its `bindings()` call already expects to find
// it) before requiring it. See scripts/fetch-audify-prebuilds.js for how
// to add a platform or update these when audify releases a new version.
const SUPPORTED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64'];

function applyPlatformBinary(extensionPath: string): void {
  const platformKey = `${process.platform}-${process.arch}`;
  if (!SUPPORTED_PLATFORMS.includes(platformKey)) {
    throw new Error(
      `Voice isn't available on this platform (${platformKey}) yet — supported: ${SUPPORTED_PLATFORMS.join(', ')}.`,
    );
  }
  const prebuildDir = path.join(extensionPath, 'resources', 'audify-prebuilds', platformKey, 'build', 'Release');
  if (!fs.existsSync(prebuildDir)) {
    throw new Error(`Voice prebuild files missing for ${platformKey} — reinstalling the extension may fix this.`);
  }
  // node_modules/audify's own module root, resolved via the same lookup
  // `require('audify')` itself will use right after this — not hardcoded,
  // since exactly where node_modules ends up can vary (e.g. hoisting).
  const audifyPackageJson = require.resolve('audify/package.json');
  const targetDir = path.join(path.dirname(audifyPackageJson), 'build', 'Release');
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of fs.readdirSync(prebuildDir)) {
    fs.copyFileSync(path.join(prebuildDir, file), path.join(targetDir, file));
  }
}

// Whisper's native rate — was hardcoded here and forced on every device via
// openStream's sampleRate argument. Confirmed live (2026-09-02) that's
// wrong: CoreAudio rejects being forced to a rate the physical device
// doesn't itself support at the driver level (RtAudio Error Code 10,
// kAudioHardwareUnspecifiedError, "setting sample rate for device") —
// common for Bluetooth mics and plenty of built-in ones too, depending on
// the device and macOS version. Groq's transcription endpoint accepts any
// standard WAV sample rate (it resamples server-side), so there's no actual
// need to force 16kHz — recording at whatever rate the device natively
// supports and writing that real rate into the WAV header is both correct
// and avoids this failure class entirely. Only used now as the very last
// fallback if a device's own reported rates are somehow empty.
const FALLBACK_SAMPLE_RATE = 16000;
const CHANNELS = 1;

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * CHANNELS * 2, 28); // byte rate
  header.writeUInt16LE(CHANNELS * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// Picks a sample rate the *device itself* actually reports supporting,
// instead of forcing one on it. preferredSampleRate is what the OS/driver
// is already configured for (fastest path, no rate-switch needed); the
// first entry of sampleRates is RtAudio's own queried-supported-rates list,
// used when preferredSampleRate is unset (0) for this device/backend.
function pickSampleRate(rt: RtAudioType, deviceId: number): number {
  const device = rt.getDevices().find((d) => d.id === deviceId);
  if (!device) { return FALLBACK_SAMPLE_RATE; }
  if (device.preferredSampleRate > 0) { return device.preferredSampleRate; }
  if (device.sampleRates.length > 0) { return device.sampleRates[0]; }
  return FALLBACK_SAMPLE_RATE;
}

export class VoiceRecorder {
  private rtAudio: RtAudioType | null = null;
  private chunks: Buffer[] = [];
  private sampleRate: number = FALLBACK_SAMPLE_RATE;

  isRecording(): boolean {
    return this.rtAudio !== null;
  }

  start(extensionPath: string): void {
    if (this.rtAudio) { return; }
    applyPlatformBinary(extensionPath);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const audify: { RtAudio: new () => RtAudioType; RtAudioFormat: Record<string, number> } = require('audify');
    const rt = new audify.RtAudio();
    this.chunks = [];
    const deviceId = rt.getDefaultInputDevice();
    // Try the device's own reported rates in order, falling back through
    // the list (then FALLBACK_SAMPLE_RATE) rather than failing outright on
    // the first rejection — a device's reported list can itself be stale
    // or incomplete for a given backend, so one candidate failing isn't
    // proof the next one will too.
    const device = rt.getDevices().find((d) => d.id === deviceId);
    const candidates = [
      pickSampleRate(rt, deviceId),
      ...(device?.sampleRates ?? []),
      FALLBACK_SAMPLE_RATE,
    ].filter((rate, i, arr) => rate > 0 && arr.indexOf(rate) === i); // dedupe, keep order

    let lastError: unknown;
    for (const rate of candidates) {
      try {
        rt.openStream(
          null,
          { deviceId, nChannels: CHANNELS },
          audify.RtAudioFormat.RTAUDIO_SINT16,
          rate,
          1024,
          'notevs-agent-mic',
          (data: Buffer) => { this.chunks.push(Buffer.from(data)); },
          null,
        );
        rt.start();
        this.rtAudio = rt;
        this.sampleRate = rate;
        return;
      } catch (err) {
        lastError = err;
        // try the next candidate rate
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
    const minBytes = this.sampleRate * CHANNELS * 2 * 0.2; // ~200ms floor
    if (pcm.length < minBytes) { return undefined; }
    return pcmToWav(pcm, this.sampleRate);
  }
}

// Voice (STT/TTS) is a separate concern from the chat LLM (notevs.llmProvider)
// — it needs its own provider because not every chat provider offers speech
// APIs at all (Anthropic doesn't). Groq and OpenAI both do, with
// near-identical request/response shapes (OpenAI's Whisper endpoint is what
// Groq's own is modeled after), so both are supported directly; agentPanel.ts
// resolves which one to actually use from whichever key is available.
export type VoiceProvider = 'groq' | 'openai';

const STT_ENDPOINTS: Record<VoiceProvider, { url: string; model: string }> = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' },
};

export async function transcribeAudio(wav: Buffer, apiKey: string, provider: VoiceProvider = 'groq'): Promise<string> {
  const { url, model } = STT_ENDPOINTS[provider];
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  form.append('response_format', 'text');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`${provider} transcription failed: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text.trim();
}

const TTS_ENDPOINTS: Record<VoiceProvider, { url: string; model: string; voice: string }> = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/speech', model: 'canopylabs/orpheus-v1-english', voice: 'austin' },
  openai: { url: 'https://api.openai.com/v1/audio/speech', model: 'gpt-4o-mini-tts', voice: 'alloy' },
};

// Returns a data: URI (audio/wav) ready to hand straight to an <audio> tag
// in the webview — playback isn't blocked the way mic capture is, so this
// can go directly to the webview rather than through another native step.
export async function synthesizeSpeech(text: string, apiKey: string, provider: VoiceProvider = 'groq'): Promise<string> {
  const { url, model, voice } = TTS_ENDPOINTS[provider];
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: text.slice(0, 2000), // keep TTS cost/latency bounded for a long reply
      voice,
      response_format: 'wav',
    }),
  });
  if (!res.ok) {
    throw new Error(`${provider} speech synthesis failed: ${res.status} ${await res.text()}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}
