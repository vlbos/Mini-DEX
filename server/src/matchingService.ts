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

export interface PlaceInput {
  id: string;
  owner: string;
  side: Side;
  type: OrderType;
  price: bigint;
  qty: bigint;
  ts?: number;
}

export class MatchingService {
  readonly book: OrderBook;

  constructor(
    private readonly ledger: Ledger,
  ) {
    this.book = new OrderBook();

    this.restoreOrders();
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
   * 下单：
   *
   * 1. 冻结
   * 2. 撮合
   * 3. 成交结算
   * 4. 更新 SQLite
   * 5. 处理剩余冻结
   */
  placeOrder(
    input: PlaceInput,
  ) {
    const owner =
      input.owner.toLowerCase();

    const lockAsset =
      input.side === "buy"
        ? "USDC"
        : "WAVAX";

    let lockAmount: bigint;

    /**
     * sell：
     * WAVAX qty
     */
    if (input.side === "sell") {
      lockAmount = input.qty;
    }

    /**
     * limit buy：
     * price * qty
     */
    else if (input.type === "limit") {
      lockAmount =
        mulFixed(
          input.price,
          input.qty,
        );
    }

    /**
     * market buy：
     * 先冻结全部 USDC available。
     */
    else {
      const available =
        this.ledger.get(owner)
          .USDC.available;

      const estimated =
        this.estimateBuyCost(
          input.qty,
        );

      if (estimated > available) {
        throw new Error(
          "余额不足: USDC 不够买这么多",
        );
      }

      lockAmount = available;
    }

    /**
     * 1. 冻结
     */
    this.ledger.lock(
      owner,
      lockAsset,
      lockAmount,
    );

    let result;

    try {
      /**
       * 2. 撮合
       */
      result =
        this.book.submit({
          id: input.id,
          owner,
          side: input.side,
          type: input.type,
          price: input.price,
          qty: input.qty,
          ts: input.ts,
        });
    } catch (err) {
      /**
       * 撮合异常：
       * 恢复冻结。
       */
      this.ledger.unlock(
        owner,
        lockAsset,
        lockAmount,
      );

      throw err;
    }

    /**
     * 3. 每笔成交：
     *
     * SQLite trades
     * +
     * maker order remaining
     * +
     * ledger settlement
     */
    for (const fill of result.fills) {
      this.settleFill(fill);

      saveTrade(fill);

      this.persistMakerAfterFill(fill);
    }

    /**
     * 4. taker 剩余订单。
     */
    if (result.resting) {
      saveOrder(result.resting);

      /**
       * limit buy：
       * 实际仍需冻结：
       *
       * price * remaining
       *
       * 如果之前成交价格更低，
       * 差价已经在 locked 中，
       * 这里退回。
       */
      if (input.side === "buy") {
        const need =
          input.type === "limit"
            ? mulFixed(
                input.price,
                result.resting.remaining,
              )
            : 0n;

        const refund =
          lockAmount -
          this.lockedConsumedByFills(
            input,
            result.fills,
          ) -
          need;

        /**
         * 对于 limit buy，
         * 更简单可靠的计算方式：
         *
         * 原始冻结 - 成交实际花费 - 剩余挂单所需冻结
         */
        if (refund > 0n) {
          this.ledger.unlock(
            owner,
            "USDC",
            refund,
          );
        }
      }

      /**
       * sell：
       * 成交 qty 后 remaining
       * 自动已经通过 transferLocked
       * 减少 locked。
       */
    }

    /**
     * 5. taker 已经完全成交：
     *
     * 如果没有 resting：
     * 剩余冻结全部退回。
     *
     * 对 limit buy：
     * 原冻结金额 - 实际成交金额。
     *
     * 对 market buy：
     * 全部可用 USDC - 实际成交金额。
     *
     * 对 sell：
     * 如果完全成交，剩余 WAVAX 应该为 0。
     */
    else {
      const consumed =
        input.side === "buy"
          ? result.fills.reduce(
              (sum, f) =>
                sum +
                mulFixed(
                  f.price,
                  f.qty,
                ),
              0n,
            )
          : result.fills.reduce(
              (sum, f) =>
                sum + f.qty,
              0n,
            );

      const refund =
        lockAmount - consumed;

      if (refund > 0n) {
        this.ledger.unlock(
          owner,
          lockAsset,
          refund,
        );
      }
    }

    return result;
  }

  /**
   * 计算 taker 已经因为成交消耗掉的冻结资金。
   */
  private lockedConsumedByFills(
    input: PlaceInput,
    fills: Fill[],
  ): bigint {
    if (input.side === "buy") {
      return fills.reduce(
        (sum, f) =>
          sum +
          mulFixed(
            f.price,
            f.qty,
          ),
        0n,
      );
    }

    return fills.reduce(
      (sum, f) =>
        sum + f.qty,
      0n,
    );
  }

  /**
   * maker 部分成交：
   * 更新 remaining。
   *
   * maker 完全成交：
   * 从 SQLite 删除。
   */
  private persistMakerAfterFill(
    fill: Fill,
  ): void {
    const maker =
      this.book.get(
        fill.makerOrderId,
      );

    if (maker) {
      saveOrder(maker);
    } else {
      deleteOrder(
        fill.makerOrderId,
      );
    }
  }

  /**
   * 成交结算：
   *
   * 买方 USDC locked
   *       ↓
   * 卖方 USDC available
   *
   * 卖方 WAVAX locked
   *       ↓
   * 买方 WAVAX available
   */
  private settleFill(
    fill: Fill,
  ): void {
    const buyer =
      fill.side === "buy"
        ? fill.taker
        : fill.maker;

    const seller =
      fill.side === "buy"
        ? fill.maker
        : fill.taker;

    const quote =
      mulFixed(
        fill.price,
        fill.qty,
      );

    this.ledger.transferLocked(
      buyer,
      seller,
      "USDC",
      quote,
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
        mulFixed(
          order.price,
          order.remaining,
        );

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

    return order;
  }
}