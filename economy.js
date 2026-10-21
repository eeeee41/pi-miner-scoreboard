/* =====================================================================
   Pi Miner — Phase 1: wallets and the Pi coin exchange
   ---------------------------------------------------------------------
   Two currencies:
     • Pi coin — mined on the Mine tab (whole coins)
     • Cash    — in-game dollars, stored in cents (integers) to avoid
                 rounding errors. New players get $10,000 once.

   Firestore layout:
     users/{uid}                  wallet: cash, coins (+ mining fields)
     users/{uid}/history/{id}     the player's own activity feed
     market/PI/buys/{orderId}     open + finished buy orders
     market/PI/sells/{orderId}    open + finished sell orders
     market/PI/trades/{tradeId}   every trade, public

   An order is "on the book" while it has a `p` (price) field. When it
   fills or is cancelled, `p` is removed, which drops it out of the
   orderBy("p") book queries without deleting its record.

   Matching runs in the browser of whoever places the order, inside one
   Firestore transaction: it re-reads the resting orders, fills them at
   their own price, credits the other players, and records the trades.
   Money behind an open order is taken out of the wallet when the order
   is placed (escrow) and given back if it's cancelled.
   ===================================================================== */
const Economy = (() => {
  const START_CASH = 1000000;   // $10,000.00 in cents — keep in sync with firestore.rules
  const BOOK_ROWS = 10;         // price levels shown on each side of the book
  const MATCH_DEPTH = 25;       // resting orders considered per trade

  let fb = null, db = null, user = null, unsubs = [];
  const st = {
    wallet: { cash: 0, coins: 0, loaded: false },
    asks: [], bids: [], trades: [], myBuys: [], mySells: [], history: [],
    side: "buy", type: "limit", busy: false
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
  const fmtPi = (n) => `${n.toLocaleString()} Pi`;
  const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : Date.now());
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  };
  const myName = () => ((user && user.displayName) || "Anonymous Miner").slice(0, 40);

  const userRef = (uid) => db.collection("users").doc(uid);
  const market = () => db.collection("market").doc("PI");
  const book = (side) => market().collection(side === "buy" ? "buys" : "sells");
  const tradesCol = () => market().collection("trades");
  const now = () => fb.firestore.FieldValue.serverTimestamp();
  const asOrder = (d) => ({ id: d.id, ref: d.ref, ...d.data({ serverTimestamps: "estimate" }) });

  const lastPrice = () => (st.trades.length ? st.trades[0].price : null);
  const lockedCash = () => st.myBuys.reduce((a, o) => a + o.remaining * o.price, 0);
  const lockedCoins = () => st.mySells.reduce((a, o) => a + o.remaining, 0);

  function errText(err) {
    if (err && err.code === "permission-denied")
      return "Firestore refused this. Publish the new firestore.rules in the Firebase console (Firestore → Rules).";
    if (err && err.code === "unavailable") return "Can't reach Firestore. Check your connection.";
    return (err && err.message) || "Something went wrong.";
  }

  /* ---------- wallet setup ---------- */
  async function ensureWallet(u) {
    const ref = userRef(u.uid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const grant = { kind: "grant", amount: START_CASH, at: now() };
      if (!snap.exists) {
        tx.set(ref, {
          displayName: myName(), coins: 0, cash: START_CASH, batches: 0,
          cashGranted: true, createdAt: now(), lastBatchAt: now()
        });
        tx.set(ref.collection("history").doc("starting-cash"), grant);
      } else if (!snap.data().cashGranted) {
        tx.update(ref, { cash: (snap.data().cash || 0) + START_CASH, cashGranted: true });
        tx.set(ref.collection("history").doc("starting-cash"), grant);
      }
    });
  }

  /* ---------- placing an order ---------- */
  async function placeOrder({ side, type, qty, price }) {
    const uid = user.uid, name = myName();
    const other = side === "buy" ? "sell" : "buy";
    const crosses = (p) => type === "market" || (side === "buy" ? p <= price : p >= price);
    const better = (a, b) => (side === "buy" ? a.p - b.p : b.p - a.p) || ms(a.createdAt) - ms(b.createdAt);

    // 1. Find candidate resting orders (queries can't run inside a transaction).
    const snap = await book(other).orderBy("p", side === "buy" ? "asc" : "desc").limit(MATCH_DEPTH).get();
    const candidates = snap.docs.map(asOrder).filter((o) => crosses(o.p)).sort(better);
    if (candidates.some((o) => o.uid === uid))
      throw new Error("That would trade with one of your own orders. Cancel it first, or change your price.");
    if (type === "market" && !candidates.length)
      throw new Error(`No one is ${side === "buy" ? "selling" : "buying"} Pi right now. Try a limit order instead.`);

    // 2. Re-read everything inside a transaction, then move the money.
    return db.runTransaction(async (tx) => {
      const meSnap = await tx.get(userRef(uid));
      const fresh = [];
      for (const c of candidates) {
        const s = await tx.get(c.ref);
        if (s.exists) fresh.push(asOrder(s));
      }
      const live = fresh
        .filter((o) => typeof o.p === "number" && o.remaining > 0 && o.uid !== uid && crosses(o.p))
        .sort(better);

      const fills = [];
      let left = qty;
      for (const o of live) {
        if (!left) break;
        const n = Math.min(left, o.remaining);
        fills.push({ o, n });
        left -= n;
      }
      const filled = qty - left;
      if (type === "market" && !filled) throw new Error("Those orders were just taken. Try again.");

      const me = meSnap.data() || {};
      let cash = me.cash || 0, coins = me.coins || 0;
      const value = fills.reduce((a, f) => a + f.n * f.o.p, 0);
      const rest = type === "limit" ? left : 0;          // market orders never rest on the book
      if (side === "buy") {
        const need = value + rest * price;
        if (need > cash) throw new Error(`Not enough Cash: this needs ${fmtCash(need)} and you have ${fmtCash(cash)}.`);
        cash -= need;
        coins += filled;
      } else {
        const need = filled + rest;
        if (need > coins) throw new Error(`Not enough Pi coin: this needs ${fmtPi(need)} and you have ${fmtPi(coins)}.`);
        coins -= need;
        cash += value;
      }

      // Writes: fill each resting order, record trades, pay the other players.
      const credits = new Map();
      for (const { o, n } of fills) {
        const remaining = o.remaining - n;
        tx.update(o.ref, remaining === 0
          ? { remaining: 0, filled: (o.filled || 0) + n, status: "filled", p: fb.firestore.FieldValue.delete() }
          : { remaining, filled: (o.filled || 0) + n });

        const c = credits.get(o.uid) || { cash: 0, coins: 0 };
        if (side === "buy") c.cash += n * o.p; else c.coins += n;
        credits.set(o.uid, c);

        const t = tradesCol().doc();
        const buyer = side === "buy" ? uid : o.uid, seller = side === "buy" ? o.uid : uid;
        tx.set(t, {
          price: o.p, qty: n, taker: side, at: now(),
          buyer, seller, parties: [buyer, seller],
          buyerName: side === "buy" ? name : o.name, sellerName: side === "buy" ? o.name : name
        });
        tx.set(userRef(uid).collection("history").doc(t.id), { kind: "trade", side, price: o.p, qty: n, with: o.name, at: now() });
        tx.set(userRef(o.uid).collection("history").doc(t.id), { kind: "trade", side: other, price: o.p, qty: n, with: name, at: now() });
      }
      const inc = fb.firestore.FieldValue.increment;
      for (const [maker, c] of credits) tx.update(userRef(maker), { cash: inc(c.cash), coins: inc(c.coins) });

      tx.update(userRef(uid), { cash, coins });
      if (rest > 0) {
        tx.set(book(side).doc(), {
          uid, name, side, price, p: price, qty, remaining: rest, filled, status: "open", createdAt: now()
        });
      }
      return { filled, value, rest };
    });
  }

  async function cancelOrder(o) {
    const uid = user.uid;
    await db.runTransaction(async (tx) => {
      const s = await tx.get(o.ref);
      const meSnap = await tx.get(userRef(uid));
      const d = s.data();
      if (!s.exists || d.uid !== uid || typeof d.p !== "number" || d.remaining <= 0)
        throw new Error("That order already filled or was cancelled.");
      const me = meSnap.data() || {};
      tx.update(o.ref, { status: "cancelled", p: fb.firestore.FieldValue.delete() });
      if (d.side === "buy") tx.update(userRef(uid), { cash: (me.cash || 0) + d.remaining * d.price });
      else tx.update(userRef(uid), { coins: (me.coins || 0) + d.remaining });
    });
  }

  /* ---------- order form ---------- */
  function readForm() {
    const qty = Math.floor(Number(g("xQty").value));
    const price = Math.round(Number(g("xPrice").value) * 100);
    return { side: st.side, type: st.type, qty, price };
  }

  // Walks the book to estimate what a market order would cost or earn.
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
    g("xBuy").classList.toggle("on", side === "buy");
    g("xSell").classList.toggle("on", side === "sell");
    g("xBuy").setAttribute("aria-pressed", String(side === "buy"));
    g("xSell").setAttribute("aria-pressed", String(side === "sell"));
    g("xPriceField").classList.toggle("hidden", type === "market");
    const btn = g("xSubmit");
    btn.className = "btn-primary " + side;
    btn.textContent = st.busy ? "Placing order…" : side === "buy" ? "Buy Pi" : "Sell Pi";
    btn.disabled = st.busy || !st.wallet.loaded;

    g("xAvail").textContent = side === "buy" ? fmtCash(st.wallet.cash) : fmtPi(st.wallet.coins);
    g("xTotalLabel").textContent = side === "buy" ? "You pay" : "You receive";
    if (!(qty > 0)) { g("xTotal").textContent = "—"; return; }
    if (type === "market") {
      const est = marketEstimate(side, qty);
      g("xTotal").textContent = est.value
        ? `≈ ${fmtCash(est.value)}${est.short ? ` (only ${fmtPi(qty - est.short)} available)` : ""}`
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
    if (!(o.qty >= 1)) return setMsg("Enter how many whole Pi coins to trade.", "err");
    if (o.type === "limit" && !(o.price >= 1)) return setMsg("Enter a price of at least $0.01.", "err");
    st.busy = true; setMsg("", ""); renderForm();
    try {
      const r = await placeOrder(o);
      const verb = o.side === "buy" ? "Bought" : "Sold";
      const parts = [];
      if (r.filled) parts.push(`${verb} ${fmtPi(r.filled)} for ${fmtCash(r.value)}`);
      if (r.rest) parts.push(`${fmtPi(r.rest)} placed on the book at ${fmtCash(o.price)}`);
      if (o.type === "market" && r.filled < o.qty)
        parts.push(`the other ${fmtPi(o.qty - r.filled)} didn't trade: no more ${o.side === "buy" ? "sellers" : "buyers"}`);
      setMsg(`✓ ${parts.join(" · ")}`, "ok");
    } catch (err) {
      setMsg(errText(err), "err");
    } finally {
      st.busy = false; renderForm();
    }
  }

  /* ---------- rendering ---------- */
  function levels(orders) {             // group orders by price
    const map = new Map();
    for (const o of orders) {
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
    const asks = levels(st.asks).slice(0, BOOK_ROWS).reverse();   // highest at top, best ask next to the spread
    const bids = levels(st.bids).slice(0, BOOK_ROWS);
    g("xAsks").replaceChildren(...(asks.length ? asks.map((l) => bookRow(l, "ask")) : [mk("div", "empty", "No sell orders yet.")]));
    g("xBids").replaceChildren(...(bids.length ? bids.map((l) => bookRow(l, "bid")) : [mk("div", "empty", "No buy orders yet.")]));

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
    const pts = st.trades.slice().reverse();            // oldest → newest
    if (pts.length < 2) {
      box.replaceChildren(mk("div", "empty", pts.length
        ? "One trade so far. The chart appears after the second."
        : "No trades yet. Place the first order to set Pi coin's price."));
      return;
    }
    // Draw at the box's real size so text isn't stretched
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
    svg.setAttribute("aria-label", `Pi coin price over the last ${pts.length} trades`);
    const add = (tag, attrs, text) => {
      const e = document.createElementNS(ns, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      svg.append(e);
      return e;
    };
    for (const v of [hi, lo]) {
      add("line", { x1: padL, x2: W - padR, y1: Y(v), y2: Y(v), stroke: "var(--border)", "stroke-dasharray": "3 4", "vector-effect": "non-scaling-stroke" });
      add("text", { x: W - padR + 8, y: Y(v) + 4, fill: "var(--muted)", "font-size": 11 }, fmtCash(v));
    }
    add("path", { d: `${line}L${X(ms(last.at))} ${H - padB}L${padL} ${H - padB}Z`, fill: "var(--gold)", "fill-opacity": 0.1, stroke: "none" });
    add("path", { d: line, fill: "none", stroke: "var(--gold)", "stroke-width": 2, "vector-effect": "non-scaling-stroke" });
    add("circle", { cx: X(ms(last.at)), cy: Y(last.price), r: 3.5, fill: "var(--gold)" });
    box.replaceChildren(svg);
  }

  function renderMarket() {
    const lp = lastPrice();
    g("xLast").textContent = lp != null ? fmtCash(lp) : "—";
    if (lp != null && !st.priceTouched) g("xPrice").value = (lp / 100).toFixed(2);   // start from the market price
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
    g("xVol").textContent = fmtPi(recent.reduce((a, t) => a + t.qty, 0));

    const box = g("xTrades");
    if (!st.trades.length) box.replaceChildren(mk("div", "empty", "No trades yet."));
    else box.replaceChildren(...st.trades.slice(0, 20).map((t) => {
      const row = mk("div", "trade-row");
      row.append(
        mk("span", t.taker === "buy" ? "pos" : "neg", fmtCash(t.price)),
        mk("span", null, fmtPi(t.qty)),
        mk("span", "t", ago(ms(t.at)))
      );
      row.title = `${t.buyerName} bought from ${t.sellerName}`;
      return row;
    }));
    renderChart();
    renderBook();
    renderWallet();
  }

  function renderMyOrders() {
    const mine = [...st.myBuys, ...st.mySells].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    const box = g("xMine");
    if (!mine.length) { box.replaceChildren(mk("div", "empty", "No open orders.")); return; }
    box.replaceChildren(...mine.map((o) => {
      const row = mk("div", "order-row");
      const label = mk("span", o.side === "buy" ? "pos" : "neg", o.side === "buy" ? "Buy" : "Sell");
      const what = mk("span", null, `${fmtPi(o.remaining)} at ${fmtCash(o.price)}${o.filled ? ` · ${o.filled.toLocaleString()} filled` : ""}`);
      const btn = mk("button", "btn-ghost", "Cancel");
      btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = "Cancelling…";
        try { await cancelOrder(o); setMsg("Order cancelled; the money behind it is back in your wallet.", "ok"); }
        catch (err) { setMsg(errText(err), "err"); btn.disabled = false; btn.textContent = "Cancel"; }
      });
      row.append(label, what, btn);
      return row;
    }));
  }

  function renderWallet() {
    const w = st.wallet;
    if (!w.loaded) return;
    const lc = lockedCash(), lk = lockedCoins(), lp = lastPrice();
    g("wCash").textContent = fmtCash(w.cash + lc);
    g("wCashSub").textContent = `${fmtCash(w.cash)} available · ${fmtCash(lc)} in open orders`;
    g("wCoins").textContent = fmtPi(w.coins + lk);
    g("wCoinsSub").textContent = `${fmtPi(w.coins)} available · ${fmtPi(lk)} in open orders`;
    if (lp != null) {
      g("wWorth").textContent = fmtCash(w.cash + lc + (w.coins + lk) * lp);
      g("wWorthSub").textContent = `Pi coin valued at the last trade, ${fmtCash(lp)}`;
    } else {
      g("wWorth").textContent = fmtCash(w.cash + lc);
      g("wWorthSub").textContent = "Pi coin has no price until the first trade";
    }
    renderForm();
  }

  function renderHistory() {
    const box = g("wHistory");
    if (!st.history.length) { box.replaceChildren(mk("div", "empty", "Nothing yet.")); return; }
    box.replaceChildren(...st.history.map((h) => {
      const row = mk("div", "hist-row");
      const what = mk("div", "what");
      let amt;
      if (h.kind === "grant") {
        what.append(mk("div", null, "Starting Cash"));
        amt = mk("div", "amt pos", `+${fmtCash(h.amount)}`);
      } else {
        const buy = h.side === "buy";
        what.append(mk("div", null, `${buy ? "Bought" : "Sold"} ${fmtPi(h.qty)} at ${fmtCash(h.price)} ${buy ? "from" : "to"} ${h.with || "a player"}`));
        amt = mk("div", "amt " + (buy ? "neg" : "pos"), `${buy ? "-" : "+"}${fmtCash(h.qty * h.price)}`);
      }
      what.append(mk("div", "when", ago(ms(h.at))));
      row.append(what, amt);
      return row;
    }));
  }

  /* ---------- tabs ---------- */
  const TABS = ["mine", "wallet", "exchange"];
  function showTab(name) {
    if (!TABS.includes(name)) name = "mine";
    for (const t of TABS) {
      g(`tab-${t}`).classList.toggle("hidden", t !== name);
      const b = g(`tabBtn-${t}`);
      b.classList.toggle("active", t === name);
      b.setAttribute("aria-selected", String(t === name));
    }
    if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
    if (name === "exchange" && user) renderChart();   // the chart needs a visible box to measure
  }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore) {
    fb = firebaseNs; db = firestore;
    for (const t of TABS) g(`tabBtn-${t}`).addEventListener("click", () => showTab(t));
    window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
    showTab(location.hash.slice(1));

    g("xBuy").addEventListener("click", () => { st.side = "buy"; setMsg("", ""); renderForm(); });
    g("xSell").addEventListener("click", () => { st.side = "sell"; setMsg("", ""); renderForm(); });
    g("xType").addEventListener("change", (e) => { st.type = e.target.value; renderForm(); });
    g("xQty").addEventListener("input", renderForm);
    g("xPrice").addEventListener("input", () => { st.priceTouched = true; renderForm(); });
    g("xSubmit").addEventListener("click", onSubmit);
    setInterval(() => { if (user) { renderMarket(); renderHistory(); } }, 30000);   // keep "x min ago" fresh
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
      renderWallet();
    }, fail("Wallet")));
    unsubs.push(book("sell").orderBy("p", "asc").limit(40).onSnapshot((s) => {
      st.asks = s.docs.map(asOrder).sort((a, b) => a.p - b.p || ms(a.createdAt) - ms(b.createdAt));
      renderBook();
    }, fail("Order book")));
    unsubs.push(book("buy").orderBy("p", "desc").limit(40).onSnapshot((s) => {
      st.bids = s.docs.map(asOrder).sort((a, b) => b.p - a.p || ms(a.createdAt) - ms(b.createdAt));
      renderBook();
    }, fail("Order book")));
    unsubs.push(tradesCol().orderBy("at", "desc").limit(150).onSnapshot((s) => {
      st.trades = s.docs.map(asOrder);
      renderMarket();
    }, fail("Trades")));
    for (const side of ["buy", "sell"]) {
      unsubs.push(book(side).where("uid", "==", uid).onSnapshot((s) => {
        const open = s.docs.map(asOrder).filter((o) => typeof o.p === "number");
        if (side === "buy") st.myBuys = open; else st.mySells = open;
        renderMyOrders();
        renderWallet();
      }, fail("Your orders")));
    }
    unsubs.push(userRef(uid).collection("history").orderBy("at", "desc").limit(50).onSnapshot((s) => {
      st.history = s.docs.map(asOrder);
      renderHistory();
    }, fail("History")));
  }

  function signOut() {
    unsubs.forEach((u) => u());
    unsubs = [];
    user = null;
    Object.assign(st, {
      wallet: { cash: 0, coins: 0, loaded: false },
      asks: [], bids: [], trades: [], myBuys: [], mySells: [], history: [], busy: false
    });
    if (!g("xMsg")) return;
    // Clear the previous player's numbers so they never flash up for the next one
    setMsg("", "");
    for (const id of ["wCash", "wCoins", "wWorth"]) g(id).textContent = "…";
    for (const id of ["wCashSub", "wCoinsSub", "wWorthSub", "xAvail"]) g(id).textContent = "";
    for (const id of ["wHistory", "xMine"]) g(id).replaceChildren(mk("div", "empty", "Loading…"));
  }

  return { init, signIn, signOut };
})();
