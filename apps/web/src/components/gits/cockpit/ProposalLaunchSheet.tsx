import type {
  AutomodeGoal,
  AutomodePolicy,
  GitsVerifyCommand,
  HermesProposalCard,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import type { MotokoProposalDecision, MotokoProposalEdits } from "./MotokoPanel";
import {
  TEST_PROPOSAL,
  initialProposalLaunchForm,
  launchModelOptions,
  proposalLaunchEdits,
  readProposalLaunchStep,
  validateProposalLaunchForm,
  type LaunchStep,
  type ProposalLaunchForm,
} from "./proposal-launch/proposalLaunch.logic";

interface ProposalLaunchSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly proposal: HermesProposalCard | null;
  readonly policy: AutomodePolicy;
  readonly testMode?: "proposal";
  readonly onDecision: (
    proposal: HermesProposalCard,
    decision: MotokoProposalDecision,
    edits: MotokoProposalEdits,
  ) => Promise<AutomodeGoal | null>;
}

const steps: ReadonlyArray<{ readonly id: LaunchStep; readonly label: string }> = [
  { id: "idea", label: "Idea" },
  { id: "model", label: "Run" },
  { id: "review", label: "Queue" },
];

function StepRail({ current }: { readonly current: LaunchStep }) {
  const activeIndex = steps.findIndex((step) => step.id === current);
  return (
    <div className="grid grid-cols-3 gap-1" aria-label={`Step ${activeIndex + 1} of 3`}>
      {steps.map((step, index) => (
        <div key={step.id} className="grid gap-1.5">
          <div
            className={cn(
              "h-1 rounded-full bg-border transition-colors",
              index <= activeIndex && "bg-info",
            )}
          />
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span
              className={
                index === activeIndex ? "font-medium text-foreground" : "text-muted-foreground"
              }
            >
              {step.label}
            </span>
            {index === activeIndex ? (
              <span className="font-mono text-[10px] text-muted-foreground">{index + 1} of 3</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function IdeaStep({ proposal }: { readonly proposal: HermesProposalCard }) {
  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Outcome</p>
        <h3 className="font-heading text-2xl font-semibold tracking-tight">{proposal.title}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{proposal.summary}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">
            {proposal.risk[0]!.toUpperCase() + proposal.risk.slice(1)} risk
          </Badge>
          <Badge variant="outline">{proposal.actionKind}</Badge>
          <span className="font-mono text-[11px] text-muted-foreground">
            {proposal.projectDir ?? "Repository chosen before queueing"}
          </span>
        </div>
      </section>
      <div className="grid gap-4 rounded-xl border border-border/70 bg-muted/24 p-4">
        <section className="grid gap-2">
          <p className="text-xs font-medium text-muted-foreground">What changes</p>
          <div className="flex flex-wrap gap-1.5">
            {proposal.scope.map((item) => (
              <Badge key={item} variant="outline">
                {item}
              </Badge>
            ))}
          </div>
        </section>
        <section className="grid gap-2 border-t border-border/60 pt-4">
          <p className="text-xs font-medium text-muted-foreground">Why now</p>
          <ul className="grid gap-1.5 text-sm leading-5">
            {proposal.evidence.map((item) => (
              <li key={item}>— {item}</li>
            ))}
          </ul>
        </section>
        {proposal.verificationPlan.length > 0 ? (
          <section className="grid gap-2 border-t border-border/60 pt-4">
            <p className="text-xs font-medium text-muted-foreground">How it will be checked</p>
            <ul className="grid gap-1.5 text-sm leading-5">
              {proposal.verificationPlan.map((item) => (
                <li key={item}>— {item}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{proposal.detail}</p>
    </div>
  );
}

function VerificationRows({
  commands,
  onChange,
}: {
  readonly commands: ReadonlyArray<GitsVerifyCommand>;
  readonly onChange: (commands: ReadonlyArray<GitsVerifyCommand>) => void;
}) {
  const update = (index: number, patch: Partial<GitsVerifyCommand>) =>
    onChange(commands.map((command, row) => (row === index ? { ...command, ...patch } : command)));
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Verification checks</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => onChange([...commands, { label: "Check", cmd: ["bun", "run", "test"] }])}
        >
          <PlusIcon /> Add check
        </Button>
      </div>
      {commands.map((command, index) => (
        <div
          key={`${command.label}-${index}`}
          className="grid gap-2 rounded-lg border border-border/60 p-3"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_8rem_auto] gap-2">
            <Input
              aria-label={`Verification ${index + 1} label`}
              value={command.label}
              onChange={(event) => update(index, { label: event.currentTarget.value })}
            />
            <Input
              aria-label={`Verification ${index + 1} timeout seconds`}
              min="0"
              placeholder="Timeout"
              type="number"
              value={command.timeoutSeconds ?? ""}
              onChange={(event) => {
                const { timeoutSeconds: _, ...withoutTimeout } = command;
                const value = event.currentTarget.value;
                onChange(
                  commands.map((entry, row) =>
                    row === index
                      ? value === ""
                        ? withoutTimeout
                        : { ...withoutTimeout, timeoutSeconds: Number(value) }
                      : entry,
                  ),
                );
              }}
            />
            <Button
              aria-label={`Remove verification ${index + 1}`}
              size="icon"
              variant="ghost"
              onClick={() => onChange(commands.filter((_, row) => row !== index))}
            >
              <Trash2Icon />
            </Button>
          </div>
          <div className="grid gap-2">
            {command.cmd.map((argument, argumentIndex) => (
              // oxlint-disable-next-line react/no-array-index-key -- argv values can repeat; position is their identity
              <div key={argumentIndex} className="flex gap-2">
                <Input
                  aria-label={`Verification ${index + 1} argument ${argumentIndex + 1}`}
                  className="font-mono text-xs"
                  value={argument}
                  onChange={(event) =>
                    update(index, {
                      cmd: command.cmd.map((entry, row) =>
                        row === argumentIndex ? event.currentTarget.value : entry,
                      ),
                    })
                  }
                />
                <Button
                  aria-label={`Remove verification ${index + 1} argument ${argumentIndex + 1}`}
                  disabled={command.cmd.length === 1}
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    update(index, {
                      cmd: command.cmd.filter((_, row) => row !== argumentIndex),
                    })
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            <Button
              className="justify-self-start"
              size="xs"
              variant="ghost"
              onClick={() => update(index, { cmd: [...command.cmd, ""] })}
            >
              <PlusIcon /> Add argument
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function RunStep({
  form,
  policy,
  advanced,
  onAdvancedChange,
  onFormChange,
}: {
  readonly form: ProposalLaunchForm;
  readonly policy: AutomodePolicy;
  readonly advanced: boolean;
  readonly onAdvancedChange: (open: boolean) => void;
  readonly onFormChange: (form: ProposalLaunchForm) => void;
}) {
  const modelOptions = launchModelOptions(policy);
  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <label
          className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
          htmlFor="proposal-model"
        >
          Model
        </label>
        <Select
          items={modelOptions}
          value={form.model}
          onValueChange={(value) =>
            typeof value === "string" && onFormChange({ ...form, model: value })
          }
        >
          <SelectTrigger id="proposal-model" aria-label="Model" size="lg">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectGroup>
              {modelOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectPopup>
        </Select>
        <p className="text-xs text-muted-foreground">
          The recommended model is preselected. Change it only when the idea needs a different
          depth.
        </p>
      </section>

      <div className="border-t border-border/70 pt-3">
        <Button
          className="w-full justify-between px-0 hover:bg-transparent"
          variant="ghost"
          onClick={() => onAdvancedChange(!advanced)}
        >
          Advanced details
          {advanced ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        {advanced ? (
          <div className="mt-3 grid gap-4 rounded-xl border border-border/70 bg-muted/20 p-4">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Repository override
              <Input
                value={form.repository}
                onChange={(event) =>
                  onFormChange({ ...form, repository: event.currentTarget.value })
                }
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                Start after
                <Input
                  type="datetime-local"
                  value={form.notBefore}
                  onChange={(event) =>
                    onFormChange({ ...form, notBefore: event.currentTarget.value })
                  }
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                Runtime minutes
                <Input
                  min="0"
                  type="number"
                  value={form.runtime}
                  onChange={(event) =>
                    onFormChange({ ...form, runtime: event.currentTarget.value })
                  }
                />
              </label>
            </div>
            <VerificationRows
              commands={form.verificationCommands}
              onChange={(verificationCommands) => onFormChange({ ...form, verificationCommands })}
            />
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Integration branch
              <Input
                value={form.integrationBranch}
                onChange={(event) =>
                  onFormChange({ ...form, integrationBranch: event.currentTarget.value })
                }
              />
            </label>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReviewStep({
  form,
  proposal,
}: {
  readonly form: ProposalLaunchForm;
  readonly proposal: HermesProposalCard;
}) {
  const rows = [
    ["Model", form.model],
    ["Repository", form.repository],
    ["Runtime", form.runtime ? `${form.runtime} minutes` : "Policy default"],
    ["Start", form.notBefore || "Next eligible slot"],
  ] as const;
  return (
    <div className="grid gap-5">
      <div className="rounded-xl border border-info/30 bg-info/6 p-4">
        <p className="font-mono text-[10px] tracking-[0.18em] text-info-foreground uppercase">
          Queue ready
        </p>
        <p className="mt-2 text-sm leading-6">
          Accepting creates one queued Goal. Autopilot starts it only when policy and schedule gates
          allow.
        </p>
      </div>
      <dl className="divide-y divide-border/60 rounded-xl border border-border/70">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 px-4 py-3 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd
              className={cn("min-w-0 break-words", label === "Repository" && "font-mono text-xs")}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-2 rounded-xl border border-border/70 p-4 text-sm">
        <p className="font-medium">What runs</p>
        <p className="text-muted-foreground">{form.prompt}</p>
        {proposal.verificationPlan.length > 0 ? (
          <p className="text-muted-foreground">
            Expected verification: {proposal.verificationPlan.join(" · ")}
          </p>
        ) : null}
        <p className="text-muted-foreground">
          Successful work stays on an isolated branch and ends in a held PR for review. Autopilot
          does not merge it automatically.
        </p>
      </div>
    </div>
  );
}

export function ProposalLaunchSheet({
  open,
  onOpenChange,
  proposal,
  policy,
  testMode,
  onDecision,
}: ProposalLaunchSheetProps) {
  const activeProposal = testMode === "proposal" ? TEST_PROPOSAL : proposal;
  const seed = activeProposal ?? TEST_PROPOSAL;
  const [step, setStep] = useState<LaunchStep>("idea");
  const [form, setForm] = useState(() => initialProposalLaunchForm(seed, policy));
  const [advanced, setAdvanced] = useState(false);
  const [working, setWorking] = useState(false);
  const [queued, setQueued] = useState<AutomodeGoal | null>(null);
  const [testComplete, setTestComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = `${activeProposal?.id ?? "none"}:${testMode ?? "real"}`;

  useEffect(() => {
    if (!open || activeProposal === null) return;
    setStep(readProposalLaunchStep(typeof window === "undefined" ? "" : window.location.search));
    setForm(initialProposalLaunchForm(activeProposal, policy));
    setAdvanced(false);
    setWorking(false);
    setQueued(null);
    setTestComplete(false);
    setError(null);
  }, [identity, open, activeProposal, policy]);

  const validation = useMemo(() => validateProposalLaunchForm(form), [form]);
  if (activeProposal === null) return null;

  const changeStep = (next: LaunchStep) => {
    setStep(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("proposalStep", next);
    window.history.replaceState(null, "", url);
  };

  const decide = async (decision: MotokoProposalDecision) => {
    if (decision === "approve" && !validation.ok) {
      setError(validation.message);
      return;
    }
    if (testMode === "proposal") {
      setTestComplete(true);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const goal = await onDecision(
        activeProposal,
        decision,
        decision === "approve" ? proposalLaunchEdits(form) : {},
      );
      if (decision === "approve" && goal === null) {
        throw new Error("The proposal was approved, but its queued Goal could not be confirmed.");
      }
      if (decision === "approve") setQueued(goal);
      else onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The proposal could not be updated. Retry.",
      );
    } finally {
      setWorking(false);
    }
  };

  const finished = queued !== null || testComplete;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="max-w-xl">
        <SheetHeader className="gap-4 border-b border-border/60 pb-4">
          <div className="flex items-center gap-2 pr-8">
            <SheetTitle>Validate and queue</SheetTitle>
            {testMode === "proposal" ? <Badge variant="warning">Test notification</Badge> : null}
          </div>
          <SheetDescription>One decision, one model choice, one queued Goal.</SheetDescription>
          {!finished ? <StepRail current={step} /> : null}
        </SheetHeader>

        <SheetPanel className="min-h-0 py-6">
          {queued !== null ? (
            <div className="grid place-items-center gap-3 py-16 text-center">
              <div className="grid size-12 place-items-center rounded-full bg-success/12 text-success-foreground">
                <CheckCircle2Icon />
              </div>
              <p className="font-heading text-2xl font-semibold">Queued</p>
              <p className="max-w-sm text-sm text-muted-foreground">{queued.title}</p>
              <Badge variant="success">{queued.status}</Badge>
            </div>
          ) : testComplete ? (
            <div className="grid place-items-center gap-3 py-16 text-center">
              <div className="grid size-12 place-items-center rounded-full bg-success/12 text-success-foreground">
                <CheckCircle2Icon />
              </div>
              <p className="font-heading text-2xl font-semibold">Test complete</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                The notification opened the real review experience without creating work.
              </p>
            </div>
          ) : step === "idea" ? (
            <IdeaStep proposal={activeProposal} />
          ) : step === "model" ? (
            <RunStep
              form={form}
              policy={policy}
              advanced={advanced}
              onAdvancedChange={setAdvanced}
              onFormChange={setForm}
            />
          ) : (
            <ReviewStep form={form} proposal={activeProposal} />
          )}
          {error !== null ? (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
        </SheetPanel>

        <SheetFooter>
          {finished ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <div className="flex flex-1 gap-2">
                <Button disabled={working} variant="ghost" onClick={() => void decide("reject")}>
                  Reject
                </Button>
                <Button disabled={working} variant="ghost" onClick={() => void decide("defer")}>
                  Later
                </Button>
              </div>
              {step !== "idea" ? (
                <Button
                  disabled={working}
                  variant="outline"
                  onClick={() => changeStep(step === "review" ? "model" : "idea")}
                >
                  Back
                </Button>
              ) : null}
              {step === "idea" ? (
                <Button onClick={() => changeStep("model")}>Continue</Button>
              ) : step === "model" ? (
                <Button
                  onClick={() =>
                    validation.ok ? changeStep("review") : setError(validation.message)
                  }
                >
                  Review queue
                </Button>
              ) : (
                <Button disabled={working} onClick={() => void decide("approve")}>
                  {testMode === "proposal"
                    ? "Complete Test"
                    : working
                      ? "Queueing…"
                      : "Accept & Queue"}
                </Button>
              )}
            </>
          )}
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}
