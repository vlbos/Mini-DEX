// 内存账本：每个地址两种资产（USDC / WAVAX），各有 available（可用）和 locked（下单冻结）。
// 重启即丢，生产要落库（Primit 用 TimescaleDB）。
// 教训来自 Primit：地址一律小写存取，否则同一个钱包大小写不同会变成"两个用户"。
import { formatFixed as f } from "./fixed.js";
import {
    loadBalances,
    saveBalance,
    saveTwoBalances,
} from "./db/ledgerRepository.js";

export type Asset = "USDC" | "WAVAX";

export const ASSETS: Asset[] = [
    "USDC",
    "WAVAX",
];

export interface AssetBalance {
    available: bigint;
    locked: bigint;
}

export type Balances = Record<Asset, AssetBalance>;

export class Ledger {
    /**
     * SQLite 是持久化数据源。
     * Map 只是运行时 cache。
     */
    private accounts = new Map<string, Balances>();

    /** 取账户，不存在则从 SQLite 恢复 */
    get(address: string): Balances {
        const key = norm(address);

        let b = this.accounts.get(key);

        if (!b) {
            b = loadBalances(key);
            this.accounts.set(key, b);
        }

        return b;
    }

    /** 入金 */
    credit(
        address: string,
        asset: Asset,
        amount: bigint,
    ): void {
        assertPositive(amount);

        const b = this.get(address);

        b[asset].available += amount;

        saveBalance(
            address,
            asset,
            b[asset],
        );
    }

    /** 出金 */
    debit(
        address: string,
        asset: Asset,
        amount: bigint,
    ): void {
        assertPositive(amount);

        const b = this.get(address)[asset];

        if (b.available < amount) {
            throw new Error(
                `余额不足: ${asset} 可用 ${f(b.available)} < 需要 ${f(amount)}`
            );
        }

        b.available -= amount;

        saveBalance(
            address,
            asset,
            b,
        );
    }

    /** available -> locked */
    lock(
        address: string,
        asset: Asset,
        amount: bigint,
    ): void {
        if (amount === 0n) return;

        assertPositive(amount);

        const b = this.get(address)[asset];

        if (b.available < amount) {
            throw new Error(
                `余额不足: ${asset} 可用 ${f(b.available)} < 需要 ${f(amount)}`
            );
        }

        b.available -= amount;
        b.locked += amount;

        saveBalance(
            address,
            asset,
            b,
        );
    }

    /** locked -> available */
    unlock(
        address: string,
        asset: Asset,
        amount: bigint,
    ): void {
        if (amount === 0n) return;

        assertPositive(amount);

        const b = this.get(address)[asset];

        if (b.locked < amount) {
            throw new Error(
                `冻结不足: ${asset} locked ${f(b.locked)} < ${f(amount)}`
            );
        }

        b.locked -= amount;
        b.available += amount;

        saveBalance(
            address,
            asset,
            b,
        );
    }

    /**
     * 成交：
     *
     * from.locked -> 0
     * to.available -> +
     *
     * 两边必须在一个 SQLite transaction 中完成。
     */
    transferLocked(
        from: string,
        to: string,
        asset: Asset,
        amount: bigint,
    ): void {
        if (amount === 0n) return;

        assertPositive(amount);

        const src = this.get(from)[asset];

        if (src.locked < amount) {
            throw new Error(
                `冻结不足: ${asset} locked ${f(src.locked)} < ${f(amount)}`
            );
        }

        const dst = this.get(to)[asset];

        src.locked -= amount;
        dst.available += amount;

        saveTwoBalances(
            from,
            src,
            to,
            dst,
            asset,
        );
    }
hasAccount(address: string): boolean {
    const key = norm(address);

    if (this.accounts.has(key)) {
        return true;
    }

    const balances = loadBalances(key);

    const exists =
        balances.USDC.available !== 0n ||
        balances.USDC.locked !== 0n ||
        balances.WAVAX.available !== 0n ||
        balances.WAVAX.locked !== 0n;

    if (exists) {
        this.accounts.set(key, balances);
    }

    return exists;
}
}

export function norm(address: string): string {
    return address.toLowerCase();
}

function assertPositive(amount: bigint): void {
    if (amount <= 0n) {
        throw new Error(
            `金额必须 > 0: ${f(amount)}`
        );
    }
}