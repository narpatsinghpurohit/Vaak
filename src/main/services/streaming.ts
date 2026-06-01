import { startStreamingRecording, stopStreamingRecording } from "./audio";
import { transcribeLocalStream, type StreamWord } from "./local-whisper";
import { isSileroLoaded, createVadStream, loadSilero, type VadStream } from "./silero";
import type { StreamingTuning } from "./types";

// ── Live streaming dictation engine ────────────────────────────────────────
//
// Whisper is a batch decoder, so we fake "live" by re-transcribing a short
// rolling buffer on a clock and committing only the words that have stabilized.
// "Stabilized" = the longest prefix that two consecutive decodes agree on
// (LocalAgreement-2, from ÚFAL's whisper_streaming). Committed words are emitted
// once and never revised — which is exactly the contract we need to type into an
// arbitrary focused app we can't reach back into.
//
// A VAD rides alongside: it skips decoding pure silence (saving Metal cycles) and
// forces an unconditional flush of the trailing words when the user pauses or
// stops (LocalAgreement structurally never commits the final word). The VAD is
// Silero (a neural speech detector that rejects background noise like birdsong)
// when available, falling back to a pure-JS RMS detector if the model can't load.
//
// All decodes are strictly serialized: the patched single whisper context cannot
// run two transcribes at once.

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 ms @ 16 kHz — RMS VAD analysis frame
const SILERO_CHUNK = 512; // 32 ms @ 16 kHz — Silero VAD window
const MIN_DECODE_SAMPLES = 8000; // 0.5 s — below this whisper output is noise

// RMS VAD tuning (fallback path; 16 kHz mono speech).
const SPEECH_MULT = 3.5; // speech when rms > noiseFloor * this
const ABS_FLOOR = 0.01; // absolute rms floor so near-silence never counts as speech
const NOISE_EMA = 0.005; // how fast the noise floor adapts (per frame, during silence)
const TRAIL_MARGIN_S = 0.2; // audio kept past the last speech frame (trailing-silence trim)
const FRAMES_PER_SEC = SAMPLE_RATE / FRAME; // 50

// Silero speech-probability hysteresis: turn ON at >= START, stay ON until < END.
const VAD_START = 0.5;
const VAD_END = 0.35;

interface AbsWord {
  text: string; // original whisper text (keeps leading space)
  norm: string; // normalized for agreement comparison
  start: number; // absolute seconds from session start
  end: number; // absolute seconds from session start
  confidence?: number;
}

export interface StreamingCallbacks {
  /** A newly stabilized text fragment to append at the cursor. */
  onCommit: (text: string) => void;
  /** The current not-yet-committed tail (for a live preview HUD). */
  onTentative?: (text: string) => void;
  /** Smoothed mic level 0–1 (for a waveform). */
  onLevel?: (level: number) => void;
}

export interface StreamingConfig {
  modelsDir: string;
  modelId: string;
  language: string;
  tuning: StreamingTuning;
}

let active = false;
let cb: StreamingCallbacks | null = null;
let cfg: StreamingConfig | null = null;

// Rolling audio buffer (only the un-trimmed tail is kept).
let chunks: Float32Array[] = [];
let bufferLen = 0; // samples currently held in `chunks`
let bufferStartTime = 0; // absolute seconds of chunks[0][0]
let totalSamples = 0; // every sample ever received this session

// Commit state.
let committedText = "";
let committedAnything = false;
let lastCommittedTime = 0; // absolute seconds (end of last committed word)
let lastCommittedNorm = "";
let committedNorms: string[] = []; // normalized text of every committed word (for n-gram dedup)
let prevWords: AbsWord[] = []; // previous hypothesis's uncommitted words

// Scheduling.
let samplesSinceDecode = 0;
let decoding = false;
let pendingFinalize = false;
let sessionStartMs = 0;

// VAD state.
let noiseFloor = 0.005;
let silenceSamples = 0;
let speechActive = false;
let hasSpeechSinceCommit = false;
let pauseTriggered = false;
let frameAcc: number[] = []; // leftover samples not yet forming a full frame
let frameCount = 0; // VAD frames processed since session start (20 ms each)
let speechFrames: boolean[] = []; // per-frame speech flag, indexed by absolute frame
let lastSpeechTime = 0; // absolute seconds: end of the most recent speech frame

