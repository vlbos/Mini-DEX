import db from "./database.js";
import type { Asset, AssetBalance, Balances } from "../ledger.js";

type BalanceRow = {
    owner: string;
    asset: Asset;
    available: string;
    locked: string;
};

function emptyBalances(): Balances {
    return {
        USDC: {
            available: 0n,
            locked: 0n,
        },
        WAVAX: {
            available: 0n,
            locked: 0n,
        },
    };
}

export function loadBalances(owner: string): Balances {
    const key = owner.toLowerCase();

    const rows = db
        .prepare(`
            SELECT owner, asset, available, locked
            FROM balances
            WHERE owner = ?
        `)
        .all(key) as BalanceRow[];

    const balances = emptyBalances();

    for (const row of rows) {
        balances[row.asset] = {
            available: BigInt(row.available),
            locked: BigInt(row.locked),
        };
    }

    return balances;
}

const upsertBalanceStmt = db.prepare(`
    INSERT INTO balances (
        owner,
        asset,
        available,
        locked
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(owner, asset)
    DO UPDATE SET
        available = excluded.available,
        locked = excluded.locked
`);

export function saveBalance(
    owner: string,
    asset: Asset,
    balance: AssetBalance,
): void {
    upsertBalanceStmt.run(
        owner.toLowerCase(),
        asset,
        balance.available.toString(),
        balance.locked.toString(),
    );
}

/**
 * 两个账户同时更新。
 * 用 SQLite transaction 避免 from 成功、to 失败导致数据不一致。
 */
export const saveTwoBalances = db.transaction(
    (
        from: string,
        fromAsset: AssetBalance,
        to: string,
        toAsset: AssetBalance,
        asset: Asset,
    ) => {
        upsertBalanceStmt.run(
            from.toLowerCase(),
            asset,
            fromAsset.available.toString(),
            fromAsset.locked.toString(),
        );

        upsertBalanceStmt.run(
            to.toLowerCase(),
            asset,
            toAsset.available.toString(),
            toAsset.locked.toString(),
        );
    },
);