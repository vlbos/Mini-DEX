// 入口：读 env -> 组装 账本/引擎/登录/链/WS/路由 -> 监听 8787。
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { Hex } from "viem";
import { MatchingService } from "./matchingService.js";
import { Ledger } from "./ledger.js";
import { createAuth } from "./auth.js";
import { createChain } from "./chain.js";
import { createWs } from "./ws.js";
import { createRoutes } from "./routes.js";
import { startMarketMaker,type MarketMakerConfig, } from "./marketmaker.js";
import { parseFixed } from "./fixed.js";

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const CHAIN_ID = Number(env.CHAIN_ID ?? 31337);
const JWT_SECRET = env.JWT_SECRET ?? "dev-secret-change-me";
// 做市（可选）：MARKET_MAKER=1 开启，把 Binance 盘口镜像到本所订单簿
const MM_ENABLED = ["1", "true", "on"].includes((env.MARKET_MAKER ?? "").toLowerCase());
const MM: MarketMakerConfig = {
    address:
        env.MM_ADDRESS ??
        "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",

    // Binance 交易对
    symbol:
        env.MM_SYMBOL ??
        "AVAXUSDT",

    // ★ 作业要求：买 3 档 + 卖 3 档
    levels:
        Number(env.MM_LEVELS ?? 3),

    // Binance 数量缩放
    scale:
        Number(env.MM_SCALE ?? 0.05),

    // 每 2 秒刷新
    intervalMs:
        Number(env.MM_INTERVAL_MS ?? 2000),

    // 单档最小数量
    minQty:
        Number(env.MM_MIN_QTY ?? 0.1),

    // 单档最大数量
    maxQty:
        Number(env.MM_MAX_QTY ?? 200),
};

const config = {
    chainId: CHAIN_ID,
    wsUrl: `ws://localhost:${PORT}/ws`,
    vault: env.VAULT_ADDRESS ?? "",
    usdc: env.USDC_ADDRESS ?? "",
    wavax: env.WAVAX_ADDRESS ?? "",
    marketMaker: MM_ENABLED ? { address: MM.address.toLowerCase(), symbol: MM.symbol, source: "binance" } : null,
};

const ledger = new Ledger();

const matching =
    new MatchingService(ledger);


const book = matching.book;
const auth = createAuth({ chainId: CHAIN_ID, jwtSecret: JWT_SECRET });
const chain = createChain({
    chainId: CHAIN_ID,
    rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8545",
    vault: config.vault, usdc: config.usdc, wavax: config.wavax,
    signerKey: (env.BACKEND_SIGNER_PRIVATE_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex,
});

const app = new Hono();
app.use("*", cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }));
app.get("/", (c) => c.json({ ok: true, name: "mini-dex", mode: chain.offline ? "offline" : "chain" }));
app.route("/", auth.router);

// routes 需要 ws，ws 需要 http server，所以先占个位，server 起来后再填
let hub: ReturnType<typeof createWs> | null = null;
const routes = createRoutes({
    ledger,
    matching,
    chain,
    bearer: auth.bearer,
    config,
    ws: {
        broadcast: (t, d) =>
            hub?.broadcast(t, d),
        sendBalance: (a, d) =>
            hub?.sendBalance(a, d),
        sendOrder: (a, t, d) =>
            hub?.sendOrder(a, t, d),
    },
});
app.route("/", routes.app);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[server] http://localhost:${info.port}  ws://localhost:${info.port}/ws  chainId=${CHAIN_ID}`);
}) as Server;

hub = createWs({ server, verifyToken: auth.verifyToken, getSnapshot: () => routes.snapshot(10) });
// DEPOSIT_FROM_BLOCK 有值时，启动先从该区块回放 Deposit/Withdraw 重建余额（内存账本重启即丢）
const fromBlock = env.DEPOSIT_FROM_BLOCK ? BigInt(env.DEPOSIT_FROM_BLOCK) : undefined;
chain.watchDeposits(routes.onDeposit, { fromBlock, onWithdraw: routes.onWithdrawBackfill });

if (MM_ENABLED) {
    /**
     * 做市账户初始化资金。
     *
     * 仅用于教学/离线做市。
     *
     * BUY 需要 USDC
     * SELL 需要 WAVAX
     */
    const seedUsdc =
        env.MM_SEED_USDC ?? "100000";

    const seedWavax =
        env.MM_SEED_WAVAX ?? "10000";

    /**
     * 只有做市账户当前没有余额时才进行虚拟注资。
     *
     * 避免 server 重启后重复增加余额。
     */
    const mmBalance =
        ledger.get(MM.address);

    const hasMmBalance =
        mmBalance.USDC.available !== 0n ||
        mmBalance.USDC.locked !== 0n ||
        mmBalance.WAVAX.available !== 0n ||
        mmBalance.WAVAX.locked !== 0n;

    if (!hasMmBalance) {
        if (Number(seedUsdc) > 0) {
            ledger.credit(
                MM.address,
                "USDC",
                parseFixed(seedUsdc),
            );
        }

        if (Number(seedWavax) > 0) {
            ledger.credit(
                MM.address,
                "WAVAX",
                parseFixed(seedWavax),
            );
        }

        console.log(
            `[mm] seed balance: ` +
            `USDC=${seedUsdc}, ` +
            `WAVAX=${seedWavax}`,
        );
    }

    /**
     * 启动做市机器人。
     *
     * levels=3：
     *
     * BUY:
     *   Binance bid 1
     *   Binance bid 2
     *   Binance bid 3
     *
     * SELL:
     *   Binance ask 1
     *   Binance ask 2
     *   Binance ask 3
     *
     * 总共 6 档。
     */
    console.log(
        `[mm] starting market maker: ` +
        `${MM.symbol}, ` +
        `levels=${MM.levels}, ` +
        `interval=${MM.intervalMs}ms`,
    );

    startMarketMaker(MM, {
        ledger,

        ordersOf:
            routes.ordersOf,

        placeOrder:
            routes.placeOrder,

        cancelOrder:
            routes.cancelOrder,

        broadcastBook:
            routes.broadcastBook,

        log:
            (message) =>
                console.log(message),
    });
}