// Silero VAD path (chosen once per session in startStreamingSession). When `vad`
// is null the engine uses the RMS fallback above. Both write the SAME state
// (frameCount/speechFrames/lastSpeechTime/silenceSamples/...), so every downstream
// consumer is identical regardless of which detector is active.
let vad: VadStream | null = null;
let vadQueue: Float32Array[] = []; // PCM awaiting (async) Silero inference, in order
let vadDraining = false;
let vadSamplesProcessed = 0; // samples Silero has consumed (its frame clock)
let vadTriggered = false; // hysteresis latch

function reset(): void {
  chunks = [];
  bufferLen = 0;
  bufferStartTime = 0;
  totalSamples = 0;
  committedText = "";
  committedAnything = false;
  lastCommittedTime = 0;
  lastCommittedNorm = "";
  committedNorms = [];
  prevWords = [];
  samplesSinceDecode = 0;
  decoding = false;
  pendingFinalize = false;
  noiseFloor = 0.005;
  silenceSamples = 0;
  speechActive = false;
  hasSpeechSinceCommit = false;
  pauseTriggered = false;
  frameAcc = [];
  frameCount = 0;
  speechFrames = [];
  lastSpeechTime = 0;
  vad = null;
  vadQueue = [];
  vadDraining = false;
  vadSamplesProcessed = 0;
  vadTriggered = false;
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function isStreamingActive(): boolean {
  return active;
}

export function startStreamingSession(config: StreamingConfig, callbacks: StreamingCallbacks): void {
  if (active) {
    console.warn("[stream] session already active");
    return;
  }
  reset();
  active = true;
  cfg = config;
  cb = callbacks;
  sessionStartMs = Date.now();

  // Decide the VAD ONCE for the whole session. If Silero is already loaded, use
  // it (neural noise rejection); otherwise use the RMS fallback for this session
  // and warm Silero up for next time. We never switch the frame clock mid-session
  // on purpose — mixing the two detectors' clocks would desync speechFrames.
  if (isSileroLoaded()) {
    try {
      vad = createVadStream();
      console.log("[stream] using Silero VAD");
    } catch (e) {
      vad = null;
      console.warn("[stream] Silero init failed, RMS fallback:", e instanceof Error ? e.message : e);
    }
  } else {
    vad = null;
    console.log("[stream] Silero not ready — RMS VAD this session");
    void loadSilero();
  }

  console.log(`[stream] session start — model=${config.modelId} step=${config.tuning.stepMs}ms cap=${config.tuning.maxBufferSec}s`);
  startStreamingRecording(onPcm);
}

function onPcm(pcm: Float32Array): void {
  if (!active) return;
  chunks.push(pcm);
  bufferLen += pcm.length;
  totalSamples += pcm.length;
  samplesSinceDecode += pcm.length;

  if (vad) {
    // Silero path: queue for in-order async inference; level meter computed here
    // (the RMS path computes it inside runVad).
    vadQueue.push(pcm);
    void drainVad();
    if (cb?.onLevel) {
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) {
        const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
        if (a > peak) peak = a;
      }
      cb.onLevel(Math.min(1, peak * 4));
    }
  } else {
    runVad(pcm); // RMS fallback
  }

  maybeDecode();
}

// Single-flight drain of the Silero queue. PCM MUST be processed in arrival order
// (the LSTM state is order-dependent), so never parallelize this.
async function drainVad(): Promise<void> {
  if (vadDraining || !vad) return;
  vadDraining = true;
  try {
    while (vadQueue.length && vad) {
      const pcm = vadQueue.shift()!;
      let probs: number[];
      try {
        probs = await vad.process(pcm);
      } catch (e) {
        // Mid-session inference failure → drop to RMS for the rest of the session.
        console.error("[stream] Silero inference failed, switching to RMS:", e instanceof Error ? e.message : e);
        vad = null;
        vadQueue = [];
        break;
      }
      for (const prob of probs) {
        vadSamplesProcessed += SILERO_CHUNK;
        applySpeechDecision(prob, vadSamplesProcessed);
      }
    }
  } finally {
    vadDraining = false;
    if (vadQueue.length && vad) void drainVad();
  }
}

