import db from "./database.js";
import type { Order } from "../engine/orderbook.js";

type OrderRow = {
    id: string;
    owner: string;
    side: "buy" | "sell";
    type: "limit" | "market";
    price: string;
    qty: string;
    remaining: string;
    ts: number;
    seq: number;
};

const saveOrderStmt = db.prepare(`
    INSERT INTO orders (
        id,
        owner,
        side,
        type,
        price,
        qty,
        remaining,
        ts,
        seq
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id)
    DO UPDATE SET
        owner = excluded.owner,
        side = excluded.side,
        type = excluded.type,
        price = excluded.price,
        qty = excluded.qty,
        remaining = excluded.remaining,
        ts = excluded.ts,
        seq = excluded.seq
`);

export function saveOrder(order: Order): void {
    saveOrderStmt.run(
        order.id,
        order.owner.toLowerCase(),
        order.side,
        order.type,
        order.price.toString(),
        order.qty.toString(),
        order.remaining.toString(),
        order.ts,
        order.seq,
    );
}

export function deleteOrder(id: string): void {
    db.prepare(`
        DELETE FROM orders
        WHERE id = ?
    `).run(id);
}

export function loadOpenOrders(): Order[] {
    const rows = db
        .prepare(`
            SELECT
                id,
                owner,
                side,
                type,
                price,
                qty,
                remaining,
                ts,
                seq
            FROM orders
            WHERE remaining != '0'
            ORDER BY seq ASC
        `)
        .all() as OrderRow[];

    return rows.map((row) => ({
        id: row.id,
        owner: row.owner,
        side: row.side,
        type: row.type,

        price: BigInt(row.price),
        qty: BigInt(row.qty),
        remaining: BigInt(row.remaining),

        ts: row.ts,
        seq: row.seq,
    }));
}