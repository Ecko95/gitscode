/**
 * VoiceTranscriptionLive - Server-side proxy to a hosted Whisper API.
 *
 * Resolves the selected provider from `ServerSettings.voiceTranscription`, reads
 * the API key from `ServerSecretStore` (never the cleartext key off the wire),
 * decodes the recorded audio, and POSTs it as multipart `file`+`model` to the
 * provider's OpenAI-compatible `/audio/transcriptions` endpoint.
 *
 * @module VoiceTranscriptionLive
 */
import { type VoiceTranscriptionProvider, VoiceTranscriptionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerSettingsService, voiceTranscriptionSecretName } from "../../serverSettings.ts";
import {
  VoiceTranscriptionService,
  type VoiceTranscriptionServiceShape,
} from "../Services/VoiceTranscription.ts";

interface ProviderEndpoint {
  readonly url: string;
  readonly model: string;
}

const PROVIDER_ENDPOINTS: Record<VoiceTranscriptionProvider, ProviderEndpoint> = {
  groq: {
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    model: "whisper-large-v3-turbo",
  },
  openai: {
    url: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
  },
};

const TranscriptionResponse = Schema.Struct({
  text: Schema.String,
});
const decodeTranscriptionResponse = HttpClientResponse.schemaBodyJson(TranscriptionResponse);

const textDecoder = new TextDecoder();

function decodeBase64ToBytes(audioBase64: string): Uint8Array {
  const buffer = Buffer.from(audioBase64, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export const makeVoiceTranscriptionService = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore;

  const transcribe: VoiceTranscriptionServiceShape["transcribe"] = (input) =>
    Effect.gen(function* () {
      const bytes = decodeBase64ToBytes(input.audioBase64);
      if (bytes.byteLength === 0) {
        return yield* new VoiceTranscriptionError({
          reason: "empty_audio",
          detail: "Recorded audio was empty.",
        });
      }

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new VoiceTranscriptionError({
              reason: "provider_error",
              detail: `Failed to read voice transcription settings: ${cause.detail}`,
              cause,
            }),
        ),
      );

      const provider = settings.voiceTranscription.provider;
      const endpoint = PROVIDER_ENDPOINTS[provider];

      const secret = yield* secretStore.get(voiceTranscriptionSecretName()).pipe(
        Effect.mapError(
          (cause) =>
            new VoiceTranscriptionError({
              reason: "provider_error",
              detail: "Failed to read the stored Whisper API key.",
              cause,
            }),
        ),
      );
      const apiKey = secret ? textDecoder.decode(secret).trim() : "";
      if (apiKey.length === 0) {
        return yield* new VoiceTranscriptionError({
          reason: "missing_api_key",
          detail: `No API key is configured for the ${provider} transcription provider.`,
        });
      }

      const file = new File([bytes], input.fileName, { type: input.mimeType });
      const request = HttpClientRequest.post(endpoint.url).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
        HttpClientRequest.bodyFormDataRecord({ file, model: endpoint.model }),
      );

      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new VoiceTranscriptionError({
              reason: "network_error",
              detail: `Failed to reach the ${provider} transcription endpoint.`,
              cause,
            }),
        ),
      );

      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* new VoiceTranscriptionError({
          reason: "provider_error",
          detail: `${provider} transcription request failed with status ${response.status}${
            body ? `: ${body}` : ""
          }`,
        });
      }

      const decoded = yield* decodeTranscriptionResponse(response).pipe(
        Effect.mapError(
          (cause) =>
            new VoiceTranscriptionError({
              reason: "provider_error",
              detail: `Failed to parse the ${provider} transcription response.`,
              cause,
            }),
        ),
      );

      return { text: decoded.text };
    });

  return {
    transcribe,
  } satisfies VoiceTranscriptionServiceShape;
});

export const VoiceTranscriptionLive = Layer.effect(
  VoiceTranscriptionService,
  makeVoiceTranscriptionService,
);
