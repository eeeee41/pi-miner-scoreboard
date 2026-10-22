/* =====================================================================
   Pi Miner — wallets and the exchange (Pi coin + company shares)
   ---------------------------------------------------------------------
   Money:
     • Cash    — in-game dollars, stored in cents (integers). $10,000 to start.
     • Pi coin — mined on the shared chain (whole coins), in users/{uid}.coins
     • Shares  — whole shares of a company, in companies/{TICKER}/holders/{uid}

   Every asset has its own market, laid out the same way:
     market/{ASSET}/buys/{orderId}    buy orders (open + finished)
     market/{ASSET}/sells/{orderId}   sell orders (open + finished)
     market/{ASSET}/trades/{tradeId}  every trade; pending until a block confirms it
   ASSET is "PI" for Pi coin or a company ticker such as "ACME".

   An order is on the book while it has a `p` (price) field; filling,
   cancelling or expiring it removes `p`. Matching runs in the placing
   player's browser inside Firestore transactions, 9 resting orders per
   round (Firestore allows 20 rule lookups per transaction).

   10-day rule: a sell order still open after 10 days is bought by the
   market at 80% of the lower of its price and the recent average trade
   price. Something that has never traded can't be priced, so it goes back
   to the seller instead. Any player's page settles these (no server).
   ===================================================================== */
