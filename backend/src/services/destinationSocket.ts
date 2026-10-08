// The socket the wisp server dials for a stream, with a stall guard. Apple hostnames resolve to a pool
// not every member of which is usable: some accept the TCP connection then never answer the TLS handshake,
// and wisp dials only the first address with no timeout, so a sign-in on a silent member waits forever. This
// socket dials a candidate list instead, swapping and replaying the guest's bytes (a TLS ClientHello) so the
// guest sees one stream; only an answer's presence, never its content, is read; silence past every candidate closes it.

import { lookup } from "dns/promises";
import net from "net";

/** Addresses that failed are skipped this long before being tried again. */
export const FAILED_ADDRESS_TTL_MS = 30_000;

/** A working Apple edge accepts a connection in milliseconds. */
export const CONNECT_TIMEOUT_MS = 4_000;

/**
 * How long the destination may stay silent after the guest's first bytes. A working
 * handshake lands in 600 ms and the slowest measured was 4 s, so this only fires on a
 * connection that is going nowhere.
 */
export const ANSWER_TIMEOUT_MS = 6_000;

/** How many candidates one stream may dial before giving up. */
export const MAX_ATTEMPTS = 3;

/**
 * The whole recovery — the resolver, every dial and every silence window, until the destination's
 * first byte — must be over before the client gives up: `APPLE_REQUEST_TIMEOUT_MS` in
 * `frontend/src/apple/request.ts` is 20 s, leaving ~3 s for the answer's TLS and body. Every dial
 * and silence window is clamped to what is left, so the constants below are ideals, not a sum.
 */
export const RECOVERY_BUDGET_MS = 17_000;

/**
 * How long the resolver may take. A hung lookup would stall a stream outside every other
 * bound; real answers land in milliseconds, so this only fires on a resolver that has
 * stopped answering.
 */
export const DNS_TIMEOUT_MS = 3_000;

/**
 * How much the relay may read ahead of the guest before the destination is paused.
 * Matches wisp's own `ServerStream.buffer_size`, which its socket compares its queue
 * against.
 */
export const RECV_BUFFER_SIZE = 128;