// Translate one Silero window's probability into the SAME speech state the RMS
// path maintains: stamp the per-20ms speechFrames grid up to this window's end,
// update lastSpeechTime, and run the pause-flush. Hysteresis kills flicker.
function applySpeechDecision(prob: number, winEndSamples: number): void {
  vadTriggered = vadTriggered ? prob >= VAD_END : prob >= VAD_START;
  const speech = vadTriggered;

  const winEndSec = winEndSamples / SAMPLE_RATE;
  const frameEnd = Math.floor(winEndSec * FRAMES_PER_SEC);
  for (; frameCount <= frameEnd; frameCount++) speechFrames[frameCount] = speech;
  if (speech) lastSpeechTime = winEndSec;

  if (speech) {
    silenceSamples = 0;
    speechActive = true;
    hasSpeechSinceCommit = true;
    pauseTriggered = false;
  } else {
    silenceSamples += SILERO_CHUNK;
    const pauseSamples = (cfg!.tuning.pauseFlushMs / 1000) * SAMPLE_RATE;
    if (active && speechActive && hasSpeechSinceCommit && !pauseTriggered && silenceSamples >= pauseSamples) {
      pauseTriggered = true;
      speechActive = false;
      void decodePass(true); // flush the just-finished utterance
    }
  }
}

function runVad(pcm: Float32Array): void {
  let peak = 0;
  // Process complete 20 ms frames, carrying any remainder to the next chunk.
  let buf: number[] | Float32Array = pcm;
  if (frameAcc.length) {
    buf = frameAcc.concat(Array.from(pcm));
    frameAcc = [];
  }
  let i = 0;
  for (; i + FRAME <= buf.length; i += FRAME) {
    let sum = 0;
    for (let j = 0; j < FRAME; j++) {
      const v = buf[i + j];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / FRAME);
    if (rms > peak) peak = rms;

    const speech = rms > Math.max(noiseFloor * SPEECH_MULT, ABS_FLOOR);
    // Record this frame's speech flag against absolute time (used to trim trailing
    // silence before decoding and to energy-gate hallucinated words).
    speechFrames[frameCount] = speech;
    frameCount++;
    if (speech) lastSpeechTime = (frameCount * FRAME) / SAMPLE_RATE;

    if (speech) {
      silenceSamples = 0;
      speechActive = true;
      hasSpeechSinceCommit = true;
      pauseTriggered = false;
    } else {
      noiseFloor = noiseFloor * (1 - NOISE_EMA) + rms * NOISE_EMA;
      silenceSamples += FRAME;
      const pauseSamples = (cfg!.tuning.pauseFlushMs / 1000) * SAMPLE_RATE;
      if (speechActive && hasSpeechSinceCommit && !pauseTriggered && silenceSamples >= pauseSamples) {
        pauseTriggered = true;
        speechActive = false;
        void decodePass(true); // flush the just-finished utterance
      }
    }
  }
  // Stash the remainder (< one frame) for next time.
  if (i < buf.length) {
    frameAcc = Array.from(buf instanceof Float32Array ? buf.subarray(i) : buf.slice(i));
  }

  if (cb?.onLevel) cb.onLevel(Math.min(1, peak * 4));
}

function maybeDecode(): void {
  if (!active || decoding) return;
  const stepSamples = (cfg!.tuning.stepMs / 1000) * SAMPLE_RATE;
  if (samplesSinceDecode < stepSamples) return;
  if (!hasSpeechSinceCommit || bufferLen < MIN_DECODE_SAMPLES) {
    // Nothing worth decoding (pure silence) — reset the clock and wait.
    samplesSinceDecode = 0;
    return;
  }
  void decodePass(false);
}

function concatBuffer(maxSamples?: number): Float32Array {
  const n = maxSamples != null ? Math.max(0, Math.min(maxSamples, bufferLen)) : bufferLen;
  const out = new Float32Array(n);
  let off = 0;
  for (const c of chunks) {
    if (off >= n) break;
    const take = Math.min(c.length, n - off);
    out.set(take === c.length ? c : c.subarray(0, take), off);
    off += take;
  }
  return out;
}

