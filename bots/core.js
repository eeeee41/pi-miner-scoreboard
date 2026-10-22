/* =====================================================================
   Pi Miner — investor bots
   ---------------------------------------------------------------------
   Ten bots whose only job is to invest. A scheduled GitHub Actions job
   (.github/workflows/bots.yml → bots/run.mjs) runs them about once an hour
   with Firebase admin access, so they trade even when nobody is online.
   They use the same order books, trades, wallets and shareholdings as
   players, so players trade with them like anyone else.

   Each run, every bot:
     1. cancels the orders it left last time (money and shares come back)
     2. values every company: (treasury + its dividend for `horizon` hours)
        ÷ shares. A company paying no dividend with an empty treasury is
        worth next to nothing to a bot.
     3. buys shares offered below its buy price (from players' sell orders
        or the company's own share offering), and sells into bids above its
        sell price
     4. trades Pi coin around its recent average price
     5. leaves a few resting buy and sell orders for players to trade with

   Bots never trade with each other, and never bid more than 25% above
   what players have recently paid, so they can't invent prices on their own.
   Bots never hold more than 10% of a company and can never take control
   of one (the game and the rules skip bots when handing over control).
   This file runs both in Node (firebase-admin) and in the browser tests.
   ===================================================================== */
(function (root) {
  const START_CASH = 10000000;     // $100,000 each
  const MAX_STAKE = 0.10;          // never more than 10% of a company
  const MAX_FILLS = 9;             // resting orders filled per trade
  const DEPTH = 10;                // order book rows each bot looks at
  const MAX_RESTING = 4;           // orders each bot leaves on the books
  const AVG_TRADES = 20;

  // horizon: hours of dividends a share is worth to them · buyAt / sellAt: multiples of that value
  // perAsset: most of their Cash they'll put into one asset in a run · piBand: how far from Pi's
  // average they buy and sell · piShare: most of their Cash they'll hold in Pi
  const BOTS = [
    { id: "bot-01", name: "Ada (bot)",     horizon: 720,  buyAt: 0.80, sellAt: 1.50, perAsset: 0.10, piBand: 0.12, piShare: 0.10 },
    { id: "bot-02", name: "Bram (bot)",    horizon: 336,  buyAt: 0.90, sellAt: 1.30, perAsset: 0.12, piBand: 0.08, piShare: 0.20 },
    { id: "bot-03", name: "Cleo (bot)",    horizon: 168,  buyAt: 1.00, sellAt: 1.25, perAsset: 0.15, piBand: 0.10, piShare: 0.05 },
    { id: "bot-04", name: "Dex (bot)",     horizon: 1440, buyAt: 0.70, sellAt: 2.00, perAsset: 0.08, piBand: 0.15, piShare: 0.10 },
    { id: "bot-05", name: "Esme (bot)",    horizon: 480,  buyAt: 0.85, sellAt: 1.40, perAsset: 0.10, piBand: 0.05, piShare: 0.30 },
    { id: "bot-06", name: "Finn (bot)",    horizon: 240,  buyAt: 0.95, sellAt: 1.20, perAsset: 0.20, piBand: 0.20, piShare: 0.00 },
    { id: "bot-07", name: "Gia (bot)",     horizon: 960,  buyAt: 0.75, sellAt: 1.60, perAsset: 0.06, piBand: 0.10, piShare: 0.15 },
    { id: "bot-08", name: "Hugo (bot)",    horizon: 120,  buyAt: 1.05, sellAt: 1.15, perAsset: 0.10, piBand: 0.06, piShare: 0.25 },
    { id: "bot-09", name: "Iris (bot)",    horizon: 600,  buyAt: 0.80, sellAt: 1.35, perAsset: 0.12, piBand: 0.09, piShare: 0.10 },
    { id: "bot-10", name: "Jules (bot)",   horizon: 360,  buyAt: 0.90, sellAt: 1.45, perAsset: 0.14, piBand: 0.18, piShare: 0.05 }
  ];
  const isBot = (uid) => typeof uid === "string" && uid.startsWith("bot-");

  async function runBots({ db, FieldValue, log = () => {}, only = null }) {
    const inc = (n) => FieldValue.increment(n);
    const now = () => FieldValue.serverTimestamp();
    const ms = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : 0);
    const userRef = (uid) => db.collection("users").doc(uid);
    const companyRef = (t) => db.collection("companies").doc(t);
    const holderRef = (t, uid) => companyRef(t).collection("holders").doc(uid);
    const book = (asset, side) => db.collection("market").doc(asset).collection(side === "buy" ? "buys" : "sells");
    const tradesCol = (asset) => db.collection("market").doc(asset).collection("trades");
    const asOrder = (s) => ({ ref: s.ref, id: s.id, ...s.data() });
    const isPi = (a) => a === "PI";
    const summary = [];
    const bots = only ? BOTS.filter((b) => only.includes(b.id)) : BOTS;

    /* ---------- wallets ---------- */
    for (const b of bots) {
      const s = await userRef(b.id).get();
      if (!s.exists) {
        await userRef(b.id).set({ displayName: b.name, coins: 0, cash: START_CASH, batches: 0, cashGranted: true,
          createdAt: now(), lastBatchAt: now(), bot: true, openOrders: [] });
        log(`${b.name}: opened a wallet with $${START_CASH / 100}`);
      }
    }

    /* ---------- one trade: same steps as a player's order (fill up to 9 resting orders, rest the remainder) ---------- */
    async function trade(b, asset, side, price, qty, rest) {
      const other = side === "buy" ? "sell" : "buy";
      const crosses = (p) => (side === "buy" ? p <= price : p >= price);
      const better = (a, c) => (side === "buy" ? a.p - c.p : c.p - a.p) || ms(a.createdAt) - ms(c.createdAt);
      const snap = await book(asset, other).orderBy("p", side === "buy" ? "asc" : "desc").limit(DEPTH).get();
      const opposite = snap.docs.map(asOrder).filter((o) => typeof o.p === "number");
      // Bots never trade with each other (that would invent prices nobody paid), and a resting order
      // stops one cent short of any other bot's order on the other side, so the book never crosses
      const botBest = opposite.filter((o) => isBot(o.uid)).map((o) => o.p);
      if (rest && botBest.length) price = side === "buy" ? Math.min(price, Math.min(...botBest) - 1) : Math.max(price, Math.max(...botBest) + 1);
      if (!(price >= 1)) return { filled: 0, value: 0, rest: 0 };
      const candidates = opposite.filter((o) => crosses(o.p) && !isBot(o.uid)).sort(better);
      if (!candidates.length && !rest) return { filled: 0, value: 0, rest: 0 };
      return db.runTransaction(async (tx) => {
        const meSnap = await tx.get(userRef(b.id));
        const heldSnap = isPi(asset) ? meSnap : await tx.get(holderRef(asset, b.id));
        const company = isPi(asset) ? null : await tx.get(companyRef(asset));
        const fresh = [];
        for (const c of candidates) { const s = await tx.get(c.ref); if (s.exists) fresh.push(asOrder(s)); }
        const live = fresh.filter((o) => typeof o.p === "number" && o.remaining > 0 && !isBot(o.uid) && crosses(o.p)).sort(better);
        const fills = [];
        let left = qty;
        for (const o of live) {
          if (!left || fills.length >= MAX_FILLS) break;
          const n = Math.min(left, o.remaining);
          fills.push({ o, n });
          left -= n;
        }
        const filled = qty - left;
        const me = meSnap.data() || {};
        let cash = me.cash || 0;
        let held = isPi(asset) ? me.coins || 0 : (heldSnap.exists && heldSnap.data().shares) || 0;
        const value = fills.reduce((a, f) => a + f.n * f.o.p, 0);
        let restQty = rest && fills.length < MAX_FILLS ? left : 0;
        if (side === "buy") {
          if (value > cash) return { filled: 0, value: 0, rest: 0 };
          restQty = Math.min(restQty, Math.floor((cash - value) / price));
          cash -= value + restQty * price;
          held += filled;
        } else {
          if (filled > held) return { filled: 0, value: 0, rest: 0 };
          restQty = Math.min(restQty, held - filled);
          held -= filled + restQty;
          cash += value;
        }
        if (!filled && !restQty) return { filled: 0, value: 0, rest: 0 };
        const credits = new Map();
        for (const { o, n } of fills) {
          const remaining = o.remaining - n;
          tx.update(o.ref, remaining === 0
            ? { remaining: 0, filled: (o.filled || 0) + n, status: "filled", p: FieldValue.delete() }
            : { remaining, filled: (o.filled || 0) + n });
          const c = credits.get(o.uid) || { cash: 0, qty: 0, name: o.name };
          if (side === "buy") c.cash += n * o.p; else c.qty += n;
          credits.set(o.uid, c);
          const t = tradesCol(asset).doc();
          const buyer = side === "buy" ? b.id : o.uid, seller = side === "buy" ? o.uid : b.id;
          tx.set(t, { asset, price: o.p, qty: n, taker: side, at: now(), block: null, buyer, seller, parties: [buyer, seller],
            buyerName: side === "buy" ? b.name : o.name, sellerName: side === "buy" ? o.name : b.name });
          tx.set(userRef(b.id).collection("history").doc(t.id), { kind: "trade", asset, side, price: o.p, qty: n, with: o.name, at: now() });
          tx.set(userRef(o.uid).collection("history").doc(t.id), { kind: "trade", asset, side: other, price: o.p, qty: n, with: b.name, at: now() });
        }
        for (const [maker, c] of credits) {
          if (isPi(asset)) tx.update(userRef(maker), { cash: inc(c.cash), coins: inc(c.qty) });
          else {
            if (c.cash) tx.update(userRef(maker), { cash: inc(c.cash) });
            if (c.qty) tx.set(holderRef(asset, maker), { uid: maker, name: c.name, shares: inc(c.qty) }, { merge: true });
          }
        }
        let orderPath = null;
        if (restQty > 0) {
          const o = book(asset, side).doc();
          tx.set(o, { uid: b.id, name: b.name, side, price, p: price, qty: filled + restQty, remaining: restQty, filled, status: "open", createdAt: now() });
          orderPath = o.path;
        }
        const wallet = isPi(asset) ? { cash, coins: held } : { cash };
        if (orderPath) wallet.openOrders = FieldValue.arrayUnion(orderPath);
        tx.update(userRef(b.id), wallet);
        if (!isPi(asset)) {
          tx.set(holderRef(asset, b.id), { uid: b.id, name: b.name, shares: held }, { merge: true });
          if (fills.length && company && company.exists) tx.update(companyRef(asset), { lastPrice: fills[fills.length - 1].o.p });
        }
        return { filled, value, rest: restQty };
      });
    }

    async function cancelAll(b) {
      const w = (await userRef(b.id).get()).data() || {};
      for (const path of w.openOrders || []) {
        await db.runTransaction(async (tx) => {
          const ref = db.doc(path);
          const s = await tx.get(ref);
          const meSnap = await tx.get(userRef(b.id));
          const d = s.exists ? s.data() : null;
          const asset = path.split("/")[1];
          const heldSnap = d && !isPi(asset) && d.side === "sell" ? await tx.get(holderRef(asset, b.id)) : null;
          if (!d || d.uid !== b.id || typeof d.p !== "number" || d.remaining <= 0) return;
          const me = meSnap.data() || {};
          tx.update(ref, { status: "cancelled", p: FieldValue.delete() });
          if (d.side === "buy") tx.update(userRef(b.id), { cash: (me.cash || 0) + d.remaining * d.price });
          else if (isPi(asset)) tx.update(userRef(b.id), { coins: (me.coins || 0) + d.remaining });
          else tx.set(holderRef(asset, b.id), { uid: b.id, name: b.name, shares: ((heldSnap && heldSnap.exists && heldSnap.data().shares) || 0) + d.remaining }, { merge: true });
        });
      }
      await userRef(b.id).update({ openOrders: [] });
    }

    async function buyOffering(b, ticker, qty) {
      return db.runTransaction(async (tx) => {
        const c = (await tx.get(companyRef(ticker))).data();
        const w = (await tx.get(userRef(b.id))).data() || {};
        const h = await tx.get(holderRef(ticker, b.id));
        if (!c || !c.offerLeft || !c.offerPrice) return 0;
        const held = (h.exists && h.data().shares) || 0;
        const n = Math.min(qty, c.offerLeft, Math.floor((w.cash || 0) / c.offerPrice), Math.floor(MAX_STAKE * (c.shares + qty)) - held);
        if (n <= 0) return 0;
        const cost = n * c.offerPrice;
        tx.update(companyRef(ticker), { shares: c.shares + n, offerLeft: c.offerLeft - n, treasury: c.treasury + cost });
        tx.update(userRef(b.id), { cash: w.cash - cost });
        tx.set(holderRef(ticker, b.id), { uid: b.id, name: b.name, shares: held + n }, { merge: true });
        tx.set(userRef(b.id).collection("history").doc(), { kind: "offering", asset: ticker, qty: n, price: c.offerPrice, at: now() });
        return n;
      });
    }

    /* ---------- the market as it stands ---------- */
    const companies = (await db.collection("companies").get()).docs.map((d) => d.data()).filter((c) => c && c.shares > 0);
    // Best price a player is offering (bots' own orders don't count: bots don't trade with bots)
    async function top(asset, side) {
      const s = await book(asset, side).orderBy("p", side === "buy" ? "desc" : "asc").limit(DEPTH).get();
      const o = s.docs.map(asOrder).find((x) => typeof x.p === "number" && !isBot(x.uid));
      return o ? o.p : null;
    }
    // What players have actually paid lately (trades between two bots don't count)
    async function playerAvg(asset) {
      const ts = (await tradesCol(asset).orderBy("at", "desc").limit(AVG_TRADES).get()).docs.map((d) => d.data())
        .filter((t) => !(isBot(t.buyer) && isBot(t.seller)));
      const q = ts.reduce((a, t) => a + t.qty, 0);
      return q ? ts.reduce((a, t) => a + t.qty * t.price, 0) / q : null;
    }
    const piAvg = await playerAvg("PI");
    const MAX_CHASE = 1.25;      // never bid more than 25% above what players have recently paid

    /* ---------- each bot ---------- */
    for (const b of bots) {
      const did = [];
      await cancelAll(b);
      const wallet = () => userRef(b.id).get().then((s) => s.data() || {});
      const holding = (t) => holderRef(t, b.id).get().then((s) => (s.exists && s.data().shares) || 0);
      const resting = [];

      for (const c of companies) {
        const fair = (c.treasury + b.horizon * (c.dividendPerHour || 0)) / c.shares;   // cents per share
        const recent = c.tradingClosed ? null : await playerAvg(c.ticker);
        let bid = Math.floor(fair * b.buyAt);
        if (recent) bid = Math.min(bid, Math.floor(recent * MAX_CHASE));
        const ask = Math.max(1, Math.ceil(fair * b.sellAt), recent ? Math.ceil(recent) : 1);
        const cap = Math.floor(MAX_STAKE * c.shares);
        let held = await holding(c.ticker);
        const w = await wallet();
        const budget = Math.floor((w.cash || 0) * b.perAsset);

        // New shares from the company itself
        if (bid >= 1 && c.offerLeft > 0 && c.offerPrice > 0 && c.offerPrice <= bid && held < cap) {
          const n = await buyOffering(b, c.ticker, Math.min(cap - held, Math.floor(budget / c.offerPrice)));
          if (n) { did.push(`bought ${n.toLocaleString()} new ${c.ticker} shares at $${(c.offerPrice / 100).toFixed(2)}`); held += n; }
        }
        if (c.tradingClosed) continue;

        // Players selling cheap / buying dear
        const bestAsk = await top(c.ticker, "sell"), bestBid = await top(c.ticker, "buy");
        if (bid >= 1 && bestAsk != null && bestAsk <= bid && held < cap) {
          const qty = Math.min(cap - held, Math.floor(budget / bid));
          if (qty > 0) {
            const r = await trade(b, c.ticker, "buy", bid, qty, false);
            if (r.filled) { did.push(`bought ${r.filled.toLocaleString()} ${c.ticker} shares`); held += r.filled; }
          }
        }
        if (held > 0 && bestBid != null && bestBid >= ask) {
          const r = await trade(b, c.ticker, "sell", ask, held, false);
          if (r.filled) { did.push(`sold ${r.filled.toLocaleString()} ${c.ticker} shares`); held -= r.filled; }
        }
        // Orders to leave on the book (best value first)
        if (bid >= 1 && held < cap) resting.push({ asset: c.ticker, side: "buy", price: bid, qty: Math.min(cap - held, Math.floor(budget / bid)), score: fair / Math.max(1, bestAsk || bid) });
        // Offer half for sale; the other half stays put earning dividends (shares in a sell order don't)
        if (held > 0) resting.push({ asset: c.ticker, side: "sell", price: ask, qty: Math.ceil(held / 2), score: 1 });
      }

      // Pi coin, around its recent average price
      if (piAvg) {
        const bid = Math.max(1, Math.floor(piAvg * (1 - b.piBand))), ask = Math.max(bid + 1, Math.ceil(piAvg * (1 + b.piBand)));
        const w = await wallet();
        const worth = (w.cash || 0) + (w.coins || 0) * piAvg;
        const room = Math.floor(Math.max(0, worth * b.piShare - (w.coins || 0) * piAvg) / bid);
        const bestAsk = await top("PI", "sell"), bestBid = await top("PI", "buy");
        if (room > 0 && bestAsk != null && bestAsk <= bid) {
          const r = await trade(b, "PI", "buy", bid, room, false);
          if (r.filled) did.push(`bought ${r.filled.toLocaleString()} Pi`);
        }
        const coins = (await wallet()).coins || 0;
        if (coins > 0 && bestBid != null && bestBid >= ask) {
          const r = await trade(b, "PI", "sell", ask, Math.ceil(coins / 2), false);
          if (r.filled) did.push(`sold ${r.filled.toLocaleString()} Pi`);
        }
        const w2 = await wallet();
        const room2 = Math.floor(Math.max(0, ((w2.cash || 0) + (w2.coins || 0) * piAvg) * b.piShare - (w2.coins || 0) * piAvg) / bid);
        if (room2 > 0) resting.push({ asset: "PI", side: "buy", price: bid, qty: room2, score: 0.9 });
        if (w2.coins > 0) resting.push({ asset: "PI", side: "sell", price: ask, qty: Math.ceil(w2.coins / 2), score: 0.9 });
      }

      // Leave a few orders for players to trade with
      resting.sort((x, y) => y.score - x.score);
      let placed = 0;
      for (const o of resting) {
        if (placed >= MAX_RESTING || !(o.qty > 0)) continue;
        const r = await trade(b, o.asset, o.side, o.price, o.qty, true);
        if (r.filled) did.push(`${o.side === "buy" ? "bought" : "sold"} ${r.filled.toLocaleString()} ${o.asset === "PI" ? "Pi" : `${o.asset} shares`}`);
        if (r.rest) { placed++; did.push(`left an order to ${o.side} ${r.rest.toLocaleString()} ${o.asset === "PI" ? "Pi" : o.asset} at $${(o.price / 100).toFixed(2)}`); }
      }
      const w = await wallet();
      summary.push({ bot: b.name, cash: w.cash, coins: w.coins || 0, did });
      log(`${b.name}: ${did.length ? did.join("; ") : "nothing worth doing"} · cash $${((w.cash || 0) / 100).toFixed(2)}, ${w.coins || 0} Pi`);
    }
    return summary;
  }

  const api = { runBots, BOTS, isBot, START_CASH, MAX_STAKE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PiBots = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
