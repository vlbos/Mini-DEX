

import { beforeEach, describe, expect, it } from "vitest";

import db from "../src/db/database.js";
import { MatchingService } from "../src/matchingService.js";
import { Ledger } from "../src/ledger.js";
import { parseFixed } from "../src/fixed.js";

const USDC = (n: string) => parseFixed(n);
const WAVAX = (n: string) => parseFixed(n);

describe("MatchingService IOC/FOK funds", () => {
    let ledger: Ledger;
    let service: MatchingService;

    beforeEach(() => {
        // 每个 TIF 测试使用干净的 SQLite 状态。
        // 必须在 new MatchingService() 之前执行，
        // 因为 MatchingService constructor 会 restoreOrders()。
        db.exec(`
            DELETE FROM orders;
            DELETE FROM balances;
        `);

        ledger = new Ledger();
        service = new MatchingService(ledger);
    });

    function credit(
        owner: string,
        asset: "USDC" | "WAVAX",
        amount: bigint,
    ) {
        ledger.credit(owner, asset, amount);
    }




    describe("IOC", () => {
        it("IOC 买单部分成交后，剩余 USDC 应解锁", () => {
            const seller = "0xioc-buy-seller-1";
            const buyer = "0xioc-buy-buyer-1";

            // Seller 挂 10 WAVAX @ 100 USDC
            credit(
                seller,
                "WAVAX",
                WAVAX("10"),
            );

            service.placeOrder({
                id: "sell-ioc-buy-1",
                owner: seller,
                side: "sell",
                type: "limit",
                price: USDC("100"),
                qty: WAVAX("10"),
            });

            // Buyer IOC 买 20，只能成交 10
            credit(
                buyer,
                "USDC",
                USDC("2000"),
            );

            const result = service.placeOrder({
                id: "ioc-buy-1",
                owner: buyer,
                side: "buy",
                type: "limit",
                price: USDC("100"),
                qty: WAVAX("20"),
                timeInForce: "IOC",
            });

            expect(result.fills).toHaveLength(1);

            expect(result.fills[0].qty).toBe(
                WAVAX("10"),
            );

            // IOC 剩余 10 不应该进入订单簿
            expect(
                service.getOrder("ioc-buy-1"),
            ).toBeUndefined();

            expect(
                service.ordersOf(buyer),
            ).toHaveLength(0);

            const buyerBalance =
                ledger.get(buyer);

            // 初始冻结 2000
            // 成交使用 1000
            // 剩余 1000 解锁
            expect(
                buyerBalance.USDC.available,
            ).toBe(USDC("1000"));

            expect(
                buyerBalance.USDC.locked,
            ).toBe(0n);

            // Buyer 获得 10 WAVAX
            expect(
                buyerBalance.WAVAX.available,
            ).toBe(WAVAX("10"));
        });

        it("IOC 卖单部分成交后，剩余 WAVAX 应解锁", () => {
            const buyer = "0xioc-sell-buyer-1";
            const seller = "0xioc-sell-seller-1";

            // Buyer 挂 10 WAVAX @ 100 USDC
            credit(
                buyer,
                "USDC",
                USDC("1000"),
            );

            service.placeOrder({
                id: "buy-ioc-sell-1",
                owner: buyer,
                side: "buy",
                type: "limit",
                price: USDC("100"),
                qty: WAVAX("10"),
            });

            // Seller IOC 卖 20，只能成交 10
            credit(
                seller,
                "WAVAX",
                WAVAX("20"),
            );

            const result = service.placeOrder({
                id: "ioc-sell-1",
                owner: seller,
                side: "sell",
                type: "limit",
                price: USDC("100"),
                qty: WAVAX("20"),
                timeInForce: "IOC",
            });

            expect(result.fills).toHaveLength(1);

            expect(result.fills[0].qty).toBe(
                WAVAX("10"),
            );

            // IOC 剩余 10 不应该进入订单簿
            expect(
                service.getOrder("ioc-sell-1"),
            ).toBeUndefined();

            expect(
                service.ordersOf(seller),
            ).toHaveLength(0);

            const sellerBalance =
                ledger.get(seller);

            // 初始冻结 20 WAVAX
            // 成交 10
            // 剩余 10 解锁
            expect(
                sellerBalance.WAVAX.available,
            ).toBe(WAVAX("10"));

            expect(
                sellerBalance.WAVAX.locked,
            ).toBe(0n);

            // Seller 收到 1000 USDC
            expect(
                sellerBalance.USDC.available,
            ).toBe(USDC("1000"));
        });

        it("IOC 完全不成交时，应全额解锁资金", () => {
            const buyer = "0xioc-no-fill-buyer-1";

            // 盘口没有卖单
            credit(
                buyer,
                "USDC",
                USDC("1000"),
            );

            const result = service.placeOrder({
                id: "ioc-no-fill-1",
                owner: buyer,
                side: "buy",
                type: "limit",
                price: USDC("100"),
                qty: WAVAX("10"),
                timeInForce: "IOC",
            });

            expect(result.fills).toHaveLength(0);

            // IOC 不留订单
            expect(
                service.getOrder("ioc-no-fill-1"),
            ).toBeUndefined();

            expect(
                service.ordersOf(buyer),
            ).toHaveLength(0);

            const balance =
                ledger.get(buyer);

            // 全部 1000 USDC 解锁
            expect(
                balance.USDC.available,
            ).toBe(USDC("1000"));

            expect(
                balance.USDC.locked,
            ).toBe(0n);
        });
    });

    describe("FOK", () => {
        it("FOK 流动性不足时，不应成交，并全额解锁资金", () => {
            const seller = "0xfok-seller-1";
            const buyer = "0xfok-buyer-1";

            // 盘口只有 5 WAVAX
            credit(
                seller,
                "WAVAX",
                WAVAX("5"),
            );

            service.placeOrder({
                id: "sell-fok-source-1",
                owner: seller,
                side: "sell",
                type: "limit",
                price: USDC("100"),
                qty: WAVAX("5"),
            });

            // Buyer FOK 要求一次买 10 WAVAX
            credit(
                buyer,
                "USDC",
                USDC("1000"),
            );

            const result = service.placeOrder({
                id: "fok-buy-1",
                owner: buyer,
                side: "buy",
                type: "limit",
                price: USDC("100"),
                qty: WAVAX("10"),
                timeInForce: "FOK",
            });

            /*
             * FOK 必须全部成交。
             *
             * 当前只有 5 WAVAX，
             * 因此：
             *
             * fills = 0
             * 不产生 resting order
             * 1000 USDC 全部解锁
             */
            expect(result.fills).toHaveLength(0);

            expect(
                service.getOrder("fok-buy-1"),
            ).toBeUndefined();

            expect(
                service.ordersOf(buyer),
            ).toHaveLength(0);

            const buyerBalance =
                ledger.get(buyer);

            expect(
                buyerBalance.USDC.available,
            ).toBe(USDC("1000"));

            expect(
                buyerBalance.USDC.locked,
            ).toBe(0n);

            expect(
                buyerBalance.WAVAX.available,
            ).toBe(0n);

            /*
             * 最重要的一点：
             * FOK 失败不能消耗卖方的 5 WAVAX。
             */
            const sellerBalance =
                ledger.get(seller);

            expect(
                sellerBalance.WAVAX.available,
            ).toBe(WAVAX("0"));

            expect(
                sellerBalance.WAVAX.locked,
            ).toBe(WAVAX("5"));
        });

        it("FOK 流动性足够时，应全部成交并释放全部剩余冻结资金", () => {
            const seller = "0xfok-full-seller-1";
            const buyer = "0xfok-full-buyer-1";

            // 卖方提供足够的 WAVAX
            credit(seller, "WAVAX", WAVAX("10"));

            service.placeOrder({
                id: "sell-fok-full-1",
                owner: seller,
                side: "sell",
                type: "limit",
                price: USDC("100"),
                qty: WAVAX("10"),
            });

            // 买方刚好有足够的 USDC
            credit(buyer, "USDC", USDC("1000"));

            const result = service.placeOrder({
                id: "fok-buy-full-1",
                owner: buyer,
                side: "buy",
                type: "limit",
                price: USDC("100"),
                qty: WAVAX("10"),
                timeInForce: "FOK",
            });

            // FOK 必须全部成交
            expect(result.fills).toHaveLength(1);
            expect(result.fills[0].qty).toBe(WAVAX("10"));
            expect(result.fills[0].price).toBe(USDC("100"));

            // 不允许留下 resting order
            expect(service.getOrder("fok-buy-full-1")).toBeUndefined();
            expect(service.ordersOf(buyer)).toHaveLength(0);

            // 买方：
            // 1000 USDC 全部用于成交，locked 必须归零
            // 收到 10 WAVAX
            const buyerBalance = ledger.get(buyer);

            expect(buyerBalance.USDC.available).toBe(USDC("0"));
            expect(buyerBalance.USDC.locked).toBe(0n);
            expect(buyerBalance.WAVAX.available).toBe(WAVAX("10"));
            expect(buyerBalance.WAVAX.locked).toBe(0n);

            // 卖方：
            // 10 WAVAX 全部成交，locked 必须归零
            // 收到 1000 USDC
            const sellerBalance = ledger.get(seller);

            expect(sellerBalance.WAVAX.available).toBe(WAVAX("0"));
            expect(sellerBalance.WAVAX.locked).toBe(0n);
            expect(sellerBalance.USDC.available).toBe(USDC("1000"));
            expect(sellerBalance.USDC.locked).toBe(0n);
        });


    });
});

