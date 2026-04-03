interface CloudConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function transcribeCloud(
  wavBuffer: Buffer,
  language: string,
  config: CloudConfig,
): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "audio.wav");
  formData.append("model", config.model);
  if (language !== "auto") {
    formData.append("language", language);
  }

  const url = `${config.baseUrl}/v1/audio/transcriptions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloud API error (${response.status}): ${body}`);
  }

  const result = (await response.json()) as { text: string };
  return result.text.trim();
}
