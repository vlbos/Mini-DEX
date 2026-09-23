
import {
    OrderBook,
    type Order,
    type Fill,
    type Side,
    type OrderType,
} from "./engine/orderbook.js";

import type { Ledger } from "./ledger.js";

import {
    loadOpenOrders,
    saveOrder,
    deleteOrder,
} from "./db/orderRepository.js";

import { saveTrade } from "./db/tradeRepository.js";

import {
    mulFixed,
} from "./fixed.js";

export type TimeInForce = "GTC" | "IOC" | "FOK";

export type PrivateOrderEvent =
    | "order.accepted"
    | "order.partially_filled"
    | "order.filled"
    | "order.cancelled"
    | "order.rejected";

export interface PrivateOrderEventPayload {
    order: Order;
    fill?: {
        price: bigint;
        qty: bigint;
    };
}

export type PrivateOrderEventHandler = (
    owner: string,
    type: PrivateOrderEvent,
    payload: PrivateOrderEventPayload,
) => void;

export interface PlaceInput {
    id: string;
    owner: string;
    side: Side;
    type: OrderType;
    price: bigint;
    qty: bigint;
    timeInForce?: TimeInForce;
    ts?: number;
}

export class MatchingService {
    readonly book: OrderBook;

    private privateOrderEventHandler:
        | PrivateOrderEventHandler
        | undefined;

    constructor(private readonly ledger: Ledger) {
        this.book = new OrderBook();
        this.restoreOrders();
    }

    setPrivateOrderEventHandler(
        handler: PrivateOrderEventHandler,
    ): void {
        this.privateOrderEventHandler = handler;
    }

    private emitPrivateOrderEvent(
        owner: string,
        type: PrivateOrderEvent,
        order: Order,
        fill?: {
            price: bigint;
            qty: bigint;
        },
    ): void {
        this.privateOrderEventHandler?.(
            owner,
            type,
            {
                order,
                fill,
            },
        );
    }

    /**
     * SQLite -> OrderBook
     *
     * 这里只恢复 open orders，
     * 不重新撮合。
     */
    private restoreOrders(): void {
        const orders = loadOpenOrders();

        for (const order of orders) {
            this.book.restore(order);
        }

        console.log(
            `[db] restored ${orders.length} open orders`,
        );
    }

    ordersOf(owner: string): Order[] {
        return this.book.ordersOf(
            owner.toLowerCase(),
        );
    }

    getOrder(id: string): Order | undefined {
        return this.book.get(id);
    }

    /**
     * 估算 market buy 最少需要多少 USDC。
     */
    private estimateBuyCost(qty: bigint): bigint {
        let cost = 0n;
        let left = qty;

        const snapshot =
            this.book.snapshot(
                Number.MAX_SAFE_INTEGER,
            );

        for (const [price, levelQty] of snapshot.asks) {
            const take =
                left < levelQty
                    ? left
                    : levelQty;

            cost += mulFixed(
                price,
                take,
            );

            left -= take;

            if (left === 0n) break;
        }

        return cost;
    }

    /**
     * 计算本次订单最初冻结的资产数量。
     *
     * 注意：
     * 成交后 transferLocked() 会逐笔消耗冻结余额，
     * 所以 IOC/FOK 后续只需要解锁仍然没有被成交消耗的部分。
     */
    private getLockAmount(input: PlaceInput): {
        asset: "USDC" | "WAVAX";
        amount: bigint;
    } {
        if (input.side === "buy") {
            return {
                asset: "USDC",
                amount:
                    input.price *
                    input.qty /
                    100000000n,
            };
        }

        return {
            asset: "WAVAX",
            amount: input.qty,
        };
    }

    /**
     * 计算指定剩余数量对应的冻结资产。
     */
    private getRemainingLockAmount(
        input: PlaceInput,
        remaining: bigint,
    ): bigint {
        if (remaining <= 0n) {
            return 0n;
        }

        if (input.side === "buy") {
            return (
                input.price *
                remaining /
                100000000n
            );
        }

        return remaining;
    }