export interface DialedSocket {
  write(data: Uint8Array, callback?: () => void): unknown;
  end(): void;
  destroy(): void;
  pause(): void;
  resume(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface DestinationSocketDeps {
  /** Every address the hostname resolves to, in resolver order. */
  lookup: (hostname: string) => Promise<string[]>;
  /** Starts a TCP connection to one address (already connecting). */
  dial: (address: string, port: number) => DialedSocket;
  now: () => number;
}

/** Addresses that stayed silent, shared by every stream this process dials. */
const failedAddresses = new Map<string, number>();

function rememberFailed(address: string, now: number): void {
  failedAddresses.set(address, now);
}

function forgetStaleFailures(now: number): void {
  for (const [address, time] of failedAddresses) {
    if (now - time > FAILED_ADDRESS_TTL_MS) failedAddresses.delete(address);
  }
}

/** Candidate order: addresses that have not just failed first, in resolver order. */
function orderCandidates(addresses: string[], now: number): string[] {
  forgetStaleFailures(now);
  const fresh = addresses.filter((address) => !failedAddresses.has(address));
  const stale = addresses.filter((address) => failedAddresses.has(address));
  return [...fresh, ...stale];
}

/**
 * Chunks waiting to be read, closeable so a reader learns the stream ended. Unlike wisp's
 * own queue, which drops what is buffered on close, this one keeps handing out the chunks
 * it holds before reporting the end — dropping them would truncate an answer that arrived
 * just as the destination went away.
 */
class DataQueue {
  private chunks: Uint8Array[] = [];
  private waiters: ((chunk: Uint8Array | null) => void)[] = [];
  private closed = false;

  get size(): number {
    return this.chunks.length;
  }

  put(chunk: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(chunk);
    else this.chunks.push(chunk);
  }

  get(): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

/**
 * Drop-in replacement for wisp's TCP socket (same methods, see ServerStream).
 * Dials candidates in turn and keeps the guest unaware of a swap.
 */
export class DestinationSocket {
  /**
   * What the guest has sent so far, in order, for the life of the stream. A swap hands the
   * replacement the whole prefix (a TLS handshake cannot be split across connections), so
   * these bytes are not disposable; growth stops once the destination answers, when a swap
   * is no longer possible. Bounded by a ClientHello and one small request body.
   */
  private readonly guestBytes: Uint8Array[] = [];
  /** How many entries of `guestBytes` the live connection has been given. */
  private carried = 0;
  private readonly queue = new DataQueue();
  private answers = 0;
  private candidates: string[] = [];
  private attempt = 0;
  private socket: DialedSocket | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private paused = false;
  /** True while a stalled connection is being replaced. */
  private swapping = false;
  /**
   * When the recovery must be over (`connect()` + {@link RECOVERY_BUDGET_MS}); Infinity
   * until then, so a socket that was never connected has no budget to run out of.
   */
  private deadline = Number.POSITIVE_INFINITY;

  constructor(
    public readonly hostname: string,
    public readonly port: number,
    private readonly deps: DestinationSocketDeps = {
      lookup: async (host) =>
        (await lookup(host, { all: true })).map((entry) => entry.address),
      dial: (address, port) => {
        const socket = net.connect({ host: address, port });
        socket.setNoDelay(true);
        return socket;
      },
      now: Date.now,
    },
  ) {}

  async connect(): Promise<void> {
    // The client's own timer started when it opened this stream, so the budget
    // runs from before the resolver: everything on the dial path is inside it.
    this.deadline = this.deps.now() + RECOVERY_BUDGET_MS;
    const addresses = await this.resolve(this.hostname);
    if (addresses.length === 0) {
      throw new Error(`no address found for ${this.hostname}`);
    }
    this.candidates = orderCandidates(addresses, this.deps.now());
    this.socket = await this.dialNext();
  }

  /**
   * Names the addresses, but never outwaits the budget: a resolver that has stopped
   * answering fails the stream (which the client can retry) instead of stalling it.
   */
  private resolve(hostname: string): Promise<string[]> {
    const lookup = this.deps.lookup(hostname);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<string[]>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`resolving ${hostname} timed out`)),
        Math.min(DNS_TIMEOUT_MS, this.remaining()),
      );
    });
    return Promise.race([lookup, bound]).finally(() => clearTimeout(timer));
  }

  /** What is left of the recovery budget. */
  private remaining(): number {
    return this.deadline - this.deps.now();
  }

  async recv(): Promise<Uint8Array | null> {
    return this.queue.get();
  }

  async send(data: Uint8Array): Promise<void> {
    if (data.length === 0) return;

    if (this.answers === 0) {
      this.guestBytes.push(new Uint8Array(data));
      this.armAnswerTimer();
      // A swap already under way is replaying this list in order and by index; writing here
      // too would put the same bytes on the wire twice (once now, once at replay), and a TLS
      // record arriving twice is a broken connection. The replay re-reads the list itself.
      if (this.swapping) return;
    }

    await this.write(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearAnswerTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.end();
    this.queue.close();
  }

  pause(): void {
    if (this.paused || !this.socket) return;
    if (this.queue.size >= RECV_BUFFER_SIZE) {
      this.socket.pause();
      this.paused = true;
    }
  }

  resume(): void {
    if (!this.paused || !this.socket) return;
    this.socket.resume();
    this.paused = false;
  }

  /** Dials the next candidate; throws when none is left or the budget is gone. */
  private async dialNext(): Promise<DialedSocket> {
    while (this.attempt < this.candidates.length && this.attempt < MAX_ATTEMPTS) {
      const remaining = this.remaining();
      if (remaining <= 0) break;
      const address = this.candidates[this.attempt];
      this.attempt++;
      try {
        return await this.dialAddress(
          address,
          Math.min(CONNECT_TIMEOUT_MS, remaining),
        );
      } catch {
        // A refused or unreachable address says nothing about the others.
        rememberFailed(address, this.deps.now());
      }
    }
    throw new Error(`no reachable address for ${this.hostname}`);
  }

  private dialAddress(
    address: string,
    timeoutMs: number,
  ): Promise<DialedSocket> {
    return new Promise((resolve, reject) => {
      const socket = this.deps.dial(address, this.port);
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`connect to ${address} failed`));
      };
      const timer = setTimeout(fail, timeoutMs);

      socket.on("connect", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(socket);
      });
      socket.on("data", (chunk: Uint8Array) => {
        // Only the connection the stream is on may speak for it: bytes from a swapped-out
        // connection would be a second answer to a handshake that already moved on.
        if (this.socket === socket) this.received(chunk);
      });
      socket.on("error", () => {
        clearTimeout(timer);
        fail();
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (!settled) {
          fail();
          return;
        }
        // The destination is gone mid-stream: end the stream for the guest too (wisp's own
        // socket closes its queue here), so it sees a truncated answer and can retry.
        if (this.socket === socket) this.giveUp();
      });
      socket.on("end", () => {
        if (this.socket === socket) this.giveUp();
      });
    });
  }

  private received(chunk: Uint8Array): void {
    if (this.closed) return;
    if (this.answers === 0) {
      // The destination is talking: the stream is real, nothing left to swap for, and
      // whatever the guest already sent is on this connection.
      this.answers = chunk.length;
      this.clearAnswerTimer();
    } else {
      this.answers += chunk.length;
    }
    this.queue.put(chunk);
  }

  private armAnswerTimer(): void {
    // One swap at a time (bytes sent while the replacement is dialled must not arm their
    // own guard), nothing to watch once the destination has spoken, nothing for a closed stream.
    if (this.answerTimer || this.closed || this.swapping || this.answers > 0) {
      return;
    }
    const remaining = this.remaining();
    if (remaining <= 0) {
      // The budget is gone: no answer can arrive inside the client's timeout any more, so
      // end the stream now (the request fails, and the retry is the user's) rather than
      // at the client's own later timeout.
      this.giveUp();
      return;
    }
    this.answerTimer = setTimeout(
      () => {
        this.answerTimer = null;
        this.swapToNextAddress();
      },
      Math.min(ANSWER_TIMEOUT_MS, remaining),
    );
  }

  private clearAnswerTimer(): void {
    if (!this.answerTimer) return;
    clearTimeout(this.answerTimer);
    this.answerTimer = null;
  }

  /**
   * The destination never answered the bytes the guest already sent. Drop that connection,
   * dial the next candidate, and replay those bytes onto it — the guest cannot tell the
   * difference and just waits a little longer.
   */
  private async swapToNextAddress(): Promise<void> {
    if (this.closed) return;
    this.swapping = true;
    try {
      const previous = this.socket;
      const previousAddress = this.candidates[this.attempt - 1];
      this.socket = null;
      if (previous) previous.destroy();
      if (previousAddress) rememberFailed(previousAddress, this.deps.now());

      const remaining = this.remaining();
      const next = remaining > 0 ? this.candidates[this.attempt] : undefined;
      if (!next) {
        console.warn(
          remaining > 0
            ? `[wisp] no address of ${this.hostname} answered; closing the stream so the request fails instead of hanging`
            : `[wisp] ${this.hostname} outlived its ${Math.round(
                RECOVERY_BUDGET_MS / 1000,
              )} s recovery budget without an answer; closing the stream so the request fails instead of hanging`,
        );
        this.giveUp();
        return;
      }
      // Worth a line: the path to Apple is degrading, and only this can see it.
      console.warn(
        `[wisp] ${this.hostname} stayed silent at ${previousAddress}, moving the stream to ${next}`,
      );

      let fresh: DialedSocket;
      try {
        fresh = await this.dialNext();
      } catch {
        // Every candidate stayed silent: let the guest see the stream close so its request
        // fails and can be retried, instead of waiting forever.
        this.giveUp();
        return;
      }

      // The guest may have closed the stream while the new connection was being dialled.
      if (this.closed) {
        fresh.destroy();
        return;
      }
      this.socket = fresh;
      // No connection has carried any of these bytes, so hand the new one the whole prefix
      // from the start; bytes sent while this runs are appended to the same list and go out
      // after the ones already in it — never beside them, never twice.
      this.carried = 0;
      this.paused = false;
      while (this.carried < this.guestBytes.length && !this.closed) {
        const chunk = this.guestBytes[this.carried];
        await this.write(chunk);
        this.carried++;
      }
    } finally {
      this.swapping = false;
    }

    // Still unanswered? keep watching on the new connection too.
    this.armAnswerTimer();
  }

  private async write(data: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    await new Promise<void>((resolve) => socket.write(data, resolve));
  }

  private giveUp(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearAnswerTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.destroy();
    this.queue.close();
  }
}
