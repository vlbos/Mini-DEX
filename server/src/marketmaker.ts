// src/marketmaker.ts
//
// 做市机器人：镜像 Binance 前 N 档盘口到本所 OrderBook。
// 默认配置为买卖两侧各 3 档，共 6 个报价。
// 每个 tick：
//   1. 获取 Binance depth
//   2. 取 bids 前 3 档 + asks 前 3 档
//   3. 按 scale 缩小数量
//   4. 与当前做市订单比较
//   5. 不需要的订单撤掉
//   6. 缺少的订单重新挂出
//   7. 根据做市账户 available 余额裁剪
//   8. 广播一次订单簿

import { ONE, mulFixed, parseFixed } from "./fixed.js";
import type { Order, Side } from "./engine/orderbook.js";
import type { Ledger } from "./ledger.js";

export type Level = [price: string, qty: string];

export interface Depth {
    bids: Level[];
    asks: Level[];
}

export interface Quote {
    side: Side;
    price: bigint;
    qty: bigint;
}

export interface Plan {
    cancel: Order[];
    place: Quote[];
}

/**
 * Binance 公共行情 API。
 */
export const REST_HOSTS = [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
];

type FetchLike = (
    input: string,
) => Promise<{
    ok: boolean;
    status?: number;
    json: () => Promise<unknown>;
}>;

export interface RestOptions {
    hosts?: string[];
    fetchFn?: FetchLike;
}

/**
 * 获取 Binance OrderBook depth。
 */
export async function fetchDepth(
    symbol: string,
    limit = 20,
    opts: RestOptions = {},
): Promise<Depth> {
    const hosts = opts.hosts ?? REST_HOSTS;

    const fetchFn: FetchLike =
        opts.fetchFn ??
        ((url) => fetch(url));

    let lastErr: unknown =
        new Error("no Binance hosts available");

    for (const host of hosts) {
        try {
            const url =
                `${host}/api/v3/depth` +
                `?symbol=${encodeURIComponent(symbol)}` +
                `&limit=${limit}`;

            const res = await fetchFn(url);

            if (!res.ok) {
                throw new Error(
                    `HTTP ${res.status ?? "?"} from ${host}`,
                );
            }

            const data =
                (await res.json()) as {
                    bids: Level[];
                    asks: Level[];
                };

            return {
                bids: data.bids,
                asks: data.asks,
            };
        } catch (err) {
            lastErr = err;
        }
    }

    throw lastErr;
}

/**
 * 做市配置。
 *
 * levels = 3：
 *   bids 取 3 档
 *   asks 取 3 档
 *   总共 6 档
 */
export interface ScaleOptions {
    levels: number;
    scale: number;
    minQty: number;
    maxQty: number;
}

/**
 * Binance depth -> 本所目标报价。
 */
export function scaleDepth(
    levels: Level[],
    options: ScaleOptions,
): Level[] {
    return levels
        .slice(0, options.levels)
        .map(([price, qty]) => {
            const scaledQty = Math.min(
                options.maxQty,
                Math.max(
                    options.minQty,
                    Number(qty) * options.scale,
                ),
            );

            return [
                trim4(Number(price)),
                trim4(scaledQty),
            ];
        });
}

function trim4(n: number): string {
    return n
        .toFixed(4)
        .replace(/\.?0+$/, "");
}

/**
 * Binance Level -> 定点数 Quote。
 */
export function toQuotes(
    side: Side,
    levels: Level[],
): Quote[] {
    return levels.map(([price, qty]) => ({
        side,
        price: parseFixed(price),
        qty: parseFixed(qty),
    }));
}

/**
 * 根据目标报价和现有订单生成增量计划。
 *
 * 规则：
 *
 * 1. 目标中不存在的旧订单 -> cancel
 * 2. 同价重复订单 -> cancel 多余订单
 * 3. 数量偏差超过 tolerance -> cancel + 重挂
 * 4. 已经满足要求 -> 保留
 * 5. 目标中不存在的价格 -> place
 */
