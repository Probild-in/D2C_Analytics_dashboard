import { EventEmitter } from "node:events";

export interface PublishedNotification {
  id: string;
  clientId: string;
  clientName: string;
  kind: "rto" | "sales" | "ads" | "roas" | "task";
  title: string;
  description: string;
  createdAt: string;
}

// A single in-process event bus for live notification delivery (see Task 3's SSE route).
// This app runs as one systemd process on one host (docs/DEPLOY.md) — if that ever
// changes to multiple processes/hosts, this in-memory bus stops being sufficient and
// needs a real pub/sub (e.g. Postgres LISTEN/NOTIFY or Redis) — not a concern today.
const EVENT_NAME = "notification";
const emitter = new EventEmitter();
// Default of 10 would log an "EventEmitter memory leak" warning once more than 10
// dashboard sessions have an SSE connection open at the same time — raise it generously
// rather than silence a real signal if this app ever does leak listeners.
emitter.setMaxListeners(200);

export function publishNotification(notification: PublishedNotification): void {
  emitter.emit(EVENT_NAME, notification);
}

export function subscribeToNotifications(listener: (notification: PublishedNotification) => void): () => void {
  emitter.on(EVENT_NAME, listener);
  return () => emitter.off(EVENT_NAME, listener);
}
