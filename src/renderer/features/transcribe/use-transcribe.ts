import { useCallback, useState } from "react";

export type TranscribeState = "idle" | "decoding" | "transcribing" | "done" | "error";

const TARGET_SAMPLE_RATE = 16000;

async function fileToInt16Pcm(file: File): Promise<ArrayBuffer> {
  const arrayBuffer = await file.arrayBuffer();

  // Decode any Chromium-supported codec into a Float32 AudioBuffer.
  // Some codecs only decode in a real AudioContext, not OfflineAudioContext.
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    void decodeCtx.close();
  }

  // Resample + downmix to 16 kHz mono in one render pass.
  const length = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext({
    numberOfChannels: 1,
    length,
    sampleRate: TARGET_SAMPLE_RATE,
  });
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  const mono = rendered.getChannelData(0);

  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const v = Math.max(-1, Math.min(1, mono[i] ?? 0));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return pcm.buffer;
}

export function useTranscribe() {
  const [state, setState] = useState<TranscribeState>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [provider, setProvider] = useState<string>("");
  const [error, setError] = useState<string>("");

  const transcribe = useCallback(async (file: File) => {
    setFileName(file.name);
    setTranscript("");
    setError("");
    setProvider("");
    setState("decoding");

    let pcm: ArrayBuffer;
    try {
      pcm = await fileToInt16Pcm(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decode audio file");
      setState("error");
      return;
    }

    setState("transcribing");
    try {
      const result = await window.voicePaste.transcribeAudioPcm(pcm);
      setTranscript(result.text);
      setProvider(result.provider);
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transcription failed");
      setState("error");
    }
  }, []);

  const reset = useCallback(() => {
    setState("idle");
    setFileName(null);
    setTranscript("");
    setProvider("");
    setError("");
  }, []);

  return { state, fileName, transcript, provider, error, transcribe, reset };
}
