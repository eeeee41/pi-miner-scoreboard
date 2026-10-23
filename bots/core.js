/* =====================================================================
   Pi Miner — investor bots
   ---------------------------------------------------------------------
   Ten bots whose only job is to invest. A scheduled GitHub Actions job
   (.github/workflows/bots.yml → bots/run.mjs) runs them about once an hour
   with Firebase admin access, so they trade even when nobody is online.
   They use the same order books, trades, wallets and shareholdings as
   players, so players trade with them like anyone else.

   How a bot values a share: by the dividends it expects to be paid while
   holding it. Each run the bots note every company's treasury, dividend
   and payout record (public information; they never look inside a
   factory) in botMemory/{TICKER}, and from that history estimate:
     • earnings: how fast the treasury grows, plus what it paid out
     • reliability: how many of its recent payout hours were actually paid
     • runway: how long the treasury can keep paying today's dividend
   A company earning more than it pays will probably raise its dividend (an
   optimistic bot counts on more of that); one paying more than it earns,
   or skipping payouts, will probably cut it. Bots differ in optimism and
   in how many hours of dividends they look ahead, so they disagree, and
   that's why they trade with players and with each other.

   Each run, every bot cancels the orders it left last time, then buys
   shares (from sell orders or company offerings) priced well under its
   valuation, sells into bids well over it, trades Pi around its recent
   price, and leaves a few orders on the books.

   Selling patiently: a bot only lists a tenth of its shares at a time.
   A sell order that sat a whole run without selling a single share comes
   back 7% cheaper next run, but never below what the bot thinks the share
   is worth. Bots don't list shares more than 25% above what players have
   recently paid; if they value a share above that, they keep it for the
   dividends instead.

   Keeping prices sane: every asset has a reference price, what players
   have recently paid (trades between two bots don't count) or, if players
   haven't traded it, the bots' average valuation. Bots only trade with
   each other within 20% below to 25% above it, never bid more than 25%
   above it, and never buy and sell the same asset in one run. So trades
   between bots can't ratchet a price up.

   Bots never hold more than 10% of a company and never run one: control
   only changes when a company's controller hands it over to a player.
   Bots pay the same 1 Pi fee as players for every order and offering
   purchase, so they buy Pi when they run low.
   This file runs both in Node (firebase-admin) and in the browser tests.
   ===================================================================== */
