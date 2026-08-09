# GITS Autonomy

GITS autonomy turns operator-reviewed improvement ideas into safely queued work while keeping the operator-visible history distinct from execution state.

## Language

**Proposal**:
A candidate piece of work presented for operator review. It is not executable work until accepted.
_Avoid_: Goal, task, notification

**Launch Configuration**:
The proposal-specific choices that define how accepted work should run, including its model and optional execution constraints.
_Avoid_: Global policy, settings form

**Acceptance**:
The operator decision that approves a Proposal with its Launch Configuration and requests exactly one Goal.
_Avoid_: Dispatch, start, run

**Goal**:
The durable execution record created from an accepted Proposal. A Goal may wait in the Queue before execution starts.
_Avoid_: Proposal, notification

**Queue**:
The ordered collection of Goals eligible for future execution. Entering the Queue does not mean execution has started.
_Avoid_: Inbox, scheduler

**Inbox Item**:
The durable operator-facing history of a Proposal and its resulting Goal. It is not execution truth.
_Avoid_: Goal, push notification

**Notification**:
An optional delivery signal that points to an Inbox Item. Delivery failure does not remove or alter the Inbox Item.
_Avoid_: Inbox Item, Proposal

**Pause**:
An operator state that prevents new proposals and future Goal starts without terminating work already running.
_Avoid_: Emergency Stop, kill

**Emergency Stop**:
An operator action that terminates running autonomous work and prevents new Goal starts until autonomy is explicitly enabled again.
_Avoid_: Pause, reject
