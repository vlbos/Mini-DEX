import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createWs, type WsHub } from "../src/ws.js";
import { Ledger } from "../src/ledger.js";
import { MatchingService } from "../src/matchingService.js";

type Message = {
    type: string;
    data?: {
        order?: {
            id: string;
            owner: string;
            side: string;
            remaining: string;
        };
        fill?: {
            price: string;
            qty: string;
        };
    };
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
            reject(
                new Error(
                    "等待 WebSocket 消息超时",
                ),
            );
        }, timeoutMs);

        const onMessage = (
            raw: WebSocket.RawData,
        ) => {
            const message =
                JSON.parse(
                    raw.toString(),
                ) as Message;

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
            socket.off(
                "message",
                onMessage,
            );
            socket.off(
                "error",
                onError,
            );
        }

        socket.on(
            "message",
            onMessage,
        );

        socket.on(
            "error",
            onError,
        );
    });
}

async function setup() {
    const server = createServer();

    const hub: WsHub = createWs({
        server,

        verifyToken: async (
            token,
        ) => {
            if (token === "alice-token") {
                return (
                    "0x1111111111111111111111111111111111111111"
                );
            }

            if (token === "bob-token") {
                return (
                    "0x2222222222222222222222222222222222222222"
                );
            }

            return null;
        },

        getSnapshot: () => ({
            bids: [],
            asks: [],
        }),
    });

    await new Promise<void>(
        (resolve) => {
            server.listen(
                0,
                "127.0.0.1",
                () => resolve(),
            );
        },
    );

    servers.push(server);

    const address =
        server.address();

    if (
        !address ||
        typeof address === "string"
    ) {
        throw new Error(
            "无法获取测试端口",
        );
    }

    const url =
        `ws://127.0.0.1:${address.port}/ws`;

    const ledger =
        new Ledger();

    const matching =
        new MatchingService(
            ledger,
        );

    /*
     * 真正把 MatchingService
     * 和 WebSocket 接起来。
     */
    matching.setPrivateOrderEventHandler(
        (
            owner,
            type,
            payload,
        ) => {
            hub.sendOrder(
                owner,
                type,
                {
                    order: {
                        id:
                            payload.order.id,
                        owner:
                            payload.order.owner,
                        side:
                            payload.order.side,
                        remaining:
                            payload.order.remaining.toString(),
                    },

                    fill:
                        payload.fill
                            ? {
                                price:
                                    payload.fill.price.toString(),
                                qty:
                                    payload.fill.qty.toString(),
                            }
                            : undefined,
                },
            );
        },
    );

    return {
        url,
        ledger,
        matching,
    };
}

async function connect(
    url: string,
    token: string,
): Promise<WebSocket> {
    const socket =
        new WebSocket(url);

    sockets.push(socket);

    await new Promise<void>(
        (resolve, reject) => {
            socket.once(
                "open",
                () => resolve(),
            );

            socket.once(
                "error",
                reject,
            );
        },
    );

    socket.send(
        JSON.stringify({
            type: "auth",
            token,
        }),
    );

    const auth =
        await waitForMessage(
            socket,
            (message) =>
                message.type ===
                "auth",
        );

    expect(auth.ok).toBe(true);

    return socket;
}

afterEach(async () => {
    for (
        const socket of sockets.splice(
            0,
        )
    ) {
        if (
            socket.readyState ===
            WebSocket.OPEN ||
            socket.readyState ===
            WebSocket.CONNECTING
        ) {
            socket.close();
        }
    }

    for (
        const server of servers.splice(
            0,
        )
    ) {
        await new Promise<void>(
            (resolve) => {
                server.close(
                    () => resolve(),
                );
            },
        );
    }
});

