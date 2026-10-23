/* =====================================================================
   Pi Miner — Phase 11: crime, jail, security and insurance
   ---------------------------------------------------------------------
   On users/{uid} (each player's own):
     crimeXp       successful crimes; every 5 is a level (better odds, bigger cap)
     jailUntil     ms; while jailed, paid actions, shifts and crimes are blocked
     lastCrimeAt   ms; one crime every 15 minutes
     robbedAt      ms; set by whoever robbed you: nobody can again for 3 hours
     security      { ticker, until }  protection bought from a Security company
     insurance     { ticker, until }  a policy bought from a Finance company
     lastHeist     id of the heist that jailed you (set by its leader)
   On companies/{T}:
     securityPrice (Security companies) and insurancePrice (Finance), cents a day
     securityUntil, securityBy        protection a company bought for itself
     heistedAt, lastHeist             last heist on it: one every 12 hours
     lastClaim                        last insurance claim it paid
   crimes/{robber_ms}   one record per robbery (who, whom, taken, fine, claim)
   heists/{id}          { target, leader, crew: [{uid, name}], status: forming | done | cancelled, ... }

   Robbing a player: takes 10–25% of their cash on hand (never the bank,
   never Pi), capped at $2,500 plus $250 a level. 50% chance, +2% a level,
   −25% if they have security. Caught: a fine (20% of what you went for,
   at least $100) goes to them, and 30–60 minutes in jail. Insured victims
   get half their loss back from their insurer's treasury.
   Heists: a crew of 2–4 takes 10–20% of a company's treasury (at most
   $20,000), split evenly. 25% chance, +5% per extra member, +1% per
   average level, −15% if the company has security. Caught: $500 each to
   the company, and an hour in jail.
   The dice are rolled in the robber's browser (no server on Spark), so a
   cheater could rig them; the rules still cap what any one crime takes
   and enforce the cooldowns.
   ===================================================================== */
