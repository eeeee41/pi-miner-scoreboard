/* =====================================================================
   Pi Miner — supply contracts between companies
   ---------------------------------------------------------------------
   contracts/{id}
     from, to            supplier and receiver (tickers) + names
     proposer            which of the two proposed it
     item, qty           what the supplier sends, and how many in total
     pay, per, every     the receiver pays `per` (cents if pay is "cash",
                         otherwise units of the `pay` good) for every
                         `every` units delivered
     delivered           units handed over so far
     escrow              payment the receiver has set aside, not yet earned
     waiting             delivered units the receiver hasn't collected yet
     owed                earned payment the supplier hasn't collected yet
     status              offered → active → done, or declined / withdrawn / ended

   • Either company can propose; the other company's controller accepts or
     declines. The receiver sets the whole payment aside when it signs
     (when it proposes, or when it accepts), so suppliers always get paid.
   • While active, whatever the supplier's lines make of the item goes to
     the contract first. The supplier can also deliver from its warehouse.
   • Factories are private, so goods and payments wait in the contract
     until each side's factory next saves (any action, every 2 minutes with the
     Factory tab open, or the 15-minute upkeep), which collects them.
   • Either side can end an active contract: anything already delivered
     and paid stays, and unused payment goes back to the receiver.
   • Ongoing contracts have no end: `qty` is the size of the deposit (in
     units it pays for). The receiver tops the deposit back up from its
     treasury or warehouse on every save, and the supplier only hands over
     whole batches the deposit can already pay for, so deliveries pause
     (never go unpaid) if the receiver runs dry.
   ===================================================================== */
