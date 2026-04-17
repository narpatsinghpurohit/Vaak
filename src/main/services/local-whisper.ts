import { join } from "path";
import { existsSync, writeFileSync } from "fs";
import { Worker } from "worker_threads";
import { tmpdir } from "os";
import { EventEmitter } from "events";

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

function makeWorkerCode(): string {
  const smartWhisperDir = findSmartWhisper();
  const metalShader = join(smartWhisperDir, "whisper.cpp/ggml/src/ggml-metal.metal");
  const hasShader = existsSync(metalShader);
  metalShaderFound = hasShader;
  metalShaderDest = hasShader ? join(process.cwd(), "ggml-metal.metal") : null;

  return `
const { parentPort } = require("worker_threads");
const { existsSync, copyFileSync } = require("fs");
const { join } = require("path");
const { Whisper } = require(${JSON.stringify(join(smartWhisperDir, "dist/index.js"))});

${hasShader ? `
const metalSrc = ${JSON.stringify(metalShader)};
const metalDest = join(process.cwd(), "ggml-metal.metal");
let metalCopied = existsSync(metalDest);
if (!metalCopied) {
  try { copyFileSync(metalSrc, metalDest); metalCopied = true; } catch(e) {
    parentPort.postMessage({ type: "log", text: "[worker] metal shader copy failed: " + e.message });
  }
}
parentPort.postMessage({ type: "metal-shader", copied: metalCopied, dest: metalDest });
` : `
parentPort.postMessage({ type: "metal-shader", copied: false, dest: null });
`}

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
      whisper = new Whisper(msg.modelPath, { gpu: true, offload: 0 });
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

      const task = await whisper.transcribe(pcm, { language: msg.language === "auto" ? "auto" : msg.language });
      const segments = await task.result;
      const text = segments.map(s => s.text).join("").trim();
      parentPort.postMessage({ type: "result", text: text === "[BLANK_AUDIO]" ? "" : text });
    } catch (err) {
      parentPort.postMessage({ type: "result", text: "", error: err.message });
    }
  }
});
`;
}

function attachGlobalListeners(w: Worker): void {
  w.on("message", (msg: { type: string; text?: string; copied?: boolean; dest?: string | null }) => {
    if (msg.type === "log" && typeof msg.text === "string") {
      pushLog(msg.text);
      emitStatus();
    } else if (msg.type === "metal-shader") {
      metalShaderCopied = !!msg.copied;
      status.metalShaderAvailable = metalShaderFound;
      status.metalShaderCopied = metalShaderCopied;
      status.metalShaderDest = msg.dest ?? metalShaderDest;
      emitStatus();
    }
  });
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

    const handler = (msg: { type: string; text?: string; error?: string }) => {
      if (msg.type === "loaded") {
        workerReady = true;
        status.state = "loaded";
        status.loadedAt = Date.now();
        status.loadDurationMs = status.loadStartedAt ? status.loadedAt - status.loadStartedAt : null;
        emitStatus();
        sendTranscribe();
      } else if (msg.type === "result") {
        w.removeListener("message", handler);
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
