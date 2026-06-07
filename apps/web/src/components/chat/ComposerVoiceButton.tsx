import { Loader2Icon, MicIcon, SquareIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { VoiceTranscriptionState } from "../../hooks/useVoiceTranscription";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerVoiceButtonProps {
  readonly state: VoiceTranscriptionState;
  readonly missingApiKey: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly size?: "sm" | "icon" | "icon-sm";
  readonly className?: string;
}

function tooltipLabel(props: ComposerVoiceButtonProps): string {
  if (props.missingApiKey) return "Add a Whisper API key in Settings → Voice";
  switch (props.state) {
    case "recording":
      return "Stop recording";
    case "transcribing":
      return "Transcribing…";
    default:
      return "Record voice input";
  }
}

/**
 * Presentational mic button shared by both composers. Stateless beyond its
 * `state`/`missingApiKey` props — the recording lifecycle lives in
 * `useVoiceTranscription`.
 */
export function ComposerVoiceButton(props: ComposerVoiceButtonProps) {
  const { state, missingApiKey, onStart, onStop } = props;
  const isRecording = state === "recording";
  const isTranscribing = state === "transcribing";
  const disabled = missingApiKey || isTranscribing;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={props.size ?? "icon-sm"}
            aria-label={isRecording ? "Stop voice recording" : "Record voice input"}
            aria-pressed={isRecording}
            disabled={disabled}
            onClick={() => (isRecording ? onStop() : onStart())}
            className={cn(
              "shrink-0 text-muted-foreground/70 hover:text-foreground/80",
              isRecording && "text-red-400 hover:text-red-300",
              props.className,
            )}
          >
            {isTranscribing ? (
              <Loader2Icon className="animate-spin" />
            ) : isRecording ? (
              <SquareIcon className="fill-current" />
            ) : (
              <MicIcon />
            )}
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltipLabel(props)}</TooltipPopup>
    </Tooltip>
  );
}
