import { join } from "path";
import { existsSync, writeFileSync } from "fs";
import { Worker } from "worker_threads";
import { tmpdir, cpus } from "os";
import { EventEmitter } from "events";

// Tuned for Apple Silicon + Metal. See transcribe call below for rationale.
const WHISPER_THREADS = Math.min(cpus().length, 8);

let worker: Worker | null = null;
let workerReady = false;
let metalShaderFound = false;
let metalShaderDest: string | null = null;
let metalShaderCopied = false;

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
  metalShaderAvailable: boolean;
  metalShaderCopied: boolean;
  metalShaderDest: string | null;
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
  metalShaderAvailable: false,
  metalShaderCopied: false,
  metalShaderDest: null,
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

function resolveMetalShader(smartWhisperDir: string): string | null {
  // smart-whisper 0.3.0 ships whisper.cpp/ggml-metal.metal (flat); newer layouts use whisper.cpp/ggml/src/
  const candidates = [
    join(smartWhisperDir, "whisper.cpp/ggml-metal.metal"),
    join(smartWhisperDir, "whisper.cpp/ggml/src/ggml-metal.metal"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function makeWorkerCode(): string {
  const smartWhisperDir = findSmartWhisper();
  const metalShader = resolveMetalShader(smartWhisperDir);
  const hasShader = metalShader !== null;
  metalShaderFound = hasShader;
  metalShaderDest = metalShader;

  return `
const { parentPort } = require("worker_threads");
const { existsSync, copyFileSync } = require("fs");
const { join, dirname } = require("path");

${hasShader ? `
// Tell whisper.cpp's Metal backend exactly where to find the shader —
// this works regardless of cwd, bundle path, or sandboxing.
const metalSrc = ${JSON.stringify(metalShader)};
process.env.GGML_METAL_PATH_RESOURCES = dirname(metalSrc);
// Belt-and-suspenders: also try to copy to cwd for older fallback path.
const metalDest = join(process.cwd(), "ggml-metal.metal");
let metalCopied = existsSync(metalDest);
if (!metalCopied) {
  try { copyFileSync(metalSrc, metalDest); metalCopied = true; } catch(e) {
    parentPort.postMessage({ type: "log", text: "[worker] metal shader copy to cwd failed (ok — GGML_METAL_PATH_RESOURCES set): " + e.message });
  }
}
parentPort.postMessage({ type: "metal-shader", found: true, src: metalSrc, copied: metalCopied, dest: metalDest });
` : `
parentPort.postMessage({ type: "metal-shader", found: false, src: null, copied: false, dest: null });
`}

const { Whisper } = require(${JSON.stringify(join(smartWhisperDir, "dist/index.js"))});

let whisper = null;
let loadedModel = null;

function log(text) {
  try { parentPort.postMessage({ type: "log", text: "[worker] " + text }); } catch(e) {}
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
      // WARNING: smart-whisper treats offload=0 as "setTimeout(free, 0)" —
      // i.e. offload IMMEDIATELY on next tick. Use a large value (1 day)
      // to functionally disable auto-offload without tripping the
      // setTimeout max-delay clamp (2^31-1 ms ≈ 24.85 days).
      whisper = new Whisper(msg.modelPath, { gpu: true, offload: 86400 });
      // Force load now so we can measure + catch errors eagerly
      await whisper.load();
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

      const audioSecs = pcm.length / 16000;
      const t0 = Date.now();
      // Speed tuning for Apple Silicon + Metal:
      //   strategy=0 (GREEDY)          — 2-5x faster than smart-whisper's BEAM_SEARCH default
      //   temperature=0, temperature_inc=0 — disables the 6-pass fallback retry loop that
      //                                       causes the invisible "sometimes slow" behavior
      //   no_context=true              — don't carry prior segments across clips
      //   n_threads=${WHISPER_THREADS} — mel spectrogram parallelism on P-cores
      //   suppress_blank=true, suppress_non_speech_tokens=true — skip filler tokens
      const task = await whisper.transcribe(pcm, {
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
});
`;
}

function attachGlobalListeners(w: Worker): void {
  w.on(
    "message",
    (msg: {
      type: string;
      text?: string;
      found?: boolean;
      src?: string | null;
      copied?: boolean;
      dest?: string | null;
    }) => {
      if (msg.type === "log" && typeof msg.text === "string") {
        pushLog(msg.text);
        // Also forward to main's console so Terminal-launched debugging
        // can see worker-side timing without opening the Settings panel.
        console.log(msg.text);
        emitStatus();
      } else if (msg.type === "metal-shader") {
        if (typeof msg.found === "boolean") metalShaderFound = msg.found;
        metalShaderCopied = !!msg.copied;
        status.metalShaderAvailable = metalShaderFound;
        status.metalShaderCopied = metalShaderCopied;
        status.metalShaderDest = msg.src ?? metalShaderDest;
        emitStatus();
      }
    },
  );
}

function getWorker(): Worker {
  if (worker) return worker;

  const code = makeWorkerCode();
  const workerPath = join(tmpdir(), "vaak-whisper-worker.js");
  writeFileSync(workerPath, code);

  worker = new Worker(workerPath);
  status.metalShaderAvailable = metalShaderFound;
  status.metalShaderDest = metalShaderDest;

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
