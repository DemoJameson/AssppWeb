import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, Server } from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import express from "express";

// The relay is asked to dial with the socket that moves a stream off an address
// that never answers. wisp's own socket would keep waiting on it forever (see
// destinationSocket.ts), so this wiring is what the tunnel's resilience rests on.
const routeRequest = vi.fn((_request: unknown, socket: { destroy(): void }) => {
  socket.destroy();
});

vi.mock("@mercuryworkshop/wisp-js/server", () => ({
  server: {
    options: {},
    routeRequest: (...args: unknown[]) => routeRequest(...args),
  },
}));

const { setupWsProxy } = await import("../src/services/wsProxy.js");
const { DestinationSocket } = await import(
  "../src/services/destinationSocket.js"
);

let httpServer: Server | null = null;

afterEach(async () => {
  routeRequest.mockClear();
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("wsProxy stream socket", () => {
  it("dials streams with the socket that moves off a silent address", async () => {
    httpServer = createServer(express());
    setupWsProxy(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/wisp/`);
    ws.on("error", () => undefined);

    await vi.waitFor(() => expect(routeRequest).toHaveBeenCalled());

    expect(routeRequest.mock.calls[0][3]).toMatchObject({
      TCPSocket: DestinationSocket,
    });

    ws.terminate();
  });
});
