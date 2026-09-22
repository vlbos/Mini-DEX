import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createWs, type WsHub } from "../src/ws.js";

type Message = {
    type: string;
    address?: string;
    data?: unknown;
    ok?: boolean;
};

const servers: ReturnType<typeof createServer>[] = [];
const sockets: WebSocket[] = [];

function waitForMessage(
    socket: WebSocket,
    predicate: (message: Message) => boolean,
    timeoutMs = 2000,
): Promise<Message> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("等待 WebSocket 消息超时"));
        }, timeoutMs);

        const onMessage = (raw: WebSocket.RawData) => {
            const message = JSON.parse(raw.toString()) as Message;

            if (!predicate(message)) {
                return;
            }

            cleanup();
            resolve(message);
        };

        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };

        function cleanup() {
            clearTimeout(timer);
            socket.off("message", onMessage);
            socket.off("error", onError);
        }

        socket.on("message", onMessage);
        socket.on("error", onError);
    });
}

async function startTestServer(): Promise<{
    url: string;
    hub: WsHub;
}> {
    const server = createServer();

    const hub = createWs({
        server,
        verifyToken: async (token) => {
            const tokens: Record<string, string> = {
                "alice-token":
                    "0x1111111111111111111111111111111111111111",
                "bob-token":
                    "0x2222222222222222222222222222222222222222",
            };

            return tokens[token] ?? null;
        },
        getSnapshot: () => ({
            bids: [],
            asks: [],
        }),
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });

    servers.push(server);

    const address = server.address();

    if (!address || typeof address === "string") {
        throw new Error("无法获取测试服务器端口");
    }

    return {
        url: `ws://127.0.0.1:${address.port}/ws`,
        hub,
    };
}

async function connect(
    url: string,
    token: string,
): Promise<WebSocket> {
    const socket = new WebSocket(url);
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
    });

    socket.send(
        JSON.stringify({
            type: "auth",
            token,
        }),
    );

    const auth = await waitForMessage(
        socket,
        (message) => message.type === "auth",
    );

    expect(auth.ok).toBe(true);

    return socket;
}

afterEach(async () => {
    for (const socket of sockets.splice(0)) {
        if (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
        ) {
            socket.close();
        }
    }

    for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }
});

describe("private WebSocket order events", () => {
    it("only sends order.accepted to the authenticated owner", async () => {
        const { url, hub } = await startTestServer();

        const alice = await connect(url, "alice-token");
        const bob = await connect(url, "bob-token");

        const aliceEvent = waitForMessage(
            alice,
            (message) => message.type === "order.accepted",
        );

        hub.sendOrder(
            "0x1111111111111111111111111111111111111111",
            "order.accepted",
            {
                id: "alice-order-1",
                side: "buy",
                remaining: "1",
            },
        );

        const message = await aliceEvent;

        expect(message.type).toBe("order.accepted");
        expect(message.data).toEqual({
            id: "alice-order-1",
            side: "buy",
            remaining: "1",
        });

        await expect(
            waitForMessage(
                bob,
                (msg) => msg.type === "order.accepted",
                500,
            ),
        ).rejects.toThrow("等待 WebSocket 消息超时");
    });

    it("routes different private events to the correct owner", async () => {
        const { url, hub } = await startTestServer();

        const alice = await connect(url, "alice-token");
        const bob = await connect(url, "bob-token");

        const aliceEvents = Promise.all([
            waitForMessage(
                alice,
                (message) => message.type === "order.partially_filled",
            ),
            waitForMessage(
                alice,
                (message) => message.type === "order.cancelled",
            ),
        ]);

        const bobEvent = waitForMessage(
            bob,
            (message) => message.type === "order.filled",
        );

        hub.sendOrder(
            "0x1111111111111111111111111111111111111111",
            "order.partially_filled",
            {
                orderId: "alice-order-1",
                filledQty: "40",
                remaining: "60",
            },
        );

        hub.sendOrder(
            "0x1111111111111111111111111111111111111111",
            "order.cancelled",
            {
                orderId: "alice-order-1",
            },
        );

        hub.sendOrder(
            "0x2222222222222222222222222222222222222222",
            "order.filled",
            {
                orderId: "bob-order-1",
                filledQty: "100",
                remaining: "0",
            },
        );

        const [partial, cancelled] = await aliceEvents;
        const filled = await bobEvent;

        expect(partial.type).toBe("order.partially_filled");
        expect(cancelled.type).toBe("order.cancelled");
        expect(filled.type).toBe("order.filled");

        expect(partial.data).toEqual({
            orderId: "alice-order-1",
            filledQty: "40",
            remaining: "60",
        });

        expect(cancelled.data).toEqual({
            orderId: "alice-order-1",
        });

        expect(filled.data).toEqual({
            orderId: "bob-order-1",
            filledQty: "100",
            remaining: "0",
        });
    });

    it("rejects invalid authentication", async () => {
        const { url } = await startTestServer();

        const socket = new WebSocket(url);
        sockets.push(socket);

        await new Promise<void>((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
        });

        socket.send(
            JSON.stringify({
                type: "auth",
                token: "invalid-token",
            }),
        );

        const message = await waitForMessage(
            socket,
            (message) => message.type === "auth",
        );

        expect(message.ok).toBe(false);
        expect(message.address).toBeUndefined();
    });
});