(function (root) {
  const START_CASH = 10000000;     // $100,000 each
  const START_PI = 10;             // starter Pi for transaction fees, like players
  const FEE = 1;                   // Pi per order or offering purchase, paid to the next block's miner
  const FEE_FLOAT = 8;             // a bot below this many Pi buys some, to keep paying fees
  const MAX_STAKE = 0.10;          // never more than 10% of a company
  const MAX_FILLS = 9;             // resting orders filled per trade
  const DEPTH = 10;                // order book rows each bot looks at
  const MAX_RESTING = 4;           // orders each bot leaves on the books
  const AVG_TRADES = 20;
  const LIST_SHARE = 0.1;          // share of its holding a bot lists for sale at once
  const MARKDOWN = 0.93;           // an unsold sell order comes back this much cheaper next run

  const BAND_LO = 0.8, BAND_HI = 1.25;   // bots trade with bots only within this range of the reference price
  const MEMORY = 72;                     // observations kept per company (about 3 days of hourly runs)

  // horizon: hours of future dividends a share is worth to them · optimism: how much of a company's
  // spare earnings (earned but not yet paid out) they expect to come back as higher dividends ·
  // buyAt / sellAt: multiples of their valuation they buy below and sell above · perAsset: most of their
  // Cash put into one asset per run · piBand: how far from Pi's reference price they trade · piShare:
  // most of their wealth they'll keep in Pi
  const BOTS = [
    { id: "bot-01", name: "Ada (bot)",   horizon: 720, optimism: 0.5, buyAt: 0.85, sellAt: 1.30, perAsset: 0.10, piBand: 0.12, piShare: 0.10 },
    { id: "bot-02", name: "Bram (bot)",  horizon: 480, optimism: 0.7, buyAt: 0.90, sellAt: 1.25, perAsset: 0.12, piBand: 0.08, piShare: 0.20 },
    { id: "bot-03", name: "Cleo (bot)",  horizon: 336, optimism: 0.3, buyAt: 0.95, sellAt: 1.20, perAsset: 0.15, piBand: 0.10, piShare: 0.05 },
    { id: "bot-04", name: "Dex (bot)",   horizon: 960, optimism: 0.2, buyAt: 0.80, sellAt: 1.40, perAsset: 0.08, piBand: 0.15, piShare: 0.10 },
    { id: "bot-05", name: "Esme (bot)",  horizon: 600, optimism: 0.9, buyAt: 0.85, sellAt: 1.30, perAsset: 0.10, piBand: 0.05, piShare: 0.30 },
    { id: "bot-06", name: "Finn (bot)",  horizon: 240, optimism: 0.4, buyAt: 0.95, sellAt: 1.15, perAsset: 0.20, piBand: 0.20, piShare: 0.00 },
    { id: "bot-07", name: "Gia (bot)",   horizon: 840, optimism: 0.6, buyAt: 0.80, sellAt: 1.35, perAsset: 0.06, piBand: 0.10, piShare: 0.15 },
    { id: "bot-08", name: "Hugo (bot)",  horizon: 168, optimism: 0.1, buyAt: 1.00, sellAt: 1.10, perAsset: 0.10, piBand: 0.06, piShare: 0.25 },
    { id: "bot-09", name: "Iris (bot)",  horizon: 540, optimism: 0.8, buyAt: 0.85, sellAt: 1.30, perAsset: 0.12, piBand: 0.09, piShare: 0.10 },
    { id: "bot-10", name: "Jules (bot)", horizon: 400, optimism: 0.5, buyAt: 0.90, sellAt: 1.35, perAsset: 0.14, piBand: 0.18, piShare: 0.05 }
  ];
  const isBot = (uid) => typeof uid === "string" && uid.startsWith("bot-");

  /* ---------- predicting a company ----------
     From the bots' notes on a company (oldest first) and the company as it is now, estimate its
     dividend, how reliably it's paid, what it earns per hour and how long its treasury lasts. */
  function forecast(c, notes, now = Date.now()) {
    const HOUR = 3600000, div = c.dividendPerHour || 0;
    const past = (notes || []).filter((n) => n.at < now - 30 * 60000);
    // Reliability: share of recent payout hours that were actually paid
    const lp = c.lastPayout;
    const paid = past.reduce((a, n) => a + (n.paidHours || 0), 0) + (lp ? lp.paidHours : 0);
    const due = past.reduce((a, n) => a + (n.hours || 0), 0) + (lp ? lp.hours : 0);
    const reliable = due ? paid / due : c.treasury >= div * 24 ? 0.9 : 0.5;
    // Earnings per hour: treasury growth plus what it paid out over the same stretch
    let earn = null;
    if (past.length) {
      const first = past[0], hours = Math.max(1, (now - first.at) / HOUR);
      const paidOut = past.slice(1).reduce((a, n) => a + (n.paidCash || 0), 0);
      earn = (c.treasury - first.treasury + paidOut) / hours;
    }
    // Runway: hours today's treasury pays today's dividend without new earnings
    const runway = div ? c.treasury / div : Infinity;
    return { div, reliable: Math.max(0, Math.min(1, reliable)), earn, runway };
  }
  // What one share is worth to a bot: the dividends it expects over its horizon, per share (cents)
  function shareValue(b, c, f) {
    const H = b.horizon;
    let total;
    if (f.earn == null) {
      // No history yet: today's dividend, for as long as the treasury can fund it
      total = f.div * Math.min(H, f.runway);
    } else if (f.earn >= f.div) {
      // Earns more than it pays: today's dividend is safe, and some of the spare may come back as raises
      total = (f.div + b.optimism * (f.earn - f.div)) * H;
    } else {
      // Pays more than it earns: today's dividend until the treasury runs dry, then only what it earns
      const lasts = c.treasury / (f.div - Math.max(0, f.earn));
      const k = Math.min(H, lasts);
      total = f.div * k + Math.max(0, f.earn) * (H - k);
    }
    return Math.max(0, total * f.reliable) / c.shares;
  }

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
    const inBand = (p, ref) => !!ref && p >= ref * BAND_LO && p <= ref * BAND_HI;
    const memRef = (t) => db.collection("botMemory").doc(t);
    const feesRef = db.collection("meta").doc("fees");
    const summary = [];
    const bots = only ? BOTS.filter((b) => only.includes(b.id)) : BOTS;

    /* ---------- wallets ---------- */
    for (const b of bots) {
      const s = await userRef(b.id).get();
      if (!s.exists) {
        await userRef(b.id).set({ displayName: b.name, coins: START_PI, cash: START_CASH, batches: 0, cashGranted: true, piGranted: true,
          createdAt: now(), lastBatchAt: now(), bot: true, openOrders: [] });
        log(`${b.name}: opened a wallet with $${START_CASH / 100} and ${START_PI} Pi`);
      } else if (!s.data().piGranted) {
        await userRef(b.id).update({ coins: inc(START_PI), piGranted: true });
      }
    }

    /* ---------- one trade: same steps as a player's order (fill up to 9 resting orders, rest the remainder) ---------- */
    async function trade(b, asset, side, price, qty, rest, ref) {
      const other = side === "buy" ? "sell" : "buy";
      const crosses = (p) => (side === "buy" ? p <= price : p >= price);
      const better = (a, c) => (side === "buy" ? a.p - c.p : c.p - a.p) || ms(a.createdAt) - ms(c.createdAt);
      const snap = await book(asset, other).orderBy("p", side === "buy" ? "asc" : "desc").limit(DEPTH).get();
      const opposite = snap.docs.map(asOrder).filter((o) => typeof o.p === "number" && o.uid !== b.id);
      // Another bot's order only counts if its price is close to the reference price
      const ok = (o) => !isBot(o.uid) || inBand(o.p, ref);
      // A resting order stops one cent short of any bot order it isn't allowed to trade with
      const blocked = opposite.filter((o) => !ok(o) && crosses(o.p)).map((o) => o.p);
      if (rest && blocked.length) price = side === "buy" ? Math.min(price, Math.min(...blocked) - 1) : Math.max(price, Math.max(...blocked) + 1);
      if (!(price >= 1)) return { filled: 0, value: 0, rest: 0 };
      const candidates = opposite.filter((o) => crosses(o.p) && ok(o)).sort(better);
      if (!candidates.length && !rest) return { filled: 0, value: 0, rest: 0 };
      return db.runTransaction(async (tx) => {
        const meSnap = await tx.get(userRef(b.id));
        const heldSnap = isPi(asset) ? meSnap : await tx.get(holderRef(asset, b.id));
        const company = isPi(asset) ? null : await tx.get(companyRef(asset));
        const fresh = [];
        for (const c of candidates) { const s = await tx.get(c.ref); if (s.exists) fresh.push(asOrder(s)); }
        const live = fresh.filter((o) => typeof o.p === "number" && o.remaining > 0 && o.uid !== b.id && ok(o) && crosses(o.p)).sort(better);
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
        // The order's Pi fee: from the Pi being traded, or from the wallet (buying Pi with none is free)
        let coins = me.coins || 0, feePaid = false;
        if (isPi(asset)) {
          if (side === "sell") { if (held < FEE) return { filled: 0, value: 0, rest: 0 }; held -= FEE; feePaid = true; }
          else if ((me.coins || 0) >= FEE) { held -= FEE; feePaid = true; }
        } else {
          if (coins < FEE) return { filled: 0, value: 0, rest: 0, noPi: true };
          coins -= FEE; feePaid = true;
        }
        if (feePaid) tx.set(feesRef, { pool: inc(FEE) }, { merge: true });
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
        const wallet = isPi(asset) ? { cash, coins: held } : { cash, coins };
        if (orderPath) wallet.openOrders = FieldValue.arrayUnion(orderPath);
        tx.update(userRef(b.id), wallet);
        if (!isPi(asset)) {
          tx.set(holderRef(asset, b.id), { uid: b.id, name: b.name, shares: held }, { merge: true });
          if (fills.length && company && company.exists) tx.update(companyRef(asset), { lastPrice: fills[fills.length - 1].o.p });
        }
        return { filled, value, rest: restQty, price };
      });
    }

    // Cancels every order the bot left last run. Returns what each one was: "TICKER:side" → { price, untouched }
    async function cancelAll(b) {
      const w = (await userRef(b.id).get()).data() || {};
      const was = new Map();
      for (const path of w.openOrders || []) {
        await db.runTransaction(async (tx) => {
          const ref = db.doc(path);
          const s = await tx.get(ref);
          const meSnap = await tx.get(userRef(b.id));
          const d = s.exists ? s.data() : null;
          const asset = path.split("/")[1];
          const heldSnap = d && !isPi(asset) && d.side === "sell" ? await tx.get(holderRef(asset, b.id)) : null;
          if (!d || d.uid !== b.id || typeof d.p !== "number" || d.remaining <= 0) return;
          was.set(`${asset}:${d.side}`, { price: d.price, untouched: !(d.filled > 0) });
          const me = meSnap.data() || {};
          tx.update(ref, { status: "cancelled", p: FieldValue.delete() });
          if (d.side === "buy") tx.update(userRef(b.id), { cash: (me.cash || 0) + d.remaining * d.price });
          else if (isPi(asset)) tx.update(userRef(b.id), { coins: (me.coins || 0) + d.remaining });
          else tx.set(holderRef(asset, b.id), { uid: b.id, name: b.name, shares: ((heldSnap && heldSnap.exists && heldSnap.data().shares) || 0) + d.remaining }, { merge: true });
        });
      }
      await userRef(b.id).update({ openOrders: [] });
      return was;
    }

    async function buyOffering(b, ticker, qty) {
      return db.runTransaction(async (tx) => {
        const c = (await tx.get(companyRef(ticker))).data();
        const w = (await tx.get(userRef(b.id))).data() || {};
        const h = await tx.get(holderRef(ticker, b.id));
        if (!c || !c.offerLeft || !c.offerPrice || (w.coins || 0) < FEE) return 0;
        const held = (h.exists && h.data().shares) || 0;
        const n = Math.min(qty, c.offerLeft, Math.floor((w.cash || 0) / c.offerPrice), Math.floor(MAX_STAKE * (c.shares + qty)) - held);
        if (n <= 0) return 0;
        const cost = n * c.offerPrice;
        tx.update(companyRef(ticker), { shares: c.shares + n, offerLeft: c.offerLeft - n, treasury: c.treasury + cost });
        tx.update(userRef(b.id), { cash: w.cash - cost, coins: w.coins - FEE });
        tx.set(feesRef, { pool: inc(FEE) }, { merge: true });
        tx.set(holderRef(ticker, b.id), { uid: b.id, name: b.name, shares: held + n }, { merge: true });
        tx.set(userRef(b.id).collection("history").doc(), { kind: "offering", asset: ticker, qty: n, price: c.offerPrice, at: now() });
        return n;
      });
    }

    /* ---------- the market as it stands ---------- */
    const companies = (await db.collection("companies").get()).docs.map((d) => d.data()).filter((c) => c && c.shares > 0);
    // Best price on the other side this bot may trade with: players at any price, bots near the reference
    async function top(asset, side, ref, me) {
      const s = await book(asset, side).orderBy("p", side === "buy" ? "desc" : "asc").limit(DEPTH).get();
      const o = s.docs.map(asOrder).find((x) => typeof x.p === "number" && x.uid !== me && (!isBot(x.uid) || inBand(x.p, ref)));
      return o ? o.p : null;
    }
    // What players have actually paid lately (trades between two bots don't count)
    async function playerAvg(asset) {
      const ts = (await tradesCol(asset).orderBy("at", "desc").limit(AVG_TRADES).get()).docs.map((d) => d.data())
        .filter((t) => !(isBot(t.buyer) && isBot(t.seller)));
      const q = ts.reduce((a, t) => a + t.qty, 0);
      return q ? ts.reduce((a, t) => a + t.qty * t.price, 0) / q : null;
    }

    // Read the notes on every company, forecast it, and add this run's observation
    const view = new Map();
    for (const c of companies) {
      const m = await memRef(c.ticker).get();
      const notes = (m.exists && m.data().notes) || [];
      const f = forecast(c, notes);
      const values = BOTS.map((x) => shareValue(x, c, f));
      const consensus = values.reduce((a, v) => a + v, 0) / values.length;
      const players = c.tradingClosed ? null : await playerAvg(c.ticker);
      view.set(c.ticker, { f, ref: players || (consensus >= 1 ? consensus : null) });
      // Count each payout once: only a payout newer than the last one noted
      const lastSeen = notes.length ? notes[notes.length - 1].payoutAt || 0 : 0;
      const lp = c.lastPayout && c.lastPayout.at > lastSeen ? c.lastPayout : null;
      const note = { at: Date.now(), treasury: c.treasury, div: c.dividendPerHour || 0,
        paidHours: lp ? lp.paidHours : 0, hours: lp ? lp.hours : 0, paidCash: lp ? lp.amount : 0, payoutAt: lp ? lp.at : lastSeen };
      if (!only) await memRef(c.ticker).set({ ticker: c.ticker, notes: [...notes, note].slice(-MEMORY),
        forecast: { earn: f.earn, reliable: f.reliable, runway: Number.isFinite(f.runway) ? f.runway : null }, updatedAt: Date.now() });
    }
    const piRef = await playerAvg("PI");

    /* ---------- each bot ---------- */
    for (const b of bots) {
      const did = [];
      const last = await cancelAll(b);
      const wallet = () => userRef(b.id).get().then((s) => s.data() || {});
      const holding = (t) => holderRef(t, b.id).get().then((s) => (s.exists && s.data().shares) || 0);
      const resting = [];
      const sideTaken = new Map();     // asset → "buy" or "sell" this run: never both

      // Keep enough Pi to pay fees: buy some from sellers near Pi's reference price
      if (piRef && ((await wallet()).coins || 0) < FEE_FLOAT) {
        const r = await trade(b, "PI", "buy", Math.ceil(piRef * BAND_HI), 20, false, piRef);
        if (r.filled) { did.push(`bought ${r.filled} Pi for fees`); sideTaken.set("PI", "buy"); }
      }

      for (const c of companies) {
        const { f, ref } = view.get(c.ticker);
        const value = shareValue(b, c, f);          // cents per share, from expected dividends
        let bid = Math.floor(value * b.buyAt);
        if (ref) bid = Math.min(bid, Math.floor(ref * BAND_HI));
        // Asking price: well over its valuation, cheaper again if last run's order didn't sell, never under the
        // valuation, and never more than 25% over what players pay (worth more than that to it: it holds)
        const worth = Math.max(1, Math.ceil(value));
        let ask = Math.max(1, Math.ceil(value * b.sellAt), ref ? Math.ceil(ref * BAND_LO) : 1);
        const prev = last.get(`${c.ticker}:sell`);
        if (prev && prev.untouched) ask = Math.min(ask, Math.max(worth, Math.floor(prev.price * MARKDOWN)));
        let hold = false;
        if (ref && ask > ref * BAND_HI) { if (worth > ref * BAND_HI) hold = true; else ask = Math.floor(ref * BAND_HI); }
        const cap = Math.floor(MAX_STAKE * c.shares);
        let held = await holding(c.ticker);
        const w = await wallet();
        const budget = Math.floor((w.cash || 0) * b.perAsset);

        // New shares from the company itself
        if (bid >= 1 && c.offerLeft > 0 && c.offerPrice > 0 && c.offerPrice <= bid && held < cap) {
          const n = await buyOffering(b, c.ticker, Math.min(cap - held, Math.floor(budget / c.offerPrice)));
          if (n) { did.push(`bought ${n.toLocaleString()} new ${c.ticker} shares at $${(c.offerPrice / 100).toFixed(2)}`); held += n; sideTaken.set(c.ticker, "buy"); }
        }
        if (c.tradingClosed) continue;

        // Shares offered well under what it expects them to pay, or bids well over
        const bestAsk = await top(c.ticker, "sell", ref, b.id), bestBid = await top(c.ticker, "buy", ref, b.id);
        if (bid >= 1 && bestAsk != null && bestAsk <= bid && held < cap && sideTaken.get(c.ticker) !== "sell") {
          const qty = Math.min(cap - held, Math.floor(budget / bid));
          if (qty > 0) {
            const r = await trade(b, c.ticker, "buy", bid, qty, false, ref);
            if (r.filled) { did.push(`bought ${r.filled.toLocaleString()} ${c.ticker} shares`); held += r.filled; sideTaken.set(c.ticker, "buy"); }
          }
        }
        if (held > 0 && bestBid != null && bestBid >= ask && sideTaken.get(c.ticker) !== "buy") {
          const r = await trade(b, c.ticker, "sell", ask, held, false, ref);
          if (r.filled) { did.push(`sold ${r.filled.toLocaleString()} ${c.ticker} shares`); held -= r.filled; sideTaken.set(c.ticker, "sell"); }
        }
        // Orders to leave on the book (best value first)
        if (bid >= 1 && held < cap && sideTaken.get(c.ticker) !== "sell")
          resting.push({ asset: c.ticker, ref, side: "buy", price: bid, qty: Math.min(cap - held, Math.floor(budget / bid)), score: value / Math.max(1, bestAsk || bid) });
        // Offer a tenth for sale; the rest stays put earning dividends (shares in a sell order don't)
        if (held > 0 && !hold && sideTaken.get(c.ticker) !== "buy")
          resting.push({ asset: c.ticker, ref, side: "sell", price: ask, qty: Math.max(1, Math.ceil(held * LIST_SHARE)), score: 1 });
      }

      // Pi coin pays no dividend: bots just trade it around its reference price
      if (piRef) {
        const bid = Math.max(1, Math.floor(piRef * (1 - b.piBand))), ask = Math.max(bid + 1, Math.ceil(piRef * (1 + b.piBand)));
        const w = await wallet();
        const worth = (w.cash || 0) + (w.coins || 0) * piRef;
        const room = Math.floor(Math.max(0, worth * b.piShare - (w.coins || 0) * piRef) / bid);
        const bestAsk = await top("PI", "sell", piRef, b.id), bestBid = await top("PI", "buy", piRef, b.id);
        if (room > 0 && bestAsk != null && bestAsk <= bid) {
          const r = await trade(b, "PI", "buy", bid, room, false, piRef);
          if (r.filled) { did.push(`bought ${r.filled.toLocaleString()} Pi`); sideTaken.set("PI", "buy"); }
        }
        const coins = (await wallet()).coins || 0;
        if (coins > 0 && bestBid != null && bestBid >= ask && sideTaken.get("PI") !== "buy") {
          const r = await trade(b, "PI", "sell", ask, Math.ceil(coins / 2), false, piRef);
          if (r.filled) { did.push(`sold ${r.filled.toLocaleString()} Pi`); sideTaken.set("PI", "sell"); }
        }
        const w2 = await wallet();
        const room2 = Math.floor(Math.max(0, ((w2.cash || 0) + (w2.coins || 0) * piRef) * b.piShare - (w2.coins || 0) * piRef) / bid);
        if (room2 > 0 && sideTaken.get("PI") !== "sell") resting.push({ asset: "PI", ref: piRef, side: "buy", price: bid, qty: room2, score: 0.9 });
        if (w2.coins > 0 && sideTaken.get("PI") !== "buy") resting.push({ asset: "PI", ref: piRef, side: "sell", price: ask, qty: Math.ceil(w2.coins / 2), score: 0.9 });
      }

      // Leave a few orders on the books
      resting.sort((x, y) => y.score - x.score);
      let placed = 0;
      for (const o of resting) {
        if (placed >= MAX_RESTING || !(o.qty > 0)) continue;
        const r = await trade(b, o.asset, o.side, o.price, o.qty, true, o.ref);
        if (r.filled) did.push(`${o.side === "buy" ? "bought" : "sold"} ${r.filled.toLocaleString()} ${o.asset === "PI" ? "Pi" : `${o.asset} shares`}`);
        if (r.rest) { placed++; did.push(`left an order to ${o.side} ${r.rest.toLocaleString()} ${o.asset === "PI" ? "Pi" : o.asset} at $${(r.price / 100).toFixed(2)}`); }
      }
      const w = await wallet();
      summary.push({ bot: b.name, cash: w.cash, coins: w.coins || 0, did });
      log(`${b.name}: ${did.length ? did.join("; ") : "nothing worth doing"} · cash $${((w.cash || 0) / 100).toFixed(2)}, ${w.coins || 0} Pi`);
    }
    return summary;
  }

  const api = { runBots, BOTS, isBot, forecast, shareValue, START_CASH, MAX_STAKE, BAND_LO, BAND_HI };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PiBots = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
