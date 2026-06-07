import { CheckIcon, MicIcon } from "lucide-react";
import { useState } from "react";
import type { VoiceTranscriptionProvider } from "@t3tools/contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const PROVIDER_OPTIONS: ReadonlyArray<{
  readonly value: VoiceTranscriptionProvider;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "groq",
    label: "Groq",
    description: "whisper-large-v3-turbo — ~200x real-time.",
  },
  {
    value: "openai",
    label: "OpenAI",
    description: "whisper-1.",
  },
];

export function VoiceSettingsPanel() {
  const provider = useSettings((settings) => settings.voiceTranscription.provider);
  const apiKeyRedacted = useSettings((settings) => settings.voiceTranscription.apiKeyRedacted);
  const { updateSettings } = useUpdateSettings();
  const [apiKeyDraft, setApiKeyDraft] = useState("");

  const handleProviderChange = (value: VoiceTranscriptionProvider) => {
    // Echo the redacted indicator so the stored key is preserved across a
    // provider-only change.
    updateSettings({
      voiceTranscription: { provider: value, apiKey: "", apiKeyRedacted },
    });
  };

  const handleSaveKey = () => {
    const apiKey = apiKeyDraft.trim();
    if (apiKey.length === 0) return;
    updateSettings({
      voiceTranscription: { provider, apiKey, apiKeyRedacted: false },
    });
    setApiKeyDraft("");
  };

  const handleClearKey = () => {
    updateSettings({
      voiceTranscription: { provider, apiKey: "", apiKeyRedacted: false },
    });
    setApiKeyDraft("");
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice Transcription" icon={<MicIcon className="size-3.5" />}>
        <SettingsRow
          title="Provider"
          description="Hosted Whisper service used to transcribe recorded audio."
          control={
            <Select
              value={provider}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  handleProviderChange(value as VoiceTranscriptionProvider);
                }
              }}
            >
              <SelectTrigger variant="ghost" size="sm" className="min-w-36 font-medium">
                <SelectValue>
                  {(value) =>
                    PROVIDER_OPTIONS.find((option) => option.value === value)?.label ?? value
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="min-w-56 py-2">
                    <div className="grid min-w-0 gap-0.5">
                      <span className="font-medium text-foreground">{option.label}</span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="API key"
          description="Stored server-side in the secret store. It is never written to disk in plain text or sent back to the browser."
          status={
            apiKeyRedacted ? (
              <Badge variant="success" size="sm">
                <CheckIcon className="size-3" />
                Key configured
              </Badge>
            ) : (
              <Badge variant="warning" size="sm">
                No key set
              </Badge>
            )
          }
        >
          <div className="flex flex-col gap-2 pt-3 pb-3.5 sm:flex-row sm:items-center">
            <Input
              type="password"
              autoComplete="off"
              value={apiKeyDraft}
              placeholder={
                apiKeyRedacted ? "Enter a new key to replace the stored one" : "Paste your API key"
              }
              className="sm:max-w-md"
              spellCheck={false}
              onChange={(event) => setApiKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleSaveKey();
                }
              }}
            />
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={apiKeyDraft.trim().length === 0}
                onClick={handleSaveKey}
              >
                Save key
              </Button>
              {apiKeyRedacted ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={handleClearKey}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
