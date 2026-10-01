import type { Order } from "../types.js";

/** Protocol version this SDK was written for. */
export const SUPPORTED_PROTOCOL_VERSION = 1;

export interface WelcomeFrame {
  type: "welcome";
  protocol_version: number;
  /** The server's own pong cadence (30), not a client deadline. */
  heartbeat_interval_seconds: number;
  max_subscriptions: number;
  connection_id: string;
  /** Single-use challenge for `authKey()` (API-key authentication). */
  challenge?: string;
}

export interface PongFrame {
  type: "pong";
  id?: string | null;
}

export interface SubscribedFrame {
  type: "subscribed";
  channels: string[];
  id?: string | null;
}

export interface AuthenticatedFrame {
  type: "authenticated";
  id?: string | null;
  user_id?: string;
}

export interface UnsubscribedFrame {
  type: "unsubscribed";
  channels?: string[];
  id?: string | null;
}

export interface ErrorFrame {
  type: "error";
  code: string;
  message?: string;
  id?: string | null;
}

/** `[price, quantity]`, both decimal strings. */
export type BookLevel = [price: string, quantity: string];

export interface OrderBookUpdateData {
  symbol: string;
  /**
   * Always `true`: every update is the complete top 50 of both sides and replaces the
   * previous state. There are no deltas.
   */
  full?: boolean;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface SessionRevokedData {
  session_id: string | null;
  reason: string;
  current: boolean;
}

interface EventBase<T extends string, D> {
  type: T;
  channel: string;
  /**
   * Public channels: per channel, +1 per update, resets when the server restarts. Private
   * channels: per topic (this account's channel on one server instance); the first frame after
   * `subscribed` is the baseline. The client reports gaps (`sequenceGap`).
   */
  sequence?: number;
  timestamp?: string;
  data: D;
}

type Data = Record<string, unknown>;

export type OrderBookUpdateEvent = EventBase<"orderbook.update", OrderBookUpdateData>;
export type SessionRevokedEvent = EventBase<"session.revoked", SessionRevokedData>;
export type TickerUpdateEvent = EventBase<"ticker.update", Data>;
export type TradeNewEvent = EventBase<"trade.new", Data>;
export type MarketStatusEvent = EventBase<"market.status", Data>;
export type OrderEvent = EventBase<"order.created" | "order.updated" | "order.cancelled" | "order.filled", Order>;
/** `balance.updated` data. `sequence` is the balance's own sequence (same as REST `Balance.sequence`). */
export interface BalanceUpdatedData {
  asset: string;
  available: string;
  locked: string;
  pending: string;
  total: string;
  /** Never decreases; may skip values or repeat (a skip is not a loss). */
  sequence: number;
}

export type BalanceUpdatedEvent = EventBase<"balance.updated", BalanceUpdatedData>;
/** The server could not resume its balance change stream: events may be missing. Refetch balances. */
export type BalancesResyncEvent = EventBase<"balances.resync", Record<string, never>>;
/** Planned server frame: refetch the deposit or withdrawal list (events may be missing). */
export type ListResyncEvent = EventBase<"deposits.resync" | "withdrawals.resync", Record<string, never>>;
export type DepositEvent = EventBase<"deposit.detected" | "deposit.updated" | "deposit.completed", Data>;
export type WithdrawalUpdatedEvent = EventBase<"withdrawal.updated", Data>;

/** Every event type the SDK knows. Unknown types are ignored (they may be added without notice). */
export type WsEvent =
  | OrderBookUpdateEvent
  | SessionRevokedEvent
  | TickerUpdateEvent
  | TradeNewEvent
  | MarketStatusEvent
  | OrderEvent
  | BalanceUpdatedEvent
  | BalancesResyncEvent
  | ListResyncEvent
  | DepositEvent
  | WithdrawalUpdatedEvent;

export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<WsEvent["type"]>([
  "ticker.update",
  "orderbook.update",
  "trade.new",
  "market.status",
  "order.created",
  "order.updated",
  "order.cancelled",
  "order.filled",
  "balance.updated",
  "deposit.detected",
  "deposit.updated",
  "deposit.completed",
  "withdrawal.updated",
  "session.revoked",
  "balances.resync",
  "deposits.resync",
  "withdrawals.resync",
]);

/** Channels that need `auth`. */
export const PRIVATE_CHANNELS: ReadonlySet<string> = new Set(["orders", "balances", "deposits", "withdrawals", "account"]);

/** Minimal WebSocket surface shared by the browser/Node 22 global and the `ws` package. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketConstructor = new (url: string, options?: unknown) => WebSocketLike;
