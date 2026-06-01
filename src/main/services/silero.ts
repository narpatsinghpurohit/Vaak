import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Silero VAD v5 inference (onnxruntime-node, main process) ────────────────
//
// A small neural voice-activity detector that — unlike a volume threshold —
// reliably tells real speech from background noise (birdsong, fans, keyboards,
// music). We use it to drive the streaming engine's speech decision.
//
// VERIFIED model contract (snakers4 silero-vad v5, inspected against the actual
// .onnx with onnxruntime-node):
//   inputs : input [1, 576] f32  (64-sample context + 512-sample chunk)
//            state [2, 1, 128] f32  (LSTM state, carried across chunks)
//            sr    int64 scalar (16000)
//   outputs: output [1, 1] f32  (speech probability 0..1)
//            stateN [2, 1, 128] f32  (next state)
// The 64-sample context (last 64 samples of the previous 512-chunk) matches the
// official OnnxWrapper; state + context MUST be reset between utterances.

const SR = 16000;
const CHUNK = 512; // 32 ms @ 16 kHz — the v5 window
const CTX = 64; // samples of lookback carried from the previous chunk

type Ort = typeof import("onnxruntime-node");
type Session = import("onnxruntime-node").InferenceSession;
type Tensor = import("onnxruntime-node").Tensor;

let ort: Ort | null = null;
let session: Session | null = null;
let loadFailed = false;
let loadPromise: Promise<boolean> | null = null;

function findModelBytes(): Uint8Array {
  // Native ORT reads model PATHS via raw C++ I/O that can't see inside app.asar,
  // so we read the bytes ourselves through Node fs (which IS asar-aware) and hand
  // ORT a buffer. Works identically in dev and in the packaged app.
  const candidates = [
    join(process.cwd(), "assets/silero_vad.onnx"), // dev (cwd = repo root)
    join(__dirname, "../../assets/silero_vad.onnx"), // packaged: dist/main → app root
    join(process.resourcesPath || "", "app.asar/assets/silero_vad.onnx"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return new Uint8Array(readFileSync(c));
  }
  throw new Error("silero_vad.onnx not found in: " + candidates.join(", "));
}

/** Lazy, idempotent load. Resolves false (never throws) if ORT/model unavailable. */
export function loadSilero(): Promise<boolean> {
  if (session) return Promise.resolve(true);
  if (loadFailed) return Promise.resolve(false);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      // Require lazily + guarded so a missing/broken native module can never
      // crash app startup — the engine just falls back to its RMS VAD.
      ort = require("onnxruntime-node") as Ort;
      const bytes = findModelBytes();
      session = await ort.InferenceSession.create(bytes, {
        interOpNumThreads: 1,
        intraOpNumThreads: 1, // tiny model — don't contend with whisper's threads
      });
      console.log("[silero] VAD model loaded");
      return true;
    } catch (e) {
      loadFailed = true;
      session = null;
      console.error(
        "[silero] load failed, streaming will use RMS VAD fallback:",
        e instanceof Error ? e.message : e,
      );
      return false;
    }
  })();
  return loadPromise;
}

export function isSileroLoaded(): boolean {
  return session != null;
}

export interface VadStream {
  /**
   * Push arbitrary-length 16 kHz mono PCM. Returns the speech probability for
   * every COMPLETE 512-sample window that closed during this push (0, 1, or
   * more), in order. Leftover (<512) samples are buffered for the next push.
   */
  process(pcm: Float32Array): Promise<number[]>;
  /** Reset LSTM state + context (call at session start and after each commit). */
  reset(): void;
}

/** Create an independent VAD stream (own LSTM state, context, frame remainder). */
export function createVadStream(): VadStream {
  if (!session || !ort) throw new Error("Silero not loaded");
  const o = ort;
  const s = session;

  const sr = new o.Tensor("int64", BigInt64Array.from([BigInt(SR)]), []);
  let state: Tensor;
  let context: Float32Array;
  let remainder: Float32Array; // <512 carried samples (analog of frameAcc)

  function reset(): void {
    state = new o.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    context = new Float32Array(CTX);
    remainder = new Float32Array(0);
  }
  reset();

  async function runWindow(chunk: Float32Array): Promise<number> {
    const input = new Float32Array(CTX + CHUNK); // 576
    input.set(context, 0);
    input.set(chunk, CTX);
    const out = await s.run({
      input: new o.Tensor("float32", input, [1, CTX + CHUNK]),
      state,
      sr,
    });
    const prob = out.output.data[0] as number;
    state = out.stateN as Tensor;
    context = chunk.slice(CHUNK - CTX); // last 64 samples → next context
    return prob;
  }

  async function process(pcm: Float32Array): Promise<number[]> {
    let buf: Float32Array;
    if (remainder.length) {
      buf = new Float32Array(remainder.length + pcm.length);
      buf.set(remainder, 0);
      buf.set(pcm, remainder.length);
    } else {
      buf = pcm;
    }
    const probs: number[] = [];
    let i = 0;
    // Serialized: each run awaited before the next — the LSTM state is
    // order-dependent, so windows MUST be processed in sequence.
    for (; i + CHUNK <= buf.length; i += CHUNK) {
      probs.push(await runWindow(buf.subarray(i, i + CHUNK)));
    }
    remainder = i < buf.length ? buf.slice(i) : new Float32Array(0);
    return probs;
  }

  return { process, reset };
}
