import type { ServerResponse } from "node:http";
import type { Db } from "../db/index.ts";
import { listRunLogSince } from "../db/repo/log.ts";

interface Subscriber {
  res: ServerResponse;
  runId: number;
}

const subscribers = new Set<Subscriber>();

export function sseHandler(
  db: Db,
  runId: number,
  res: ServerResponse,
  lastEventId: string | undefined
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Replay anything the client missed since its last seen seq (run_log.seq
  // reuses the table's own autoincrement id — globally monotonic, so this
  // doubles as the Last-Event-ID cursor with no separate counter to track).
  const since = lastEventId ? Number(lastEventId) : 0;
  for (const row of listRunLogSince(db, runId, since)) {
    writeEvent(res, row.seq, row.kind, JSON.parse(row.payload_json));
  }

  const sub: Subscriber = { res, runId };
  subscribers.add(sub);

  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15000);

  res.on("close", () => {
    clearInterval(keepAlive);
    subscribers.delete(sub);
  });
}

function writeEvent(res: ServerResponse, seq: number, kind: string, payload: unknown): void {
  res.write(`id: ${seq}\n`);
  res.write(`event: ${kind}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Broadcast a run_log row (already persisted) to every live subscriber for that run. */
export function broadcastRunLog(runId: number, seq: number, kind: string, payload: unknown): void {
  for (const sub of subscribers) {
    if (sub.runId !== runId) continue;
    writeEvent(sub.res, seq, kind, payload);
  }
}
