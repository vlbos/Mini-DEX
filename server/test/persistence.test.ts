import { describe, expect, it } from "vitest";

import { Ledger } from "../src/ledger.js";
import { MatchingService } from "../src/matchingService.js";

const ALICE =
    "0xAbCdEf0000000000000000000000000000000001";

describe("SQLite persistence", () => {
    it("persists ledger balance", () => {
        const ledger = new Ledger();

        ledger.credit(
            ALICE,
            "USDC",
            1000n,
        );

        ledger.lock(
            ALICE,
            "USDC",
            300n,
        );

        const ledgerAfterRestart =
            new Ledger();

        const balance =
            ledgerAfterRestart.get(ALICE).USDC;

        expect(balance.available).toBe(700n);
        expect(balance.locked).toBe(300n);
    });
});

describe("order persistence", () => {
    it("restores open order after restart", () => {
        const ledger1 = new Ledger();

        const service1 =
            new MatchingService(ledger1);

        const owner =
            "0x1111111111111111111111111111111111111111";

        // 买单需要 USDC 作为锁定资金
        ledger1.credit(
            owner,
            "USDC",
            100000000n,
        );

        service1.placeOrder({
            id: "order-1",
            owner,
            side: "buy",
            type: "limit",
            price: 100000000n,
            qty: 100000000n,
        });

        // 模拟 server restart
        const ledger2 =
            new Ledger();

        const service2 =
            new MatchingService(ledger2);

        const order =
            service2.getOrder("order-1");

        expect(order).toBeDefined();
        expect(order?.remaining).toBe(100000000n);
    });

    it("persists remaining quantity after partial fill", () => {
        const ledger =
            new Ledger();

        const service =
            new MatchingService(ledger);

        const seller =
            "0x2222222222222222222222222222222222222222";

        const buyer =
            "0x3333333333333333333333333333333333333333";

        ledger.credit(
            seller,
            "WAVAX",
            100000000n,
        );

        ledger.credit(
            buyer,
            "USDC",
            100000000000n,
        );

        service.placeOrder({
            id: "sell-1",
            owner: seller,
            side: "sell",
            type: "limit",
            price: 3000000000n,
            qty: 100000000n,
        });

        service.placeOrder({
            id: "buy-1",
            owner: buyer,
            side: "buy",
            type: "limit",
            price: 3000000000n,
            qty: 40000000n,
        });

        const remaining =
            service.getOrder("sell-1");

        expect(
            remaining?.remaining,
        ).toBe(60000000n);
    });
});