/**
 * True if any VAD frame within [start, end] (absolute seconds, ±1 frame slack)
 * was speech. Whisper hallucinations ("thanks for watching", "bye") land in
 * silent regions, so a word with zero speech frames across its whole span is one.
 */
function hasSpeechInRegion(start: number, end: number): boolean {
  let fs = Math.floor(start * FRAMES_PER_SEC) - 1;
  let fe = Math.ceil(end * FRAMES_PER_SEC) + 1;
  if (fs < 0) fs = 0;
  if (fe > frameCount - 1) fe = frameCount - 1;
  for (let f = fs; f <= fe; f++) {
    if (speechFrames[f]) return true;
  }
  return false;
}

/** Drop buffered audio before `absTime` (seconds) and advance bufferStartTime. */
function trimTo(absTime: number): void {
  let dropSamples = Math.floor((absTime - bufferStartTime) * SAMPLE_RATE);
  if (dropSamples <= 0) return;
  dropSamples = Math.min(dropSamples, bufferLen);
  let toDrop = dropSamples;
  while (toDrop > 0 && chunks.length) {
    if (chunks[0].length <= toDrop) {
      toDrop -= chunks[0].length;
      bufferLen -= chunks[0].length;
      chunks.shift();
    } else {
      chunks[0] = chunks[0].subarray(toDrop);
      bufferLen -= toDrop;
      toDrop = 0;
    }
  }
  bufferStartTime += dropSamples / SAMPLE_RATE;
}

/** Longest common (by normalized text) prefix of two word lists. */
function agreedPrefix(a: AbsWord[], b: AbsWord[], excludeLast: boolean): AbsWord[] {
  // In non-final passes, never commit the most recent word of the current
  // hypothesis — more audio is likely to revise it.
  const aLimit = excludeLast ? a.length - 1 : a.length;
  const n = Math.min(aLimit, b.length);
  const out: AbsWord[] = [];
  for (let i = 0; i < n; i++) {
    if (a[i].norm === b[i].norm) out.push(a[i]);
    else break;
  }
  return out;
}

