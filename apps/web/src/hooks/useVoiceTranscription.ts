import { useCallback, useEffect, useRef, useState } from "react";

import { readFileAsDataUrl } from "../components/ChatView.logic";
import { toastManager } from "../components/ui/toast";
import { ensureLocalApi } from "../localApi";
import { useSettings } from "./useSettings";

export type VoiceTranscriptionState = "idle" | "recording" | "transcribing" | "error";

/** Preferred recording mime types, in order. Safari lacks webm/opus → mp4 fallback. */
const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];

/** Hard cap on recording length to keep the base64 WS payload small. */
const MAX_RECORDING_MS = 60_000;

interface VoiceTranscriptionErrorLike {
  readonly _tag: "VoiceTranscriptionError";
  readonly reason: "missing_api_key" | "empty_audio" | "provider_error" | "network_error";
  readonly detail: string;
}

function isVoiceTranscriptionError(error: unknown): error is VoiceTranscriptionErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag?: unknown })._tag === "VoiceTranscriptionError"
  );
}

function describeError(error: unknown): string {
  if (isVoiceTranscriptionError(error)) {
    switch (error.reason) {
      case "missing_api_key":
        return "Add a Whisper API key in Settings → Voice.";
      case "empty_audio":
        return "No audio was captured. Try recording again.";
      case "network_error":
        return "Could not reach the transcription provider.";
      default:
        return error.detail || "Transcription failed.";
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Transcription failed.";
}

function pickSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const candidate of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function fileExtensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}

export interface UseVoiceTranscriptionResult {
  readonly state: VoiceTranscriptionState;
  readonly isBusy: boolean;
  readonly missingApiKey: boolean;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
}

/**
 * Shared mic-recording + hosted-Whisper transcription state machine used by both
 * composers. Records via the browser-native `MediaRecorder`, base64-encodes the
 * blob, and proxies it through the `audio.transcribe` WS RPC. The returned
 * transcript is handed back through `onTranscript`; each composer inserts it via
 * its own setter so no editor internals are duplicated here.
 */
export function useVoiceTranscription(options: {
  readonly onTranscript: (text: string) => void;
}): UseVoiceTranscriptionResult {
  const onTranscriptRef = useRef(options.onTranscript);
  onTranscriptRef.current = options.onTranscript;

  const apiKeyRedacted = useSettings((settings) => settings.voiceTranscription.apiKeyRedacted);
  const missingApiKey = !apiKeyRedacted;

  const [state, setState] = useState<VoiceTranscriptionState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("audio/webm");
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const releaseStream = useCallback(() => {
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const transcribeBlob = useCallback(async (blob: Blob) => {
    if (blob.size === 0) {
      setState("error");
      toastManager.add({ type: "error", title: "No audio was captured. Try recording again." });
      setState("idle");
      return;
    }

    setState("transcribing");
    const mimeType = mimeTypeRef.current;
    console.info("[voice] captured audio", blob.size, "bytes", mimeType);
    try {
      const dataUrl = await readFileAsDataUrl(
        new File([blob], `voice-input.${fileExtensionForMimeType(mimeType)}`, { type: mimeType }),
      );
      const audioBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      console.info("[voice] sending to transcription provider…");
      const result = await ensureLocalApi().audio.transcribe({
        audioBase64,
        mimeType,
        fileName: `voice-input.${fileExtensionForMimeType(mimeType)}`,
      });
      const text = result.text.trim();
      if (text.length > 0) {
        console.info("[voice] transcript received:", text.length, "chars:", text.slice(0, 120));
        onTranscriptRef.current(text);
      } else {
        console.warn("[voice] provider returned empty transcript");
      }
      setState("idle");
    } catch (error) {
      console.error("[voice] transcription failed:", error);
      toastManager.add({ type: "error", title: describeError(error) });
      setState("idle");
    }
  }, []);

  const start = useCallback(async () => {
    if (missingApiKey) {
      toastManager.add({ type: "error", title: "Add a Whisper API key in Settings → Voice." });
      return;
    }
    if (state === "recording" || state === "transcribing") {
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toastManager.add({ type: "error", title: "Microphone recording is not available here." });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mimeTypeRef.current = recorder.mimeType || mimeType || "audio/webm";
      chunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });
      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
        console.info(
          "[voice] recording stopped:",
          chunksRef.current.length,
          "chunks,",
          blob.size,
          "bytes",
          blob.type,
        );
        releaseStream();
        void transcribeBlob(blob);
      });
      recorderRef.current = recorder;
      recorder.start();
      setState("recording");
      stopTimeoutRef.current = setTimeout(() => {
        if (recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
        }
      }, MAX_RECORDING_MS);
    } catch (error) {
      releaseStream();
      setState("idle");
      toastManager.add({
        type: "error",
        title:
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Microphone permission was denied."
            : "Could not start recording.",
      });
    }
  }, [missingApiKey, releaseStream, state, transcribeBlob]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
    }
  }, []);

  useEffect(() => releaseStream, [releaseStream]);

  return {
    state,
    isBusy: state === "recording" || state === "transcribing",
    missingApiKey,
    start,
    stop,
  };
}
