/**
 * Conformance: cexy-api-spec/conformance/ws/private_signout.json and server_signout.json, run step by step against a
 * scripted server (no automatic auth or subscribe replies; the script sends every frame).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CexyWebSocket,
  type AuthChange,
  type ResyncReason,
} from "../src/index.js";
import { loadJson } from "./helpers.js";
import { startFakeServer } from "./ws-server.js";

interface Step {
  client?: "auth" | "subscribe";
  token?: string;
  channels?: string[];
  server?: Record<string, unknown>;
  reply_to?: "auth" | "subscribe";
  expect_sent?: { op: string; token?: string; channels?: string[] }[];
  expect_events?: Record<string, unknown>[];
  expect_held?: string[];
  expect_token?: boolean;
}
type Spec = { cases: { id: string; steps: Step[] }[] };
const FILES = ["private_signout.json", "server_signout.json"] as const;

type Server = Awaited<ReturnType<typeof startFakeServer>>;
let srv: Server | null = null;
let ws: CexyWebSocket | null = null;
afterEach(async () => {
  ws?.close();
  ws = null;
  await srv?.close();
  srv = null;
});

const sorted = (xs: string[]) => [...xs].sort();

for (const file of FILES) {
  describe(`conformance: ws/${file}`, () => {
    const spec = loadJson<Spec>(`conformance/ws/${file}`);
    for (const c of spec.cases) {
      it(c.id, async () => {
        srv = await startFakeServer({ auth: "silent", ackSubscribe: false });
        ws = new CexyWebSocket({
          url: srv.url,
          allowInsecure: true,
          reconnect: false,
          logger: { warn: () => {} },
        });
        await ws.connect();
        const conn = srv.conns[0]!;
        const events: Record<string, unknown>[] = [];
        ws.on("authChanged", (a: AuthChange) =>
          events.push({
            type: "auth_changed",
            reason: a.reason,
            previous_user_id: a.previousUserId,
            user_id: a.userId,
            code: a.code,
            dropped: sorted(a.dropped),
          }),
        );
        ws.on("resync", (r: ResyncReason) =>
          events.push({ type: "resync", reason: r }),
        );
        ws.on("authLost", () => events.push({ type: "auth_lost" }));
        ws.on("error", () => {});
        ws.on("serverError", () => {});

        const requests = () => conn.received.filter((m) => m.op !== "ping");
        const answered = new Set<string>();
        let sentMark = 0;
        // Barrier: two ping round trips. The first ensures the client has processed every frame
        // sent before it; the second that the server has recorded everything the client sent in
        // reaction.
        const settle = async () => {
          await ws!.ping();
          await ws!.ping();
        };

        for (const step of c.steps) {
          if (step.client === "auth") {
            const before = requests().length;
            ws.auth(step.token!).catch(() => {});
            await srv.until(() => requests().length > before, "auth frame");
          } else if (step.client === "subscribe") {
            const before = requests().length;
            ws.subscribe(step.channels!).catch(() => {});
            await srv.until(
              () => requests().length > before,
              "subscribe frame",
            );
          } else if (step.server) {
            let frame = step.server;
            if (step.reply_to) {
              const req = [...requests()]
                .reverse()
                .find((m) => m.op === step.reply_to && !answered.has(m.id));
              expect(
                req,
                `no unanswered ${step.reply_to} request`,
              ).toBeDefined();
              answered.add(req.id);
              frame = { ...frame, id: req.id };
            }
            conn.send(frame);
            await settle();
          } else if (step.expect_sent) {
            await settle();
            const sent = requests()
              .slice(sentMark)
              .map((m) => {
                const o: Record<string, unknown> = { op: m.op };
                if (m.token !== undefined) o.token = m.token;
                if (m.channels !== undefined) o.channels = sorted(m.channels);
                return o;
              });
            sentMark = requests().length;
            expect(sent).toEqual(
              step.expect_sent.map((e) =>
                e.channels ? { ...e, channels: sorted(e.channels) } : e,
              ),
            );
          } else if (step.expect_events) {
            await settle();
            const got = events.splice(0);
            expect(got.length, JSON.stringify(got)).toBe(
              step.expect_events.length,
            );
            for (const want of step.expect_events) {
              const w = want.dropped
                ? { ...want, dropped: sorted(want.dropped as string[]) }
                : want;
              expect(got).toContainEqual(expect.objectContaining(w));
            }
          } else if (step.expect_held) {
            await settle();
            expect(sorted(ws.channels)).toEqual(sorted(step.expect_held));
          } else if (step.expect_token !== undefined) {
            await settle();
            expect(ws.hasToken).toBe(step.expect_token);
          }
        }
      });
    }
  });
}