async function decodePass(finalize: boolean): Promise<void> {
  if (decoding) {
    if (finalize) pendingFinalize = true;
    return;
  }
  decoding = true;
  try {
    // Trim trailing silence: whisper hallucinates ("thanks for watching", "bye")
    // when fed silent audio, so only decode up to a hair past the last speech.
    const bufferEndTime = bufferStartTime + bufferLen / SAMPLE_RATE;
    let decodeEndTime = bufferEndTime;
    if (lastSpeechTime > bufferStartTime) {
      decodeEndTime = Math.min(bufferEndTime, lastSpeechTime + TRAIL_MARGIN_S);
    }
    const decodeSamples = Math.round((decodeEndTime - bufferStartTime) * SAMPLE_RATE);
    const pcm = concatBuffer(decodeSamples);
    const startTime = bufferStartTime;
    samplesSinceDecode = 0;
    if (pcm.length < MIN_DECODE_SAMPLES && !finalize) return;
    if (pcm.length < FRAME) return;

    let words: StreamWord[] = [];
    try {
      words = await transcribeLocalStream(pcm, cfg!.modelsDir, cfg!.modelId, cfg!.language);
    } catch (e) {
      console.error("[stream] transcribe failed:", e instanceof Error ? e.message : e);
      return;
    }

    // Map to absolute time and drop anything already committed.
    let abs: AbsWord[] = words
      .map((w) => ({
        text: w.text,
        norm: normalize(w.text),
        start: startTime + w.from / 1000,
        end: startTime + w.to / 1000,
        confidence: w.confidence,
      }))
      .filter((w) => w.norm.length > 0 && w.end > lastCommittedTime + 0.001);

    // Boundary dedup: drop a leading word that just repeats the last committed
    // word over the same audio (whisper sometimes re-emits it).
    while (abs.length && abs[0].norm === lastCommittedNorm && abs[0].start < lastCommittedTime + 0.25) {
      abs.shift();
    }

    // Trailing-only energy gate: whisper's silence phantoms ("Bye", "Thank you")
    // land at the END, in a silent span. Drop trailing words whose audio had no
    // speech energy — but NEVER interior words. A raw energy filter across ALL
    // words would eat real quiet speech (soft consonants, fricatives, low mics);
    // the phantom only ever appears at the tail, so only the tail is gated.
    while (abs.length && !hasSpeechInRegion(abs[abs.length - 1].start, abs[abs.length - 1].end)) {
      abs.pop();
    }

    const commitWords = finalize ? abs : agreedPrefix(abs, prevWords, true);

    if (commitWords.length) {
      // N-gram overlap dedup: whisper re-decoding under noise sometimes re-emits the
      // tail of what we already committed ("I am testing this" → "am testing this").
      // Drop leading words that verbatim-repeat the committed tail. Require k>=2 so a
      // legitimate single-word stutter ("the the") survives.
      let toCommit = commitWords;
      const maxK = Math.min(8, committedNorms.length, toCommit.length);
      let overlap = 0;
      for (let k = maxK; k >= 2; k--) {
        let match = true;
        for (let j = 0; j < k; j++) {
          if (committedNorms[committedNorms.length - k + j] !== toCommit[j].norm) {
            match = false;
            break;
          }
        }
        if (match) {
          overlap = k;
          break;
        }
      }
      if (overlap) toCommit = toCommit.slice(overlap);

      // Advance past EVERYTHING in commitWords — the dropped repeat is already-said
      // audio, so don't let it re-enter the next window.
      lastCommittedTime = commitWords[commitWords.length - 1].end;

      if (toCommit.length) {
        let chunk = toCommit.map((w) => w.text).join("");
        if (!committedAnything) chunk = chunk.replace(/^\s+/, "");
        committedAnything = true;
        committedText += chunk;
        committedNorms.push(...toCommit.map((w) => w.norm));
        lastCommittedNorm = toCommit[toCommit.length - 1].norm;
        cb?.onCommit(chunk);
      }
    }

    const remaining = abs.filter((w) => w.end > lastCommittedTime + 0.001);
    prevWords = finalize ? [] : remaining;
    cb?.onTentative?.(remaining.map((w) => w.text).join("").trim());

    if (finalize) {
      // Utterance done — discard committed audio and reset for the next one. Reset
      // Silero's LSTM/context too so the next utterance starts clean (the absolute
      // clocks — frameCount/vadSamplesProcessed/lastSpeechTime — keep running).
      trimTo(lastCommittedTime);
      hasSpeechSinceCommit = false;
      vad?.reset();
      vadTriggered = false;
    } else if (bufferLen / SAMPLE_RATE > cfg!.tuning.maxBufferSec && lastCommittedTime > bufferStartTime) {
      trimTo(lastCommittedTime);
    }
  } finally {
    decoding = false;
    if (pendingFinalize) {
      pendingFinalize = false;
      await decodePass(true);
    }
  }
}

export async function stopStreamingSession(): Promise<{ fullText: string; durationSecs: number }> {
  if (!active) return { fullText: "", durationSecs: 0 };

  // Keep `active` true while rec drains so trailing PCM (the user's final words,
  // spoken right before they pressed stop) still gets appended via onPcm. Only
  // then do we freeze the buffer.
  await stopStreamingRecording();
  active = false;

  // Drain any queued Silero windows first so the final words' speechFrames /
  // lastSpeechTime are stamped before the flush trims trailing silence.
  while (vadDraining || vadQueue.length) await new Promise((r) => setTimeout(r, 5));
  // Wait out any in-flight decode, then flush the remaining tail unconditionally.
  while (decoding) await new Promise((r) => setTimeout(r, 15));
  await decodePass(true);
  while (decoding) await new Promise((r) => setTimeout(r, 15));

  const fullText = committedText.trim();
  const durationSecs = (Date.now() - sessionStartMs) / 1000;
  console.log(`[stream] session stop — ${durationSecs.toFixed(1)}s, "${fullText.slice(0, 60)}"`);
  cb?.onTentative?.("");
  reset();
  cb = null;
  cfg = null;
  return { fullText, durationSecs };
}