const Crime = (() => {
  const MIN = 60000, HOUR = 3600000, DAY = 24 * HOUR;
  const COOLDOWN = 15 * MIN, VICTIM_COOLDOWN = 3 * HOUR, HEIST_COOLDOWN = 12 * HOUR;
  const ROB_CAP = 250000, ROB_CAP_PER_LEVEL = 25000, MIN_TARGET_CASH = 10000;
  const HEIST_CAP = 2000000, HEIST_MIN_TREASURY = 100000, HEIST_FINE = 50000, MAX_CREW = 4;
  const XP_PER_LEVEL = 5;

  let fb = null, db = null, user = null, unsubs = [];
  const st = { me: null, targets: [], heists: [], busy: false, loadedAt: 0 };

  const g = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtCash = (c) => Economy.fmtCash(c);
  const userRef = (uid) => db.collection("users").doc(uid);
  const companyRef = (t) => db.collection("companies").doc(t);
  const heistsCol = () => db.collection("heists");
  const now = () => fb.firestore.FieldValue.serverTimestamp();
  const myName = () => ((user && user.displayName) || "Player").slice(0, 40);
  const level = (w) => Math.min(10, Math.floor(((w && w.crimeXp) || 0) / XP_PER_LEVEL));
  const active = (p, t = Date.now()) => !!(p && p.until > t);
  const jailed = (w, t = Date.now()) => !!(w && w.jailUntil > t);
  const companies = () => (typeof Factory !== "undefined" ? Factory.companies() : []);
  const mins = (ms) => `${Math.max(1, Math.ceil(ms / MIN))} min`;
  const isBot = (uid) => String(uid).startsWith("bot-");

  function setMsg(text, kind) {
    const m = g("cMsgCrime");
    if (!m) return;
    m.textContent = text;
    m.className = "status" + (kind ? " " + kind : "");
  }
  async function run(fn) {
    if (st.busy) return;
    st.busy = true;
    setMsg("", "");
    try { const msg = await fn(); if (msg) setMsg(msg.text || msg, msg.kind || "ok"); }
    catch (e) { setMsg(Economy.errText(e), "err"); }
    finally { st.busy = false; refresh(); }
  }
  // Can this player commit a crime right now?
  function ready(w, t) {
    if (jailed(w, t)) throw new Error(`You're in jail for another ${mins(w.jailUntil - t)}.`);
    if (w.lastCrimeAt && t - w.lastCrimeAt < COOLDOWN) throw new Error(`Lie low for another ${mins(COOLDOWN - (t - w.lastCrimeAt))} before the next job.`);
  }

  /* ---------- robbing a player ---------- */
  const rob = (victim) => db.runTransaction(async (tx) => {
    const me = user.uid, t = Date.now();
    if (victim === me || isBot(victim)) throw new Error("You can't rob that player.");
    const w = (await tx.get(userRef(me))).data() || {};
    const v = (await tx.get(userRef(victim))).data();
    if (!v) throw new Error("That player is gone.");
    const ins = active(v.insurance, t) ? (await tx.get(companyRef(v.insurance.ticker))).data() : null;
    ready(w, t);
    if (v.robbedAt && t - v.robbedAt < VICTIM_COOLDOWN) throw new Error(`${v.displayName} was robbed recently. They're watching their pockets for another ${mins(VICTIM_COOLDOWN - (t - v.robbedAt))}.`);
    if ((v.cash || 0) < MIN_TARGET_CASH) throw new Error(`${v.displayName} has less than ${fmtCash(MIN_TARGET_CASH)} on hand. Not worth it.`);
    const coins = Economy.payFee(tx, w, "A robbery");
    const lvl = level(w);
    const chance = Math.max(0.05, 0.5 + 0.02 * lvl - (active(v.security, t) ? 0.25 : 0));
    const success = Math.random() < chance;
    const aim = Math.min(ROB_CAP + ROB_CAP_PER_LEVEL * lvl, Math.floor(v.cash * (0.1 + Math.random() * 0.15)));
    const id = `${me}_${t}`;
    let taken = 0, fine = 0, claim = 0;
    if (success) {
      taken = aim;
      if (ins && ins.insurancePrice > 0) {
        claim = Math.min(Math.floor(taken / 2), ins.treasury);
        if (claim > 0) tx.update(companyRef(v.insurance.ticker), { treasury: ins.treasury - claim, lastClaim: id });
      }
      tx.update(userRef(me), { cash: (w.cash || 0) + taken, coins, crimeXp: (w.crimeXp || 0) + 1, lastCrimeAt: t });
    } else {
      fine = Math.min(w.cash || 0, Math.max(10000, Math.floor(aim * 0.2)));
      tx.update(userRef(me), { cash: (w.cash || 0) - fine, coins, lastCrimeAt: t, jailUntil: t + (30 + Math.floor(Math.random() * 31)) * MIN });
    }
    tx.update(userRef(victim), { cash: v.cash - taken + claim + fine, robbedAt: t });
    tx.set(db.collection("crimes").doc(id), { kind: "rob", by: me, byName: myName(), target: victim, targetName: (v.displayName || "Player").slice(0, 40),
      success, taken, fine, claim, insurer: claim ? v.insurance.ticker : null, t, at: now() });
    tx.set(userRef(victim).collection("history").doc(id), { kind: "robbed", by: myName(), success, amount: taken, fine, claim, at: now() });
    tx.set(userRef(me).collection("history").doc(), { kind: "crime", what: `Robbed ${(v.displayName || "a player").slice(0, 40)}`, success, amount: success ? taken : -fine, at: now() });
    return success
      ? { text: `✓ You got away with ${fmtCash(taken)} from ${v.displayName}.${claim ? ` (Their insurer paid them back ${fmtCash(claim)}.)` : ""}` }
      : { text: `Caught! You paid ${v.displayName} a ${fmtCash(fine)} fine and you're in jail.`, kind: "err" };
  });

  /* ---------- heists ---------- */
  const planHeist = (ticker) => db.runTransaction(async (tx) => {
    const me = user.uid, t = Date.now();
    const w = (await tx.get(userRef(me))).data() || {};
    const c = (await tx.get(companyRef(ticker))).data();
    ready(w, t);
    if (!c) throw new Error("That company is gone.");
    if (c.controller === me) throw new Error("You can't rob your own company.");
    if (c.heistedAt && t - c.heistedAt < HEIST_COOLDOWN) throw new Error(`${ticker} was hit recently and has tightened up for another ${mins(HEIST_COOLDOWN - (t - c.heistedAt))}.`);
    if (c.treasury < HEIST_MIN_TREASURY) throw new Error(`${ticker}'s treasury has less than ${fmtCash(HEIST_MIN_TREASURY)}. Not worth it.`);
    if (st.heists.some((h) => h.status === "forming" && h.crew.some((m) => m.uid === me))) throw new Error("You're already in a crew. Leave it first.");
    tx.set(heistsCol().doc(), { target: ticker, targetName: c.name.slice(0, 40), leader: me, leaderName: myName(), crew: [{ uid: me, name: myName() }], members: [me], status: "forming", createdAt: now(), t });
    return `✓ Heist on ${ticker} planned. You need at least one more crew member before you can launch it.`;
  });
  const joinHeist = (id) => db.runTransaction(async (tx) => {
    const me = user.uid, t = Date.now();
    const h = (await tx.get(heistsCol().doc(id))).data();
    const w = (await tx.get(userRef(me))).data() || {};
    if (jailed(w, t)) throw new Error(`You're in jail for another ${mins(w.jailUntil - t)}.`);
    if (!h || h.status !== "forming") throw new Error("That crew isn't recruiting any more.");
    if (h.crew.some((m) => m.uid === me)) throw new Error("You're already in this crew.");
    if (h.crew.length >= MAX_CREW) throw new Error(`A crew is at most ${MAX_CREW}.`);
    const c = companies().find((x) => x.ticker === h.target);
    if (c && c.controller === me) throw new Error("You can't rob your own company.");
    tx.update(heistsCol().doc(id), { crew: [...h.crew, { uid: me, name: myName() }], members: [...h.members, me] });
    return `✓ You're in. ${h.leaderName} launches it when they're ready.`;
  });
  const leaveHeist = (id) => db.runTransaction(async (tx) => {
    const me = user.uid;
    const h = (await tx.get(heistsCol().doc(id))).data();
    if (!h || h.status !== "forming") return "";
    if (h.leader === me) { tx.update(heistsCol().doc(id), { status: "cancelled" }); return "✓ Heist called off."; }
    tx.update(heistsCol().doc(id), { crew: h.crew.filter((m) => m.uid !== me), members: h.members.filter((u) => u !== me) });
    return "✓ You've left the crew.";
  });
  const launchHeist = (id) => db.runTransaction(async (tx) => {
    const me = user.uid, t = Date.now();
    const ref = heistsCol().doc(id);
    const h = (await tx.get(ref)).data();
    if (!h || h.status !== "forming" || h.leader !== me) throw new Error("Only the crew's leader can launch it.");
    if (h.crew.length < 2) throw new Error("You need at least 2 in the crew.");
    const c = (await tx.get(companyRef(h.target))).data();
    const members = [];
    for (const m of h.crew) members.push({ ...m, w: (await tx.get(userRef(m.uid))).data() || {} });
    const lead = members.find((m) => m.uid === me);
    ready(lead.w, t);
    if (c.heistedAt && t - c.heistedAt < HEIST_COOLDOWN) throw new Error(`${h.target} was hit recently. Try again later.`);
    const coins = Economy.payFee(tx, lead.w, "Launching a heist");
    const avgLevel = members.reduce((a, m) => a + level(m.w), 0) / members.length;
    const chance = Math.max(0.05, 0.25 + 0.05 * (members.length - 1) + 0.01 * avgLevel - (c.securityUntil > t ? 0.15 : 0));
    const success = Math.random() < chance;
    if (success) {
      const take = Math.min(HEIST_CAP, Math.floor(c.treasury * (0.1 + Math.random() * 0.1)));
      const share = Math.floor(take / members.length);
      tx.update(companyRef(h.target), { treasury: c.treasury - share * members.length, heistedAt: t, lastHeist: id });
      for (const m of members) {
        if (m.uid === me) tx.update(userRef(me), { cash: (m.w.cash || 0) + share, coins, crimeXp: (m.w.crimeXp || 0) + 1, lastCrimeAt: t });
        else tx.update(userRef(m.uid), { cash: fb.firestore.FieldValue.increment(share) });
        tx.set(userRef(m.uid).collection("history").doc(`${id}_${m.uid}`), { kind: "heist", target: h.target, success: true, amount: share, at: now() });
      }
      tx.update(ref, { status: "done", success: true, take: share * members.length, share, fine: 0, doneAt: t });
      return { text: `✓ The heist on ${h.target} worked! ${fmtCash(share * members.length)} split ${members.length} ways: ${fmtCash(share)} each.` };
    }
    let fines = 0;
    for (const m of members) {
      const fine = Math.min(m.w.cash || 0, HEIST_FINE);
      fines += fine;
      const jail = { cash: (m.w.cash || 0) - fine, jailUntil: t + HOUR, lastHeist: id };
      if (m.uid === me) tx.update(userRef(me), { ...jail, coins, lastCrimeAt: t });
      else tx.update(userRef(m.uid), jail);
      tx.set(userRef(m.uid).collection("history").doc(`${id}_${m.uid}`), { kind: "heist", target: h.target, success: false, amount: -fine, at: now() });
    }
    tx.update(companyRef(h.target), { treasury: c.treasury + fines, heistedAt: t, lastHeist: id });
    tx.update(ref, { status: "done", success: false, take: 0, share: 0, fine: HEIST_FINE, doneAt: t });
    return { text: `Caught! The whole crew paid ${h.target} a ${fmtCash(HEIST_FINE)} fine each and went to jail for an hour.`, kind: "err" };
  });

  /* ---------- buying protection ---------- */
  const buyCover = (kind, ticker, days, forCompany) => db.runTransaction(async (tx) => {
    const me = user.uid, t = Date.now();
    const seller = (await tx.get(companyRef(ticker))).data();
    const price = seller && (kind === "security" ? seller.securityPrice : seller.insurancePrice);
    if (!price) throw new Error(`${ticker} doesn't sell ${kind} right now.`);
    const cost = price * days;
    const w = (await tx.get(userRef(me))).data() || {};
    const c = forCompany ? (await tx.get(companyRef(forCompany))).data() : null;   // every read before any write
    const coins = Economy.payFee(tx, w, kind === "security" ? "Buying security" : "Buying insurance");
    if (forCompany) {
      // A controller protecting their company against heists, paid from its treasury
      if (!c || c.controller !== me) throw new Error(`Only whoever runs ${forCompany} can buy protection for it.`);
      if (forCompany === ticker) throw new Error("A company can't protect itself.");
      if (c.treasury < cost) throw new Error(`${days} days costs ${fmtCash(cost)}; ${forCompany}'s treasury has ${fmtCash(c.treasury)}.`);
      const until = Math.max(c.securityUntil || 0, t) + days * DAY;
      tx.update(companyRef(forCompany), { treasury: c.treasury - cost, securityUntil: until, securityBy: ticker });
      tx.update(companyRef(ticker), { treasury: seller.treasury + cost });
      tx.update(userRef(me), { coins });
      return `✓ ${forCompany} is protected by ${ticker} for ${days} day${days === 1 ? "" : "s"} (${fmtCash(cost)} from its treasury).`;
    }
    if ((w.cash || 0) < cost) throw new Error(`${days} days costs ${fmtCash(cost)}; you have ${fmtCash(w.cash || 0)} on hand.`);
    const cur = w[kind];
    const from = cur && cur.ticker === ticker && cur.until > t ? cur.until : t;
    tx.update(userRef(me), { cash: w.cash - cost, coins, [kind]: { ticker, until: from + days * DAY } });
    tx.update(companyRef(ticker), { treasury: seller.treasury + cost });
    tx.set(userRef(me).collection("history").doc(), { kind: "cover", what: kind, seller: ticker, days, amount: cost, at: now() });
    return kind === "security"
      ? `✓ ${ticker} is watching your back for ${days} day${days === 1 ? "" : "s"}: robbers are 25% less likely to get you.`
      : `✓ Insured by ${ticker} for ${days} day${days === 1 ? "" : "s"}: if you're robbed, they pay back half.`;
  });

  /* ---------- rendering ---------- */
  function renderStatus() {
    const box = g("crStatus"), w = st.me;
    if (!box) return;
    if (!w) { box.replaceChildren(mk("div", "empty", "Loading…")); return; }
    const t = Date.now(), lvl = level(w);
    const kpis = mk("div", "kpis four");
    const k = (label, value, sub) => { const d = mk("div", "kpi"); d.append(mk("span", "k", label), mk("b", null, value)); if (sub) d.append(mk("span", "ks", sub)); return d; };
    kpis.append(
      k("Status", jailed(w, t) ? "In jail" : w.lastCrimeAt && t - w.lastCrimeAt < COOLDOWN ? "Lying low" : "Free",
        jailed(w, t) ? `out in ${mins(w.jailUntil - t)}` : w.lastCrimeAt && t - w.lastCrimeAt < COOLDOWN ? `next job in ${mins(COOLDOWN - (t - w.lastCrimeAt))}` : "ready for a job"),
      k("Crime level", String(lvl), `${w.crimeXp || 0} successful jobs · +${2 * lvl}% odds, cap ${fmtCash(ROB_CAP + ROB_CAP_PER_LEVEL * lvl)}`),
      k("Security", active(w.security, t) ? w.security.ticker : "None", active(w.security, t) ? `until ${new Date(w.security.until).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "robbers have the usual odds"),
      k("Insurance", active(w.insurance, t) ? w.insurance.ticker : "None", active(w.insurance, t) ? "half of any robbery paid back" : "robberies aren't covered")
    );
    const parts = [kpis];
    if (jailed(w, t)) parts.push(mk("p", "co-note neg", "While you're in jail you can't buy, sell, trade, hire, start shifts or commit crimes. Your companies keep running."));
    parts.push(mk("p", "co-note", `Only cash on hand can be stolen: you have ${fmtCash(w.cash || 0)} on hand and ${fmtCash(w.bank || 0)} safe in the bank.`));
    box.replaceChildren(...parts);
  }

  function renderTargets() {
    const box = g("crTargets");
    if (!box) return;
    const t = Date.now();
    const list = st.targets.filter((u) => u.id !== (user && user.uid) && !isBot(u.id) && (u.cash || 0) >= MIN_TARGET_CASH);
    box.replaceChildren(...(list.length ? list.map((u) => {
      const row = mk("div", "f-person");
      const info = mk("div", "f-person-info");
      const cool = u.robbedAt && t - u.robbedAt < VICTIM_COOLDOWN;
      info.append(mk("b", null, u.displayName || "Player"),
        mk("span", null, `${fmtCash(u.cash || 0)} on hand${active(u.security, t) ? " · has security" : ""}${active(u.insurance, t) ? " · insured" : ""}`));
      if (cool) info.append(mk("span", null, `Robbed recently: safe for another ${mins(VICTIM_COOLDOWN - (t - u.robbedAt))}`));
      const acts = mk("div", "f-person-acts");
      const b = mk("button", "btn-ghost", "Rob");
      b.disabled = !!cool;
      b.addEventListener("click", () => run(() => rob(u.id)));
      acts.append(b);
      row.append(info, acts);
      return row;
    }) : [mk("div", "empty", `Nobody else has ${fmtCash(MIN_TARGET_CASH)} or more on hand right now.`)]));
  }

  function renderHeists() {
    const box = g("crHeists");
    if (!box) return;
    const me = user && user.uid, t = Date.now();
    const forming = st.heists.filter((h) => h.status === "forming");
    const rows = forming.map((h) => {
      const row = mk("div", "f-person");
      const info = mk("div", "f-person-info");
      const inCrew = h.crew.some((m) => m.uid === me);
      info.append(mk("b", null, `Heist on ${h.target} · ${h.targetName}`),
        mk("span", null, `Crew (${h.crew.length}/${MAX_CREW}): ${h.crew.map((m) => m.name).join(", ")} · led by ${h.leaderName}`));
      const acts = mk("div", "f-person-acts");
      if (h.leader === me) {
        const go = mk("button", "btn-primary buy", "Launch");
        go.disabled = h.crew.length < 2;
        if (h.crew.length < 2) go.title = "You need at least 2 in the crew";
        go.addEventListener("click", () => run(() => launchHeist(h.id)));
        acts.append(go);
        const off = mk("button", "btn-ghost", "Call off"); off.addEventListener("click", () => run(() => leaveHeist(h.id))); acts.append(off);
      } else if (inCrew) {
        const lv = mk("button", "btn-ghost", "Leave crew"); lv.addEventListener("click", () => run(() => leaveHeist(h.id))); acts.append(lv);
      } else {
        const j = mk("button", "btn-ghost", "Join crew");
        j.disabled = h.crew.length >= MAX_CREW;
        j.addEventListener("click", () => run(() => joinHeist(h.id)));
        acts.append(j);
      }
      row.append(info, acts);
      return row;
    });
    if (!rows.length) rows.push(mk("div", "empty", "No crews are forming. Plan a heist below."));
    // Plan a new one
    const targets = companies().filter((c) => c.controller !== me && c.treasury >= HEIST_MIN_TREASURY && !(c.heistedAt && t - c.heistedAt < HEIST_COOLDOWN));
    const form = mk("div", "co-form");
    const sel = mk("select"); sel.id = "crHeistTarget";
    sel.replaceChildren(...(targets.length ? targets.map((c) => Object.assign(mk("option", null, `${c.ticker} · ${fmtCash(c.treasury)} in the treasury${c.securityUntil > t ? " · has security" : ""}`), { value: c.ticker }))
      : [Object.assign(mk("option", null, "No company worth hitting right now"), { value: "" })]));
    const keep = g("crHeistTarget") && g("crHeistTarget").value;
    if (keep && targets.some((c) => c.ticker === keep)) sel.value = keep;
    const l = mk("label", "field"); l.htmlFor = "crHeistTarget"; l.append(mk("span", null, "Target"), sel);
    const plan = mk("button", "btn-ghost", "Plan a heist (1 Pi to launch)");
    plan.disabled = !targets.length;
    plan.addEventListener("click", () => run(() => planHeist(sel.value)));
    form.append(l, plan);
    box.replaceChildren(...rows, form);
  }

  function renderCover() {
    const box = g("crCover");
    if (!box) return;
    const sellers = (kind) => companies().filter((c) => (kind === "security" ? c.industry === "Security" && c.securityPrice > 0 : c.industry === "Finance" && c.insurancePrice > 0))
      .sort((a, b) => (kind === "security" ? a.securityPrice - b.securityPrice : a.insurancePrice - b.insurancePrice));
    const mine = companies().filter((c) => user && c.controller === user.uid);
    const block = (kind) => {
      const list = sellers(kind);
      const wrap = mk("div", "co-sec");
      wrap.append(mk("h3", null, kind === "security" ? "Security (from Security companies)" : "Insurance (from Finance companies)"));
      if (!list.length) { wrap.append(mk("p", "co-note", `No company sells ${kind} yet. ${kind === "security" ? "Found a Security company" : "A Finance company"} and set a daily price on the Stocks tab.`)); return wrap; }
      const row = mk("div", "co-form");
      const sel = mk("select"); sel.id = `cr-${kind}-seller`;
      sel.replaceChildren(...list.map((c) => Object.assign(mk("option", null, `${c.ticker} · ${fmtCash(kind === "security" ? c.securityPrice : c.insurancePrice)}/day`), { value: c.ticker })));
      const days = mk("select"); days.id = `cr-${kind}-days`;
      days.replaceChildren(...[1, 3, 7].map((d) => Object.assign(mk("option", null, `${d} day${d === 1 ? "" : "s"}`), { value: d })));
      const who = mk("select"); who.id = `cr-${kind}-who`;
      who.replaceChildren(Object.assign(mk("option", null, "For me"), { value: "" }),
        ...(kind === "security" ? mine.map((c) => Object.assign(mk("option", null, `For ${c.ticker} (against heists)`), { value: c.ticker })) : []));
      for (const e of [sel, days, who]) { const old = g(e.id); if (old && [...e.options].some((o) => o.value === old.value)) e.value = old.value; }
      const b = mk("button", "btn-ghost", "Buy");
      b.addEventListener("click", () => run(() => buyCover(kind, sel.value, Number(days.value), who.value || null)));
      row.append(sel, days, who, b);
      wrap.append(row, mk("p", "co-note", kind === "security" ? "Security makes robbers 25% less likely to get you (or heists on your company 15% less likely)." : "If you're robbed, your insurer pays back half of what was taken, from its treasury."));
      return wrap;
    };
    box.replaceChildren(block("security"), block("insurance"));
  }

  function render() { renderStatus(); renderTargets(); renderHeists(); renderCover(); }
  async function refresh() {
    if (!user || !db) return;
    const s = await db.collection("users").orderBy("cash", "desc").limit(25).get().catch(() => null);
    if (s) st.targets = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    st.loadedAt = Date.now();
    render();
  }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore) {
    fb = firebaseNs; db = firestore;
    setInterval(() => {
      if (!user || !g("tab-crime") || g("tab-crime").classList.contains("hidden")) return;
      if (Date.now() - st.loadedAt > 30000) refresh(); else renderStatus();
    }, 5000);
    const btn = document.getElementById("tabBtn-crime");
    if (btn) btn.addEventListener("click", () => refresh());
  }
  function signIn(u) {
    signOut();
    user = u;
    unsubs.push(userRef(u.uid).onSnapshot((s) => { st.me = s.data() || {}; renderStatus(); }, () => {}));
    unsubs.push(heistsCol().where("status", "==", "forming").limit(30).onSnapshot((s) => {
      st.heists = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderHeists();
    }, () => {}));
  }
  function signOut() {
    unsubs.forEach((u) => u());
    unsubs = [];
    user = null;
    Object.assign(st, { me: null, targets: [], heists: [], busy: false, loadedAt: 0 });
  }

  return { init, signIn, signOut, refresh, jailed };
})();
