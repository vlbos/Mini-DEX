import db from "./database.js";
import type { Fill } from "../engine/orderbook.js";

export function saveTrade(fill: Fill): void {
    const id =
        `${fill.takerOrderId}:` +
        `${fill.makerOrderId}:` +
        `${fill.ts}:` +
        `${fill.qty.toString()}`;

    db.prepare(`
        INSERT OR IGNORE INTO trades (
            id,
            taker_order_id,
            maker_order_id,
            taker,
            maker,
            price,
            qty,
            side,
            ts
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        fill.takerOrderId,
        fill.makerOrderId,
        fill.taker.toLowerCase(),
        fill.maker.toLowerCase(),
        fill.price.toString(),
        fill.qty.toString(),
        fill.side,
        fill.ts,
    );
}