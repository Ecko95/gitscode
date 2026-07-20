// Redesigned as the Autopilot panel (automode + night scheduler + control-panel kill
// switches) in ./AutopilotPanel.tsx. This file only exists so GitsCockpit.tsx's
// `import { AutomodePanel } from "./cockpit/AutomodePanel"` keeps working unmodified.
export { AutopilotPanel as AutomodePanel } from "./AutopilotPanel";
