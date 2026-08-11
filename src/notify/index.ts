export interface NotifyEvent {
  kind: "plan_ready" | "approval_needed" | "run_complete" | "run_failed";
  runId: number;
  approvalId?: number;
  title: string;
  body: string;
}

export type Fanout = (event: NotifyEvent) => void;

// Populated by src/notify/desktop.ts and src/notify/webpush.ts once the
// server wires them in (see src/server/index.ts) — kept as simple
// injectable hooks so this module has zero dependencies of its own and the
// server layer controls what's actually enabled (config.notify.*).
type SideChannel = (event: NotifyEvent) => void;
const sideChannels: SideChannel[] = [];

export function registerSideChannel(fn: SideChannel): void {
  sideChannels.push(fn);
}

/**
 * The SSE side of the fan-out (constraint: three independent notification
 * channels — desktop, in-app SSE, web push). SSE delivery persists through
 * the same run_log table the rest of the run transcript uses, under a
 * dedicated "notification" event kind, so a client only needs one
 * EventSource connection per run to get both transcript and notifications,
 * and reopening a tab replays missed notifications along with everything
 * else (appendRunLog broadcasts to live subscribers as a side effect — see
 * src/db/repo/log.ts).
 */
export function createFanout(appendRunLog: (runId: number, kind: string, payload: unknown) => void): Fanout {
  return (event: NotifyEvent) => {
    appendRunLog(event.runId, "notification", event);
    for (const channel of sideChannels) {
      try {
        channel(event);
      } catch {
        // A side channel failing (e.g. notify-send missing, a push endpoint
        // gone stale) must never take down the run or the other channels.
      }
    }
  };
}
