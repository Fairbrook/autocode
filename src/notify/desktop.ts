import { spawn } from "node:child_process";
import type { NotifyEvent } from "./index.ts";

const notificationIdByRun = new Map<number, number>();

/**
 * Fires a desktop notification via `notify-send` (confirmed present on this
 * machine during the Gate 2/3 spikes: /usr/bin/notify-send, swaync daemon).
 * Reuses one notification slot per run (`-p`/`-r`) so a run's status
 * updates replace each other in the notification center instead of
 * spamming a new toast per event. Fails silently if notify-send is
 * missing or DBUS isn't reachable — desktop notification is one of three
 * independent channels (constraint: desktop + SSE + web push), and losing
 * it must never affect the run itself or the other two channels.
 */
export function sendDesktopNotification(event: NotifyEvent): void {
  const urgency = event.kind === "approval_needed" ? "critical" : "normal";
  const existingId = notificationIdByRun.get(event.runId);

  const args = ["-u", urgency, "-p"];
  if (existingId !== undefined) args.push("-r", String(existingId));
  args.push(event.title, event.body);

  const child = spawn("notify-send", args, {
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS:
        process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    },
  });

  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.on("close", (code) => {
    if (code === 0) {
      const id = Number.parseInt(stdout.trim(), 10);
      if (Number.isFinite(id)) notificationIdByRun.set(event.runId, id);
    }
  });
  child.on("error", () => {
    // notify-send not installed, or DBUS unreachable (e.g. running as a
    // headless systemd service with no session bus) — swallow. This
    // channel is best-effort by design.
  });
}