export function planQuotes(
    targets: Quote[],
    existing: Order[],
    tolerance = 0.2,
): Plan {
    const key = (
        side: Side,
        price: bigint,
    ) => `${side}:${price}`;

    const wanted = new Map(
        targets.map((target) => [
            key(target.side, target.price),
            target,
        ]),
    );

    const matched = new Set<string>();

    const cancel: Order[] = [];

    for (const order of existing) {
        const k = key(
            order.side,
            order.price,
        );

        const target = wanted.get(k);

        if (!target || matched.has(k)) {
            cancel.push(order);
            continue;
        }

        const diff =
            order.remaining > target.qty
                ? order.remaining - target.qty
                : target.qty - order.remaining;

        if (
            Number(diff) >
            Number(target.qty) * tolerance
        ) {
            cancel.push(order);
            continue;
        }

        matched.add(k);
    }

    const place = targets.filter(
        (target) =>
            !matched.has(
                key(target.side, target.price),
            ),
    );

    return {
        cancel,
        place,
    };
}

/**
 * 根据做市账户 available 余额裁剪报价。
 *
 * BUY：
 *   使用 USDC
 *
 * SELL：
 *   使用 WAVAX
 */
export function capByBalance(
    quotes: Quote[],
    avail: {
        USDC: bigint;
        WAVAX: bigint;
    },
    minQty: bigint,
): Quote[] {
    let usdc = avail.USDC;
    let wavax = avail.WAVAX;

    const result: Quote[] = [];

    for (const quote of quotes) {
        if (quote.side === "buy") {
            const cost = mulFixed(
                quote.price,
                quote.qty,
            );

            let qty = quote.qty;

            if (cost > usdc) {
                qty = floor4(
                    (usdc * ONE) /
                    quote.price,
                );
            }

            if (
                qty < minQty ||
                qty <= 0n
            ) {
                continue;
            }

            usdc -= mulFixed(
                quote.price,
                qty,
            );

            result.push({
                ...quote,
                qty,
            });
        } else {
            let qty = quote.qty;

            if (qty > wavax) {
                qty = wavax;
            }

            if (
                qty < minQty ||
                qty <= 0n
            ) {
                continue;
            }

            wavax -= qty;

            result.push({
                ...quote,
                qty,
            });
        }
    }

    return result;
}

/**
 * 8 位定点数截断到 4 位小数。
 */
function floor4(value: bigint): bigint {
    const unit = 10n ** 4n;

    return (
        value / unit
    ) * unit;
}

export interface MarketMakerConfig {
    /**
     * 做市账户地址。
     */
    address: string;

    /**
     * Binance 交易对。
     * 例如 WAVAXUSDC。
     */
    symbol: string;

    /**
     * 买卖两侧档数。
     *
     * 作业要求：
     * levels = 3
     */
    levels: number;

    /**
     * Binance 数量缩放比例。
     */
    scale: number;

    /**
     * 刷新间隔。
     */
    intervalMs: number;

    /**
     * 单档最小数量。
     */
    minQty: number;

    /**
     * 单档最大数量。
     */
    maxQty: number;
}
export interface MarketMakerDeps {
    ledger: Ledger;

    ordersOf(
        owner: string,
    ): Order[];

    placeOrder(
        owner: string,
        q: {
            side: Side;
            type: "limit";
            price: bigint;
            qty: bigint;
        },
        opts: {
            broadcastBook: boolean;
        },
    ): unknown;

    cancelOrder(
        owner: string,
        id: string,
        opts?: {
            broadcastBook?: boolean;
        },
    ): unknown;

    broadcastBook(): void;

    fetchDepth?: typeof fetchDepth;

    log?: (msg: string) => void;
}

/**
 * 启动做市机器人。
 *
 * 返回 stop 函数。
 */
