import type {
  AudioTranscribeInput,
  AudioTranscribeResult,
  VoiceTranscriptionError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface VoiceTranscriptionServiceShape {
  /**
   * Transcribe recorded audio through the configured hosted Whisper provider.
   *
   * Reads the selected provider from `ServerSettings.voiceTranscription` and the
   * API key from `ServerSecretStore`, then POSTs the audio as multipart
   * `file`+`model` to the provider's OpenAI-compatible transcription endpoint.
   */
  readonly transcribe: (
    input: AudioTranscribeInput,
  ) => Effect.Effect<AudioTranscribeResult, VoiceTranscriptionError>;
}

export class VoiceTranscriptionService extends Context.Service<
  VoiceTranscriptionService,
  VoiceTranscriptionServiceShape
>()("t3/voice/Services/VoiceTranscription/VoiceTranscriptionService") {}