const Economy = (() => {
  const START_CASH = 1000000;               // $10,000.00 in cents — keep in sync with firestore.rules
  const START_PI = 10;                      // starter Pi, given once — keep in sync with firestore.rules
  const FEE = 1;                            // Pi per transaction, paid to the miner of the next block
  const BOOK_ROWS = 10;
  const MATCH_DEPTH = 25;
  const MAX_FILLS = 9;
  const EXPIRY_MS = 10 * 24 * 3600 * 1000;  // 10 days — keep in sync with firestore.rules
  const BUYOUT_RATE = 0.8;
  const AVG_TRADES = 20;                    // trades averaged for the buyout price
  const UPKEEP_MS = 5 * 60 * 1000;

  let fb = null, db = null, user = null;
  let unsubs = [], marketUnsubs = [], myOrderUnsubs = new Map(), upkeepTimer = 0;
  const st = {
    wallet: { cash: 0, coins: 0, loaded: false },
    asset: "PI",
    markets: [{ ticker: "PI", name: "Pi coin" }],
    held: { PI: 0 },                         // my balance per asset (coins or shares)
    asks: [], bids: [], trades: [], history: [],
    myOrders: new Map(),                     // asset -> { buys: [], sells: [] }
    shareValue: 0,
    side: "buy", type: "limit", busy: false, priceTouched: false
  };

  /* ---------- helpers ---------- */
  const g = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtCash = (cents) =>
    (cents < 0 ? "-$" : "$") + (Math.abs(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isPi = (a) => a === "PI";
  const fmtQty = (n, a = st.asset) => (isPi(a) ? `${n.toLocaleString()} Pi` : `${n.toLocaleString()} ${a} share${n === 1 ? "" : "s"}`);
  const fmtPi = (n) => fmtQty(n, "PI");
  const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : typeof ts === "number" ? ts : Date.now());
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  };
  const myName = () => ((user && user.displayName) || "Anonymous Miner").slice(0, 40);

  const userRef = (uid) => db.collection("users").doc(uid);
  const companyRef = (t) => db.collection("companies").doc(t);
  const holderRef = (t, uid) => companyRef(t).collection("holders").doc(uid);
  const market = (a) => db.collection("market").doc(a);
  const book = (a, side) => market(a).collection(side === "buy" ? "buys" : "sells");
  const tradesCol = (a) => market(a).collection("trades");
  const now = () => fb.firestore.FieldValue.serverTimestamp();
  const inc = (n) => fb.firestore.FieldValue.increment(n);
  const asOrder = (d) => ({ id: d.id, ref: d.ref, asset: d.ref.parent.parent.id, ...d.data({ serverTimestamps: "estimate" }) });

  const lastPrice = () => (st.trades.length ? st.trades[0].price : null);
  const orders = (a) => st.myOrders.get(a) || { buys: [], sells: [] };
  const lockedCash = () => [...st.myOrders.values()].reduce((a, o) => a + o.buys.reduce((s, x) => s + x.remaining * x.price, 0), 0);
  const lockedQty = (a) => orders(a).sells.reduce((s, x) => s + x.remaining, 0);

  function errText(err) {
    if (err && err.code === "permission-denied")
      return "Firestore refused this. Publish the latest firestore.rules in the Firebase console (Firestore → Rules).";
    if (err && err.code === "unavailable") return "Can't reach Firestore. Check your connection.";
    return (err && err.message) || "Something went wrong.";
  }

  /* ---------- Pi fees ----------
     Every basic transaction costs FEE Pi. Fees collect in meta/fees and the miner of the next block
     receives them on top of the block reward. Call inside a transaction, after reading the wallet
     (`me`); returns the player's Pi after the fee, which the caller writes with the rest of the wallet
     change (a wallet is written once per transaction). */
  const feesRef = () => db.collection("meta").doc("fees");
  function payFee(tx, me, what = "This") {
    const coins = (me && me.coins) || 0;
    if (coins < FEE)
      throw new Error(`${what} costs a ${FEE} Pi fee, and you have no Pi. Mine a block, or buy Pi on the Exchange (buying Pi is free when you have none).`);
    tx.set(feesRef(), { pool: inc(FEE) }, { merge: true });
    return coins - FEE;
  }

  /* ---------- wallet setup ---------- */
  async function ensureWallet(u) {
    const ref = userRef(u.uid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const grant = { kind: "grant", amount: START_CASH, at: now() };
      const piGrant = { kind: "piGrant", amount: START_PI, at: now() };
      if (!snap.exists) {
        tx.set(ref, {
          displayName: myName(), coins: START_PI, cash: START_CASH, batches: 0,
          cashGranted: true, piGranted: true, createdAt: now(), lastBatchAt: now()
        });
        tx.set(ref.collection("history").doc("starting-cash"), grant);
        tx.set(ref.collection("history").doc("starting-pi"), piGrant);
      } else if (!snap.data().cashGranted) {
        tx.update(ref, { cash: (snap.data().cash || 0) + START_CASH, cashGranted: true });
        tx.set(ref.collection("history").doc("starting-cash"), grant);
      } else if (!snap.data().piGranted) {
        // Players from before Pi fees get their starter Pi once
        tx.update(ref, { coins: (snap.data().coins || 0) + START_PI, piGranted: true });
        tx.set(ref.collection("history").doc("starting-pi"), piGrant);
      }
    });
  }

  /* ---------- placing an order ---------- */
  // A company's controller can close trading in its shares (no secondary market)
  const isClosed = (asset) => !isPi(asset) && !!(st.markets.find((m) => m.ticker === asset) || {}).closed;
  async function placeOrder(o) {
    if (isClosed(o.asset)) throw new Error(`Trading in ${o.asset} shares is closed by its controller.`);
    let left = o.qty, filled = 0, value = 0, rest = 0;
    for (let round = 0; round < 50 && left > 0; round++) {
      const r = await placeChunk(o.asset, { ...o, qty: left }, round > 0, round === 0);
      filled += r.filled;
      value += r.value;
      rest = r.rest;
      left -= r.filled + r.rest;
      if (!r.capped) break;
    }
    return { filled, value, rest };
  }

  // One transaction: fill up to MAX_FILLS resting orders, then rest any remainder (limit orders).
  async function placeChunk(asset, { side, type, qty, price }, continuing, withFee) {
    const uid = user.uid, name = myName();
    const other = side === "buy" ? "sell" : "buy";
    const crosses = (p) => type === "market" || (side === "buy" ? p <= price : p >= price);
    const better = (a, b) => (side === "buy" ? a.p - b.p : b.p - a.p) || ms(a.createdAt) - ms(b.createdAt);
    const nothing = { filled: 0, value: 0, rest: 0, capped: false };

    const snap = await book(asset, other).orderBy("p", side === "buy" ? "asc" : "desc").limit(MATCH_DEPTH).get();
    const candidates = snap.docs.map(asOrder).filter((o) => crosses(o.p)).sort(better);
    if (candidates.some((o) => o.uid === uid))
      throw new Error("That would trade with one of your own orders. Cancel it first, or change your price.");
    if (type === "market" && !candidates.length) {
      if (continuing) return nothing;
      throw new Error(`No one is ${side === "buy" ? "selling" : "buying"} ${isPi(asset) ? "Pi" : asset} right now. Try a limit order instead.`);
    }

    return db.runTransaction(async (tx) => {
      const meSnap = await tx.get(userRef(uid));
      const heldSnap = isPi(asset) ? meSnap : await tx.get(holderRef(asset, uid));
      const fresh = [];
      for (const c of candidates) {
        const s = await tx.get(c.ref);
        if (s.exists) fresh.push(asOrder(s));
      }
      const live = fresh.filter((o) => typeof o.p === "number" && o.remaining > 0 && o.uid !== uid && crosses(o.p)).sort(better);

      const fills = [];
      let left = qty;
      for (const o of live) {
        if (!left || fills.length >= MAX_FILLS) break;
        const n = Math.min(left, o.remaining);
        fills.push({ o, n });
        left -= n;
      }
      const filled = qty - left;
      const capped = left > 0 && fills.length >= MAX_FILLS;
      if (type === "market" && !filled) {
        if (continuing) return nothing;
        throw new Error("Those orders were just taken. Try again.");
      }

      const me = meSnap.data() || {};
      let cash = me.cash || 0;
      let held = isPi(asset) ? me.coins || 0 : (heldSnap.exists && heldSnap.data().shares) || 0;
      const value = fills.reduce((a, f) => a + f.n * f.o.p, 0);
      const rest = type === "limit" && !capped ? left : 0;
      if (side === "buy") {
        const need = value + rest * price;
        if (need > cash) throw new Error(`Not enough Cash: this needs ${fmtCash(need)} and you have ${fmtCash(cash)}.`);
        cash -= need;
        held += filled;
      } else {
        const need = filled + rest + (withFee && isPi(asset) ? FEE : 0);
        if (need > held) throw new Error(`Not enough to sell: this needs ${fmtQty(need, asset)}${withFee && isPi(asset) ? ` (including the ${FEE} Pi fee)` : ""} and you have ${fmtQty(held, asset)}.`);
        held -= filled + rest;
        cash += value;
      }
      // The order's Pi fee (once per order). Buying Pi with no Pi at all is free, so nobody gets stuck.
      let coinsAfter = null;
      if (withFee) {
        if (isPi(asset)) {
          if (side === "sell" || (me.coins || 0) >= FEE) { held -= FEE; tx.set(feesRef(), { pool: inc(FEE) }, { merge: true }); }
        } else coinsAfter = payFee(tx, me, "Every order");
      }

      // Fill resting orders, record trades, pay the other players.
      const credits = new Map();
      for (const { o, n } of fills) {
        const remaining = o.remaining - n;
        tx.update(o.ref, remaining === 0
          ? { remaining: 0, filled: (o.filled || 0) + n, status: "filled", p: fb.firestore.FieldValue.delete() }
          : { remaining, filled: (o.filled || 0) + n });
        const c = credits.get(o.uid) || { cash: 0, qty: 0, name: o.name };
        if (side === "buy") c.cash += n * o.p; else c.qty += n;
        credits.set(o.uid, c);

        const t = tradesCol(asset).doc();
        const buyer = side === "buy" ? uid : o.uid, seller = side === "buy" ? o.uid : uid;
        tx.set(t, {
          asset, price: o.p, qty: n, taker: side, at: now(), block: null,
          buyer, seller, parties: [buyer, seller],
          buyerName: side === "buy" ? name : o.name, sellerName: side === "buy" ? o.name : name
        });
        tx.set(userRef(uid).collection("history").doc(t.id), { kind: "trade", asset, side, price: o.p, qty: n, with: o.name, at: now() });
        tx.set(userRef(o.uid).collection("history").doc(t.id), { kind: "trade", asset, side: other, price: o.p, qty: n, with: name, at: now() });
      }
      for (const [maker, c] of credits) {
        if (isPi(asset)) tx.update(userRef(maker), { cash: inc(c.cash), coins: inc(c.qty) });
        else {
          if (c.cash) tx.update(userRef(maker), { cash: inc(c.cash) });
          if (c.qty) tx.set(holderRef(asset, maker), { uid: maker, name: c.name, shares: inc(c.qty) }, { merge: true });
        }
      }

      if (isPi(asset)) tx.update(userRef(uid), { cash, coins: held });
      else {
        tx.update(userRef(uid), coinsAfter == null ? { cash } : { cash, coins: coinsAfter });
        tx.set(holderRef(asset, uid), { uid, name, shares: held }, { merge: true });
        if (fills.length) tx.update(companyRef(asset), { lastPrice: fills[fills.length - 1].o.p });
      }
      if (rest > 0) {
        tx.set(book(asset, side).doc(), {
          uid, name, side, price, p: price, qty, remaining: rest, filled, status: "open", createdAt: now()
        });
      }
      return { filled, value, rest, capped };
    });
  }

  async function cancelOrder(o) {
    const uid = user.uid, asset = o.asset;
    await db.runTransaction(async (tx) => {
      const s = await tx.get(o.ref);
      const meSnap = await tx.get(userRef(uid));
      const heldSnap = isPi(asset) || o.side === "buy" ? null : await tx.get(holderRef(asset, uid));
      const d = s.data();
      if (!s.exists || d.uid !== uid || typeof d.p !== "number" || d.remaining <= 0)
        throw new Error("That order already filled, expired or was cancelled.");
      const me = meSnap.data() || {};
      tx.update(o.ref, { status: "cancelled", p: fb.firestore.FieldValue.delete() });
      if (d.side === "buy") tx.update(userRef(uid), { cash: (me.cash || 0) + d.remaining * d.price });
      else if (isPi(asset)) tx.update(userRef(uid), { coins: (me.coins || 0) + d.remaining });
      else tx.set(holderRef(asset, uid), { uid, name: myName(), shares: ((heldSnap.exists && heldSnap.data().shares) || 0) + d.remaining }, { merge: true });
    });
  }

  /* ---------- 10-day rule ---------- */
  // Recent volume-weighted average price for an asset, or null if it has never traded.
  async function averagePrice(asset) {
    const snap = await tradesCol(asset).orderBy("at", "desc").limit(AVG_TRADES).get();
    let qty = 0, val = 0;
    snap.forEach((d) => { const t = d.data(); qty += t.qty; val += t.qty * t.price; });
    return qty ? val / qty : null;
  }

  async function buyout(asset, ref, avg) {
    return db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const o = s.data();
      if (!o || typeof o.p !== "number" || o.remaining <= 0 || Date.now() - ms(o.createdAt) < EXPIRY_MS) return null;
      const seller = o.uid;
      const hist = userRef(seller).collection("history").doc(`expired-${asset}-${s.id}`);
      if (avg == null) {
        // Never traded: can't be priced, so give it back
        tx.update(ref, { status: "returned", p: fb.firestore.FieldValue.delete() });
        if (isPi(asset)) tx.update(userRef(seller), { coins: inc(o.remaining) });
        else tx.set(holderRef(asset, seller), { uid: seller, name: o.name, shares: inc(o.remaining) }, { merge: true });
        tx.set(hist, { kind: "returned", asset, order: s.id, qty: o.remaining, price: 0, at: now() });
        return "returned";
      }
      const unit = Math.floor(Math.min(o.price, avg) * BUYOUT_RATE);
      tx.update(ref, {
        status: "bought", p: fb.firestore.FieldValue.delete(),
        remaining: 0, filled: (o.filled || 0) + o.remaining, buyoutPrice: unit
      });
      if (unit > 0) tx.update(userRef(seller), { cash: inc(unit * o.remaining) });
      // Shares the market bought sit with the "market" holder (they get no dividends); Pi coin is retired
      if (!isPi(asset)) tx.set(holderRef(asset, "market"), { uid: "market", name: "The market", shares: inc(o.remaining) }, { merge: true });
      tx.set(hist, { kind: "bought", asset, order: s.id, qty: o.remaining, price: unit, at: now() });
      return "bought";
    });
  }

  async function settleExpired() {
    const cutoff = new Date(Date.now() - EXPIRY_MS);
    for (const m of st.markets) {
      const snap = await book(m.ticker, "sell").where("createdAt", "<", cutoff).limit(10).get();
      const open = snap.docs.filter((d) => typeof d.data().p === "number");
      if (!open.length) continue;
      const avg = await averagePrice(m.ticker);
      for (const d of open) await buyout(m.ticker, d.ref, avg).catch((err) => console.warn("Buyout failed", err));
    }
  }

  async function upkeep() {
    if (!user) return;
    try { await settleExpired(); } catch (err) { console.warn("Upkeep:", err); }
    if (typeof Factory !== "undefined") await Factory.upkeep().catch((err) => console.warn("Factory upkeep:", err));   // bank car sales first
    if (typeof Companies !== "undefined") await Companies.upkeep().catch((err) => console.warn("Company upkeep:", err));
    if (typeof Market !== "undefined") await Market.upkeep().catch((err) => console.warn("Market upkeep:", err));
    if (typeof Work !== "undefined") await Work.upkeep().catch((err) => console.warn("Work upkeep:", err));
    if (typeof Bank !== "undefined") await Bank.upkeep().catch((err) => console.warn("Bank upkeep:", err));
  }

  /* ---------- order form ---------- */
  function readForm() {
    return {
      asset: st.asset, side: st.side, type: st.type,
      qty: Math.floor(Number(g("xQty").value)),
      price: Math.round(Number(g("xPrice").value) * 100)
    };
  }

  function marketEstimate(side, qty) {
    const levels = side === "buy" ? st.asks : st.bids;
    let left = qty, value = 0;
    for (const o of levels) {
      if (!left || o.uid === user.uid) continue;
      const n = Math.min(left, o.remaining);
      value += n * o.p;
      left -= n;
    }
    return { value, short: left };
  }

  function renderForm() {
    const { side, type, qty, price } = readForm();
    const unit = isPi(st.asset) ? "Pi" : st.asset;
    g("xBuy").classList.toggle("on", side === "buy");
    g("xSell").classList.toggle("on", side === "sell");
    g("xBuy").setAttribute("aria-pressed", String(side === "buy"));
    g("xSell").setAttribute("aria-pressed", String(side === "sell"));
    g("xPriceField").classList.toggle("hidden", type === "market");
    g("xQtyLabel").textContent = isPi(st.asset) ? "Amount (Pi)" : `Amount (${st.asset} shares)`;
    g("xPriceLabel").textContent = isPi(st.asset) ? "Price per Pi ($)" : "Price per share ($)";
    const btn = g("xSubmit");
    const closed = isClosed(st.asset);
    btn.className = "btn-primary " + side;
    btn.textContent = st.busy ? "Placing order…" : closed ? "Trading closed" : `${side === "buy" ? "Buy" : "Sell"} ${unit}`;
    btn.disabled = st.busy || !st.wallet.loaded || closed;
    g("xClosed").classList.toggle("hidden", !closed);
    g("xClosed").textContent = closed ? `${st.asset}'s controller has closed trading in its shares. Open orders can still be cancelled, and new shares only come from the company's own offerings on the Stocks tab.` : "";

    g("xAvail").textContent = side === "buy" ? fmtCash(st.wallet.cash) : fmtQty(st.held[st.asset] || 0);
    const myPi = st.wallet.coins || 0;
    g("xFee").textContent = isPi(st.asset) && side === "buy" && myPi < FEE ? "free (you have no Pi)"
      : `${FEE} Pi${myPi < FEE ? " · you have none" : ` · you have ${fmtPi(myPi)}`}`;
    g("xTotalLabel").textContent = side === "buy" ? "You pay" : "You receive";
    if (!(qty > 0)) { g("xTotal").textContent = "—"; return; }
    if (type === "market") {
      const est = marketEstimate(side, qty);
      g("xTotal").textContent = est.value
        ? `≈ ${fmtCash(est.value)}${est.short ? ` (only ${fmtQty(qty - est.short)} available)` : ""}`
        : "No orders to match";
    } else {
      g("xTotal").textContent = price > 0 ? fmtCash(qty * price) : "—";
    }
  }

  function setMsg(text, kind) {
    const m = g("xMsg");
    m.textContent = text;
    m.className = "status" + (kind ? " " + kind : "");
  }

  async function onSubmit() {
    const o = readForm();
    if (isClosed(o.asset)) return setMsg(`Trading in ${o.asset} shares is closed by its controller.`, "err");
    if (!(o.qty >= 1)) return setMsg(`Enter how many whole ${isPi(o.asset) ? "Pi coins" : "shares"} to trade.`, "err");
    if (o.type === "limit" && !(o.price >= 1)) return setMsg("Enter a price of at least $0.01.", "err");
    st.busy = true; setMsg("", ""); renderForm();
    try {
      const r = await placeOrder(o);
      const verb = o.side === "buy" ? "Bought" : "Sold";
      const parts = [];
      if (r.filled) parts.push(`${verb} ${fmtQty(r.filled, o.asset)} for ${fmtCash(r.value)}`);
      if (r.rest) parts.push(`${fmtQty(r.rest, o.asset)} placed on the book at ${fmtCash(o.price)}`);
      if (o.type === "market" && r.filled < o.qty)
        parts.push(`the other ${fmtQty(o.qty - r.filled, o.asset)} didn't trade: no more ${o.side === "buy" ? "sellers" : "buyers"}`);
      setMsg(`✓ ${parts.join(" · ")}`, "ok");
    } catch (err) {
      setMsg(errText(err), "err");
    } finally {
      st.busy = false; renderForm();
    }
  }

  /* ---------- rendering ---------- */
  function levels(list) {
    const map = new Map();
    for (const o of list) {
      const l = map.get(o.p) || { p: o.p, qty: 0, mine: false };
      l.qty += o.remaining;
      if (user && o.uid === user.uid) l.mine = true;
      map.set(o.p, l);
    }
    return [...map.values()];
  }

  function bookRow(l, kind) {
    const row = mk("div", `book-row ${kind}${l.mine ? " mine" : ""}`);
    row.append(mk("span", null, fmtCash(l.p)), mk("span", null, l.qty.toLocaleString()), mk("span", null, fmtCash(l.p * l.qty)));
    row.title = "Use this price";
    row.addEventListener("click", () => {
      g("xPrice").value = (l.p / 100).toFixed(2);
      st.priceTouched = true;
      if (st.type === "market") { st.type = "limit"; g("xType").value = "limit"; }
      renderForm();
    });
    return row;
  }

  function renderBook() {
    const asks = levels(st.asks).slice(0, BOOK_ROWS).reverse();
    const bids = levels(st.bids).slice(0, BOOK_ROWS);
    g("xAsks").replaceChildren(...(asks.length ? asks.map((l) => bookRow(l, "ask")) : [mk("div", "empty", "No sell orders yet.")]));
    g("xBids").replaceChildren(...(bids.length ? bids.map((l) => bookRow(l, "bid")) : [mk("div", "empty", "No buy orders yet.")]));
    g("xBookHead").textContent = isPi(st.asset) ? "Pi" : "Shares";
    const bestAsk = st.asks.length ? st.asks[0].p : null, bestBid = st.bids.length ? st.bids[0].p : null;
    g("xAsk").textContent = bestAsk != null ? fmtCash(bestAsk) : "—";
    g("xBid").textContent = bestBid != null ? fmtCash(bestBid) : "—";
    const spread = g("xSpread");
    spread.replaceChildren();
    const lp = lastPrice();
    spread.append(mk("b", null, lp != null ? fmtCash(lp) : "No trades yet"));
    if (bestAsk != null && bestBid != null) spread.append(document.createTextNode(`  · spread ${fmtCash(bestAsk - bestBid)}`));
    renderForm();
  }

  function renderChart() {
    const box = g("xChart");
    const pts = st.trades.slice().reverse();
    if (pts.length < 2) {
      box.replaceChildren(mk("div", "empty", pts.length
        ? "One trade so far. The chart appears after the second."
        : `No trades yet. Place the first order to set ${isPi(st.asset) ? "Pi coin's" : `${st.asset}'s`} price.`));
      return;
    }
    const W = Math.max(280, Math.round(box.clientWidth || 640)), H = Math.max(120, Math.round(box.clientHeight || 170));
    const padL = 4, padR = 64, padT = 10, padB = 18;
    const t0 = ms(pts[0].at), t1 = ms(pts[pts.length - 1].at) || t0 + 1;
    let lo = Math.min(...pts.map((p) => p.price)), hi = Math.max(...pts.map((p) => p.price));
    if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
    const X = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
    const Y = (p) => padT + (1 - (p - lo) / (hi - lo)) * (H - padT - padB);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${X(ms(p.at)).toFixed(1)} ${Y(p.price).toFixed(1)}`).join("");
    const last = pts[pts.length - 1];
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${st.asset} price over the last ${pts.length} trades`);
    const add = (tag, attrs, text) => {
      const e = document.createElementNS(ns, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      svg.append(e);
    };
    for (const v of [hi, lo]) {
      add("line", { x1: padL, x2: W - padR, y1: Y(v), y2: Y(v), stroke: "var(--border)", "stroke-dasharray": "3 4" });
      add("text", { x: W - padR + 8, y: Y(v) + 4, fill: "var(--muted)", "font-size": 11 }, fmtCash(v));
    }
    add("path", { d: `${line}L${X(ms(last.at))} ${H - padB}L${padL} ${H - padB}Z`, fill: "var(--gold)", "fill-opacity": 0.1, stroke: "none" });
    add("path", { d: line, fill: "none", stroke: "var(--gold)", "stroke-width": 2 });
    add("circle", { cx: X(ms(last.at)), cy: Y(last.price), r: 3.5, fill: "var(--gold)" });
    box.replaceChildren(svg);
  }

  function renderMarket() {
    const lp = lastPrice();
    g("xPair").textContent = `${isPi(st.asset) ? "PI" : st.asset} / Cash · last trade`;
    g("xLast").textContent = lp != null ? fmtCash(lp) : "—";
    if (lp != null && !st.priceTouched) g("xPrice").value = (lp / 100).toFixed(2);
    const dayAgo = Date.now() - 86400000;
    const recent = st.trades.filter((t) => ms(t.at) >= dayAgo);
    const before = st.trades.find((t) => ms(t.at) < dayAgo) || st.trades[st.trades.length - 1];
    const chg = g("xChange");
    if (lp != null && before && before.price) {
      const pct = ((lp - before.price) / before.price) * 100;
      chg.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% over the last 24 hours`;
      chg.className = "stat-sub " + (pct > 0 ? "pos" : pct < 0 ? "neg" : "");
    } else {
      chg.textContent = "No trades yet";
      chg.className = "stat-sub";
    }
    g("xVol").textContent = fmtQty(recent.reduce((a, t) => a + t.qty, 0));

    const box = g("xTrades");
    if (!st.trades.length) box.replaceChildren(mk("div", "empty", "No trades yet."));
    else box.replaceChildren(...st.trades.slice(0, 20).map((t) => {
      const row = mk("div", "trade-row");
      row.append(
        mk("span", t.taker === "buy" ? "pos" : "neg", fmtCash(t.price)),
        mk("span", null, t.qty.toLocaleString()),
        mk("span", "t", `${ago(ms(t.at))} · ${t.block ? `block #${t.block}` : "pending"}`)
      );
      row.title = `${t.buyerName} bought from ${t.sellerName}` +
        (t.block ? `, confirmed in block #${t.block}` : ". Waiting for a miner to put it in a block.");
      return row;
    }));
    renderChart();
    renderBook();
    renderWallet();
  }

  function renderMarketSelect() {
    const sel = g("xMarket");
    const want = st.markets.map((m) => m.ticker).join(",");
    if (sel.dataset.list !== want + st.markets.map((m) => (m.closed ? 1 : 0)).join("")) {
      sel.replaceChildren(...st.markets.map((m) => {
        const o = mk("option", null, isPi(m.ticker) ? "Pi coin (PI)" : `${m.ticker} · ${m.name}${m.closed ? " (trading closed)" : ""}`);
        o.value = m.ticker;
        return o;
      }));
      sel.dataset.list = want + st.markets.map((m) => (m.closed ? 1 : 0)).join("");
    }
    sel.value = st.asset;
  }

  function renderMyOrders() {
    const mine = [...st.myOrders.values()].flatMap((o) => [...o.buys, ...o.sells]).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    const box = g("xMine");
    if (!mine.length) { box.replaceChildren(mk("div", "empty", "No open orders.")); return; }
    box.replaceChildren(...mine.map((o) => {
      const row = mk("div", "order-row");
      const label = mk("span", o.side === "buy" ? "pos" : "neg", o.side === "buy" ? "Buy" : "Sell");
      const left = Math.max(0, Math.ceil((ms(o.createdAt) + EXPIRY_MS - Date.now()) / 86400000));
      const what = mk("span", null,
        `${fmtQty(o.remaining, o.asset)} at ${fmtCash(o.price)}${o.filled ? ` · ${o.filled.toLocaleString()} filled` : ""}` +
        (o.side === "sell" ? ` · market buys it in ${left} day${left === 1 ? "" : "s"}` : ""));
      const btn = mk("button", "btn-ghost", "Cancel");
      btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = "Cancelling…";
        try { await cancelOrder(o); setMsg("Order cancelled; what was held for it is back in your wallet.", "ok"); }
        catch (err) { setMsg(errText(err), "err"); btn.disabled = false; btn.textContent = "Cancel"; }
      });
      row.append(label, what, btn);
      return row;
    }));
  }

  function renderWallet() {
    const w = st.wallet;
    if (!w.loaded) return;
    const lc = lockedCash(), lk = lockedQty("PI");
    const lp = st.asset === "PI" ? lastPrice() : st.piPrice;
    g("wCash").textContent = fmtCash(w.cash + lc);
    g("wCashSub").textContent = `${fmtCash(w.cash)} available · ${fmtCash(lc)} in open orders`;
    g("wCoins").textContent = fmtPi(w.coins + lk);
    g("wCoinsSub").textContent = `${fmtPi(w.coins)} available · ${fmtPi(lk)} in open orders`;
    const piValue = lp != null ? (w.coins + lk) * lp : 0;
    g("wWorth").textContent = fmtCash(w.cash + lc + piValue + st.shareValue);
    const parts = [lp != null ? `Pi coin at ${fmtCash(lp)}` : "Pi coin has no price yet"];
    if (st.shareValue) parts.push(`${fmtCash(st.shareValue)} in shares`);
    g("wWorthSub").textContent = parts.join(" · ");
    renderForm();
  }

  function renderHistory() {
    const box = g("wHistory");
    if (!st.history.length) { box.replaceChildren(mk("div", "empty", "Nothing yet.")); return; }
    box.replaceChildren(...st.history.map((h) => {
      const row = mk("div", "hist-row");
      const what = mk("div", "what");
      const a = h.asset || "PI";
      let when = ago(ms(h.at)), text, amt;
      switch (h.kind) {
        case "grant": text = "Starting Cash"; amt = ["pos", `+${fmtCash(h.amount)}`]; break;
        case "piGrant": text = "Starter Pi, for transaction fees"; amt = ["pos", `+${fmtPi(h.amount)}`]; break;
        case "job": text = `Shift as a ${String(h.job).toLowerCase()} (${h.hours} hour${h.hours === 1 ? "" : "s"})`; amt = ["pos", `+${fmtCash(h.amount)}`]; break;
        case "wage": text = `Wages from ${a} (${h.hours} hour${h.hours === 1 ? "" : "s"})`; amt = ["pos", `+${fmtCash(h.amount)}`]; break;
        case "bank": {
          const B = { deposit: ["Deposited in the bank", "", "−"], withdraw: ["Withdrew from the bank", "pos", "+"], borrow: ["Borrowed from the bank", "pos", "+"],
            repay: ["Repaid the bank", "", "−"], liquidated: ["Loan closed: the bank kept your collateral", "", "−"] }[h.action] || ["Bank", "", ""];
          text = B[0];
          amt = [B[1], h.action === "liquidated" ? `${B[2]}${fmtPi(h.amount)}` : `${B[2]}${fmtCash(h.amount)}`];
          break;
        }
        case "block":
          text = `Mined block #${h.height}${h.trades ? `, confirming ${h.trades} trade${h.trades === 1 ? "" : "s"}` : ""}${h.fees ? `, plus ${fmtPi(h.fees)} in fees` : ""}`;
          amt = ["pos", `+${fmtPi(h.reward + (h.fees || 0))}`]; break;
        case "bought":
          text = `The market bought your ${fmtQty(h.qty, a)} at ${fmtCash(h.price)} each after 10 days unsold`;
          amt = ["pos", `+${fmtCash(h.qty * h.price)}`]; break;
        case "returned":
          text = `Your ${fmtQty(h.qty, a)} sell order expired after 10 days and came back (never traded, so it couldn't be priced)`;
          amt = ["", "returned"]; break;
        case "dividend":
          text = `Dividend from ${a}${h.hours > 1 ? ` (${h.hours} hours)` : ""}`;
          amt = ["pos", `+${fmtCash(h.amount)}`]; break;
        case "founded":
          text = `Founded ${a}: $1,000 fee${h.amount > 100000 ? ` + ${fmtCash(h.amount - 100000)} into the treasury` : ""}`;
          amt = ["neg", `-${fmtCash(h.amount)}`]; break;
        case "offering":
          text = `Bought ${fmtQty(h.qty, a)} from the company at ${fmtCash(h.price)}`;
          amt = ["neg", `-${fmtCash(h.qty * h.price)}`]; break;
        case "deposit":
          text = `Put Cash into ${a}'s treasury`;
          amt = ["neg", `-${fmtCash(h.amount)}`]; break;
        default: {
          const buy = h.side === "buy";
          text = `${buy ? "Bought" : "Sold"} ${fmtQty(h.qty, a)} at ${fmtCash(h.price)} ${buy ? "from" : "to"} ${h.with || "a player"}`;
          amt = [buy ? "neg" : "pos", `${buy ? "-" : "+"}${fmtCash(h.qty * h.price)}`];
          const t = st.trades.find((x) => x.id === h.id);
          if (t) when += t.block ? ` · confirmed in block #${t.block}` : " · pending, waiting for a block";
        }
      }
      what.append(mk("div", null, text), mk("div", "when", when));
      row.append(what, mk("div", "amt " + amt[0], amt[1]));
      return row;
    }));
  }

  /* ---------- tabs ---------- */
  const TABS = ["mine", "wallet", "exchange", "stocks", "factory", "market", "work", "bank"];
  function showTab(name) {
    if (!TABS.includes(name)) name = "mine";
    document.body.dataset.tab = name;          // lets page-wide pieces (like the Employees panel) follow the tab
    for (const t of TABS) {
      g(`tab-${t}`).classList.toggle("hidden", t !== name);
      const b = g(`tabBtn-${t}`);
      b.classList.toggle("active", t === name);
      b.setAttribute("aria-selected", String(t === name));
    }
    if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
    if (name === "exchange" && user) renderChart();
  }

  /* ---------- live data ---------- */
  function watchMarket(asset) {
    marketUnsubs.forEach((u) => u());
    marketUnsubs = [];
    st.asset = asset;
    st.asks = []; st.bids = []; st.trades = [];
    st.priceTouched = false;
    renderMarketSelect();
    const fail = (where) => (err) => setMsg(`${where}: ${errText(err)}`, "err");
    marketUnsubs.push(book(asset, "sell").orderBy("p", "asc").limit(40).onSnapshot((s) => {
      st.asks = s.docs.map(asOrder).sort((a, b) => a.p - b.p || ms(a.createdAt) - ms(b.createdAt));
      renderBook();
    }, fail("Order book")));
    marketUnsubs.push(book(asset, "buy").orderBy("p", "desc").limit(40).onSnapshot((s) => {
      st.bids = s.docs.map(asOrder).sort((a, b) => b.p - a.p || ms(a.createdAt) - ms(b.createdAt));
      renderBook();
    }, fail("Order book")));
    marketUnsubs.push(tradesCol(asset).orderBy("at", "desc").limit(150).onSnapshot((s) => {
      st.trades = s.docs.map(asOrder);
      if (isPi(asset)) st.piPrice = lastPrice();
      renderMarket();
      renderHistory();
    }, fail("Trades")));
    if (!isPi(asset)) {
      marketUnsubs.push(holderRef(asset, user.uid).onSnapshot((s) => {
        st.held[asset] = (s.exists && s.data().shares) || 0;
        renderForm();
      }, fail("Your shares")));
    }
    renderMarket();
  }

  function watchMyOrders(asset) {
    if (myOrderUnsubs.has(asset)) return;
    const subs = ["buy", "sell"].map((side) => book(asset, side).where("uid", "==", user.uid).onSnapshot((s) => {
      const open = s.docs.map(asOrder).filter((o) => typeof o.p === "number");
      const cur = orders(asset);
      st.myOrders.set(asset, side === "buy" ? { ...cur, buys: open } : { ...cur, sells: open });
      renderMyOrders();
      renderWallet();
    }, (err) => setMsg(`Your orders: ${errText(err)}`, "err")));
    myOrderUnsubs.set(asset, subs);
  }

  /* ---------- public API ---------- */
  function init(firebaseNs, firestore) {
    fb = firebaseNs; db = firestore;
    for (const t of TABS) g(`tabBtn-${t}`).addEventListener("click", () => showTab(t));
    window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
    showTab(location.hash.slice(1));

    g("xMarket").addEventListener("change", (e) => { if (user) watchMarket(e.target.value); });
    g("xBuy").addEventListener("click", () => { st.side = "buy"; setMsg("", ""); renderForm(); });
    g("xSell").addEventListener("click", () => { st.side = "sell"; setMsg("", ""); renderForm(); });
    g("xType").addEventListener("change", (e) => { st.type = e.target.value; renderForm(); });
    g("xQty").addEventListener("input", renderForm);
    g("xPrice").addEventListener("input", () => { st.priceTouched = true; renderForm(); });
    g("xSubmit").addEventListener("click", onSubmit);
    setInterval(() => { if (user) { renderMarket(); renderHistory(); renderMyOrders(); } }, 30000);
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (user) renderChart(); }, 150);
    });
  }

  function signIn(u) {
    signOut();
    user = u;
    const uid = u.uid;
    const fail = (where) => (err) => setMsg(`${where}: ${errText(err)}`, "err");
    ensureWallet(u).catch(fail("Setting up your wallet"));

    unsubs.push(userRef(uid).onSnapshot((s) => {
      const d = s.data() || {};
      st.wallet = { cash: d.cash || 0, coins: d.coins || 0, loaded: true };
      st.held.PI = d.coins || 0;
      renderWallet();
    }, fail("Wallet")));
    unsubs.push(userRef(uid).collection("history").orderBy("at", "desc").limit(50).onSnapshot((s) => {
      st.history = s.docs.map(asOrder);
      renderHistory();
    }, fail("History")));
    // Pi coin's price is needed for net worth even while another market is open
    unsubs.push(tradesCol("PI").orderBy("at", "desc").limit(1).onSnapshot((s) => {
      st.piPrice = s.empty ? null : s.docs[0].data().price;
      renderWallet();
    }, fail("Trades")));

    watchMyOrders("PI");
    watchMarket("PI");
    setTimeout(upkeep, 4000);
    upkeepTimer = setInterval(upkeep, UPKEEP_MS);
  }

  function signOut() {
    unsubs.forEach((u) => u());
    marketUnsubs.forEach((u) => u());
    myOrderUnsubs.forEach((subs) => subs.forEach((u) => u()));
    unsubs = []; marketUnsubs = []; myOrderUnsubs = new Map();
    clearInterval(upkeepTimer);
    user = null;
    Object.assign(st, {
      wallet: { cash: 0, coins: 0, loaded: false }, asset: "PI",
      held: { PI: 0 }, asks: [], bids: [], trades: [], history: [], myOrders: new Map(),
      shareValue: 0, busy: false, priceTouched: false, piPrice: null
    });
    if (!g("xMsg")) return;
    setMsg("", "");
    for (const id of ["wCash", "wCoins", "wWorth"]) g(id).textContent = "…";
    for (const id of ["wCashSub", "wCoinsSub", "wWorthSub", "xAvail"]) g(id).textContent = "";
    for (const id of ["wHistory", "xMine"]) g(id).replaceChildren(mk("div", "empty", "Loading…"));
  }

  // Companies module → keeps the market list in sync and opens a company's market
  function setMarkets(companies) {
    st.markets = [{ ticker: "PI", name: "Pi coin" }, ...companies.map((c) => ({ ticker: c.ticker, name: c.name, closed: !!c.tradingClosed }))];
    if (user) for (const c of companies) watchMyOrders(c.ticker);
    renderMarketSelect();
  }
  function openMarket(ticker) {
    if (!user) return;
    if (ticker !== st.asset) watchMarket(ticker);
    showTab("exchange");
  }
  function setShareValue(v) { st.shareValue = v; renderWallet(); }

  return { init, signIn, signOut, setMarkets, openMarket, setShareValue, upkeep, fmtCash, errText, payFee, FEE };
})();
