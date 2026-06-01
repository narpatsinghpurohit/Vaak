import { join } from "path";
import { existsSync, writeFileSync } from "fs";
import { Worker } from "worker_threads";
import { tmpdir, cpus } from "os";
import { EventEmitter } from "events";

// Tuned for Apple Silicon + Metal. See transcribe call below for rationale.
const WHISPER_THREADS = Math.min(cpus().length, 8);

let worker: Worker | null = null;
let workerReady = false;

export type ModelRuntimeState =
  | "idle"
  | "loading"
  | "loaded"
  | "offloaded"
  | "error";

export interface ModelRuntimeStatus {
  state: ModelRuntimeState;
  modelId: string | null;
  modelPath: string | null;
  gpuRequested: boolean;
  loadStartedAt: number | null;
  loadedAt: number | null;
  loadDurationMs: number | null;
  lastTranscribeMs: number | null;
  lastTranscribeAudioSecs: number | null;
  lastError: string | null;
  logs: string[];
}

const MAX_LOG_LINES = 40;

const status: ModelRuntimeStatus = {
  state: "idle",
  modelId: null,
  modelPath: null,
  gpuRequested: true,
  loadStartedAt: null,
  loadedAt: null,
  loadDurationMs: null,
  lastTranscribeMs: null,
  lastTranscribeAudioSecs: null,
  lastError: null,
  logs: [],
};

export const modelEvents = new EventEmitter();

function emitStatus(): void {
  modelEvents.emit("status", getModelStatus());
}

function pushLog(line: string): void {
  status.logs.push(line);
  if (status.logs.length > MAX_LOG_LINES) {
    status.logs = status.logs.slice(-MAX_LOG_LINES);
  }
}

export function getModelStatus(): ModelRuntimeStatus {
  return { ...status, logs: [...status.logs] };
}

function findSmartWhisper(): string {
  const candidates = [
    join(process.cwd(), "node_modules/smart-whisper"),
    join(__dirname, "../../node_modules/smart-whisper"),
    join(__dirname, "../../../node_modules/smart-whisper"),
  ];

  for (const c of candidates) {
    if (existsSync(join(c, "dist/index.js"))) {
      return c;
    }
  }

  try {
    const resolved = require.resolve("smart-whisper");
    return resolved.replace(/\/dist\/index\.js$/, "");
  } catch {}

  throw new Error("smart-whisper not found");
}