describe(
    "MatchingService + private WebSocket",
    () => {
        it(
            "下单 -> accepted -> partial fill -> filled",
            async () => {
                const {
                    url,
                    ledger,
                    matching,
                } = await setup();

                const alice =
                    await connect(
                        url,
                        "alice-token",
                    );

                const bob =
                    await connect(
                        url,
                        "bob-token",
                    );

                const aliceAccepted =
                    waitForMessage(
                        alice,
                        (m) =>
                            m.type ===
                            "order.accepted" &&
                            m.data?.order
                                ?.id ===
                            "alice-sell",
                    );

                /*
                 * Alice 卖 1 WAVAX
                 * 价格 300 USDC
                 */
                ledger.credit(
                    "0x1111111111111111111111111111111111111111",
                    "WAVAX",
                    100000000n,
                );

                matching.placeOrder({
                    id: "alice-sell",
                    owner:
                        "0x1111111111111111111111111111111111111111",
                    side: "sell",
                    type: "limit",
                    price: 30000000000n,
                    qty: 100000000n,
                });

                const accepted =
                    await aliceAccepted;

                expect(
                    accepted.type,
                ).toBe(
                    "order.accepted",
                );

                expect(
                    accepted.data
                        ?.order?.id,
                ).toBe(
                    "alice-sell",
                );

                /*
                 * Bob 先买 0.4 WAVAX
                 *
                 * Alice:
                 * 1.0 -> 0.6
                 *
                 * 所以 Alice 应收到
                 * partially_filled
                 */
                const alicePartial =
                    waitForMessage(
                        alice,
                        (m) =>
                            m.type ===
                            "order.partially_filled" &&
                            m.data?.order
                                ?.id ===
                            "alice-sell",
                    );

                const bobFilled =
                    waitForMessage(
                        bob,
                        (m) =>
                            m.type ===
                            "order.filled" &&
                            m.data?.order
                                ?.id ===
                            "bob-buy",
                    );

                ledger.credit(
                    "0x2222222222222222222222222222222222222222",
                    "USDC",
                    100000000000n,
                );

                matching.placeOrder({
                    id: "bob-buy",
                    owner:
                        "0x2222222222222222222222222222222222222222",
                    side: "buy",
                    type: "limit",
                    price: 30000000000n,
                    qty: 40000000n,
                });

                const partial =
                    await alicePartial;

                const filled =
                    await bobFilled;

                expect(
                    partial.type,
                ).toBe(
                    "order.partially_filled",
                );

                expect(
                    partial.data
                        ?.order
                        ?.remaining,
                ).toBe(
                    "60000000",
                );

                expect(
                    filled.type,
                ).toBe(
                    "order.filled",
                );

                expect(
                    filled.data
                        ?.order
                        ?.remaining,
                ).toBe("0");
            },
        );

        it(
            "下单 -> accepted -> cancel -> cancelled",
            async () => {
                const {
                    url,
                    ledger,
                    matching,
                } = await setup();

                const alice =
                    await connect(
                        url,
                        "alice-token",
                    );

                ledger.credit(
                    "0x1111111111111111111111111111111111111111",
                    "USDC",
                    100000000000n,
                );

                const accepted =
                    waitForMessage(
                        alice,
                        (m) =>
                            m.type ===
                            "order.accepted" &&
                            m.data?.order
                                ?.id ===
                            "cancel-test",
                    );

                matching.placeOrder({
                    id: "cancel-test",
                    owner:
                        "0x1111111111111111111111111111111111111111",
                    side: "buy",
                    type: "limit",
                    price: 30000000000n,
                    qty: 100000000n,
                });

                await accepted;

                const cancelled =
                    waitForMessage(
                        alice,
                        (m) =>
                            m.type ===
                            "order.cancelled" &&
                            m.data?.order
                                ?.id ===
                            "cancel-test",
                    );

                const result =
                    matching.cancelOrder(
                        "0x1111111111111111111111111111111111111111",
                        "cancel-test",
                    );

                expect(
                    result,
                ).not.toBeNull();

                const message =
                    await cancelled;

                expect(
                    message.type,
                ).toBe(
                    "order.cancelled",
                );

                expect(
                    message.data
                        ?.order?.id,
                ).toBe(
                    "cancel-test",
                );
            },
        );
    },
);