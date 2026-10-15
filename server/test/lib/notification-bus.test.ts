import { describe, it, expect, vi } from "vitest";
import { publishNotification, subscribeToNotifications } from "../../src/lib/notification-bus.js";

describe("notification-bus", () => {
  it("delivers a published notification to a subscriber", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToNotifications(listener);
    const notif = { id: "n1", clientId: "abc-fashion", clientName: "ABC Fashion", kind: "task" as const, title: "t", description: "d", createdAt: "2026-10-16T00:00:00.000Z" };
    publishNotification(notif);
    expect(listener).toHaveBeenCalledWith(notif);
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToNotifications(listener);
    unsubscribe();
    publishNotification({ id: "n2", clientId: "abc-fashion", clientName: "ABC Fashion", kind: "task", title: "t", description: "d", createdAt: "2026-10-16T00:00:00.000Z" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers to every active subscriber, not just the first", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeToNotifications(a);
    const unsubB = subscribeToNotifications(b);
    const notif = { id: "n3", clientId: "abc-fashion", clientName: "ABC Fashion", kind: "task" as const, title: "t", description: "d", createdAt: "2026-10-16T00:00:00.000Z" };
    publishNotification(notif);
    expect(a).toHaveBeenCalledWith(notif);
    expect(b).toHaveBeenCalledWith(notif);
    unsubA();
    unsubB();
  });
});
