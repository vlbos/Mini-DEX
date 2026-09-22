import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.resolve(__dirname, "../../data");

fs.mkdirSync(dataDir, { recursive: true });

const dbFile =
    process.env.NODE_ENV === "test"
        ? "minidex.test.sqlite"
        : "minidex.sqlite";

const dbPath = path.join(dataDir, dbFile);

const db = new Database(dbPath);

// SQLite WAL：适合服务端读写
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS balances (
    owner TEXT NOT NULL,
    asset TEXT NOT NULL,
    available TEXT NOT NULL DEFAULT '0',
    locked TEXT NOT NULL DEFAULT '0',

    PRIMARY KEY (owner, asset)
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    side TEXT NOT NULL,
    type TEXT NOT NULL,

    price TEXT NOT NULL,
    qty TEXT NOT NULL,
    remaining TEXT NOT NULL,

    ts INTEGER NOT NULL,
    seq INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_owner
ON orders(owner);

CREATE INDEX IF NOT EXISTS idx_orders_remaining
ON orders(remaining);

CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,

    taker_order_id TEXT NOT NULL,
    maker_order_id TEXT NOT NULL,

    taker TEXT NOT NULL,
    maker TEXT NOT NULL,

    price TEXT NOT NULL,
    qty TEXT NOT NULL,

    side TEXT NOT NULL,
    ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_ts
ON trades(ts);

CREATE INDEX IF NOT EXISTS idx_trades_taker
ON trades(taker);

CREATE INDEX IF NOT EXISTS idx_trades_maker
ON trades(maker);
`);

export default db;

export function closeDatabase(): void {
    db.close();
}