import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  DestinationSocket,
  DNS_TIMEOUT_MS,
  FAILED_ADDRESS_TTL_MS,
  MAX_ATTEMPTS,
  RECOVERY_BUDGET_MS,
  RECV_BUFFER_SIZE,
  type DialedSocket,
  type DestinationSocketDeps,
} from "../src/services/destinationSocket.js";

/** A dialled connection whose events the test fires by hand. */
class FakeSocket implements DialedSocket {
  readonly written: Uint8Array[] = [];
  destroyed = false;
  ended = false;
  paused = false;

  private readonly listeners = new Map<string, ((...args: any[]) => void)[]>();
  /** When set, writes are parked here until `releaseWrites()`. */
  private held: (() => void)[] | null = null;

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  hasListener(event: string): boolean {
    return (this.listeners.get(event)?.length ?? 0) > 0;
  }

  /**
   * Parks every write's completion callback, so a test can act while a writer
   * is waiting on the socket — the window a swap replays in.
   */
  holdWrites(): void {
    this.held = [];
  }

  releaseWrites(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const release of held) release();
  }

  write(data: Uint8Array, callback?: () => void): void {
    this.written.push(new Uint8Array(data));
    if (this.held) this.held.push(() => callback?.());
    else callback?.();
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }
}

interface Harness {
  deps: DestinationSocketDeps;
  dialled: FakeSocket[];
  clock: { now: number };
}

function harness(overrides: Partial<DestinationSocketDeps> = {}): Harness {
  const dialled: FakeSocket[] = [];
  const clock = { now: 0 };
  const deps: DestinationSocketDeps = {
    lookup: async () => ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
    dial: () => {
      const socket = new FakeSocket();
      dialled.push(socket);
      return socket;
    },
    now: () => clock.now,
    ...overrides,
  };
  return { deps, dialled, clock };
}

/** Connects, accepting the dial the socket makes as soon as it appears. */
async function connect(
  socket: DestinationSocket,
  h: Harness,
  index = 0,
): Promise<FakeSocket> {
  const pending = socket.connect();
  await acceptDial(h, index);
  await pending;
  return h.dialled[index];
}

/** Lets the `index`-th dialled connection finish connecting. */
async function acceptDial(h: Harness, index: number): Promise<FakeSocket> {
  await vi.waitFor(() => expect(h.dialled.length).toBeGreaterThan(index));
  const fake = h.dialled[index];
  await vi.waitFor(() => expect(fake.hasListener("connect")).toBe(true));
  fake.emit("connect");
  return fake;
}