const Contracts = (() => {
  let db = null, user = null, unsubs = [];
  const st = { ticker: null, from: [], to: [], got: {}, busy: false };
  const OPEN = ["offered", "active"];
  const MAX_OPEN = 8;

  const g = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtCash = (c) => Economy.fmtCash(c);
  const qtyName = (k, n) => Factory.qtyName(k, n);
  const payName = (pay, n) => (pay === "cash" ? fmtCash(n) : qtyName(pay, n));
  const all = () => [...st.from, ...st.to].filter((d, i, a) => a.findIndex((x) => x.id === d.id) === i);
  const companies = () => Factory.companies();
  const me = () => st.ticker;
  const total = (d) => (d.qty / d.every) * d.per;
  const terms = (d) => `${d.ongoing ? `${Factory.ITEMS[d.item].many}, ongoing,` : qtyName(d.item, d.qty)} from ${d.from} to ${d.to} · ${payName(d.pay, d.per)} for every ${qtyName(d.item, d.every)}`;
  const where = (d) => (d.pay === "cash" ? "treasury" : "warehouse");

  // The factory reads contracts through this when this company's list is already live
  function cached(t) {
    if (t !== st.ticker || !st.got.from || !st.got.to) return null;
    return all().map((d) => ({ id: d.id, data: d }));
  }

  function setMsg(text, kind) {
    const m = g("cMsg");
    if (!m) return;
    m.textContent = text;
    m.className = "status" + (kind ? " " + kind : "");
  }
  async function run(fn) {
    if (st.busy) return;
    st.busy = true;
    setMsg("", "");
    try { const msg = await fn(); if (msg) setMsg(msg, "ok"); }
    catch (e) { setMsg(Economy.errText(e), "err"); }
    finally { st.busy = false; }
  }

  /* ---------- actions (each one is a save of this company's factory) ---------- */
  function takePayment(f, treasury, pay, amount, who) {
    if (pay === "cash") {
      if (treasury < amount) throw new Error(`The payment needs ${fmtCash(amount)} set aside; ${who}'s treasury has ${fmtCash(treasury)}.`);
      return treasury - amount;
    }
    if ((f.inventory[pay] || 0) < amount) throw new Error(`The payment needs ${qtyName(pay, amount)} set aside; ${who}'s warehouse has ${qtyName(pay, f.inventory[pay] || 0)}.`);
    f.inventory[pay] -= amount;
    return treasury;
  }

  function propose(form) {
    const t = me();
    return Factory.actFor(t, (f, treasury, now, c, ctx) => {
      const p = companies().find((x) => x.ticker === form.partner);
      if (!p || p.ticker === t) throw new Error("Pick another company to make a contract with.");
      if (all().filter((d) => OPEN.includes(d.status)).length >= MAX_OPEN) throw new Error(`A company can have at most ${MAX_OPEN} open contracts.`);
      const weReceive = form.dir === "in";
      const d = {
        from: weReceive ? p.ticker : t, fromName: weReceive ? p.name : c.name,
        to: weReceive ? t : p.ticker, toName: weReceive ? c.name : p.name,
        proposer: t, item: form.item, qty: form.qty, every: form.every, pay: form.pay, per: form.per,
        delivered: 0, escrow: 0, waiting: 0, owed: 0, status: "offered", ongoing: !!form.ongoing
      };
      // We're the ones paying: set the whole payment aside now
      if (weReceive) { treasury = takePayment(f, treasury, d.pay, total(d), t); d.escrow = total(d); }
      ctx.created.push(d);
      return { treasury, msg: `✓ Offered ${p.ticker} a contract: ${terms(d)}.${weReceive ? ` ${payName(d.pay, d.escrow)} is set aside ${d.ongoing ? "as a deposit" : "until it's delivered or called off"}.` : ` ${p.ticker} sets the payment aside when it accepts.`}` };
    }, { fee: "Offering a contract" });
  }

  // Change one contract this company is part of
  function onContract(id, fn, fee) {
    const t = me();
    return Factory.actFor(t, (f, treasury, now, c, ctx) => {
      const k = ctx.contracts.find((x) => x.id === id);
      if (!k || (k.data.from !== t && k.data.to !== t)) throw new Error("That contract isn't this company's.");
      const out = fn(k.data, f, treasury, t) || {};
      k.dirty = true;
      return out;
    }, { contracts: [id], ...(fee ? { fee } : {}) });
  }

  const accept = (id) => onContract(id, (d, f, treasury, t) => {
    if (d.status !== "offered") throw new Error("That offer is no longer open.");
    if (d.proposer === t) throw new Error(`Waiting for ${d.proposer === d.from ? d.to : d.from} to accept.`);
    if (d.to === t) { treasury = takePayment(f, treasury, d.pay, total(d), t); d.escrow = total(d); }
    d.status = "active";
    return { treasury, msg: `✓ Contract signed: ${terms(d)}.` };
  }, "Signing a contract");
  const decline = (id) => onContract(id, (d, f, treasury, t) => {
    if (d.status !== "offered" || d.proposer === t) throw new Error("That offer is no longer open.");
    d.status = "declined";
    return { msg: "✓ Declined." };
  });
  const withdraw = (id) => onContract(id, (d, f, treasury, t) => {
    if (d.status !== "offered" || d.proposer !== t) throw new Error("That offer is no longer open.");
    d.status = "withdrawn";
    return { msg: `✓ Offer withdrawn.${d.to === t ? " The payment set aside comes back." : ""}` };
  });
  const end = (id) => onContract(id, (d) => {
    if (d.status !== "active") throw new Error("That contract isn't running.");
    d.status = "ended";
    return { msg: `✓ Contract ended after ${qtyName(d.item, d.delivered)}. Unused payment goes back to ${d.to}.` };
  });
  const deliverNow = (id) => onContract(id, (d, f, treasury, t) => {
    if (d.status !== "active" || d.from !== t) throw new Error("Only the supplier can deliver on a running contract.");
    if (Factory.room(d) <= 0) throw new Error(`${d.to}'s deposit can't pay for any more right now. Deliveries pick up once ${d.to} tops it up.`);
    const u = Math.min(f.inventory[d.item] || 0, Factory.room(d));
    if (u <= 0) throw new Error(`The warehouse has no ${Factory.ITEMS[d.item].many} to deliver.`);
    f.inventory[d.item] -= u;
    Factory.deliver(d, u);
    return { msg: `✓ Delivered ${qtyName(d.item, u)} from the warehouse.` };
  });

  /* ---------- rendering ---------- */
  function contractRow(d) {
    const t = me(), row = mk("div", "c-row");
    const weSupply = d.from === t;
    const head = mk("div", "c-head");
    head.append(mk("b", null, weSupply ? `We supply ${d.to}` : `${d.from} supplies us`),
      mk("span", "chip" + (d.status === "active" ? " crew" : d.status === "offered" ? " robo" : ""), d.status === "offered" ? (d.proposer === t ? "waiting for them" : "offer for you") : d.status));
    const info = mk("div", "c-info", d.ongoing
      ? `Ongoing ${Factory.ITEMS[d.item].many} until either side ends it · ${d.to} pays ${payName(d.pay, d.per)} for every ${qtyName(d.item, d.every)} · keeps ${payName(d.pay, total(d))} on deposit (enough for ${qtyName(d.item, d.qty)})`
      : `${qtyName(d.item, d.qty)} · ${d.to} pays ${payName(d.pay, d.per)} for every ${qtyName(d.item, d.every)} (${payName(d.pay, total(d))} in all)`);
    row.append(head, info);
    if (d.ongoing && d.status !== "offered") {
      const bar = mk("div", "progress"); const fill = mk("div"); fill.style.width = Math.min(100, (d.escrow / total(d)) * 100) + "%"; bar.append(fill);
      const bits = [`${d.delivered.toLocaleString()} delivered so far`, `deposit ${payName(d.pay, d.escrow)} of ${payName(d.pay, total(d))}`];
      if (d.waiting && d.to === t) bits.push(`${qtyName(d.item, d.waiting)} on the way to our warehouse`);
      if (d.owed && d.from === t) bits.push(`${payName(d.pay, d.owed)} on the way to us`);
      row.append(bar, mk("div", "c-info", bits.join(" · ")));
      if (d.status === "active" && Factory.room(d) <= 0)
        row.append(mk("div", "c-info neg", d.to === t
          ? `Paused: our deposit is empty. It refills from our ${where(d)} on the factory's next save.`
          : `Paused: ${d.to}'s deposit is empty, so nothing more is handed over until ${d.to} has more in its ${where(d)}.`));
      else if (d.status === "active" && d.to === t) row.append(mk("div", "c-info", `The deposit tops itself up from our ${where(d)} every time the factory saves.`));
    } else if (d.status !== "offered") {
      const bar = mk("div", "progress"); const fill = mk("div"); fill.style.width = Math.min(100, (d.delivered / d.qty) * 100) + "%"; bar.append(fill);
      const bits = [`${d.delivered.toLocaleString()} of ${d.qty.toLocaleString()} delivered`];
      if (d.escrow) bits.push(`${payName(d.pay, d.escrow)} still set aside`);
      if (d.waiting && d.to === t) bits.push(`${qtyName(d.item, d.waiting)} on the way to our warehouse`);
      if (d.owed && d.from === t) bits.push(`${payName(d.pay, d.owed)} on the way to us`);
      row.append(bar, mk("div", "c-info", bits.join(" · ")));
    } else if (d.to === t && d.proposer === t) row.append(mk("div", "c-info", `${payName(d.pay, d.escrow)} set aside from our ${d.pay === "cash" ? "treasury" : "warehouse"}.`));
    else if (d.to === t) row.append(mk("div", "c-info", `Accepting sets ${payName(d.pay, total(d))} aside from our ${d.pay === "cash" ? "treasury" : "warehouse"}.`));
    const acts = mk("div", "co-form");
    const btn = (label, fn, cls = "btn-ghost") => { const b = mk("button", cls, label); b.addEventListener("click", () => run(() => fn(d.id))); acts.append(b); };
    if (d.status === "offered" && d.proposer !== t) { btn("Accept", accept, "btn-primary buy"); btn("Decline", decline); }
    if (d.status === "offered" && d.proposer === t) btn("Withdraw offer", withdraw);
    if (d.status === "active" && weSupply) btn("Deliver from warehouse", deliverNow);
    if (d.status === "active") btn("End contract", end);
    if (acts.children.length) row.append(acts);
    return row;
  }

  function renderList() {
    const box = g("cList");
    if (!box) return;
    const t = me();
    if (!t) { box.replaceChildren(); return; }
    const list = all();
    const rank = (d) => (d.status === "offered" && d.proposer !== t ? 0 : d.status === "active" ? 1 : d.status === "offered" ? 2 : 3);
    const sorted = list.sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const shown = sorted.filter((d) => OPEN.includes(d.status)).concat(sorted.filter((d) => !OPEN.includes(d.status)).slice(0, 4));
    box.replaceChildren(...(shown.length ? shown.map(contractRow)
      : [mk("div", "empty", "No contracts yet. Offer one below: another company sends you goods as it makes them, and you pay as they arrive.")]));
    const waiting = list.filter((d) => d.status === "offered" && d.proposer !== t).length;
    g("cBadge").textContent = waiting ? `${waiting} offer${waiting === 1 ? "" : "s"} waiting` : "";
    g("cBadge").classList.toggle("hidden", !waiting);
  }

  function readForm() {
    const pay = g("cPay").value;
    const n = (id) => Number(g(id).value);
    return {
      ongoing: g("cOngoing").checked,
      partner: g("cPartner").value, dir: g("cDir").value, item: g("cItem").value,
      qty: Math.floor(n("cQty")), every: Math.floor(n("cEvery")), pay,
      per: pay === "cash" ? Math.round(n("cPer") * 100) : Math.floor(n("cPer"))
    };
  }
  function check(fm) {
    if (!fm.partner) return "Pick a company.";
    if (!(fm.qty >= 1) || fm.qty > 1000000) return fm.ongoing ? "Enter how many units the deposit should cover (up to 1,000,000)." : "Enter how many in total (up to 1,000,000).";
    if (!(fm.every >= 1)) return 'Enter "for every" as a whole number, 1 or more.';
    if (fm.qty % fm.every) return `${fm.ongoing ? "The deposit size" : "The total"} has to be a multiple of ${fm.every.toLocaleString()}.`;
    if (!(fm.per >= 1)) return fm.pay === "cash" ? "Enter a price of at least $0.01." : "Enter at least 1 for the payment.";
    if (fm.pay === fm.item) return "Pay with something other than the goods being supplied.";
    return "";
  }

  function renderForm() {
    if (!g("cPartner")) return;
    const t = me();
    g("cCard").classList.toggle("hidden", !t);
    if (!t) return;
    const others = companies().filter((c) => c.ticker !== t);
    const sel = g("cPartner"), key = others.map((c) => c.ticker).join(",");
    if (sel.dataset.key !== key) {
      const keep = sel.value;
      sel.replaceChildren(...(others.length ? others.map((c) => { const o = mk("option", null, `${c.ticker} · ${c.name} (${c.industry})`); o.value = c.ticker; return o; })
        : [Object.assign(mk("option", null, "No other companies yet"), { value: "" })]));
      sel.dataset.key = key;
      if (others.some((c) => c.ticker === keep)) sel.value = keep;
    }
    g("cPerLabel").textContent = g("cPay").value === "cash" ? "Pay ($)" : "Pay (units)";
    g("cQtyLabel").textContent = g("cOngoing").checked ? "Deposit covers (units)" : "How many in total";
    const fm = readForm(), err = check(fm);
    const weReceive = fm.dir === "in";
    const them = fm.partner || "them";
    const payer = weReceive ? t : them, sup = weReceive ? them : t, rcv = weReceive ? t : them;
    g("cSummary").textContent = err ? err : fm.ongoing
      ? `${sup} sends ${rcv} ${Factory.ITEMS[fm.item].many} as it makes them, until either side ends it. ${payer} pays ${payName(fm.pay, fm.per)} for every ${qtyName(fm.item, fm.every)}, ` +
        `from a deposit of ${payName(fm.pay, total(fm))} (enough for ${qtyName(fm.item, fm.qty)}) that ${weReceive ? `${t} sets aside now` : `${them} sets aside when it accepts`} and that refills itself from ${payer}'s ${fm.pay === "cash" ? "treasury" : "warehouse"}. ` +
        `If the deposit runs dry, deliveries pause until it's refilled.`
      : `${weReceive ? them : t} sends ${weReceive ? t : them} ${qtyName(fm.item, fm.qty)} as it makes them. ${weReceive ? t : them} pays ${payName(fm.pay, fm.per)} for every ${qtyName(fm.item, fm.every)}: ${payName(fm.pay, total(fm))} in all, ` +
        (weReceive ? `set aside from ${t}'s ${fm.pay === "cash" ? "treasury" : "warehouse"} now.` : `which ${them} sets aside when it accepts.`) +
        (fm.pay === "cash" ? ` Suppliers charge ${fmtCash(Factory.supplierPrice(fm.item))} each; materials are worth about ${fmtCash(Factory.BASE_VALUE[fm.item])}.` : "");
    g("cSummary").className = "co-note" + (err ? " neg" : "");
  }

  function render() { renderList(); renderForm(); }

  // Follow the contracts of the company open on the Factory tab
  function watch(ticker) {
    if (ticker === st.ticker && unsubs.length) { render(); return; }
    unsubs.forEach((u) => u());
    unsubs = [];
    Object.assign(st, { ticker, from: [], to: [], got: {} });
    if (ticker && db && user) {
      for (const side of ["from", "to"]) {
        unsubs.push(db.collection("contracts").where(side, "==", ticker).onSnapshot((s) => {
          st[side] = s.docs.map((d) => ({ id: d.id, ...d.data() }));
          st.got[side] = true;
          renderList();
        }, () => {}));
      }
    }
    render();
  }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore) {
    db = firestore;
    const goods = Factory.GOODS;
    g("cItem").replaceChildren(...goods.map((k) => { const o = mk("option", null, Factory.ITEMS[k].name); o.value = k; return o; }));
    g("cItem").value = "iron";
    g("cPay").replaceChildren(Object.assign(mk("option", null, "Cash"), { value: "cash" }),
      ...goods.map((k) => { const o = mk("option", null, Factory.ITEMS[k].name); o.value = k; return o; }));
    for (const id of ["cPartner", "cDir", "cItem", "cQty", "cPay", "cPer", "cEvery", "cOngoing"]) {
      g(id).addEventListener("input", renderForm);
      g(id).addEventListener("change", renderForm);
    }
    g("cPropose").addEventListener("click", () => {
      const fm = readForm(), err = check(fm);
      if (err) return setMsg(err, "err");
      run(() => propose(fm));
    });
  }
  function signIn(u) { user = u; }
  function signOut() {
    unsubs.forEach((u) => u());
    unsubs = [];
    user = null;
    Object.assign(st, { ticker: null, from: [], to: [], got: {} });
    render();
  }

  return { init, signIn, signOut, watch, render, cached };
})();
