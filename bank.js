/* =====================================================================
   Pi Miner — Phase 9: the bank
   ---------------------------------------------------------------------
   Fields on users/{uid}:
     bank, bankAt        Cash in the bank (cents) and when interest was last added
     loan, loanAt        what you owe (cents) and when interest was last added
     collateral          Pi locked against the loan

   • Deposits earn 0.25% a day, added for every whole hour that has passed
     whenever you open the game. Cash in the bank can't be stolen (Phase 11).
   • Loans: lock Pi as collateral and borrow up to half of what it's worth
     at Pi's recent trading price. Loans cost 1% a day. Repay any time;
     paying it all back unlocks the Pi.
   • If what you owe reaches 80% of the collateral's value (Pi's price
     fell, or interest piled up), the loan is closed: the debt is wiped and
     the bank keeps the collateral, so those Pi leave the game.
   Deposits, withdrawals, borrowing and repaying each cost the 1 Pi fee.
   ===================================================================== */
const Bank = (() => {
  const HOUR = 3600000;
  const DEPOSIT_RATE = 0.0025 / 24;    // per hour
  const LOAN_RATE = 0.01 / 24;         // per hour
  const LTV = 0.5, LIQUIDATE_AT = 0.8;
  const PRICE_TRADES = 20;

  let fb = null, db = null, user = null, unsubs = [];
  const st = { wallet: null, piPrice: null, busy: false };

  const g = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtCash = (c) => Economy.fmtCash(c);
  const userRef = (uid) => db.collection("users").doc(uid);
  const now = () => fb.firestore.FieldValue.serverTimestamp();
  const toCents = (v) => Math.round(Number(v) * 100);

  function setMsg(text, kind) {
    const m = g("bMsg");
    m.textContent = text;
    m.className = "status" + (kind ? " " + kind : "");
  }
  async function run(fn) {
    if (st.busy) return;
    st.busy = true;
    setMsg("", "");
    try { const msg = await fn(); if (msg) setMsg(msg, "ok"); }
    catch (e) { setMsg(Economy.errText(e), "err"); }
    finally { st.busy = false; render(); }
  }

  // Interest for every whole hour since it was last added. Returns the changed fields.
  function accrue(w, t = Date.now()) {
    const out = {};
    if (w.bank > 0 && w.bankAt) {
      const h = Math.floor((t - w.bankAt) / HOUR);
      if (h > 0) { out.bank = w.bank + Math.floor(w.bank * DEPOSIT_RATE * h); out.bankAt = w.bankAt + h * HOUR; }
    }
    if (w.loan > 0 && w.loanAt) {
      const h = Math.floor((t - w.loanAt) / HOUR);
      if (h > 0) { out.loan = w.loan + Math.ceil(w.loan * LOAN_RATE * h); out.loanAt = w.loanAt + h * HOUR; }
    }
    return out;
  }
  const collateralValue = (w, price) => (price ? (w.collateral || 0) * price : 0);
  // Close a loan that's grown too big for its collateral: the bank keeps the Pi
  function liquidate(w, price) {
    if (!(w.loan > 0) || !price || w.loan < LIQUIDATE_AT * collateralValue(w, price)) return null;
    return { pi: w.collateral || 0 };
  }

  // Pi's recent trading price (cents), from the last trades on the Exchange
  async function piPrice() {
    const s = await db.collection("market").doc("PI").collection("trades").orderBy("at", "desc").limit(PRICE_TRADES).get();
    let q = 0, v = 0;
    s.forEach((d) => { const t = d.data(); q += t.qty; v += t.qty * t.price; });
    return q ? v / q : null;
  }

  // Every bank action: re-read the wallet, add interest, check the loan, apply the change, pay the fee.
  async function act(change, fee) {
    const price = await piPrice();
    st.piPrice = price;
    return db.runTransaction(async (tx) => {
      const ref = userRef(user.uid);
      const w0 = (await tx.get(ref)).data() || {};
      const w = { ...w0, ...accrue(w0) };
      const upd = {};
      for (const k of ["bank", "bankAt", "loan", "loanAt"]) if (w[k] !== w0[k]) upd[k] = w[k];
      const liq = liquidate(w, price);
      let msg = "";
      if (liq) {
        Object.assign(w, { loan: 0, loanAt: null, collateral: 0 });
        Object.assign(upd, { loan: 0, loanAt: null, collateral: 0 });
        tx.set(ref.collection("history").doc(), { kind: "bank", action: "liquidated", amount: liq.pi, at: now() });
        msg = `Your loan was closed: it reached 80% of your collateral's value, so the bank kept the ${liq.pi} Pi you'd locked.`;
      }
      if (change) {
        const r = change(w, price) || {};
        Object.assign(upd, r.upd || {});
        if (fee) upd.coins = Economy.payFee(tx, { coins: upd.coins != null ? upd.coins : w.coins }, fee);
        if (r.history) tx.set(ref.collection("history").doc(), { ...r.history, at: now() });
        msg = r.msg || msg;
      }
      if (Object.keys(upd).length) tx.update(ref, upd);
      return msg;
    });
  }

  const deposit = (amount) => act((w) => {
    if (amount > (w.cash || 0)) throw new Error(`You have ${fmtCash(w.cash || 0)} on hand.`);
    const t = Date.now();
    return { upd: { cash: w.cash - amount, bank: (w.bank || 0) + amount, bankAt: w.bank > 0 ? w.bankAt : t },
      history: { kind: "bank", action: "deposit", amount }, msg: `✓ Deposited ${fmtCash(amount)}. It earns 0.25% a day.` };
  }, "A deposit");
  const withdraw = (amount) => act((w) => {
    if (amount > (w.bank || 0)) throw new Error(`The bank holds ${fmtCash(w.bank || 0)} for you.`);
    const left = w.bank - amount;
    return { upd: { cash: (w.cash || 0) + amount, bank: left, bankAt: left > 0 ? w.bankAt : null },
      history: { kind: "bank", action: "withdraw", amount }, msg: `✓ Withdrew ${fmtCash(amount)}.` };
  }, "A withdrawal");
  const borrow = (lockPi, amount) => act((w, price) => {
    if (!price) throw new Error("Pi hasn't traded on the Exchange yet, so the bank can't value it as collateral.");
    const coins = w.coins || 0;
    if (lockPi > coins - 1) throw new Error(`You have ${coins} Pi; keep 1 for the fee.`);
    const collateral = (w.collateral || 0) + lockPi;
    const limit = Math.floor(LTV * collateral * price);
    const loan = (w.loan || 0) + amount;
    if (loan > limit) throw new Error(`${collateral.toLocaleString()} Pi is worth about ${fmtCash(Math.round(collateral * price))}, so you can owe at most ${fmtCash(limit)}.`);
    return { upd: { coins: coins - lockPi, collateral, cash: (w.cash || 0) + amount, loan, loanAt: w.loan > 0 ? w.loanAt : Date.now() },
      history: { kind: "bank", action: "borrow", amount }, msg: `✓ Borrowed ${fmtCash(amount)} against ${collateral.toLocaleString()} Pi. Interest is 1% a day.` };
  }, "A loan");
  const repay = (amount) => act((w) => {
    const owe = w.loan || 0;
    if (!owe) throw new Error("You don't owe the bank anything.");
    const pay = Math.min(amount, owe);
    if (pay > (w.cash || 0)) throw new Error(`You have ${fmtCash(w.cash || 0)} on hand.`);
    const left = owe - pay;
    const upd = { cash: w.cash - pay, loan: left, loanAt: left > 0 ? w.loanAt : null };
    if (!left) { upd.coins = (w.coins || 0) + (w.collateral || 0); upd.collateral = 0; }
    return { upd, history: { kind: "bank", action: "repay", amount: pay },
      msg: left ? `✓ Repaid ${fmtCash(pay)}. You still owe ${fmtCash(left)}.` : `✓ Loan paid off. Your ${(w.collateral || 0).toLocaleString()} Pi is unlocked.` };
  }, "A repayment");

  /* ---------- rendering ---------- */
  function render() {
    if (!g("bSummary")) return;
    const w0 = st.wallet;
    if (!w0) { g("bSummary").replaceChildren(mk("div", "empty", "Loading…")); return; }
    const w = { ...w0, ...accrue(w0) };
    const price = st.piPrice;
    const kpis = mk("div", "kpis four");
    const k = (label, value, sub) => { const d = mk("div", "kpi"); d.append(mk("span", "k", label), mk("b", null, value)); if (sub) d.append(mk("span", "ks", sub)); return d; };
    const cv = collateralValue(w, price);
    kpis.append(
      k("Cash on hand", fmtCash(w.cash || 0), "can be spent, and stolen"),
      k("In the bank", fmtCash(w.bank || 0), "earns 0.25% a day"),
      k("Loan", fmtCash(w.loan || 0), w.loan ? `1% a day · closes at ${fmtCash(Math.floor(LIQUIDATE_AT * cv))}` : "none"),
      k("Collateral", `${(w.collateral || 0).toLocaleString()} Pi`, price ? `worth about ${fmtCash(Math.round(cv))} · borrow up to ${fmtCash(Math.floor(LTV * cv))}` : "Pi has no price yet")
    );
    const notes = [kpis];
    if (w.loan && price && w.loan >= 0.7 * cv) notes.push(mk("p", "co-note neg", `Careful: you owe ${Math.round((w.loan / cv) * 100)}% of your collateral's value. At 80% the loan is closed and the bank keeps the Pi. Repay some, or lock more Pi.`));
    notes.push(mk("p", "co-note", `Pi's recent price: ${price ? fmtCash(Math.round(price)) : "none yet"}. Each bank action costs the 1 Pi fee. You have ${(w.coins || 0).toLocaleString()} Pi free.`));
    g("bSummary").replaceChildren(...notes);
  }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore) {
    fb = firebaseNs; db = firestore;
    const amount = (id) => toCents(g(id).value);
    g("bDeposit").addEventListener("click", () => { const a = amount("bAmount"); if (!(a >= 1)) return setMsg("Enter an amount of at least $0.01.", "err"); run(() => deposit(a)); });
    g("bWithdraw").addEventListener("click", () => { const a = amount("bAmount"); if (!(a >= 1)) return setMsg("Enter an amount of at least $0.01.", "err"); run(() => withdraw(a)); });
    g("bBorrow").addEventListener("click", () => {
      const pi = Math.floor(Number(g("bLockPi").value) || 0), a = amount("bLoanAmount");
      if (!(pi >= 0) || !(a >= 1)) return setMsg("Enter the Pi to lock (0 or more) and an amount to borrow.", "err");
      run(() => borrow(pi, a));
    });
    g("bRepay").addEventListener("click", () => { const a = amount("bLoanAmount"); if (!(a >= 1)) return setMsg("Enter an amount to repay.", "err"); run(() => repay(a)); });
  }
  function signIn(u) {
    signOut();
    user = u;
    unsubs.push(userRef(u.uid).onSnapshot((s) => { st.wallet = s.data() || {}; render(); }, () => {}));
    piPrice().then((p) => { st.piPrice = p; render(); }).catch(() => {});
  }
  function signOut() {
    unsubs.forEach((u) => u());
    unsubs = [];
    user = null;
    Object.assign(st, { wallet: null, piPrice: null, busy: false });
  }
  // 15-minute upkeep: add interest and close an underwater loan, free (no fee)
  async function upkeep() {
    if (!user || !st.wallet) return;
    const w = st.wallet;
    if (w.bank > 0 || w.loan > 0) await act(null).then((m) => { if (m) setMsg(m, "err"); }).catch(() => {});
  }

  return { init, signIn, signOut, upkeep, accrue };
})();