/** Lets the stall guard fire and the swap to the next address finish dialling. */
async function stallAndSwap(h: Harness, fromIndex: number): Promise<FakeSocket> {
  await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
  const next = await acceptDial(h, fromIndex + 1);
  await vi.waitFor(() => expect(next.written.length).toBeGreaterThan(0));
  return next;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("destinationSocket", () => {
  it("dials the resolver's first address and passes bytes through", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const dialled = await connect(socket, h);

    await socket.send(new Uint8Array([1, 2, 3]));
    dialled.emit("data", new Uint8Array([9]));

    expect(h.dialled).toHaveLength(1);
    expect(dialled.written).toHaveLength(1);
    await expect(socket.recv()).resolves.toEqual(new Uint8Array([9]));
  });

  it("moves a silent connection to the next address and replays its bytes", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const first = await connect(socket, h);

    const hello = new Uint8Array([0x16, 0x03, 0x01]);
    await socket.send(hello);

    // Nothing comes back: the guard fires and the stream moves on.
    const second = await stallAndSwap(h, 0);

    expect(first.destroyed).toBe(true);
    expect(second.written[0]).toEqual(hello);

    // The guest never learns: its stream yields the answer from the new one.
    second.emit("data", new Uint8Array([0x16, 0x03, 0x03, 0x01]));
    await expect(socket.recv()).resolves.toEqual(
      new Uint8Array([0x16, 0x03, 0x03, 0x01]),
    );
  });

  it("keeps a connection that answers late", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const dialled = await connect(socket, h);

    await socket.send(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
    dialled.emit("data", new Uint8Array([2]));
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS * 2);

    expect(h.dialled).toHaveLength(1);
    await expect(socket.recv()).resolves.toEqual(new Uint8Array([2]));
  });

  it("stops swapping once the destination has spoken", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const dialled = await connect(socket, h);

    await socket.send(new Uint8Array([1]));
    dialled.emit("data", new Uint8Array([2]));
    // A request that is merely thinking must not be cut, however long it takes.
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS * 5);

    expect(h.dialled).toHaveLength(1);
    expect(dialled.destroyed).toBe(false);
  });

  it("gives up once every candidate stayed silent", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    await connect(socket, h);
    await socket.send(new Uint8Array([1]));

    let index = 0;
    while (index < MAX_ATTEMPTS - 1) {
      await stallAndSwap(h, index);
      index++;
    }
    expect(h.dialled).toHaveLength(MAX_ATTEMPTS);

    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
    await expect(socket.recv()).resolves.toBeNull();
    expect(h.dialled[MAX_ATTEMPTS - 1].destroyed).toBe(true);
  });

  it("skips an address that just stayed silent, until the failure is forgotten", async () => {
    const h = harness();
    const first = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    await connect(first, h);
    await first.send(new Uint8Array([1]));
    await stallAndSwap(h, 0);

    // A second stream to the same host starts with the address the first one
    // had moved on to, not the one that stayed silent.
    const second = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    await connect(second, h, 2);
    expect(h.dialled).toHaveLength(3);

    // Once the failure ages out, the silent address is a candidate again.
    h.clock.now = FAILED_ADDRESS_TTL_MS + 1;
    const third = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    await connect(third, h, 3);
    expect(h.dialled).toHaveLength(4);
  });

  it("tries the next address when a connection is refused", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const pending = socket.connect();
    await vi.waitFor(() => expect(h.dialled).toHaveLength(1));
    h.dialled[0].emit("error", new Error("ECONNREFUSED"));

    await acceptDial(h, 1);
    await pending;

    expect(h.dialled[0].destroyed).toBe(true);
    expect(h.dialled).toHaveLength(2);
  });

  it("gives up on a connect that never completes", async () => {
    const h = harness({ lookup: async () => ["10.0.0.1"] });
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const pending = socket.connect();
    const failed = expect(pending).rejects.toThrow("no reachable address");
    await vi.waitFor(() => expect(h.dialled).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await failed;
    expect(h.dialled[0].destroyed).toBe(true);
  });

  it("lets the guest close a stream mid-swap without leaving it open", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const dialled = await connect(socket, h);
    await socket.send(new Uint8Array([1]));

    socket.close();
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS * 2);

    expect(dialled.ended).toBe(true);
    expect(h.dialled).toHaveLength(1);
    await expect(socket.recv()).resolves.toBeNull();
  });

  it("drops a connection dialled for a guest that has gone", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    await connect(socket, h);
    await socket.send(new Uint8Array([1]));

    // The swap starts, and the guest closes before the new link is up.
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
    await vi.waitFor(() => expect(h.dialled).toHaveLength(2));
    socket.close();
    h.dialled[1].emit("connect");
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS * 2);

    expect(h.dialled[1].destroyed).toBe(true);
    expect(h.dialled[1].written).toHaveLength(0);
  });

  it("ignores what a swapped-out connection says afterwards", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const first = await connect(socket, h);
    await socket.send(new Uint8Array([1]));
    const second = await stallAndSwap(h, 0);

    // The old link answers late; the handshake already moved to the new one.
    first.emit("data", new Uint8Array([0xaa]));
    second.emit("data", new Uint8Array([0xbb]));

    // What the guest reads next is the live connection's answer — the other
    // one was never queued for it.
    await expect(socket.recv()).resolves.toEqual(new Uint8Array([0xbb]));
  });

  it("ends the stream when the destination dies mid-response", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const dialled = await connect(socket, h);
    await socket.send(new Uint8Array([1]));
    dialled.emit("data", new Uint8Array([2]));

    // The guest must not be left waiting on a connection that is over: an EOF
    // is what lets it see the truncated answer and retry (wisp's own socket
    // closes its queue here too).
    dialled.emit("error", new Error("ECONNRESET"));
    dialled.emit("close");

    dialled.emit("data", new Uint8Array([3]));
    await expect(socket.recv()).resolves.toEqual(new Uint8Array([2]));
    await expect(socket.recv()).resolves.toBeNull();
  });

  it("does not cut a swap short when the guest sends while it dials", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    await connect(socket, h);
    await socket.send(new Uint8Array([1]));

    // The guard fires: the swap starts dialling, and the guest sends more
    // bytes before that connection is up.
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
    await vi.waitFor(() => expect(h.dialled).toHaveLength(2));
    await socket.send(new Uint8Array([2]));

    // The address being dialled never connects, so the swap moves on — the
    // bytes the guest sent must not have armed a guard of their own that gives
    // up before this third candidate gets its chance.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await vi.waitFor(() => expect(h.dialled).toHaveLength(3));

    // Past the point such a guard would have fired (the guest's send, plus the
    // answer timeout), while this dial's own connect window is still open.
    await vi.advanceTimersByTimeAsync(2_500);
    const third = await acceptDial(h, 2);
    await vi.waitFor(() => expect(third.written.length).toBeGreaterThan(0));

    third.emit("data", new Uint8Array([7]));
    await expect(socket.recv()).resolves.toEqual(new Uint8Array([7]));
  });

  it("writes a byte the guest sends during a replay exactly once, in order", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    await connect(socket, h);
    const hello = new Uint8Array([0x16, 0x03, 0x01]);
    await socket.send(hello);

    // The guard fires and the replacement is dialled; its writes are parked so
    // the replay is still running when the guest sends more.
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
    await vi.waitFor(() => expect(h.dialled).toHaveLength(2));
    h.dialled[1].holdWrites();
    const second = await acceptDial(h, 1);
    await vi.waitFor(() => expect(second.written).toEqual([hello]), {
      timeout: 2_000,
    });

    const extra = new Uint8Array([0x02]);
    const sending = socket.send(extra);
    // Nothing goes out beside the replay: these bytes are in the list the
    // replay is walking, so writing them here as well would put them on the
    // wire twice — a TLS record delivered twice is a broken connection, not a
    // slower one.
    expect(second.written).toEqual([hello]);

    // Let the replay finish: it awaits nothing but its own microtasks.
    second.releaseWrites();
    await sending;
    for (let tick = 0; tick < 50; tick++) await Promise.resolve();

    expect(second.written).toEqual([hello, extra]);
  });

  it("stops reading from the destination only when the backlog is deep", async () => {
    const h = harness();
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const dialled = await connect(socket, h);

    for (let i = 0; i < RECV_BUFFER_SIZE - 1; i++) {
      dialled.emit("data", new Uint8Array([1]));
    }
    socket.pause();
    expect(dialled.paused).toBe(false);

    dialled.emit("data", new Uint8Array([1]));
    socket.pause();
    expect(dialled.paused).toBe(true);

    socket.resume();
    expect(dialled.paused).toBe(false);
  });

  it("gives up at once when the recovery budget is already spent", async () => {
    // The budget exists to stay inside the client's own request timeout (20 s):
    // once it is gone, no answer can arrive in time, so the stream ends here
    // instead of at the client's later timeout — and no connection is dialled
    // for a request nothing will wait for.
    const h = harness({ lookup: async () => ["10.0.0.1", "10.0.0.2"] });
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    await connect(socket, h);

    h.clock.now = RECOVERY_BUDGET_MS;
    await socket.send(new Uint8Array([1]));

    expect(h.dialled).toHaveLength(1);
    await expect(socket.recv()).resolves.toBeNull();
  });

  it("clamps the guard and the dial to the recovery budget that is left", async () => {
    const h = harness({ lookup: async () => ["10.0.0.1", "10.0.0.2"] });
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    await connect(socket, h);
    // Half a second of budget left: the silence guard fires on that rather than
    // on its full six seconds, the replacement dial gets the same clamped
    // window, and the stream ends when it is gone.
    h.clock.now = RECOVERY_BUDGET_MS - 500;
    await socket.send(new Uint8Array([1]));
    // Half a second in, the silence guard has fired on what was left rather
    // than on its full six seconds, and the replacement is being dialled.
    await vi.advanceTimersByTimeAsync(500);
    expect(h.dialled).toHaveLength(2);

    // The replacement dial's window is the 500 ms the budget had left, not its
    // own four seconds: the stream is over before the client's timeout is.
    await vi.advanceTimersByTimeAsync(500);
    expect(h.dialled[1].destroyed).toBe(true);
    await expect(socket.recv()).resolves.toBeNull();
  });

  it("fails the stream when the resolver never answers", async () => {
    const h = harness({ lookup: () => new Promise(() => {}) });
    const socket = new DestinationSocket("buy.itunes.apple.com", 443, h.deps);
    const pending = expect(socket.connect()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(DNS_TIMEOUT_MS);
    await pending;
    expect(h.dialled).toHaveLength(0);
  });
});