function makeWorkerCode(smartWhisperDir: string): string {
  // The Metal shader is embedded directly into smart-whisper.node
  // (GGML_METAL_EMBED_LIBRARY — see patches/smart-whisper+0.8.1.patch), so Metal
  // loads with no env var, no external file, and no cwd dependency.
  return `
const { parentPort } = require("worker_threads");

const { Whisper } = require(${JSON.stringify(join(smartWhisperDir, "dist/index.js"))});

let whisper = null;
let loadedModel = null;

function log(text) {
  try { parentPort.postMessage({ type: "log", text: "[worker] " + text }); } catch(e) {}
}

// Trim TRAILING silence from a Float32 PCM clip. Whisper was trained on YouTube
// and pads silent endings with phantom sign-offs ("Bye", "Thank you", "thanks for
// watching"); if it never sees the silent tail it can't invent one. Scan 20 ms
// frames, find the last frame with speech energy, keep up to ~200 ms past it.
// Only trims the END (leading silence is far less dangerous and clipping a soft
// first word is worse). Returns the original clip if there's nothing to trim.
function trimTrailingSilence(pcm) {
  const FR = 320; // 20 ms @ 16 kHz
  const nFrames = Math.floor(pcm.length / FR);
  if (nFrames < 3) return pcm;
  let peak = 0;
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0; const base = f * FR;
    for (let j = 0; j < FR; j++) { const v = pcm[base + j]; s += v * v; }
    const r = Math.sqrt(s / FR);
    rms[f] = r;
    if (r > peak) peak = r;
  }
  // Speech threshold relative to the clip's own peak, with an absolute floor.
  const thr = Math.max(0.01, peak * 0.10);
  let last = -1;
  for (let f = nFrames - 1; f >= 0; f--) { if (rms[f] > thr) { last = f; break; } }
  if (last < 0) return pcm; // whole clip is silence — let whisper return blank
  const keep = Math.min(pcm.length, (last + 1) * FR + 3200); // +200 ms tail pad
  if (keep >= pcm.length - FR) return pcm; // nothing meaningful to trim
  return pcm.subarray(0, keep);
}

parentPort.on("message", async (msg) => {
  if (msg.type === "load") {
    try {
      if (whisper && loadedModel === msg.modelPath) {
        parentPort.postMessage({ type: "loaded", modelPath: msg.modelPath });
        return;
      }
      if (whisper) { await whisper.free(); whisper = null; loadedModel = null; }
      log("Loading model: " + msg.modelPath);
      // smart-whisper has NO config option for "never offload" — any numeric
      // value schedules setTimeout(free, offload*1000). To keep the model
      // resident for the entire app lifetime (voice-paste is a keyboard-like
      // utility; cold reload latency is unacceptable), monkey-patch both
      // timer methods to no-ops before calling load(). Manual offload via
      // whisper.free() still works — that's what the Settings Offload
      // button uses.
      whisper = new Whisper(msg.modelPath, { gpu: true, offload: 86400 });
      whisper.reset_offload_timer = function() {};
      whisper.clear_offload_timer = function() {};
      await whisper.load();
      // Belt-and-suspenders: clear any timer that slipped through.
      if (whisper._offload_timer) {
        clearTimeout(whisper._offload_timer);
        whisper._offload_timer = null;
      }
      log("Model resident; auto-offload disabled");
      loadedModel = msg.modelPath;
      log("Model load complete");
      parentPort.postMessage({ type: "loaded", modelPath: msg.modelPath });
    } catch (err) {
      log("Load failed: " + err.message);
      parentPort.postMessage({ type: "error", error: err.message });
    }
  }

  if (msg.type === "free") {
    try {
      if (whisper) {
        await whisper.free();
        whisper = null;
        loadedModel = null;
        log("Model freed");
      }
      parentPort.postMessage({ type: "freed" });
    } catch (err) {
      parentPort.postMessage({ type: "error", error: err.message });
    }
  }

  if (msg.type === "transcribe") {
    try {
      if (!whisper) {
        parentPort.postMessage({ type: "result", text: "", error: "Model not loaded" });
        return;
      }
      const wav = Buffer.from(msg.wavData);
      if (wav.length <= 44) { parentPort.postMessage({ type: "result", text: "" }); return; }

      const n = (wav.length - 44) / 2;
      const i16 = new Int16Array(wav.buffer, wav.byteOffset + 44, n);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = (i16[i] || 0) / 32768.0;

      if (pcm.length < 16000) { parentPort.postMessage({ type: "result", text: "" }); return; }

      // Strip the silent tail before decoding (see trimTrailingSilence) so whisper
      // can't pad the end with phantom sign-offs ("Bye", "Thank you", "thanks for
      // watching"). Same root-cause fix as the streaming path.
      const clip = trimTrailingSilence(pcm);
      const audioSecs = clip.length / 16000;
      const t0 = Date.now();
      // Speed tuning for Apple Silicon + Metal:
      //   strategy=0 (GREEDY)          — 2-5x faster than smart-whisper's BEAM_SEARCH default
      //   temperature=0, temperature_inc=0 — disables the 6-pass fallback retry loop that
      //                                       causes the invisible "sometimes slow" behavior
      //   no_context=true              — don't carry prior segments across clips
      //   n_threads=${WHISPER_THREADS} — mel spectrogram parallelism on P-cores
      //   suppress_blank=true          — don't let a segment START on a blank token
      //   suppress_non_speech_tokens=true — mask bracket/symbol tokens so ambient
      //     sound becomes "" instead of an annotation like "(birds chirping)".
      //     (It can't stop WORD phantoms like "Bye" — the trailing-silence trim
      //     above handles those — but it does stop the bracketed sound labels.)
      const task = await whisper.transcribe(clip, {
        language: msg.language === "auto" ? "auto" : msg.language,
        strategy: 0,
        no_context: true,
        temperature: 0,
        temperature_inc: 0,
        n_threads: ${WHISPER_THREADS},
        suppress_blank: true,
        suppress_non_speech_tokens: true,
        print_progress: false,
        print_realtime: false,
        print_timestamps: false,
      });
      const segments = await task.result;
      const elapsedMs = Date.now() - t0;
      const text = segments.map(s => s.text).join("").trim();
      log("Transcribed " + audioSecs.toFixed(1) + "s audio in " + elapsedMs + " ms (" + (audioSecs * 1000 / elapsedMs).toFixed(1) + "x realtime)");
      parentPort.postMessage({
        type: "result",
        text: text === "[BLANK_AUDIO]" ? "" : text,
        elapsedMs,
        audioSecs,
      });
    } catch (err) {
      parentPort.postMessage({ type: "result", text: "", error: err.message });
    }
  }

  if (msg.type === "transcribeStream") {
    try {
      if (!whisper) {
        parentPort.postMessage({ type: "streamResult", words: [], error: "Model not loaded" });
        return;
      }
      // Raw Float32 PCM (16 kHz mono) is sent directly — no WAV wrapping.
      const pcm = new Float32Array(msg.pcm);
      // Whisper's mel front-end needs a minimum amount of audio; below ~0.5 s the
      // hypotheses are noise. LocalAgreement upstream won't commit them anyway, so
      // just skip the decode and save Metal cycles.
      if (pcm.length < 8000) {
        parentPort.postMessage({ type: "streamResult", words: [] });
        return;
      }

      const audioSecs = pcm.length / 16000;
      const t0 = Date.now();
      // CRITICAL: no_context:true. smart-whisper is patched to REUSE the context's
      // internal state across calls (model.cc), so prompt_past survives between
      // transcribes. We re-decode an OVERLAPPING rolling buffer every ~0.8s, so
      // carrying prior tokens (no_context:false) feeds each pass the previous
      // pass's words as context → greedy repetition loop ("So. So. So."). Clearing
      // prompt_past each call (whisper.cpp: if(no_context) prompt_past.clear()) makes
      // every re-decode independent, exactly like the batch path.
      //
      // We also do NOT pass initial_prompt: the committed audio is still inside the
      // rolling buffer, so prompting with the committed TEXT would double-count it
      // (prompt + audio = the same words) and itself induce repetition. The buffer's
      // own audio is the context.
      //
      //   token_timestamps + split_on_word + max_len:1 — ONE word per segment, each
      //     carrying from/to (ms) + confidence — the word-timestamp trick.
      //   format:"detail" — required for per-word confidence.
      const task = await whisper.transcribe(pcm, {
        language: msg.language === "auto" ? "auto" : msg.language,
        strategy: 0,
        no_context: true,
        temperature: 0,
        temperature_inc: 0,
        n_threads: ${WHISPER_THREADS},
        token_timestamps: true,
        split_on_word: true,
        max_len: 1,
        format: "detail",
        suppress_blank: true,
        suppress_non_speech_tokens: true, // mask "(birds chirping)"-style sound annotations
        print_progress: false,
        print_realtime: false,
        print_timestamps: false,
      });
      const segments = await task.result;
      const elapsedMs = Date.now() - t0;
      const words = segments
        .map(s => ({ text: s.text, from: s.from, to: s.to, confidence: s.confidence }))
        .filter(w => {
          const t = (w.text || "").trim();
          return t && t !== "[BLANK_AUDIO]";
        });
      parentPort.postMessage({ type: "streamResult", words, elapsedMs, audioSecs });
    } catch (err) {
      parentPort.postMessage({ type: "streamResult", words: [], error: err.message });
    }
  }
});
`;
}