export function startMarketMaker(
    cfg: MarketMakerConfig,
    deps: MarketMakerDeps,
): () => void {
    const log =
        deps.log ??
        ((message: string) =>
            console.log(`[mm] ${message}`));

    const getDepth =
        deps.fetchDepth ??
        fetchDepth;

    const mm =
        cfg.address.toLowerCase();

    const minQtyFixed =
        parseFixed(
            String(cfg.minQty),
        );

    let running = false;
    let failures = 0;
    let ticks = 0;

    /**
     * 单次做市刷新。
     */
    async function tick(): Promise<void> {
        // 防止上一次请求还没有结束，
        // 下一次 tick 又开始执行。
        if (running) {
            return;
        }

        running = true;

        try {
            /**
             * 1. 获取 Binance 深度。
             *
             * 多取几档，确保至少有 3 档。
             */
            const depth =
                await getDepth(
                    cfg.symbol,
                    Math.max(
                        cfg.levels,
                        5,
                    ),
                );

            /**
             * 2. 生成目标报价。
             *
             * levels = 3 时：
             *
             * bids -> 3
             * asks -> 3
             */
            const scaleOptions = {
                levels: cfg.levels,
                scale: cfg.scale,
                minQty: cfg.minQty,
                maxQty: cfg.maxQty,
            };

            const buyLevels =
                scaleDepth(
                    depth.bids,
                    scaleOptions,
                );

            const sellLevels =
                scaleDepth(
                    depth.asks,
                    scaleOptions,
                );

            const targets = [
                ...toQuotes(
                    "buy",
                    buyLevels,
                ),
                ...toQuotes(
                    "sell",
                    sellLevels,
                ),
            ];

            /**
             * 3. 和当前做市订单比较。
             */
            const existing =
                deps.ordersOf(mm);

            const plan =
                planQuotes(
                    targets,
                    existing,
                );

            /**
             * 4. 撤掉过期订单。
             */
            for (const order of plan.cancel) {
                try {
                    deps.cancelOrder(
                        mm,
                        order.id, {
                        broadcastBook: false,
                    },
                    );
                } catch (err) {
                    log(
                        `撤单失败 ${order.id}: ` +
                        `${(err as Error).message}`,
                    );
                }
            }

            /**
             * 5. 读取做市账户余额。
             */
            const balance =
                deps.ledger.get(mm);

            /**
             * 6. 根据余额裁剪要挂的订单。
             */
            const toPlace =
                capByBalance(
                    plan.place,
                    {
                        USDC:
                            balance.USDC.available,
                        WAVAX:
                            balance.WAVAX.available,
                    },
                    minQtyFixed,
                );

            /**
             * 7. 逐笔挂单。
             */
            let placed = 0;

            for (const quote of toPlace) {
                try {
                    deps.placeOrder(
                        mm,
                        {
                            side: quote.side,
                            type: "limit",
                            price: quote.price,
                            qty: quote.qty,
                        },
                        {
                            broadcastBook: false,
                        },
                    );

                    placed += 1;
                } catch (err) {
                    log(
                        `挂单失败 ` +
                        `${quote.side} ` +
                        `${quote.price}: ` +
                        `${(err as Error).message}`,
                    );
                }
            }

            /**
             * 8. 所有修改完成后只广播一次。
             */
            if (
                plan.cancel.length > 0 ||
                placed > 0
            ) {
                deps.broadcastBook();
            }

            ticks += 1;

            if (failures > 0) {
                log(
                    "Binance 行情恢复，继续做市",
                );
            }

            failures = 0;

            /**
             * 定期输出做市状态。
             */
            if (
                ticks === 1 ||
                ticks % 30 === 0
            ) {
                const orders =
                    deps.ordersOf(mm);

                const buys =
                    orders.filter(
                        (o) =>
                            o.side === "buy",
                    );

                const sells =
                    orders.filter(
                        (o) =>
                            o.side === "sell",
                    );

                log(
                    `tick#${ticks} ` +
                    `买 ${buys.length}/${cfg.levels} 档 ` +
                    `卖 ${sells.length}/${cfg.levels} 档 ` +
                    `撤 ${plan.cancel.length} ` +
                    `挂 ${placed}`,
                );

                for (const order of buys) {
                    log(
                        `  BUY  ${order.price} ` +
                        `qty=${order.remaining}`,
                    );
                }

                for (const order of sells) {
                    log(
                        `  SELL ${order.price} ` +
                        `qty=${order.remaining}`,
                    );
                }
            }
        } catch (err) {
            failures += 1;

            if (
                failures === 1 ||
                failures % 30 === 0
            ) {
                log(
                    `拉取 Binance 深度失败 ` +
                    `（连续 ${failures} 次）：` +
                    `${(err as Error).message}`,
                );
            }
        } finally {
            running = false;
        }
    }

    log(
        `启动：账户 ${mm}，` +
        `镜像 Binance ${cfg.symbol} ` +
        `前 ${cfg.levels} 档 × ${cfg.scale}，` +
        `每 ${cfg.intervalMs}ms 刷新`,
    );

    /**
     * 立即执行第一次。
     */
    void tick();

    /**
     * 周期刷新。
     */
    const timer =
        setInterval(
            () => void tick(),
            cfg.intervalMs,
        );

    /**
     * 停止做市。
     */
    return () => {
        clearInterval(timer);

        log("做市机器人已停止");
    };
}