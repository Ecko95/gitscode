import type { QueuedComposerMessage } from "../../composerDraftStore";
import { Button } from "../ui/button";

export function ComposerQueue(props: {
  messages: QueuedComposerMessage[];
  canSendNow: boolean;
  onEdit: (message: QueuedComposerMessage) => void;
  onSendNow: (message: QueuedComposerMessage) => void;
  onRemove: (message: QueuedComposerMessage) => void;
}) {
  if (props.messages.length === 0) return null;
  return (
    <div className="mb-1 grid gap-1 rounded-lg border border-border/60 bg-card/95 p-1.5">
      {props.messages.map((message) => (
        <div key={message.id} className="flex min-w-0 items-center gap-1.5 px-1">
          <span className="min-w-0 flex-1 truncate text-xs" title={message.rawPrompt}>
            {message.rawPrompt || message.titleSeed}
          </span>
          {message.attachments.length > 0 ? (
            <span className="shrink-0 text-muted-foreground text-xs">
              {message.attachments.length} attachment{message.attachments.length === 1 ? "" : "s"}
            </span>
          ) : null}
          <Button variant="ghost" size="xs" type="button" onClick={() => props.onEdit(message)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="xs"
            type="button"
            disabled={!props.canSendNow}
            title={props.canSendNow ? "Send to the active turn" : "No active turn to steer"}
            onClick={() => props.onSendNow(message)}
          >
            Send now
          </Button>
          <Button variant="ghost" size="xs" type="button" onClick={() => props.onRemove(message)}>
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}
