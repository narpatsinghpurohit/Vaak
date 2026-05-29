import React, { useRef, useState } from "react";
import type { TranscribeState } from "./use-transcribe";

interface Props {
  state: TranscribeState;
  fileName: string | null;
  transcript: string;
  provider: string;
  error: string;
  onFile: (file: File) => void;
  onReset: () => void;
}

function statusLabel(state: TranscribeState, provider: string): string {
  switch (state) {
    case "decoding":
      return "Decoding audio…";
    case "transcribing":
      return provider === "cloud"
        ? "Transcribing with cloud…"
        : "Transcribing with local model…";
    case "done":
      return "Done";
    case "error":
      return "Error";
    default:
      return "";
  }
}

export function TranscribeView({
  state,
  fileName,
  transcript,
  provider,
  error,
  onFile,
  onReset,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);

  const busy = state === "decoding" || state === "transcribing";
  const isDone = state === "done";
  const isEmpty = isDone && transcript.trim().length === 0;

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  }

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = "";
  }

  async function handleCopy() {
    if (!transcript) return;
    await navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="transcribe-root">
      <div
        className={`transcribe-drop ${dragOver ? "drag-over" : ""} ${busy ? "busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !busy && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          style={{ display: "none" }}
          onChange={handlePick}
        />
        <div className="transcribe-drop-label">
          {fileName ? fileName : "Drop an audio file here or click to pick"}
        </div>
        <div className="transcribe-drop-hint">mp3, m4a, wav, flac, ogg, webm</div>
      </div>

      {state !== "idle" && (
        <div className={`transcribe-status state-${state}`}>
          {busy && <span className="spinner" />}
          <span>{statusLabel(state, provider)}</span>
        </div>
      )}

      {state === "error" && <div className="transcribe-error">{error}</div>}

      {isDone && isEmpty && (
        <div className="transcribe-empty">No speech detected.</div>
      )}

      {isDone && !isEmpty && (
        <div className="transcribe-result">
          <textarea
            className="transcribe-text"
            value={transcript}
            readOnly
          />
          <div className="transcribe-actions">
            <button onClick={handleCopy}>{copied ? "Copied!" : "Copy"}</button>
            <button onClick={onReset}>New file</button>
          </div>
        </div>
      )}
    </div>
  );
}