function attachGlobalListeners(w: Worker): void {
  w.on("message", (msg: { type: string; text?: string }) => {
    if (msg.type === "log" && typeof msg.text === "string") {
      pushLog(msg.text);
      // Also forward to main's console so Terminal-launched debugging
      // can see worker-side timing without opening the Settings panel.
      console.log(msg.text);
      emitStatus();
    }
  });
}

function getWorker(): Worker {
  if (worker) return worker;

  const smartWhisperDir = findSmartWhisper();
  const code = makeWorkerCode(smartWhisperDir);
  const workerPath = join(tmpdir(), "vaak-whisper-worker.js");
  writeFileSync(workerPath, code);

  worker = new Worker(workerPath);

  attachGlobalListeners(worker);

  worker.on("error", (err: Error) => {
    console.error("[whisper-worker] error:", err.message);
    pushLog(`[worker] fatal: ${err.message}`);
    worker = null;
    workerReady = false;
    status.state = "error";
    status.lastError = err.message;
    emitStatus();
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      console.error("[whisper-worker] crashed:", code);
      pushLog(`[worker] exited with code ${code}`);
    }
    worker = null;
    workerReady = false;
    if (status.state !== "offloaded") {
      status.state = "error";
      status.lastError = `worker exited (${code})`;
      emitStatus();
    }
  });

  return worker;
}

