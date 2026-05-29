import React from "react";
import { useTranscribe } from "./use-transcribe";
import { TranscribeView } from "./transcribe.view";

export function Transcribe() {
  const { state, fileName, transcript, provider, error, transcribe, reset } =
    useTranscribe();

  return (
    <TranscribeView
      state={state}
      fileName={fileName}
      transcript={transcript}
      provider={provider}
      error={error}
      onFile={transcribe}
      onReset={reset}
    />
  );
}