    placeOrder(
        input: PlaceInput,
        opts: { broadcastBook?: boolean } = {},
    ) {
        const owner = input.owner.toLowerCase();

        const timeInForce =
            input.timeInForce ?? "GTC";

        const lock =
            this.getLockAmount(input);

        this.ledger.lock(
            owner,
            lock.asset,
            lock.amount,
        );

        let result;

        try {
            result = this.book.submit({
                id: input.id,
                owner,
                side: input.side,
                type: input.type,
                price: input.price,
                qty: input.qty,
                timeInForce,
                ts: input.ts,
            });
        } catch (err) {
            /**
             * OrderBook.submit() 失败：
             *
             * 撮合尚未成功进入订单生命周期，
             * 因此把本次全部冻结资金退回。
             */
            this.ledger.unlock(
                owner,
                lock.asset,
                lock.amount,
            );

            this.emitPrivateOrderEvent(
                owner,
                "order.rejected",
                {
                    id: input.id,
                    owner,
                    side: input.side,
                    type: input.type,
                    price: input.price,
                    qty: input.qty,
                    remaining: input.qty,
                    ts: input.ts ?? Date.now(),
                    seq: 0,
                },
            );

            throw err;
        }

        /*
         * 1. 订单接受
         *
         * resting 订单直接使用实际订单。
         *
         * 如果订单立即完全成交，则构造一个
         * remaining = 0 的订单快照。
         */
        const acceptedOrder =
            result.resting ??
            {
                id: input.id,
                owner,
                side: input.side,
                type: input.type,
                price: input.price,
                qty: input.qty,
                remaining: 0n,
                ts: input.ts ?? Date.now(),
                seq: 0,
            };

        this.emitPrivateOrderEvent(
            owner,
            "order.accepted",
            acceptedOrder,
        );

        /*
         * 2. 撮合
         */
        for (const fill of result.fills) {
            saveTrade(fill);

            this.persistMakerAfterFill(fill);

            this.settleFill(fill);

            /*
             * Taker
             */
            const takerOrder =
                this.book.get(fill.takerOrderId);

            const takerRemaining =
                takerOrder?.remaining ?? 0n;

            const takerSnapshot: Order =
                takerOrder ??
                {
                    id: fill.takerOrderId,
                    owner: fill.taker,
                    side: fill.side,
                    type: "limit",
                    price: fill.price,
                    qty: fill.qty,
                    remaining: 0n,
                    ts: fill.ts,
                    seq: 0,
                };

            this.emitPrivateOrderEvent(
                fill.taker,
                takerRemaining === 0n
                    ? "order.filled"
                    : "order.partially_filled",
                takerSnapshot,
                {
                    price: fill.price,
                    qty: fill.qty,
                },
            );

            /*
             * Maker
             */
            const makerOrder =
                this.book.get(fill.makerOrderId);

            const makerRemaining =
                makerOrder?.remaining ?? 0n;

            const makerSnapshot: Order =
                makerOrder ??
                {
                    id: fill.makerOrderId,
                    owner: fill.maker,
                    side:
                        fill.side === "buy"
                            ? "sell"
                            : "buy",
                    type: "limit",
                    price: fill.price,
                    qty: fill.qty,
                    remaining: 0n,
                    ts: fill.ts,
                    seq: 0,
                };

            this.emitPrivateOrderEvent(
                fill.maker,
                makerRemaining === 0n
                    ? "order.filled"
                    : "order.partially_filled",
                makerSnapshot,
                {
                    price: fill.price,
                    qty: fill.qty,
                },
            );
        }

        /*
         * 3. 根据 Time-In-Force 处理剩余数量
         *
         * GTC:
         *   剩余订单进入 OrderBook，冻结资金继续保留。
         *
         * IOC:
         *   剩余订单不能进入 OrderBook。
         *   对应冻结资金立即解锁。
         *
         * FOK:
         *   OrderBook 应保证只有在全部成交时才产生 fills。
         *   如果没有完全成交，则本次全部冻结资金解锁。
         */
        const filledQty =
            result.fills.reduce(
                (sum: bigint, fill: Fill) =>
                    sum + fill.qty,
                0n,
            );

        const remainingQty =
            input.qty > filledQty
                ? input.qty - filledQty
                : 0n;

        if (timeInForce === "IOC") {
            /**
             * IOC 永远不能留下 resting order。
             *
             * 如果有剩余数量，把对应的冻结资金释放。
             */
            if (remainingQty > 0n) {
                const refund =
                    this.getRemainingLockAmount(
                        input,
                        remainingQty,
                    );

                if (refund > 0n) {
                    this.ledger.unlock(
                        owner,
                        lock.asset,
                        refund,
                    );
                }
            }

            /**
             * 理论上 IOC 不应该出现 resting。
             *
             * 如果 OrderBook 返回了 resting，
             * 不应该保存它，否则 IOC 会变成 GTC。
             */
            if (result.resting) {
                deleteOrder(result.resting.id);
            }
        } else if (timeInForce === "FOK") {
            /**
             * FOK 必须全部成交。
             *
             * 正常情况下 OrderBook.submit() 已经保证
             * FOK 不会出现部分成交。
             *
             * 如果最终没有全部成交：
             *   - 不保存 resting
             *   - 全额解锁初始冻结
             */
            if (filledQty < input.qty) {
                if (result.resting) {
                    deleteOrder(result.resting.id);
                }

                this.ledger.unlock(
                    owner,
                    lock.asset,
                    lock.amount,
                );
            }
        } else {
            /**
             * GTC：
             * 剩余订单继续留在订单簿，
             * 对应冻结资金继续保持 locked。
             */
            if (result.resting) {
                saveOrder(result.resting);
            }
        }

        /*
         * 4. IOC / FOK 不产生 resting order。
         *
         * GTC 才会在这里持久化 open order。
         */
        if (
            timeInForce !== "GTC" &&
            result.resting
        ) {
            deleteOrder(result.resting.id);
        }

        return result;
    }

