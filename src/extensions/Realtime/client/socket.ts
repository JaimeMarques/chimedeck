// Singleton WebSocket client with reconnect backoff, room subscribe/unsubscribe,
// and event dispatch. Used by useWebSocket hook and wsMiddleware.
//
// WHY singleton: one physical WebSocket per browser tab is enough; all Redux
// middleware and React hooks share the same connection object.
import { RetryableRecoveryError } from '~/common/api/recoveryErrors';

export type WsEventHandler = (event: RealtimeEvent) => void;

export interface RealtimeEvent {
  type: string;
  board_id?: string;
  sequence?: number;
  /** Epoch ms when the server published this event — used to compute propagation delay. */
  emittedAt?: number;
  payload?: unknown;
}

interface SocketOptions {
  /** Called when the connection opens (or re-opens after reconnect) */
  onOpen?: (recovered: boolean) => void;
  /** Called when the connection closes unexpectedly */
  onClose?: () => void;
  /** Called on each incoming parsed event */
  onEvent?: WsEventHandler;
  /** Called when failed WS attempts reach the threshold — switch to polling */
  onPollingActive?: () => void;
  /** Called when WS reconnects successfully after polling mode was active */
  onPollingInactive?: () => void;
}

// Exponential backoff caps at 30 s
const MAX_BACKOFF_MS = 30_000;
// Number of consecutive WS failures before activating HTTP polling fallback
const POLLING_FALLBACK_THRESHOLD = 3;