export function preloadModel(modelsDir: string, modelId: string): void {
  const modelPath = join(modelsDir, modelId);
  if (!existsSync(modelPath)) {
    console.warn("Model not found:", modelPath);
    status.state = "error";
    status.lastError = `Model not found: ${modelPath}`;
    emitStatus();
    return;
  }

  const w = getWorker();
  status.state = "loading";
  status.modelId = modelId;
  status.modelPath = modelPath;
  status.loadStartedAt = Date.now();
  status.loadedAt = null;
  status.loadDurationMs = null;
  status.lastError = null;
  emitStatus();

  w.postMessage({ type: "load", modelPath });

  const handler = (msg: { type: string; error?: string; modelPath?: string }) => {
    if (msg.type === "loaded") {
      workerReady = true;
      status.state = "loaded";
      status.loadedAt = Date.now();
      status.loadDurationMs = status.loadStartedAt ? status.loadedAt - status.loadStartedAt : null;
      emitStatus();
      w.removeListener("message", handler);
    } else if (msg.type === "error") {
      console.error("Model load failed:", msg.error);
      status.state = "error";
      status.lastError = msg.error ?? "unknown error";
      emitStatus();
      w.removeListener("message", handler);
    }
  };
  w.on("message", handler);
}

export function offloadModel(): Promise<void> {
  return new Promise((resolve) => {
    if (!worker) {
      status.state = "offloaded";
      status.loadedAt = null;
      status.loadDurationMs = null;
      workerReady = false;
      emitStatus();
      resolve();
      return;
    }
    const w = worker;
    const handler = (msg: { type: string; error?: string }) => {
      if (msg.type === "freed" || msg.type === "error") {
        w.removeListener("message", handler);
        workerReady = false;
        status.state = "offloaded";
        status.loadedAt = null;
        status.loadDurationMs = null;
        if (msg.type === "error" && msg.error) {
          status.lastError = msg.error;
        }
        emitStatus();
        resolve();
      }
    };
    w.on("message", handler);
    w.postMessage({ type: "free" });
  });
}

export async function reloadModel(modelsDir: string, modelId: string): Promise<void> {
  await offloadModel();
  preloadModel(modelsDir, modelId);
}

