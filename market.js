/* =====================================================================
   Pi Miner — Phase 4: the marketplace for goods
   ---------------------------------------------------------------------
   items/{ITEM}/listings/{id}   goods for sale (open while it has `p`)
   items/{ITEM}/sales/{id}      every sale, for the recent average price

   • A company's controller lists goods from its warehouse at a price per
     unit. The goods leave the warehouse right away (held for the listing)
     and a 1% listing fee comes out of the treasury.
   • Any company can buy some or all of a listing: the price comes out of
     the buyer's treasury, the goods go into its warehouse, and the money
     goes into the seller's treasury.
   • Cancelling returns the unsold goods to the warehouse.
   • 10-day rule: a listing still open after 10 days is bought by the
     market at 80% of the lower of its price and the recent average sale
     price. Goods that have never sold are priced at what their materials
     cost from suppliers. Any player's page settles these.
   Cars aren't listed: everyday buyers take them the moment they're made.
   ===================================================================== */
const Market = (() => {
  const FEE_RATE = 0.01;
  const EXPIRY_MS = 10 * 24 * 3600 * 1000;
  const BUYOUT_RATE = 0.8;
  const AVG_SALES = 20;

  let fb = null, db = null, user = null;
  let unsubs = [], itemUnsubs = [], mineUnsubs = [], factoryUnsub = null;
  const st = { companies: [], ticker: null, factory: null, item: "steel", listings: [], sales: [], mine: new Map(), busy: false, typed: new Map() };

  /* ---------- helpers ---------- */
  const g = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtCash = (c) => Economy.fmtCash(c);
  const errText = (e) => Economy.errText(e);
  const ITEMS = () => Factory.ITEMS;
  const goods = () => Object.keys(Factory.ITEMS).filter((k) => k !== "car");
  const qtyName = (k, n) => Factory.qtyName(k, n);
  const ms = (t) => (t && t.toMillis ? t.toMillis() : typeof t === "number" ? t : Date.now());
  const now = () => fb.firestore.FieldValue.serverTimestamp();
  const companyRef = (t) => db.collection("companies").doc(t);
  const factoryRef = (t) => companyRef(t).collection("factory").doc("main");
  const listings = (item) => db.collection("items").doc(item).collection("listings");
  const sales = (item) => db.collection("items").doc(item).collection("sales");
  const asListing = (d) => ({ id: d.id, ref: d.ref, ...d.data({ serverTimestamps: "estimate" }) });
  const mineList = () => [...st.mine.values()].flat().sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const myCompanies = () => st.companies.filter((c) => user && c.controller === user.uid);
  const company = () => st.companies.find((c) => c.ticker === st.ticker);
  const feeFor = (qty, price) => Math.max(1, Math.round(qty * price * FEE_RATE));
  const avgOf = (list) => {
    let q = 0, v = 0;
    for (const s of list) { q += s.qty; v += s.qty * s.price; }
    return q ? v / q : null;
  };

  function setMsg(text, kind) {
    const m = g("mMsg");
    m.textContent = text;
    m.className = "status" + (kind ? " " + kind : "");
  }
  async function run(fn) {
    if (st.busy) return;
    st.busy = true;
    setMsg("", "");
    try { const msg = await fn(); if (msg) setMsg(msg, "ok"); }
    catch (e) { setMsg(errText(e), "err"); }
    finally { st.busy = false; }
  }

  /* ---------- actions ---------- */
  async function list(item, qty, price) {
    const t = st.ticker, uid = user.uid;
    return db.runTransaction(async (tx) => {
      const c = (await tx.get(companyRef(t))).data();
      if (!c || c.controller !== uid) throw new Error("Only the company's controller can sell its goods.");
      const snap = await tx.get(factoryRef(t));
      const f = snap.exists ? Factory.clone(snap.data()) : Factory.blank();
      const have = f.inventory[item] || 0;
      if (have < qty) throw new Error(`The warehouse has ${qtyName(item, have)}.`);
      const fee = feeFor(qty, price);
      if (c.treasury < fee) throw new Error(`The ${fmtCash(fee)} listing fee needs more in the treasury.`);
      f.inventory[item] = have - qty;
      tx.set(factoryRef(t), { ...f, updatedAt: now() });
      tx.update(companyRef(t), { treasury: c.treasury - fee });
      tx.set(listings(item).doc(), {
        company: t, companyName: c.name.slice(0, 40), item, qty, remaining: qty, price, p: price, status: "open", createdAt: now()
      });
      return `✓ Listed ${qtyName(item, qty)} at ${fmtCash(price)} each (fee ${fmtCash(fee)}).`;
    });
  }

  async function buy(l, qty) {
    const t = st.ticker, uid = user.uid;
    return db.runTransaction(async (tx) => {
      const ls = await tx.get(l.ref);
      const d = ls.data();
      const buyer = (await tx.get(companyRef(t))).data();
      const fsnap = await tx.get(factoryRef(t));
      const seller = (await tx.get(companyRef(d.company))).data();
      if (!buyer || buyer.controller !== uid) throw new Error("Only the company's controller can buy for it.");
      if (d.company === t) throw new Error("That's your own listing.");
      if (typeof d.p !== "number" || d.remaining <= 0) throw new Error("That listing just sold out or closed.");
      if (qty > d.remaining) throw new Error(`Only ${qtyName(d.item, d.remaining)} left in that listing.`);
      const cost = qty * d.price;
      if (cost > buyer.treasury) throw new Error(`That costs ${fmtCash(cost)}; ${t}'s treasury has ${fmtCash(buyer.treasury)}.`);
      const f = fsnap.exists ? Factory.clone(fsnap.data()) : Factory.blank();
      f.inventory[d.item] = (f.inventory[d.item] || 0) + qty;
      const remaining = d.remaining - qty;
      tx.update(l.ref, remaining
        ? { remaining }
        : { remaining: 0, status: "sold", p: fb.firestore.FieldValue.delete() });
      tx.update(companyRef(t), { treasury: buyer.treasury - cost });
      tx.set(factoryRef(t), { ...f, updatedAt: now() });
      tx.update(companyRef(d.company), { treasury: seller.treasury + cost });
      tx.set(sales(d.item).doc(), { qty, price: d.price, buyer: t, seller: d.company, at: now() });
      return `✓ ${t} bought ${qtyName(d.item, qty)} from ${d.company} for ${fmtCash(cost)}.`;
    });
  }

  async function cancel(l) {
    const uid = user.uid;
    return db.runTransaction(async (tx) => {
      const d = (await tx.get(l.ref)).data();
      const c = (await tx.get(companyRef(d.company))).data();
      const fsnap = await tx.get(factoryRef(d.company));
      if (!c || c.controller !== uid) throw new Error("Only the company's controller can cancel its listings.");
      if (typeof d.p !== "number") throw new Error("That listing already closed.");
      const f = fsnap.exists ? Factory.clone(fsnap.data()) : Factory.blank();
      f.inventory[d.item] = (f.inventory[d.item] || 0) + d.remaining;
      tx.update(l.ref, { status: "cancelled", p: fb.firestore.FieldValue.delete() });
      tx.set(factoryRef(d.company), { ...f, updatedAt: now() });
      return `✓ Cancelled. ${qtyName(d.item, d.remaining)} went back to the warehouse.`;
    });
  }

  // 10-day rule for goods
  async function settleExpired() {
    const cutoff = new Date(Date.now() - EXPIRY_MS);
    for (const item of goods()) {
      const snap = await listings(item).where("createdAt", "<", cutoff).limit(10).get();
      const open = snap.docs.filter((d) => typeof d.data().p === "number");
      if (!open.length) continue;
      const recent = await sales(item).orderBy("at", "desc").limit(AVG_SALES).get();
      const ref = avgOf(recent.docs.map((d) => d.data())) ?? Factory.BASE_VALUE[item];
      for (const doc of open) {
        await db.runTransaction(async (tx) => {
          const d = (await tx.get(doc.ref)).data();
          if (typeof d.p !== "number" || Date.now() - ms(d.createdAt) < EXPIRY_MS) return;
          const seller = (await tx.get(companyRef(d.company))).data();
          const unit = Math.floor(Math.min(d.price, ref) * BUYOUT_RATE);
          tx.update(doc.ref, { status: "bought", p: fb.firestore.FieldValue.delete(), remaining: 0, buyoutPrice: unit });
          if (unit > 0) tx.update(companyRef(d.company), { treasury: seller.treasury + unit * d.remaining });
        }).catch((e) => console.warn("Listing buyout failed", e));
      }
    }
  }

  /* ---------- rendering ---------- */
  function renderPickers() {
    const sel = g("mCompany");
    const mine = myCompanies();
    const key = mine.map((c) => c.ticker).join("|");
    if (sel.dataset.key !== key) {
      sel.replaceChildren(...(mine.length
        ? mine.map((c) => { const o = mk("option", null, `${c.ticker} · ${c.name}`); o.value = c.ticker; return o; })
        : [mk("option", null, "You don't run a company")]));
      sel.dataset.key = key;
    }
    sel.disabled = !mine.length;
    if (st.ticker) sel.value = st.ticker;
    for (const id of ["mItem", "mSellItem"]) {
      const s = g(id);
      if (!s.options.length) s.replaceChildren(...goods().map((k) => { const o = mk("option", null, ITEMS()[k].name); o.value = k; return o; }));
    }
  }

  function renderSummary() {
    const box = g("mSummary");
    const c = company();
    if (!c) {
      box.replaceChildren(mk("p", "co-note", "Companies trade goods here. Found a company on the Stocks tab, or buy control of one, to buy and sell."));
      return;
    }
    const inv = (st.factory && st.factory.inventory) || {};
    const stocked = goods().filter((k) => inv[k]).map((k) => qtyName(k, inv[k]));
    box.replaceChildren(mk("p", "co-note",
      `${c.ticker}'s treasury: ${fmtCash(c.treasury)} · warehouse: ${stocked.length ? stocked.join(", ") : "empty"}`));
  }

  function renderListings() {
    const item = st.item;
    const avg = avgOf(st.sales);
    g("mPrice").textContent = avg != null
      ? `Recent average: ${fmtCash(Math.round(avg))} each over the last ${st.sales.length} sale${st.sales.length === 1 ? "" : "s"} · materials cost ${fmtCash(Factory.BASE_VALUE[item])}`
      : `No sales yet · materials cost ${fmtCash(Factory.BASE_VALUE[item])}${Factory.RAW.includes(item) ? " from suppliers" : ""}`;
    const box = g("mListings");
    if (!st.listings.length) { box.replaceChildren(mk("div", "empty", `No one is selling ${ITEMS()[item].many} right now.`)); return; }
    const canBuy = !!company();
    box.replaceChildren(...st.listings.map((l, i) => {
      const row = mk("div", "m-row");
      const own = l.company === st.ticker;
      const days = Math.max(0, Math.ceil((ms(l.createdAt) + EXPIRY_MS - Date.now()) / 86400000));
      const info = mk("div", "m-info");
      info.append(
        mk("b", null, `${fmtCash(l.price)} each`),
        mk("span", null, `${qtyName(item, l.remaining)} from ${l.company}${own ? " (yours)" : ""} · ${days} day${days === 1 ? "" : "s"} left`)
      );
      row.append(info);
      if (canBuy && !own) {
        const form = mk("div", "m-buy");
        const input = mk("input"); input.type = "number"; input.min = 1; input.step = 1; input.id = `mBuyQty${i}`;
        input.value = st.typed.has(l.id) ? st.typed.get(l.id) : l.remaining;   // keep what the player typed across live updates
        input.addEventListener("input", () => st.typed.set(l.id, input.value));
        input.setAttribute("aria-label", `How many ${ITEMS()[item].many} to buy from ${l.company}`);
        const btn = mk("button", "btn-ghost", "Buy");
        btn.addEventListener("click", () => {
          const n = Math.floor(Number(input.value));
          if (!(n >= 1)) return setMsg("Enter how many to buy.", "err");
          run(() => buy(l, n));
        });
        form.append(input, btn);
        row.append(form);
      }
      return row;
    }));
  }

  function renderMine() {
    const box = g("mMine");
    const list = mineList();
    if (!company()) { box.replaceChildren(); return; }
    if (!list.length) { box.replaceChildren(mk("div", "empty", "No open listings.")); return; }
    box.replaceChildren(...list.map((l) => {
      const row = mk("div", "order-row");
      const days = Math.max(0, Math.ceil((ms(l.createdAt) + EXPIRY_MS - Date.now()) / 86400000));
      const btn = mk("button", "btn-ghost", "Cancel");
      btn.addEventListener("click", () => run(() => cancel(l)));
      row.append(mk("span", "neg", "Sell"),
        mk("span", null, `${qtyName(l.item, l.remaining)} at ${fmtCash(l.price)} · market buys it in ${days} day${days === 1 ? "" : "s"}`), btn);
      return row;
    }));
  }

  function renderSellForm() {
    const can = !!company();
    g("mSellBox").classList.toggle("hidden", !can);
    if (!can) return;
    const item = g("mSellItem").value, qty = Math.floor(Number(g("mSellQty").value)), price = Math.round(Number(g("mSellPrice").value) * 100);
    const have = (st.factory && st.factory.inventory && st.factory.inventory[item]) || 0;
    g("mHave").textContent = `In the warehouse: ${qtyName(item, have)}`;
    g("mFee").textContent = qty > 0 && price > 0 ? `Listing fee ${fmtCash(feeFor(qty, price))} (1%) · worth ${fmtCash(qty * price)} if it all sells` : "";
  }

  function renderAll() { renderPickers(); renderSummary(); renderListings(); renderMine(); renderSellForm(); }

  /* ---------- live data ---------- */
  function watchItem(item) {
    itemUnsubs.forEach((u) => u());
    st.item = item; st.listings = []; st.sales = [];
    itemUnsubs = [
      listings(item).orderBy("p", "asc").limit(30).onSnapshot((s) => { st.listings = s.docs.map(asListing); renderListings(); }, (e) => setMsg(errText(e), "err")),
      sales(item).orderBy("at", "desc").limit(AVG_SALES).onSnapshot((s) => { st.sales = s.docs.map((d) => d.data()); renderListings(); }, () => {})
    ];
    renderListings();
  }

  function watchCompany(ticker) {
    mineUnsubs.forEach((u) => u());
    if (factoryUnsub) factoryUnsub();
    mineUnsubs = []; factoryUnsub = null;
    st.ticker = ticker; st.factory = null; st.mine = new Map();
    if (ticker) {
      factoryUnsub = factoryRef(ticker).onSnapshot((s) => { st.factory = s.exists ? s.data() : null; renderSummary(); renderSellForm(); }, () => {});
      for (const item of goods()) {
        mineUnsubs.push(listings(item).where("company", "==", ticker).onSnapshot((s) => {
          st.mine.set(item, s.docs.map(asListing).filter((l) => typeof l.p === "number"));
          renderMine();
        }, () => {}));
      }
    }
    renderAll();
  }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore) {
    fb = firebaseNs; db = firestore;
    renderPickers();
    g("mItem").value = "steel";
    g("mSellItem").value = "steel";
    g("mCompany").addEventListener("change", (e) => watchCompany(e.target.value));
    g("mItem").addEventListener("change", (e) => watchItem(e.target.value));
    for (const id of ["mSellItem", "mSellQty", "mSellPrice"]) g(id).addEventListener("input", renderSellForm);
    g("mSell").addEventListener("click", () => {
      const item = g("mSellItem").value, qty = Math.floor(Number(g("mSellQty").value)), price = Math.round(Number(g("mSellPrice").value) * 100);
      if (!(qty >= 1)) return setMsg("Enter how many to sell.", "err");
      if (!(price >= 1)) return setMsg("Enter a price of at least $0.01 each.", "err");
      run(() => list(item, qty, price));
    });
  }

  function signIn(u) {
    signOut();
    user = u;
    unsubs.push(db.collection("companies").orderBy("createdAt", "asc").limit(100).onSnapshot((s) => {
      st.companies = s.docs.map((d) => d.data({ serverTimestamps: "estimate" }));
      const mine = myCompanies();
      if (!mine.find((c) => c.ticker === st.ticker)) watchCompany(mine.length ? mine[0].ticker : null);
      else renderAll();
    }, (e) => setMsg(errText(e), "err")));
    watchItem(g("mItem").value || "steel");
  }

  function signOut() {
    unsubs.forEach((u) => u()); itemUnsubs.forEach((u) => u()); mineUnsubs.forEach((u) => u());
    if (factoryUnsub) factoryUnsub();
    unsubs = []; itemUnsubs = []; mineUnsubs = []; factoryUnsub = null;
    user = null;
    Object.assign(st, { companies: [], ticker: null, factory: null, listings: [], sales: [], mine: new Map(), busy: false });
    if (g("mMsg")) { setMsg("", ""); renderAll(); }
  }

  async function upkeep() { if (user) await settleExpired(); }

  return { init, signIn, signOut, upkeep };
})();
