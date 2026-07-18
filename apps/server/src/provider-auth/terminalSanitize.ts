const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");

/** First bare `https://…` token in a string, up to the next whitespace/quote/angle bracket. */
export const HTTPS_URL = /https:\/\/[^\s<>"']+(?=[\s<>"'])/i;

/** Strip ANSI OSC/CSI control sequences from PTY transcript text before scanning it. */
export function stripTerminalControls(value: string): string {
  return value.replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "");
}
