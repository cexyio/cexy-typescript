/**
 * Conformance: cexy-api-spec/conformance/ws/live_balances.json and private_sequence_gap.json, run
 * step by step against a scripted server (only pings are answered) with an injected test clock.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CexyWebSocket, type Balance, type LiveBalances, type ResyncReason, type SequenceGap } from "../src/index.js";
import { FakeClock } from "./fake-clock.js";
import { loadJson } from "./helpers.js";
import { startFakeServer } from "./ws-server.js";

type Step = Record<string, any>;
interface Spec {
  cases: { id: string; options?: { reorder_window_ms?: number; min_snapshot_interval_ms?: number }; steps: Step[] }[];
}
const live = loadJson<Spec>("conformance/ws/live_balances.json");
const gaps = loadJson<Spec>("conformance/ws/private_sequence_gap.json");

type Server = Awaited<ReturnType<typeof startFakeServer>>;
let srv: Server | null = null;
let ws: CexyWebSocket | null = null;
let helper: LiveBalances | null = null;
afterEach(async () => {
  helper?.close();
  helper = null;
  ws?.close();
  ws = null;
  await srv?.close();
  srv = null;
});

const sorted = (xs: string[]) => [...xs].sort();

/** A source whose calls the script answers one by one. */
function scripted<T>() {
  const pending: ((v: T) => void)[] = [];
  let calls = 0;
  return {
    fn: () => {
      calls++;
      return new Promise<T>((r) => pending.push(r));
    },
    get calls() {
      return calls;
    },
    get waiting() {
      return pending.length;
    },
    answer: (v: T) => pending.shift()!(v),
  };
}

async function run(c: Spec["cases"][number]) {
  srv = await startFakeServer({ auth: "silent", ackSubscribe: false });
  const clock = new FakeClock();
  ws = new CexyWebSocket({
    url: srv.url,
    allowInsecure: true,
    reconnect: false,
    logger: { warn: () => {} },
    clock,
    reorderWindowMs: c.options?.reorder_window_ms ?? 250,
  });
  await ws.connect();
  const conn = srv.conns[0]!;
  const events: Record<string, unknown>[] = [];
  const errors: string[] = [];
  ws.on("resync", (r: ResyncReason) => events.push({ type: "resync", reason: r }));
  ws.on("sequenceGap", (g: SequenceGap) => events.push({ type: "sequence_gap", ...g }));
  ws.on("error", () => {});
  ws.on("serverError", () => {});
  const owner = scripted<string>();
  const snapshot = scripted<Balance[]>();
  const requests = () => conn.received.filter((m) => m.op !== "ping");
  const answered = new Set<string>();
  let sentMark = 0;
  const settle = async () => {
    await ws!.ping();
    await ws!.ping();
  };
  const until = (cond: () => boolean, label: string) => srv!.until(cond, label);

  for (const [i, st] of c.steps.entries()) {
    const at = `${c.id} step ${i}`;
    if (st.client === "auth") {
      const n = requests().length;
      ws.auth(st.token).catch(() => {});
      await until(() => requests().length > n, at);
    } else if (st.client === "subscribe") {
      const n = requests().length;
      ws.subscribe(st.channels).catch(() => {});
      await until(() => requests().length > n, at);
    } else if (st.client === "live_balances") {
      const n = requests().length;
      void ws
        .liveBalances({ snapshot: snapshot.fn, ownerId: owner.fn, minSnapshotIntervalMs: c.options?.min_snapshot_interval_ms ?? 2000 })
        .then((h) => {
          helper = h;
          h.on("error", (e) => errors.push((e as { code?: string }).code ?? "ERROR"));
        });
      await until(() => requests().length > n, at);
    } else if (st.server) {
      let frame = st.server;
      if (st.reply_to) {
        const req = [...requests()].reverse().find((m) => m.op === st.reply_to && !answered.has(m.id));
        expect(req, `${at}: no unanswered ${st.reply_to}`).toBeDefined();
        answered.add(req.id);
        frame = { ...frame, id: req.id };
      }
      conn.send(frame);
      await settle();
    } else if (st.owner !== undefined) {
      await until(() => owner.waiting > 0, `${at}: owner request`);
      owner.answer(st.owner);
      await settle();
    } else if (st.snapshot !== undefined) {
      await until(() => snapshot.waiting > 0, `${at}: snapshot request`);
      snapshot.answer(st.snapshot);
      await settle();
    } else if (st.advance_ms !== undefined) {
      clock.advance(st.advance_ms);
      await settle();
    } else if (st.expect_sent) {
      await settle();
      const norm = (m: any) => ({ op: m.op, ...(m.token !== undefined ? { token: m.token } : {}), ...(m.channels ? { channels: sorted(m.channels) } : {}) });
      const got = requests().slice(sentMark).map(norm);
      sentMark = requests().length;
      expect(got, at).toEqual(st.expect_sent.map(norm));
    } else if (st.expect_requests) {
      await settle();
      expect({ owner: owner.calls, snapshot: snapshot.calls }, at).toEqual(st.expect_requests);
    } else if (st.expect_state) {
      await settle();
      const rows = Object.fromEntries((helper?.all() ?? []).map((b) => [b.asset, b]));
      expect(sorted(Object.keys(rows)), at).toEqual(sorted(Object.keys(st.expect_state)));
      for (const [asset, want] of Object.entries(st.expect_state as Record<string, Record<string, unknown>>)) {
        expect(rows[asset], `${at}: ${asset}`).toMatchObject(want);
      }
    } else if (st.expect_stale !== undefined) {
      await settle();
      expect(helper?.stale ?? true, at).toBe(st.expect_stale);
    } else if (st.expect_errors) {
      await settle();
      expect(errors.splice(0), at).toEqual(st.expect_errors);
    } else if (st.expect_events) {
      await settle();
      const got = events.splice(0);
      expect(got.length, `${at}: ${JSON.stringify(got)}`).toBe(st.expect_events.length);
      for (const want of st.expect_events) expect(got, at).toContainEqual(expect.objectContaining(want));
    } else {
      throw new Error(`${at}: unknown step ${JSON.stringify(st)}`);
    }
  }
}

describe("conformance: ws/live_balances.json", () => {
  for (const c of live.cases) it(c.id, () => run(c));
});

describe("conformance: ws/private_sequence_gap.json", () => {
  for (const c of gaps.cases) it(c.id, () => run(c));
});
