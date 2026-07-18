import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PortSchema,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const PathString = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const PortId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const PortLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const TerminalId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const CommandId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const ProcessName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

const Ipv4Loopback = Schema.String.check(
  Schema.isPattern(/^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u),
);

export const PortRemoteHost = Schema.Union([Ipv4Loopback, Schema.Literal("::1")]);
export type PortRemoteHost = typeof PortRemoteHost.Type;

export const PortProtocol = Schema.Literals(["http", "https", "tcp"]);
export type PortProtocol = typeof PortProtocol.Type;

export const PortSource = Schema.Literals(["configured", "terminal", "listener", "manual"]);
export type PortSource = typeof PortSource.Type;

export const PortListenerStatus = Schema.Literals([
  "stopped",
  "starting",
  "ready",
  "unknown",
  "error",
]);
export type PortListenerStatus = typeof PortListenerStatus.Type;

export const PortOwnership = Schema.Literals(["gits-terminal", "unmanaged"]);
export type PortOwnership = typeof PortOwnership.Type;

export const PortSupervisedStatus = Schema.Literals([
  "unavailable",
  "stopped",
  "starting",
  "ready",
  "error",
]);
export type PortSupervisedStatus = typeof PortSupervisedStatus.Type;

export const PortExposureStatus = Schema.Literals([
  "none",
  "starting",
  "private",
  "public",
  "error",
]);
export type PortExposureStatus = typeof PortExposureStatus.Type;

export const PortRecord = Schema.Struct({
  id: PortId,
  remoteHost: PortRemoteHost,
  remotePort: PortSchema,
  protocol: PortProtocol,
  label: Schema.optionalKey(PortLabel),
  sources: Schema.Array(PortSource).check(Schema.isMinLength(1)),
  listenerStatus: PortListenerStatus,
  ownership: PortOwnership,
  threadId: Schema.optionalKey(ThreadId),
  terminalId: Schema.optionalKey(TerminalId),
  commandId: Schema.optionalKey(CommandId),
  pid: Schema.optionalKey(PositiveInt),
  processName: Schema.optionalKey(ProcessName),
  lastSeenAt: Schema.optionalKey(IsoDateTime),
  supervisedStatus: PortSupervisedStatus,
  exposureStatus: PortExposureStatus,
});
export type PortRecord = typeof PortRecord.Type;

export const PortsListInput = Schema.Struct({
  projectDir: PathString,
  threadId: Schema.optionalKey(ThreadId),
});
export type PortsListInput = typeof PortsListInput.Type;

export const PortsListResult = Schema.Struct({
  projectDir: PathString,
  threadId: Schema.optionalKey(ThreadId),
  scannedAt: IsoDateTime,
  ports: Schema.Array(PortRecord),
  warnings: Schema.Array(TrimmedNonEmptyString),
});
export type PortsListResult = typeof PortsListResult.Type;

export class GitsPortsError extends Schema.TaggedErrorClass<GitsPortsError>()("GitsPortsError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
