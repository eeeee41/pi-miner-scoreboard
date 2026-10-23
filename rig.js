/* =====================================================================
   Pi Miner — Phase 10: mining licences, rigs and electricity
   ---------------------------------------------------------------------
   users/{uid}.rig        0 = no licence, 1–4 = the rig tier owned
   users/{uid}.powerFrom  ticker of the Energy company you buy power from, or null for the grid

   • Mining needs a licence, which comes with a basic rig. A rig pays its
     share of each block reward (60% for the basic rig, up to 100% for a
     data centre); the rest of the reward is never created.
   • Rigs draw power while mining, and the bill is paid automatically
     every 5 minutes (and when you stop), with no Pi fee. The grid charges
     $8/MWh and that money leaves the game. An Energy company can sell
     power to miners at its own tariff instead (set on the Stocks tab).
   • What a miner buys from an Energy company goes into its treasury
     straight away, and is added to its `powerOwed` (kWh). Its power lines
     deliver that first; only what's left over goes to everyday buyers.
     A company owing more than 100 MWh takes no new customers until its
     plants catch up.
   ===================================================================== */
const Rig = (() => {
  const TIERS = [
    { name: "No licence",          share: 0,    draw: 0,   cost: 0 },
    { name: "Basic rig (licence)", share: 0.6,  draw: 0.5, cost: 50000 },
    { name: "GPU rig",             share: 0.75, draw: 1,   cost: 300000 },
    { name: "Mining farm",         share: 0.9,  draw: 2,   cost: 1500000 },
    { name: "Data centre",         share: 1,    draw: 4,   cost: 6000000 }
  ];
  const GRID_TARIFF = 800;            // cents per MWh
  const BILL_MS = 5 * 60000;
  const MAX_OWED_KWH = 100000;        // 100 MWh behind: no new customers

  let fb = null, db = null, user = null, unsub = null, hooks = {};
  const st = { wallet: null, meterSince: null, carryKwh: 0, sessionCost: 0, sessionKwh: 0, busy: false, lastBill: 0 };

  const g = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtCash = (c) => Economy.fmtCash(c);
  const userRef = () => db.collection("users").doc(user.uid);
  const companyRef = (t) => db.collection("companies").doc(t);
  const now = () => fb.firestore.FieldValue.serverTimestamp();
  const tier = () => (st.wallet && st.wallet.rig) || 0;
  const licensed = () => tier() > 0;
  // Energy companies selling power to miners right now
  const suppliers = () => (typeof Factory !== "undefined" ? Factory.companies() : [])
    .filter((c) => c.industry === "Energy" && c.tariff > 0 && (c.powerOwed || 0) < MAX_OWED_KWH)
    .sort((a, b) => a.tariff - b.tariff);
  const supplier = () => { const t = st.wallet && st.wallet.powerFrom; return t ? suppliers().find((c) => c.ticker === t) || null : null; };
  const tariff = () => (supplier() ? supplier().tariff : GRID_TARIFF);
  // Pi this rig gets from a block whose full reward is `full`
  const reward = (full) => Math.floor(full * TIERS[tier()].share);

  function setMsg(text, kind) {
    const m = g("rigMsg");
    if (!m) return;
    m.textContent = text;
    m.className = "status" + (kind ? " " + kind : "");
  }

  /* ---------- buying ---------- */
  const upgrade = () => db.runTransaction(async (tx) => {
    const w = (await tx.get(userRef())).data() || {};
    const next = (w.rig || 0) + 1;
    if (next >= TIERS.length) throw new Error("You already have the biggest rig.");
    const t = TIERS[next];
    if ((w.cash || 0) < t.cost) throw new Error(`${t.name} costs ${fmtCash(t.cost)}; you have ${fmtCash(w.cash || 0)} on hand.`);
    const coins = Economy.payFee(tx, w, next === 1 ? "A mining licence" : "A rig upgrade");
    tx.update(userRef(), { rig: next, cash: w.cash - t.cost, coins });
    tx.set(userRef().collection("history").doc(), { kind: "rig", rig: t.name, amount: t.cost, at: now() });
    return next === 1 ? `✓ Licensed to mine. Your basic rig keeps ${Math.round(t.share * 100)}% of each block reward.` : `✓ Upgraded to a ${t.name.toLowerCase()}: ${Math.round(t.share * 100)}% of each block reward.`;
  });
  const choose = (ticker) => userRef().update({ powerFrom: ticker || null })
    .then(() => (ticker ? `✓ You now buy power from ${ticker}.` : "✓ You now buy power from the grid."));

  /* ---------- the meter ---------- */
  function start() { st.meterSince = Date.now(); st.sessionCost = 0; st.sessionKwh = 0; render(); }
  // Pay for the power used since the meter last ran. Returns false if the bill couldn't be paid.
  async function bill(stopping) {
    if (!st.meterSince || !licensed()) return true;
    const t = Date.now();
    const kwh = TIERS[tier()].draw * ((t - st.meterSince) / 3600000) * 1000 + st.carryKwh;
    const whole = Math.floor(kwh);
    st.meterSince = stopping ? null : t;
    st.carryKwh = kwh - whole;
    if (!whole) return true;
    const sup = supplier(), price = sup ? sup.tariff : GRID_TARIFF;
    const cost = Math.ceil((whole * price) / 1000);
    try {
      await db.runTransaction(async (tx) => {
        const w = (await tx.get(userRef())).data() || {};
        const c = sup ? (await tx.get(companyRef(sup.ticker))).data() : null;
        if ((w.cash || 0) < cost) throw Object.assign(new Error("broke"), { broke: true });
        tx.update(userRef(), { cash: w.cash - cost });
        if (c && c.tariff === price) tx.update(companyRef(sup.ticker), { treasury: c.treasury + cost, powerOwed: (c.powerOwed || 0) + whole });
        tx.set(userRef().collection("history").doc(), { kind: "power", asset: c ? sup.ticker : "GRID", kwh: whole, amount: cost, at: now() });
      });
      st.sessionCost += cost; st.sessionKwh += whole;
      render();
      return true;
    } catch (e) {
      if (e.broke) {
        st.meterSince = null;
        setMsg(`Mining stopped: the ${fmtCash(cost)} electricity bill is more than the Cash you have on hand.`, "err");
        if (hooks.stop) hooks.stop();
        return false;
      }
      console.warn("Electricity bill:", e);
      return true;
    }
  }
  const stop = () => bill(true);

  /* ---------- rendering ---------- */
  function render() {
    if (!g("rigInfo")) return;
    const w = st.wallet;
    if (!w) { g("rigInfo").replaceChildren(mk("div", "empty", "Loading…")); return; }
    const t = TIERS[tier()], next = TIERS[tier() + 1];
    const kpis = mk("div", "kpis four");
    const k = (label, value, sub) => { const d = mk("div", "kpi"); d.append(mk("span", "k", label), mk("b", null, value)); if (sub) d.append(mk("span", "ks", sub)); return d; };
    kpis.append(
      k("Rig", licensed() ? t.name : "No licence", licensed() ? `keeps ${Math.round(t.share * 100)}% of each block reward` : "you need one to mine"),
      k("Power draw", licensed() ? `${t.draw} MW` : "—", licensed() ? `about ${fmtCash(Math.ceil(t.draw * tariff()))}/hour at ${fmtCash(tariff())}/MWh` : ""),
      k("Bought from", supplier() ? supplier().ticker : "The grid", supplier() ? supplier().name : `${fmtCash(GRID_TARIFF)}/MWh`),
      k("This session", fmtCash(st.sessionCost), `${(st.sessionKwh / 1000).toFixed(2)} MWh used`)
    );
    const parts = [kpis];
    if (next) {
      const b = mk("button", licensed() ? "btn-ghost" : "btn-primary buy",
        licensed() ? `Upgrade to a ${next.name.toLowerCase()} · ${fmtCash(next.cost)} (${Math.round(next.share * 100)}% of rewards, ${next.draw} MW)` : `Buy a mining licence · ${fmtCash(next.cost)}`);
      b.id = "rigUpgrade";
      b.addEventListener("click", () => run(upgrade));
      parts.push(b);
    } else parts.push(mk("p", "co-note", "You have the biggest rig: every block you mine pays the full reward."));
    // Power supplier
    const sel = mk("select"); sel.id = "rigPower";
    // Every Energy company, so nobody wonders where one went: those that can't take customers are greyed out, with why
    const energy = (typeof Factory !== "undefined" ? Factory.companies() : []).filter((c) => c.industry === "Energy")
      .sort((a, b) => (a.tariff || Infinity) - (b.tariff || Infinity));
    const why = (c) => !(c.tariff > 0) ? "not selling to miners: no tariff set on the Stocks tab"
      : (c.powerOwed || 0) >= MAX_OWED_KWH ? `full: ${Math.round((c.powerOwed || 0) / 1000).toLocaleString()} MWh still to deliver (limit ${MAX_OWED_KWH / 1000})` : "";
    const opts = [Object.assign(mk("option", null, `The grid · ${fmtCash(GRID_TARIFF)}/MWh`), { value: "" }),
      ...energy.map((c) => {
        const w = why(c), o = mk("option", null, `${c.ticker} · ${c.name} · ${w || `${fmtCash(c.tariff)}/MWh`}`);
        o.value = c.ticker; o.disabled = !!w;
        return o;
      })];
    sel.replaceChildren(...opts);
    sel.value = supplier() ? supplier().ticker : "";
    sel.addEventListener("change", () => run(() => choose(sel.value)));
    const l = mk("label", "field"); l.htmlFor = "rigPower"; l.append(mk("span", null, "Buy electricity from"), sel);
    const row = mk("div", "co-form"); row.append(l);
    parts.push(row, mk("p", "co-note", "Power is billed every 5 minutes while you mine, with no Pi fee. Energy companies can sell it cheaper than the grid; their plants have to produce what they sell."));
    const picked = st.wallet && st.wallet.powerFrom && energy.find((c) => c.ticker === st.wallet.powerFrom);
    if (picked && why(picked)) parts.push(mk("p", "co-note neg", `You picked ${picked.ticker}, but it's ${why(picked)}, so you're on the grid until that changes.`));
    if (!energy.length) parts.push(mk("p", "co-note", "No Energy companies yet. Found one (or switch a company to Energy) and set a tariff on the Stocks tab to sell power to miners."));
    g("rigInfo").replaceChildren(...parts);
  }
  async function run(fn) {
    if (st.busy) return;
    st.busy = true;
    setMsg("", "");
    try { const m = await fn(); if (m) setMsg(m, "ok"); } catch (e) { setMsg(Economy.errText(e), "err"); }
    finally { st.busy = false; render(); }
  }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore, h) {
    fb = firebaseNs; db = firestore; hooks = h || {};
    setInterval(() => { if (user && st.meterSince && Date.now() - st.meterSince >= BILL_MS) bill(false); }, 15000);
    setInterval(() => { if (user && document.querySelector("#tab-mine:not(.hidden)")) render(); }, 30000);
    // Energy companies load (and change their tariffs) separately from the wallet: redraw when they do
    if (typeof Factory !== "undefined" && Factory.onCompanies) Factory.onCompanies(() => { if (user) render(); });
  }
  function signIn(u) {
    signOut();
    user = u;
    unsub = db.collection("users").doc(u.uid).onSnapshot((s) => { st.wallet = s.data() || {}; render(); if (hooks.changed) hooks.changed(); }, () => {});
  }
  function signOut() {
    if (unsub) unsub();
    unsub = null; user = null;
    Object.assign(st, { wallet: null, meterSince: null, carryKwh: 0, sessionCost: 0, sessionKwh: 0, busy: false });
  }

  return { init, signIn, signOut, start, stop, bill, reward, licensed, render, TIERS, GRID_TARIFF, MAX_OWED_KWH, meter: st };
})();