export function transcribeLocal(
  wavBuffer: Buffer,
  modelsDir: string,
  modelId: string,
  language: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = getWorker();

    const sendTranscribe = () => {
      w.postMessage({
        type: "transcribe",
        wavData: wavBuffer.buffer.slice(
          wavBuffer.byteOffset,
          wavBuffer.byteOffset + wavBuffer.byteLength,
        ),
        language,
      });
    };

    const handler = (msg: {
      type: string;
      text?: string;
      error?: string;
      elapsedMs?: number;
      audioSecs?: number;
    }) => {
      if (msg.type === "loaded") {
        workerReady = true;
        status.state = "loaded";
        status.loadedAt = Date.now();
        status.loadDurationMs = status.loadStartedAt ? status.loadedAt - status.loadStartedAt : null;
        emitStatus();
        sendTranscribe();
      } else if (msg.type === "result") {
        w.removeListener("message", handler);
        if (typeof msg.elapsedMs === "number") {
          status.lastTranscribeMs = msg.elapsedMs;
          status.lastTranscribeAudioSecs = msg.audioSecs ?? null;
          emitStatus();
        }
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.text ?? "");
      } else if (msg.type === "error") {
        w.removeListener("message", handler);
        status.state = "error";
        status.lastError = msg.error ?? "unknown error";
        emitStatus();
        reject(new Error(msg.error ?? "Worker error"));
      }
    };

    w.on("message", handler);

    if (workerReady) {
      sendTranscribe();
    } else {
      const modelPath = join(modelsDir, modelId);
      status.state = "loading";
      status.modelId = modelId;
      status.modelPath = modelPath;
      status.loadStartedAt = Date.now();
      status.loadedAt = null;
      status.loadDurationMs = null;
      status.lastError = null;
      emitStatus();
      w.postMessage({ type: "load", modelPath });
    }
  });
}

export interface StreamWord {
  /** Word text as emitted by whisper (keeps its leading space). */
  text: string;
  /** Start timestamp in ms, relative to the start of the PCM buffer passed in. */
  from: number;
  /** End timestamp in ms, relative to the start of the PCM buffer passed in. */
  to: number;
  /** Average token probability for the word (0–1), when available. */
  confidence?: number;
}

/**
 * Transcribe a Float32 PCM window for streaming. Returns one entry per WORD with
 * relative ms timestamps (see {@link StreamWord}). Callers MUST serialize calls —
 * the patched single whisper context cannot run two transcribes at once.
 */
export function transcribeLocalStream(
  pcm: Float32Array,
  modelsDir: string,
  modelId: string,
  language: string,
): Promise<StreamWord[]> {
  return new Promise((resolve, reject) => {
    const w = getWorker();

    // slice() copies into a standalone ArrayBuffer we can hand off (transfer) to
    // the worker without detaching the caller's view.
    const ab = pcm.buffer.slice(
      pcm.byteOffset,
      pcm.byteOffset + pcm.byteLength,
    ) as ArrayBuffer;

    const sendTranscribe = (buffer: ArrayBuffer) => {
      w.postMessage({ type: "transcribeStream", pcm: buffer, language }, [buffer]);
    };

    const handler = (msg: {
      type: string;
      words?: StreamWord[];
      error?: string;
      elapsedMs?: number;
      audioSecs?: number;
    }) => {
      if (msg.type === "loaded") {
        workerReady = true;
        status.state = "loaded";
        status.loadedAt = Date.now();
        status.loadDurationMs = status.loadStartedAt ? status.loadedAt - status.loadStartedAt : null;
        emitStatus();
        sendTranscribe(ab);
      } else if (msg.type === "streamResult") {
        w.removeListener("message", handler);
        if (typeof msg.elapsedMs === "number") {
          status.lastTranscribeMs = msg.elapsedMs;
          status.lastTranscribeAudioSecs = msg.audioSecs ?? null;
          emitStatus();
        }
        if (msg.error === "Model not loaded") {
          reject(new Error(msg.error));
          return;
        }
        if (msg.error) console.warn("[stream] decode error:", msg.error);
        resolve(msg.words ?? []);
      } else if (msg.type === "error") {
        w.removeListener("message", handler);
        reject(new Error(msg.error ?? "Worker error"));
      }
    };

    w.on("message", handler);

    if (workerReady) {
      sendTranscribe(ab);
    } else {
      const modelPath = join(modelsDir, modelId);
      status.state = "loading";
      status.modelId = modelId;
      status.modelPath = modelPath;
      status.loadStartedAt = Date.now();
      status.loadedAt = null;
      status.loadDurationMs = null;
      status.lastError = null;
      emitStatus();
      w.postMessage({ type: "load", modelPath });
    }
  });
}
