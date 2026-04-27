interface PluginContext {
  getSecret: (key: string) => string | null;
  getGoogleToken: () => Promise<string | null>;
}

export default function setup(ctx: PluginContext) {
  return {
    tools: [
      {
        name: "openai-voice_transcribe",
        description: "Transcribe a voice message audio file using OpenAI Whisper. Provide the audio as a URL or base64-encoded content.",
        input_schema: {
          type: "object" as const,
          properties: {
            audio_url: {
              type: "string",
              description: "URL of the audio file to transcribe"
            },
            language: {
              type: "string",
              description: "Language of the audio (optional, e.g. 'en', 'de'). If omitted, Whisper will auto-detect."
            }
          },
          required: ["audio_url"]
        }
      }
    ],
    handlers: {
      "openai-voice_transcribe": async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("OPENAI_API_KEY");
        if (!apiKey) return "Error: OPENAI_API_KEY not set. Please provide it via store_secret.";

        const audioUrl = input["audio_url"] as string;
        const language = input["language"] as string | undefined;

        // Fetch the audio file
        const audioResponse = await fetch(audioUrl);
        if (!audioResponse.ok) {
          return `Error: Failed to fetch audio file from URL. Status: ${audioResponse.status}`;
        }

        const audioBuffer = await audioResponse.arrayBuffer();
        const audioBlob = new Uint8Array(audioBuffer);

        // Build multipart form data
        const boundary = "----WhisperBoundary" + Date.now();
        const filenameGuess = audioUrl.split("/").pop()?.split("?")[0] || "audio.ogg";

        const encoder = new TextEncoder();

        const partHeader = encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filenameGuess}"\r\nContent-Type: audio/ogg\r\n\r\n`
        );
        const modelPart = encoder.encode(
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`
        );
        const langPart = language
          ? encoder.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}`)
          : new Uint8Array(0);
        const closing = encoder.encode(`\r\n--${boundary}--\r\n`);

        const totalLength = partHeader.length + audioBlob.length + modelPart.length + langPart.length + closing.length;
        const body = new Uint8Array(totalLength);
        let offset = 0;
        body.set(partHeader, offset); offset += partHeader.length;
        body.set(audioBlob, offset); offset += audioBlob.length;
        body.set(modelPart, offset); offset += modelPart.length;
        body.set(langPart, offset); offset += langPart.length;
        body.set(closing, offset);

        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`
          },
          body: body
        });

        if (!response.ok) {
          const err = await response.text();
          return `Error from Whisper API: ${err}`;
        }

        const result = await response.json() as { text: string };
        return result.text || "No transcription returned.";
      }
    }
  };
}