export class RealtimeSocket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private connectionRefCount = 0;
  private readonly boardRefCounts: Map<string, number> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private intentionalClose = false;
  private failedAttempts = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private renewalAttemptId = 0;
  private renewingToken = false;
  private needsTokenRenewal = false;
  private renewalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private authRecoverySuspended = false;
  private resumeRenewalRequested = false;
  private awaitingRenewalPong = false;
  private prematureExpiryCount = 0;
  private expiryBackoffMs = 1_000;
  private recoveryPending = false;
  private expiredTokenCallback: (() => Promise<string | null>) | null = null;

  private handlers: Set<WsEventHandler> = new Set();
  private openHandlers: Set<(recovered: boolean) => void> = new Set();
  private closeHandlers: Set<() => void> = new Set();
  private pollingActiveHandlers: Set<() => void> = new Set();
  private pollingInactiveHandlers: Set<() => void> = new Set();

  // Callback for forced server-side logout (WS close code 4001).
  // Set from main.tsx to avoid circular dependency with the store.
  private forcedLogoutCallback: (() => void) | null = null;

  setForcedLogoutCallback(fn: () => void) {
    this.forcedLogoutCallback = fn;
  }

  setExpiredTokenCallback(fn: () => Promise<string | null>) {
    this.expiredTokenCallback = fn;
  }

  suspendAuthRecovery() {
    this.authRecoverySuspended = true;
    this.resumeRenewalRequested = false;
    this._clearRenewalRetry();
  }

  resumeAuthRecovery() {
    if (!this.authRecoverySuspended) return;
    this.authRecoverySuspended = false;
    this.intentionalClose = false;
    if (this.renewingToken) {
      this.resumeRenewalRequested = true;
      return;
    }
    this.recover();
  }

  resetRenewalThrottle() {
    this.awaitingRenewalPong = false;
    this.prematureExpiryCount = 0;
    this.expiryBackoffMs = 1_000;
  }

  /** True when consecutive WS failures have reached the polling threshold */
  get usingPollingFallback(): boolean {
    return this.failedAttempts >= POLLING_FALLBACK_THRESHOLD;
  }

  // ---------- Public API ----------

  connect({ boardId, token }: { boardId?: string; token: string }) {
    this.connectionRefCount += 1;
    if (this.renewingToken) this.recoveryPending = true;
    if (this.token !== token) {
      if (this.token) this.awaitingRenewalPong = true;
      this.authRecoverySuspended = false;
      this.needsTokenRenewal = false;
      this._clearRenewalRetry();
    }
    if (this.token !== token && this.ws) {
      this.recoveryPending = true;
      const ws = this.ws;
      this.ws = null;
      this._clearWatchdog();
      ws.close();
      this.closeHandlers.forEach((h) => { h(); });
    }
    this.token = token;
    this.intentionalClose = false;

    if (boardId) {
      this._addBoardRef(boardId);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (boardId) {
        this.send({ type: 'subscribe', board_id: boardId });
      }
      return;
    }

    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this._open();
  }

  disconnect({ boardId }: { boardId?: string } = {}) {
    if (boardId) {
      this._removeBoardRef(boardId);
    }

    this.connectionRefCount = Math.max(0, this.connectionRefCount - 1);

    if (this.connectionRefCount > 0) {
      return;
    }

    this.intentionalClose = true;
    this._clearReconnect();
    this._clearRenewalRetry();
    this._clearWatchdog();
    this.failedAttempts = 0;
    this.recoveryPending = false;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }

  subscribe({ onEvent, onOpen, onClose, onPollingActive, onPollingInactive }: SocketOptions): () => void {
    if (onEvent) this.handlers.add(onEvent);
    if (onOpen) this.openHandlers.add(onOpen);
    if (onClose) this.closeHandlers.add(onClose);
    if (onPollingActive) this.pollingActiveHandlers.add(onPollingActive);
    if (onPollingInactive) this.pollingInactiveHandlers.add(onPollingInactive);
    return () => {
      if (onEvent) this.handlers.delete(onEvent);
      if (onOpen) this.openHandlers.delete(onOpen);
      if (onClose) this.closeHandlers.delete(onClose);
      if (onPollingActive) this.pollingActiveHandlers.delete(onPollingActive);
      if (onPollingInactive) this.pollingInactiveHandlers.delete(onPollingInactive);
    };
  }

  send(message: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Recover a half-open connection after sleep, or bypass suspended backoff. */
  recover() {
    if (this.intentionalClose || this.authRecoverySuspended || this.renewingToken || this.connectionRefCount === 0) return;
    if (this.needsTokenRenewal) {
      this._clearRenewalRetry();
      void this._renewExpiredToken();
      return;
    }
    if (this.ws && Date.now() - this.lastFrameAt > 60_000) {
      const ws = this.ws;
      this.ws = null;
      this._clearWatchdog();
      ws.close();
      this._recordFailure();
    }
    this._clearReconnect();
    this._open();
  }

  // ---------- Internal ----------

  private _open() {
    if (!this.token || this.authRecoverySuspended || this.renewingToken || this.connectionRefCount === 0) return;
    if (this.needsTokenRenewal) {
      if (this.renewalRetryTimer === null) void this._renewExpiredToken();
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = `${this._wsBase()}/api/v1/ws?token=${encodeURIComponent(this.token)}`;
    this._clearReconnect();
    const ws = new WebSocket(url);
    this.ws = ws;
    this.lastFrameAt = Date.now();
    this._clearWatchdog();
    this.watchdogTimer = setInterval(() => { this.recover(); }, 30_000);

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      this.failedAttempts = Math.max(this.failedAttempts, this.prematureExpiryCount);
      const wasPolling = this.failedAttempts >= POLLING_FALLBACK_THRESHOLD;
      this.backoffMs = 1_000;
      if (this.prematureExpiryCount === 0) this.failedAttempts = 0;
      // Re-join all active board rooms after authentication handshake.
      for (const activeBoardId of this.boardRefCounts.keys()) {
        this.send({ type: 'subscribe', board_id: activeBoardId });
      }
      const recovered = this.recoveryPending;
      this.recoveryPending = false;
      this.openHandlers.forEach((h) => { h(recovered); });
      // Notify that polling is no longer needed now that WS is back
      if (wasPolling && !this.usingPollingFallback) {
        this.pollingInactiveHandlers.forEach((h) => { h(); });
      }
    });

    ws.addEventListener('message', (ev: MessageEvent<string>) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      try {
        const event = JSON.parse(ev.data) as RealtimeEvent;
        // [why] The server records client ping frames as its heartbeat response.
        if (event.type === 'ping') {
          this.send({ type: 'ping' });
          return;
        }
        if (event.type === 'pong') {
          const wasPolling = this.usingPollingFallback;
          this.resetRenewalThrottle();
          this.failedAttempts = 0;
          if (wasPolling) this.pollingInactiveHandlers.forEach((h) => { h(); });
          return;
        }
        this.handlers.forEach((h) => {
          try {
            h(event);
          } catch {
            // Isolate subscriber failures so one handler cannot break realtime fanout.
          }
        });
      } catch {
        // Ignore malformed frames
      }
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._clearWatchdog();
      // Code 4001 = server-initiated forced logout (session revoked)
      if (ev.code === 4001) {
        if (ev.reason === 'session expired' && this.expiredTokenCallback) {
          this.recoveryPending = true;
          this.needsTokenRenewal = true;
          this.closeHandlers.forEach((h) => { h(); });
          if (this.awaitingRenewalPong) {
            // [why] A newly minted token repeatedly rejected before validation
            // must not rotate refresh cookies at the server's heartbeat rate.
            this.prematureExpiryCount++;
            this.failedAttempts = Math.max(this.failedAttempts, this.prematureExpiryCount - 1);
            this._recordFailure();
            this.renewalRetryTimer = setTimeout(() => {
              this.renewalRetryTimer = null;
              void this._renewExpiredToken();
            }, this.expiryBackoffMs);
            this.expiryBackoffMs = Math.min(this.expiryBackoffMs * 2, MAX_BACKOFF_MS);
          } else {
            void this._renewExpiredToken();
          }
          return;
        }
        this.intentionalClose = true;
        this.needsTokenRenewal = false;
        this._clearRenewalRetry();
        this.forcedLogoutCallback?.();
        return;
      }
      if (!this.intentionalClose && this.connectionRefCount > 0) {
        this._recordFailure();
        this._scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      // 'close' will fire right after; reconnect is handled there
    });
  }

  private _scheduleReconnect() {
    this._clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.connectionRefCount === 0) {
        return;
      }
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this._open();
    }, this.backoffMs);
  }

  private _recordFailure() {
    this.recoveryPending = true;
    this.failedAttempts++;
    this.closeHandlers.forEach((h) => { h(); });
    if (this.failedAttempts === POLLING_FALLBACK_THRESHOLD) {
      this.pollingActiveHandlers.forEach((h) => { h(); });
    }
  }

  private async _renewExpiredToken() {
    if (this.renewingToken || this.authRecoverySuspended || this.connectionRefCount === 0 || this.intentionalClose) return;
    const attemptId = ++this.renewalAttemptId;
    const tokenAtStart = this.token;
    this.renewingToken = true;
    let canOpen = false;
    try {
      const token = await this.expiredTokenCallback?.();
      if (attemptId !== this.renewalAttemptId) return;
      if (!token) {
        if (this.token === tokenAtStart && !this.resumeRenewalRequested) this.intentionalClose = true;
        else canOpen = true;
        return;
      }
      // [why] Board navigation may replace subscribers during validated renewal.
      // Keep a newer token supplied by connect; otherwise adopt the validated token.
      if (this.token === tokenAtStart) this.token = token;
      this.awaitingRenewalPong = true;
      this.needsTokenRenewal = false;
      canOpen = true;
    } catch (error) {
      if (attemptId !== this.renewalAttemptId || this.connectionRefCount === 0) return;
      if (this.token !== tokenAtStart) {
        this.needsTokenRenewal = false;
        canOpen = true;
      } else if (error instanceof RetryableRecoveryError) {
        this._recordFailure();
        this.renewalRetryTimer = setTimeout(() => {
          this.renewalRetryTimer = null;
          void this._renewExpiredToken();
        }, this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      } else {
        this.intentionalClose = true;
        this.forcedLogoutCallback?.();
      }
    } finally {
      this.renewingToken = false;
      if (this._canResumeRenewal()) {
        this.resumeRenewalRequested = false;
        this.intentionalClose = false;
        this.recover();
      } else if (canOpen && !this.intentionalClose && this.connectionRefCount > 0) this._open();
    }
  }

  private _canResumeRenewal(): boolean {
    return this.resumeRenewalRequested && !this.authRecoverySuspended && this.connectionRefCount > 0;
  }

  private _clearRenewalRetry() {
    if (this.renewalRetryTimer !== null) {
      clearTimeout(this.renewalRetryTimer);
      this.renewalRetryTimer = null;
    }
  }

  private _clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _clearWatchdog() {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private _wsBase(): string {
    if (typeof window === 'undefined') return 'ws://localhost:3000';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }

  private _addBoardRef(boardId: string) {
    const count = this.boardRefCounts.get(boardId) ?? 0;
    this.boardRefCounts.set(boardId, count + 1);
  }

  private _removeBoardRef(boardId: string) {
    const count = this.boardRefCounts.get(boardId);
    if (!count) return;

    if (count === 1) {
      this.boardRefCounts.delete(boardId);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'unsubscribe', board_id: boardId });
      }
      return;
    }

    this.boardRefCounts.set(boardId, count - 1);
  }
}

// Module-level singleton
export const socket = new RealtimeSocket();
