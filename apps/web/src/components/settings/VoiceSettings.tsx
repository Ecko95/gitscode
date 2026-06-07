import { CheckIcon, EyeIcon, EyeOffIcon, MicIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { UnifiedSettings, VoiceTranscriptionProvider } from "@t3tools/contracts";

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

interface VoiceTranscriptionKeyPatch {
  readonly provider: VoiceTranscriptionProvider;
  readonly groqApiKey?: string;
  readonly groqApiKeyRedacted?: boolean;
  readonly openaiApiKey?: string;
  readonly openaiApiKeyRedacted?: boolean;
}

/**
 * Build a voiceTranscription patch carrying only the selected provider's key
 * fields. The server patch schema accepts these as optional keys, so the other
 * provider's stored secret is left untouched.
 */
function voicePatchFor(
  provider: VoiceTranscriptionProvider,
  apiKey: string,
  apiKeyRedacted: boolean,
): VoiceTranscriptionKeyPatch {
  return provider === "groq"
    ? { provider, groqApiKey: apiKey, groqApiKeyRedacted: apiKeyRedacted }
    : { provider, openaiApiKey: apiKey, openaiApiKeyRedacted: apiKeyRedacted };
}

export function VoiceSettingsPanel() {
  const provider = useSettings((settings) => settings.voiceTranscription.provider);
  const groqApiKeyRedacted = useSettings(
    (settings) => settings.voiceTranscription.groqApiKeyRedacted,
  );
  const openaiApiKeyRedacted = useSettings(
    (settings) => settings.voiceTranscription.openaiApiKeyRedacted,
  );
  const { updateSettings } = useUpdateSettings();
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  // The API key input is bound to the selected provider; reset the draft and
  // hide the value whenever the provider changes so a key typed for one
  // provider never bleeds into another.
  useEffect(() => {
    setApiKeyDraft("");
    setShowApiKey(false);
  }, [provider]);

  const apiKeyRedacted = provider === "groq" ? groqApiKeyRedacted : openaiApiKeyRedacted;

  // `updateSettings` is typed against the full settings object, but the
  // underlying server contract accepts a partial voiceTranscription patch.
  const submitVoicePatch = (voiceTranscription: VoiceTranscriptionKeyPatch) => {
    updateSettings({ voiceTranscription } as unknown as Partial<UnifiedSettings>);
  };

  const handleProviderChange = (value: VoiceTranscriptionProvider) => {
    // Echo the target provider's redacted indicator so its stored key is
    // preserved across a provider-only change.
    const redacted = value === "groq" ? groqApiKeyRedacted : openaiApiKeyRedacted;
    submitVoicePatch(voicePatchFor(value, "", redacted));
  };

  const handleSaveKey = () => {
    const apiKey = apiKeyDraft.trim();
    if (apiKey.length === 0) return;
    submitVoicePatch(voicePatchFor(provider, apiKey, false));
    setApiKeyDraft("");
    setShowApiKey(false);
  };

  const handleClearKey = () => {
    submitVoicePatch(voicePatchFor(provider, "", false));
    setApiKeyDraft("");
    setShowApiKey(false);
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
          description="Stored server-side in the secret store, per provider. It is never written to disk in plain text or sent back to the browser."
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
            <div className="relative sm:max-w-md sm:flex-1">
              <Input
                type={showApiKey ? "text" : "password"}
                autoComplete="off"
                value={apiKeyDraft}
                placeholder={
                  apiKeyRedacted
                    ? "Enter a new key to replace the stored one"
                    : "Paste your API key"
                }
                className="pr-9"
                spellCheck={false}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleSaveKey();
                  }
                }}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="absolute inset-y-0 right-1 my-auto text-muted-foreground hover:text-foreground"
                aria-label={showApiKey ? "Hide API key" : "Show API key"}
                onClick={() => setShowApiKey((value) => !value)}
              >
                {showApiKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
              </Button>
            </div>
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
