/* =====================================================================
   Pi Miner — Phase 2: companies and the stock market
   ---------------------------------------------------------------------
   companies/{TICKER}                 the company: treasury, share count,
                                      controller, hourly dividend, offering
   companies/{TICKER}/holders/{uid}   who owns how many shares
                                      ("market" = shares the market bought
                                      under the 10-day rule; they earn nothing)

   • Founding costs a $1,000 fee plus any starting investment, which goes
     into the treasury. The founder gets 1,000,000 shares.
   • Control doesn't follow share count: the founder runs the company until
     they hand control to another shareholder themselves (Stocks tab).
   • The controller sets a total dividend per hour, paid from the treasury
     to every shareholder by share count, and can offer new shares for
     sale; that money goes into the treasury. Money only leaves the
     treasury as dividends, so a controller can't drain it.
   • No server runs on the free plan, so payouts catch up whenever any
     player has the game open: every hour that passed gets paid at once.
   Shares trade on the Exchange tab, on a market per ticker.
   ===================================================================== */
const Companies = (() => {
  const FOUND_FEE = 100000;          // $1,000 in cents
  const FOUNDER_SHARES = 1000000;
  const HOUR = 3600000;
  const MAX_CATCHUP_HOURS = 168;     // a payout covers at most a week of missed hours
  const MAX_PAYEES = 200;            // shareholders paid per payout (Firestore: 500 writes per transaction)
  // Same list as Factory.INDUSTRIES: the industry decides what the company's lines can make
  const INDUSTRIES = ["Cars", "Electronics", "Steel and metals", "Mining", "Energy", "Farming", "Food", "Retail", "Software", "Finance"];

  let fb = null, db = null, user = null;
  let unsubs = [], detailUnsubs = [], holderUnsubs = new Map();
  const st = { companies: [], selected: null, top: [], mine: new Map(), busy: false };

  /* ---------- helpers ---------- */
  const g = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtCash = (c) => Economy.fmtCash(c);
  const fmtShares = (n) => `${n.toLocaleString()} share${n === 1 ? "" : "s"}`;
  const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(part / whole < 0.01 ? 3 : 1)}%` : "0%");
  const now = () => fb.firestore.FieldValue.serverTimestamp();
  const inc = (n) => fb.firestore.FieldValue.increment(n);
  const myName = () => ((user && user.displayName) || "Anonymous Miner").slice(0, 40);
  const userRef = (uid) => db.collection("users").doc(uid);
  const companyRef = (t) => db.collection("companies").doc(t);
  const holdersCol = (t) => companyRef(t).collection("holders");
  const holderRef = (t, uid) => holdersCol(t).doc(uid);
  const byTicker = (t) => st.companies.find((c) => c.ticker === t);
  const toCents = (v) => Math.round(Number(v) * 100);
  const errText = (e) => Economy.errText(e);

  function setMsg(id, text, kind) {
    const m = g(id);
    if (!m) return;
    m.textContent = text;
    m.className = "status" + (kind ? " " + kind : "");
  }

  /* ---------- actions ---------- */
  async function found({ ticker, name, industry, invest }) {
    const uid = user.uid, me = myName();
    const ref = companyRef(ticker);
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      const w = (await tx.get(userRef(uid))).data() || {};
      if (existing.exists) throw new Error(`The ticker ${ticker} is taken. Pick another.`);
      const cost = FOUND_FEE + invest;
      if ((w.cash || 0) < cost) throw new Error(`Founding needs ${fmtCash(cost)} and you have ${fmtCash(w.cash || 0)}.`);
      tx.set(ref, {
        ticker, name, industry, founder: uid, founderName: me, controller: uid, controllerName: me,
        shares: FOUNDER_SHARES, treasury: invest, dividendPerHour: 0, offerPrice: 0, offerLeft: 0,
        lastPayoutAt: Math.floor(Date.now() / HOUR) * HOUR, createdAt: now()
      });
      const coins = Economy.payFee(tx, w, "Founding a company");
      tx.set(holderRef(ticker, uid), { uid, name: me, shares: FOUNDER_SHARES });
      tx.update(userRef(uid), { cash: w.cash - cost, coins });
      tx.set(userRef(uid).collection("history").doc(`founded-${ticker}`), { kind: "founded", asset: ticker, amount: cost, at: now() });
    });
  }

  async function buyOffering(ticker, qty) {
    const uid = user.uid;
    await db.runTransaction(async (tx) => {
      const c = (await tx.get(companyRef(ticker))).data();
      const w = (await tx.get(userRef(uid))).data() || {};
      const h = await tx.get(holderRef(ticker, uid));
      if (!c.offerLeft || !c.offerPrice) throw new Error("The company isn't offering shares right now.");
      if (qty > c.offerLeft) throw new Error(`Only ${fmtShares(c.offerLeft)} are on offer.`);
      const cost = qty * c.offerPrice;
      if ((w.cash || 0) < cost) throw new Error(`That costs ${fmtCash(cost)} and you have ${fmtCash(w.cash || 0)}.`);
      const coins = Economy.payFee(tx, w, "Buying shares");
      tx.update(companyRef(ticker), { shares: c.shares + qty, offerLeft: c.offerLeft - qty, treasury: c.treasury + cost });
      tx.update(userRef(uid), { cash: w.cash - cost, coins });
      tx.set(holderRef(ticker, uid), { uid, name: myName(), shares: ((h.exists && h.data().shares) || 0) + qty }, { merge: true });
      tx.set(userRef(uid).collection("history").doc(), { kind: "offering", asset: ticker, qty, price: c.offerPrice, at: now() });
    });
  }

  async function deposit(ticker, amount) {
    const uid = user.uid;
    await db.runTransaction(async (tx) => {
      const c = (await tx.get(companyRef(ticker))).data();
      if (!c || c.controller !== uid) throw new Error(`Only whoever runs ${ticker} can add Cash to its treasury.`);
      const w = (await tx.get(userRef(uid))).data() || {};
      if ((w.cash || 0) < amount) throw new Error(`You have ${fmtCash(w.cash || 0)} available.`);
      const coins = Economy.payFee(tx, w, "Adding Cash to a treasury");
      tx.update(companyRef(ticker), { treasury: c.treasury + amount });
      tx.update(userRef(uid), { cash: w.cash - amount, coins });
      tx.set(userRef(uid).collection("history").doc(), { kind: "deposit", asset: ticker, amount, at: now() });
    });
  }

  async function saveSettings(ticker, { dividendPerHour, offerPrice, offerLeft, industry, tradingClosed, tariff }) {
    await companyRef(ticker).update({ dividendPerHour, offerPrice, offerLeft, industry, tradingClosed, ...(tariff != null ? { tariff } : {}) });
  }

  // The controller hands the company to another shareholder (a player, not the market or a bot)
  async function handOver(ticker, uid) {
    const me = user.uid;
    await db.runTransaction(async (tx) => {
      const c = (await tx.get(companyRef(ticker))).data();
      const h = await tx.get(holderRef(ticker, uid));
      if (!c || c.controller !== me) throw new Error(`Only whoever runs ${ticker} can hand it over.`);
      if (uid === "market" || String(uid).startsWith("bot-")) throw new Error("Control can only go to a player.");
      if (!h.exists || !(h.data().shares > 0)) throw new Error("Control can only go to someone who owns shares.");
      tx.update(companyRef(ticker), { controller: uid, controllerName: h.data().name });
    });
  }

  // Pay every whole hour since the last payout, in one go.
  async function payDividends(c) {
    const hs = await holdersCol(c.ticker).orderBy("shares", "desc").limit(MAX_PAYEES + 1).get();
    const payees = hs.docs.map((d) => d.data()).filter((h) => h.uid !== "market" && h.shares > 0).slice(0, MAX_PAYEES);
    return db.runTransaction(async (tx) => {
      const ref = companyRef(c.ticker);
      const d = (await tx.get(ref)).data();
      const hours = Math.floor((Date.now() - d.lastPayoutAt) / HOUR);
      if (hours < 1) return null;
      const next = d.lastPayoutAt + hours * HOUR;
      const paidHours = Math.min(hours, MAX_CATCHUP_HOURS);
      // Pay as many of the missed hours as the treasury can cover; hours it can't cover are skipped
      const affordable = d.dividendPerHour ? Math.min(paidHours, Math.floor(d.treasury / d.dividendPerHour)) : 0;
      const due = d.dividendPerHour * affordable;
      const report = (amount) => ({ at: next, hours, paidHours: affordable, amount, perHour: d.dividendPerHour, treasury: d.treasury - amount });
      if (!due) { tx.update(ref, { lastPayoutAt: next, lastPayout: report(0) }); return 0; }
      let paid = 0;
      for (const h of payees) {
        const amt = Math.floor((due * h.shares) / d.shares);
        if (amt <= 0) continue;
        tx.update(userRef(h.uid), { cash: inc(amt) });
        tx.set(userRef(h.uid).collection("history").doc(`div-${c.ticker}-${next}`),
          { kind: "dividend", asset: c.ticker, amount: amt, hours: affordable, at: now() });
        paid += amt;
      }
      tx.update(ref, { treasury: d.treasury - paid, lastPayoutAt: next, lastPayout: report(paid) });
      return paid;
    });
  }

  async function upkeep() {
    if (!user) return;
    for (const c of st.companies) {
      if (Date.now() - c.lastPayoutAt >= HOUR) await payDividends(c).catch((e) => console.warn("Dividend payout failed", c.ticker, e));
    }
  }

  /* ---------- rendering ---------- */
  function renderList() {
    const box = g("sList");
    if (!st.companies.length) {
      box.replaceChildren(mk("div", "empty", "No companies yet. Found the first one below."));
      return;
    }
    box.replaceChildren(...st.companies.map((c) => {
      const row = mk("button", "co-row" + (st.selected === c.ticker ? " on" : ""));
      const mineN = st.mine.get(c.ticker) || 0;
      const left = mk("span", "co-name");
      left.append(mk("b", "ticker", c.ticker), document.createTextNode(` ${c.name}`));
      const sub = mk("span", "co-sub", `${c.industry}${mineN ? ` · you own ${pct(mineN, c.shares)}` : ""}`);
      const price = mk("span", "co-price", c.lastPrice ? fmtCash(c.lastPrice) : "no trades");
      const info = mk("span", "co-info");
      info.append(left, sub);
      row.append(info, price);
      row.addEventListener("click", () => select(c.ticker));
      return row;
    }));
  }

  function kpi(label, value, sub) {
    const d = mk("div", "kpi");
    d.append(mk("span", "k", label), mk("b", null, value));
    if (sub) d.append(mk("span", "ks", sub));
    return d;
  }

  function field(id, label, attrs) {
    const l = mk("label", "field");
    l.htmlFor = id;
    const input = mk("input");
    input.id = id;
    Object.assign(input, attrs);
    l.append(mk("span", null, label), input);
    return l;
  }

  function actionButton(label, cls, onClick, msgId) {
    const b = mk("button", cls, label);
    b.addEventListener("click", async () => {
      if (st.busy) return;
      st.busy = true; b.disabled = true;
      setMsg(msgId, "", "");
      try { const done = await onClick(); if (done) setMsg(msgId, done, "ok"); }
      catch (e) { setMsg(msgId, errText(e), "err"); }
      finally { st.busy = false; b.disabled = false; }
    });
    return b;
  }

  function renderDetail() {
    const box = g("sDetail");
    const c = st.selected && byTicker(st.selected);
    if (!c) {
      box.replaceChildren(mk("h2", null, "Company"), mk("div", "empty", "Pick a company on the left to see its details."));
      return;
    }
    const mineN = st.mine.get(c.ticker) || 0;
    const isController = user && c.controller === user.uid;
    const perK = c.shares ? (c.dividendPerHour * 1000) / c.shares : 0;
    const nextPay = c.lastPayoutAt + HOUR;
    const mins = Math.max(0, Math.ceil((nextPay - Date.now()) / 60000));

    const head = mk("div", "co-head");
    const title = mk("h2", "co-title");
    title.append(mk("b", "ticker", c.ticker), document.createTextNode(` ${c.name}`));
    head.append(title, mk("span", "chip", c.industry));
    const ctl = mk("p", "co-ctl", `Controlled by ${isController ? "you" : c.controllerName} · founded by ${c.founder === (user && user.uid) ? "you" : c.founderName}`);

    const kpis = mk("div", "kpis");
    kpis.append(
      kpi("Last price", c.lastPrice ? fmtCash(c.lastPrice) : "—", c.lastPrice ? `company worth ${fmtCash(c.lastPrice * c.shares)}` : "no trades yet"),
      kpi("Treasury", fmtCash(c.treasury), "the company's own Cash"),
      kpi("Dividend", c.dividendPerHour ? `${fmtCash(c.dividendPerHour)}/hour` : "None",
        c.dividendPerHour ? `${fmtCash(Math.floor(perK))} per 1,000 shares/hour` : "the controller hasn't set one"),
      kpi("You own", fmtShares(mineN), `${pct(mineN, c.shares)} of ${c.shares.toLocaleString()}`)
    );

    const note = mk("p", "co-note");
    if (c.dividendPerHour && c.treasury < c.dividendPerHour) note.textContent = "The treasury can't cover the next hour's dividend, so it will be skipped until the treasury has more Cash.";
    else if (c.dividendPerHour) note.textContent = `Next payout in about ${mins} min (paid when anyone has the game open).`;
    if (c.dividendPerHour) note.textContent += " Wages and line upkeep come out of the treasury first.";
    // What happened at the last payout
    const lp = c.lastPayout;
    const last = mk("p", "co-note" + (lp && lp.paidHours < lp.hours ? " neg" : ""));
    if (lp) {
      const when = new Date(lp.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const skipped = lp.hours - lp.paidHours;
      last.textContent = lp.paidHours
        ? `Last payout (${when}): ${fmtCash(lp.amount)} for ${lp.paidHours} hour${lp.paidHours === 1 ? "" : "s"}${skipped ? `. ${skipped} more hour${skipped === 1 ? " was" : "s were"} skipped: the treasury only had enough for ${lp.paidHours}` : ""}.`
        : lp.perHour
          ? `Last payout (${when}) was skipped: the treasury had ${fmtCash(lp.treasury)}, less than one hour's ${fmtCash(lp.perHour)} dividend.`
          : `Last payout (${when}): nothing, because no dividend was set.`;
    }

    const trade = c.tradingClosed
      ? mk("p", "co-note", `${c.ticker}'s controller has closed trading in its shares, so they can't be bought or sold between players. New shares only come from the company's own offerings${c.offerLeft > 0 && c.offerPrice > 0 ? " (one is open below)" : ""}.`)
      : mk("button", "btn-primary buy", `Trade ${c.ticker} shares on the exchange`);
    if (!c.tradingClosed) trade.addEventListener("click", () => Economy.openMarket(c.ticker));

    const sections = [head, ctl, kpis, note, ...(lp ? [last] : []), trade];

    // Share offering
    if (c.offerLeft > 0 && c.offerPrice > 0) {
      const sec = mk("div", "co-sec");
      sec.append(mk("h3", null, `New shares from the company: ${fmtShares(c.offerLeft)} at ${fmtCash(c.offerPrice)}`));
      const row = mk("div", "co-form");
      row.append(field("sOfferQty", "How many", { type: "number", min: 1, step: 1, value: Math.min(100, c.offerLeft) }));
      row.append(actionButton("Buy from company", "btn-ghost", async () => {
        const q = Math.floor(Number(g("sOfferQty").value));
        if (!(q >= 1)) throw new Error("Enter how many whole shares to buy.");
        await buyOffering(c.ticker, q);
        return `✓ Bought ${fmtShares(q)}; ${fmtCash(q * c.offerPrice)} went into the treasury.`;
      }, "sOfferMsg"));
      sec.append(row, mk("div", "status", ""));
      sec.lastChild.id = "sOfferMsg";
      sections.push(sec);
    }

    // Add Cash to the treasury (the controller only)
    if (isController) {
      const dep = mk("div", "co-sec");
      dep.append(mk("h3", null, "Add Cash to the treasury"));
      const drow = mk("div", "co-form");
      drow.append(field("sDeposit", "Amount ($)", { type: "number", min: 0.01, step: 0.01, value: "100.00" }));
      drow.append(actionButton("Add to treasury", "btn-ghost", async () => {
        const a = toCents(g("sDeposit").value);
        if (!(a >= 1)) throw new Error("Enter an amount of at least $0.01.");
        await deposit(c.ticker, a);
        return `✓ Added ${fmtCash(a)}. It can only come out as dividends to every shareholder.`;
      }, "sDepositMsg"));
      const dmsg = mk("div", "status"); dmsg.id = "sDepositMsg";
      dep.append(drow, dmsg);
      sections.push(dep);
    }

    // Controller settings
    if (isController) {
      const sec = mk("div", "co-sec ctl");
      sec.append(mk("h3", null, "You control this company"));
      const r1 = mk("div", "co-form");
      const indL = mk("label", "field"); indL.htmlFor = "sSetIndustry";
      const indSel = mk("select"); indSel.id = "sSetIndustry";
      indSel.replaceChildren(...[...new Set([...INDUSTRIES, c.industry])].map((i) => { const o = mk("option", null, i); o.value = i; return o; }));
      indSel.value = c.industry;
      indL.append(mk("span", null, "Industry (what its factory makes)"), indSel);
      r1.append(field("sDiv", "Dividend per hour, total ($)", { type: "number", min: 0, step: 0.01, value: (c.dividendPerHour / 100).toFixed(2) }), indL);
      // Energy companies can sell electricity to miners
      const tariffRow = mk("div", "co-form");
      if (c.industry === "Energy") {
        tariffRow.append(field("sTariff", "Electricity for miners ($ per MWh, 0 = not selling)", { type: "number", min: 0, step: 0.01, value: ((c.tariff || 0) / 100).toFixed(2) }));
        tariffRow.append(mk("p", "co-note", `The grid charges $8.00/MWh. Miners who pick you pay into the treasury as they mine, and your power lines deliver what they bought before selling to everyday buyers.${c.powerOwed ? ` Still to deliver: ${(c.powerOwed / 1000).toFixed(1)} MWh${c.powerOwed >= 100000 ? " (over 100 MWh: no new customers until your plants catch up)" : ""}.` : ""}`));
      }
      const closeL = mk("label", "check-row"); closeL.htmlFor = "sClosed";
      const closeBox = mk("input"); closeBox.type = "checkbox"; closeBox.id = "sClosed"; closeBox.checked = !!c.tradingClosed;
      closeL.append(closeBox, mk("span", null, "Close trading in our shares: no buying or selling between players on the Exchange. New shares only come from our own offerings."));
      const r2 = mk("div", "co-form");
      r2.append(
        field("sOfferPrice", "Offer new shares at ($ each)", { type: "number", min: 0, step: 0.01, value: (c.offerPrice / 100).toFixed(2) }),
        field("sOfferLeft", "How many new shares", { type: "number", min: 0, step: 1, value: c.offerLeft })
      );
      const save = actionButton("Save", "btn-primary buy", async () => {
        const dividendPerHour = toCents(g("sDiv").value);
        const offerPrice = toCents(g("sOfferPrice").value);
        const offerLeft = Math.floor(Number(g("sOfferLeft").value));
        if (!(dividendPerHour >= 0) || !(offerPrice >= 0) || !(offerLeft >= 0)) throw new Error("Use zero or more for every box.");
        if (offerLeft > 0 && !offerPrice) throw new Error("Set a price for the new shares.");
        if (offerLeft > 10000000) throw new Error("Offer at most 10,000,000 new shares at a time.");
        const tariff = g("sTariff") ? toCents(g("sTariff").value) : null;
        if (tariff != null && !(tariff >= 0 && tariff <= 100000)) throw new Error("Set a tariff between $0 and $1,000 per MWh.");
        await saveSettings(c.ticker, { dividendPerHour, offerPrice, offerLeft, industry: g("sSetIndustry").value, tradingClosed: g("sClosed").checked, tariff });
        return "✓ Saved.";
      }, "sCtlMsg");
      const cmsg = mk("div", "status"); cmsg.id = "sCtlMsg";
      sec.append(r1, r2, tariffRow, closeL, mk("p", "co-note", "Dividends come out of the treasury every hour and are split by share count. Selling new shares raises Cash for the treasury but gives each share a smaller slice. Changing industry changes what the factory's lines can make; anything already queued still finishes."), save, cmsg);
      // Hand control to another shareholder (two clicks, so it can't happen by accident)
      const heirs = st.top.filter((h) => h.shares > 0 && h.uid !== c.controller && h.uid !== "market" && !String(h.uid).startsWith("bot-"));
      const ho = mk("div", "co-sec");
      ho.append(mk("h3", null, "Hand over control"));
      if (!heirs.length) ho.append(mk("p", "co-note", "Owning the most shares doesn't make someone the controller: you run this company until you hand it over. Only a player who owns shares can take it."));
      else {
        const row = mk("div", "co-form");
        const l = mk("label", "field"); l.htmlFor = "sHeir";
        const sel = mk("select"); sel.id = "sHeir";
        sel.replaceChildren(...heirs.map((h) => { const o = mk("option", null, `${h.name} (${pct(h.shares, c.shares)})`); o.value = h.uid; return o; }));
        l.append(mk("span", null, "Give control to"), sel);
        const go = mk("button", "btn-ghost", "Hand over control");
        const hmsg = mk("div", "status"); hmsg.id = "sHandMsg";
        let armed = null;
        sel.addEventListener("change", () => { armed = null; go.textContent = "Hand over control"; });
        go.addEventListener("click", async () => {
          const h = heirs.find((x) => x.uid === sel.value);
          if (!h) return;
          if (armed !== h.uid) { armed = h.uid; go.textContent = `Click again to give ${c.ticker} to ${h.name}`; hmsg.textContent = `You'd stop running ${c.ticker}: its factory, treasury and settings go to ${h.name}. You keep your shares.`; hmsg.className = "status"; return; }
          go.disabled = true;
          try { await handOver(c.ticker, h.uid); hmsg.textContent = `✓ ${h.name} now runs ${c.ticker}.`; hmsg.className = "status ok"; }
          catch (e) { hmsg.textContent = errText(e); hmsg.className = "status err"; go.disabled = false; }
        });
        row.append(l, go);
        ho.append(mk("p", "co-note", "Owning the most shares doesn't make someone the controller: you run this company until you hand it over."), row, hmsg);
      }
      sections.push(sec, ho);
    }

    // Shareholders
    const sh = mk("div", "co-sec");
    sh.append(mk("h3", null, "Biggest shareholders"));
    const list = st.top.filter((h) => h.shares > 0).slice(0, 10);
    if (!list.length) sh.append(mk("div", "empty", "Loading…"));
    list.forEach((h, i) => {
      const row = mk("div", "lb-row" + (user && h.uid === user.uid ? " me" : ""));
      row.append(
        mk("span", "lb-rank", i + 1),
        mk("span", "lb-name", `${h.uid === "market" ? "The market (10-day buyouts)" : h.name}${user && h.uid === user.uid ? " (you)" : ""}${h.uid === c.controller ? " · in control" : ""}`),
        mk("span", "lb-coins", pct(h.shares, c.shares))
      );
      sh.append(row);
    });
    sections.push(sh);

    box.replaceChildren(...sections);
  }

  function renderPortfolio() {
    const box = g("sPortfolio");
    const rows = st.companies.filter((c) => (st.mine.get(c.ticker) || 0) > 0);
    let total = 0;
    if (!rows.length) {
      box.replaceChildren(mk("div", "empty", "You don't own any shares yet."));
    } else {
      box.replaceChildren(...rows.map((c) => {
        const n = st.mine.get(c.ticker);
        const value = (c.lastPrice || 0) * n;
        total += value;
        const perHour = c.shares ? Math.floor((c.dividendPerHour * n) / c.shares) : 0;
        const row = mk("div", "hist-row");
        const what = mk("div", "what");
        what.append(
          mk("div", null, `${c.ticker} · ${fmtShares(n)} (${pct(n, c.shares)})${c.controller === user.uid ? " · you control it" : ""}`),
          mk("div", "when", !perHour ? "no dividend"
            : c.treasury < c.dividendPerHour ? "dividend skipped: the treasury can't cover it"
            : `earning about ${fmtCash(perHour)}/hour in dividends`)
        );
        row.append(what, mk("div", "amt", c.lastPrice ? fmtCash(value) : "no price yet"));
        row.style.cursor = "pointer";
        row.addEventListener("click", () => select(c.ticker));
        return row;
      }));
    }
    Economy.setShareValue(total);
  }

  function renderAll() { renderList(); renderDetail(); renderPortfolio(); }

  function select(ticker) {
    st.selected = ticker;
    st.top = [];
    detailUnsubs.forEach((u) => u());
    detailUnsubs = [holdersCol(ticker).orderBy("shares", "desc").limit(30).onSnapshot((s) => {
      st.top = s.docs.map((d) => d.data());
      renderDetail();
    }, (e) => setMsg("sFoundMsg", errText(e), "err"))];
    renderAll();
  }

  /* ---------- found form ---------- */
  function initFoundForm() {
    const sel = g("sIndustry");
    sel.replaceChildren(...INDUSTRIES.map((i) => { const o = mk("option", null, i); o.value = i; return o; }));
    g("sTicker").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4); });
    g("sFoundBtn").addEventListener("click", async () => {
      if (st.busy) return;
      const ticker = g("sTicker").value.trim();
      const name = g("sCoName").value.trim();
      const industry = g("sIndustry").value;
      const invest = toCents(g("sInvest").value || 0);
      if (!/^[A-Z]{3,4}$/.test(ticker) || ticker === "PI") return setMsg("sFoundMsg", "A ticker is 3 or 4 capital letters, and PI is taken by Pi coin.", "err");
      if (name.length < 2 || name.length > 40) return setMsg("sFoundMsg", "Give the company a name of 2 to 40 characters.", "err");
      if (!(invest >= 0)) return setMsg("sFoundMsg", "The starting investment can't be negative.", "err");
      st.busy = true; g("sFoundBtn").disabled = true; setMsg("sFoundMsg", "", "");
      try {
        await found({ ticker, name, industry, invest });
        setMsg("sFoundMsg", `✓ Founded ${ticker}. You own all ${FOUNDER_SHARES.toLocaleString()} shares and control it.`, "ok");
        g("sTicker").value = ""; g("sCoName").value = "";
        select(ticker);
      } catch (e) { setMsg("sFoundMsg", errText(e), "err"); }
      finally { st.busy = false; g("sFoundBtn").disabled = false; }
    });
  }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore) {
    fb = firebaseNs; db = firestore;
    initFoundForm();
    setInterval(() => { if (user) renderDetail(); }, 60000);   // keep "next payout in" fresh
  }

  function watchMine(ticker) {
    if (holderUnsubs.has(ticker)) return;
    holderUnsubs.set(ticker, holderRef(ticker, user.uid).onSnapshot((s) => {
      st.mine.set(ticker, (s.exists && s.data().shares) || 0);
      renderAll();
    }, () => {}));
  }

  function signIn(u) {
    signOut();
    user = u;
    unsubs.push(db.collection("companies").orderBy("createdAt", "asc").limit(100).onSnapshot((s) => {
      st.companies = s.docs.map((d) => d.data({ serverTimestamps: "estimate" }));
      st.companies.forEach((c) => watchMine(c.ticker));
      Economy.setMarkets(st.companies);
      if (!st.selected && st.companies.length) select(st.companies[0].ticker);
      else renderAll();
    }, (e) => setMsg("sFoundMsg", `Companies: ${errText(e)}`, "err")));
  }

  function signOut() {
    unsubs.forEach((u) => u());
    detailUnsubs.forEach((u) => u());
    holderUnsubs.forEach((u) => u());
    unsubs = []; detailUnsubs = []; holderUnsubs = new Map();
    user = null;
    Object.assign(st, { companies: [], selected: null, top: [], mine: new Map(), busy: false });
    if (!g("sList")) return;
    setMsg("sFoundMsg", "", "");
    g("sTicker").value = ""; g("sCoName").value = "";
    renderAll();
  }

  return { init, signIn, signOut, upkeep };
})();
