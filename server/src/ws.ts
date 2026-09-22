// WebSocket 广播：和 HTTP 共用同一个端口，路径 /ws。
// 服务端推三种消息：orderbook（全员）/ trade（全员）/ balance（只推给发过 {type:"auth", token} 的连接）。
// 新连接一进来就先发一份订单簿快照，前端不用再额外 GET。

import * as ws from "ws";
import type { Server } from "node:http";

export type PrivateOrderEvent =
    | "order.accepted"
    | "order.partially_filled"
    | "order.filled"
    | "order.cancelled"
    | "order.rejected";

export interface WsHub {
    broadcast(type: "orderbook" | "trade", data: unknown): void;
    sendBalance(address: string, data: unknown): void;
    sendOrder(
        address: string,
        type: PrivateOrderEvent,
        data: unknown,
    ): void;
}

export function createWs(opts: {
    server: Server;
    verifyToken: (token: string) => Promise<string | null>;
    getSnapshot: () => unknown;
}): WsHub {
    const wss = new ws.WebSocketServer({
        server: opts.server,
        path: "/ws",
    });

    // socket -> JWT 验证后的用户地址
    const authed = new Map<ws.WebSocket, string>();

    wss.on("connection", (socket: ws.WebSocket) => {
        // 新连接先收到公共订单簿快照
        send(socket, {
            type: "orderbook",
            data: opts.getSnapshot(),
        });

        socket.on("message", async (raw: ws.RawData) => {
            let msg: {
                type?: string;
                token?: string;
            };

            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }

            if (
                msg.type === "auth" &&
                typeof msg.token === "string"
            ) {
                const address = await opts.verifyToken(msg.token);

                if (address) {
                    authed.set(
                        socket,
                        address.toLowerCase(),
                    );
                }

                send(socket, {
                    type: "auth",
                    ok: !!address,
                    address: address?.toLowerCase(),
                });
            }
        });

        socket.on("close", () => {
            authed.delete(socket);
        });

        socket.on("error", () => {
            authed.delete(socket);
        });
    });

    function send(
        socket: ws.WebSocket,
        msg: unknown,
    ): void {
        if (socket.readyState === ws.WebSocket.OPEN) {
            socket.send(JSON.stringify(msg));
        }
    }

    function normalizeAddress(address: string): string {
        return address.toLowerCase();
    }

    return {
        broadcast(type, data) {
            for (const socket of wss.clients) {
                send(socket, {
                    type,
                    data,
                });
            }
        },

        sendBalance(address, data) {
            const target = normalizeAddress(address);

            for (const [socket, addr] of authed) {
                if (addr === target) {
                    send(socket, {
                        type: "balance",
                        address: target,
                        data,
                    });
                }
            }
        },

        sendOrder(address, type, data) {
            const target = normalizeAddress(address);

            for (const [socket, addr] of authed) {
                if (addr === target) {
                    send(socket, {
                        type,
                        data,
                    });
                }
            }
        },
    };
}