    private persistMakerAfterFill(
        fill: { makerOrderId: string },
    ): void {
        const maker =
            this.book.get(fill.makerOrderId);

        if (maker) {
            saveOrder(maker);
        } else {
            deleteOrder(fill.makerOrderId);
        }
    }

    private settleFill(fill: {
        taker: string;
        maker: string;
        side: Side;
        price: bigint;
        qty: bigint;
    }): void {
        const buyer =
            fill.side === "buy"
                ? fill.taker
                : fill.maker;

        const seller =
            fill.side === "buy"
                ? fill.maker
                : fill.taker;

        const quoteAmount =
            fill.price *
            fill.qty /
            100000000n;

        this.ledger.transferLocked(
            buyer,
            seller,
            "USDC",
            quoteAmount,
        );

        this.ledger.transferLocked(
            seller,
            buyer,
            "WAVAX",
            fill.qty,
        );
    }

    cancelOrder(
        owner: string,
        id: string,
    ): Order | null {
        const normalizedOwner =
            owner.toLowerCase();

        const order =
            this.book.cancel(
                id,
                normalizedOwner,
            );

        if (!order) {
            return null;
        }

        /**
         * 只解冻 remaining。
         */
        if (order.side === "buy") {
            const refund =
                order.price *
                order.remaining /
                100000000n;

            this.ledger.unlock(
                normalizedOwner,
                "USDC",
                refund,
            );
        } else {
            this.ledger.unlock(
                normalizedOwner,
                "WAVAX",
                order.remaining,
            );
        }

        deleteOrder(order.id);

        this.emitPrivateOrderEvent(
            normalizedOwner,
            "order.cancelled",
            order,
        );

        return order;
    }
}

