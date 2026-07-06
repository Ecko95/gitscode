# Web Push PWA Setup

GITS can send Web Push notifications for the same attention events used by the
in-app notification hook:

- turn diff completed
- approval requested
- user input requested

This is designed for self-hosting on a Tailscale tailnet. The phone must reach
the GITS web app to install the PWA and register a push subscription, but the
server does not need public inbound access for delivery. Delivery is an outbound
POST from the GITS server to the browser vendor's public push service.

## Generate VAPID Keys

Generate keys on the host that runs GITS:

```sh
npx web-push generate-vapid-keys
```

Configure the server with all three values:

```sh
export T3CODE_VAPID_PUBLIC_KEY="..."
export T3CODE_VAPID_PRIVATE_KEY="..."
export T3CODE_VAPID_SUBJECT="mailto:operator@example.com"
```

`T3CODE_VAPID_SUBJECT` may be a `mailto:` address or an HTTPS URL identifying
the operator. Restart the server after changing these variables. Web Push is
inert until all three values are present.

## Phone Setup

1. Connect the phone to the tailnet.
2. Open GITS from the same stable HTTPS origin you will keep using.
3. Install the app to the home screen.
4. Open the installed PWA and enable Settings -> Notifications -> Push to phone.

iOS requires iOS 16.4 or newer and a home-screen installed PWA. A normal Safari
tab cannot receive Web Push after it is closed.

## What Is Cached

The service worker only precaches the app shell and uses network-first handling
for page navigations. It does not cache `/api/*`, attachment URLs, or WebSocket
state. Live session state still comes from the server after reconnect.

## Server Event Seam

The server sends push notifications from
`OrchestrationEngineService.streamDomainEvents` via the push notification
reactor. The current mapped events are:

- `thread.turn-diff-completed`
- `thread.activity-appended` with `activity.kind === "approval.requested"`
- `thread.activity-appended` with `activity.kind === "user-input.requested"`

ponytail: notification text uses `Thread <threadId>` instead of loading the
projection title in the hot reactor path. Notification clicks still deep-link to
the exact thread route.
