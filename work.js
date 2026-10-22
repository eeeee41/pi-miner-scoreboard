/* =====================================================================
   Pi Miner — Phase 9: jobs
   ---------------------------------------------------------------------
   Two ways to earn a wage without running a company:

   • Day jobs from the game: start a shift of 1–8 hours and get paid
     when it ends. users/{uid}.shift = { key, hours, wage, startedAt, endsAt }.
     Every hour worked adds to users/{uid}.workXp, which unlocks better jobs.
     Stopping early pays the whole hours already worked.

   • Real jobs at players' companies: jobs/{id}
       company, companyName, role, wage (cents/hour), status, player,
       playerName, hours (worked), quit, createdAt, updatedAt
     A controller posts an opening (status "open", from the Employees
     panel). A player takes it ("taken"); the company's next factory save
     puts them on its staff ("active") and from then on the treasury pays
     their wage into their wallet every hour. Skill grows by one level
     per 24 hours worked. Either side can end it: the player quits here,
     the controller lets them go in the Employees panel ("ended").
   Starting and collecting work is free; it's earning, not spending.
   ===================================================================== */
const Work = (() => {
  const HOUR = 3600000;
  const DAY_JOBS = [
    { key: "courier",  name: "Courier",          wage: 1200, needs: 0,   does: "Deliver parcels around town" },
    { key: "cashier",  name: "Cashier",          wage: 1500, needs: 8,   does: "Run a till at the corner store" },
    { key: "picker",   name: "Warehouse picker", wage: 1800, needs: 24,  does: "Pick and pack orders" },
    { key: "mechanic", name: "Mechanic",         wage: 2500, needs: 72,  does: "Fix cars at the garage" },
    { key: "engineer", name: "Engineer",         wage: 4000, needs: 200, does: "Keep the power plant running" }
  ];
  const SHIFTS = [1, 2, 4, 8];
  const ROLE_NAMES = { worker: "Worker", researcher: "Researcher", sales: "Salesperson", manager: "Manager" };

  let fb = null, db = null, user = null, unsubs = [];
  const st = { wallet: null, board: [], mine: [], busy: false };

  const g = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtCash = (c) => Economy.fmtCash(c);
  const userRef = (uid) => db.collection("users").doc(uid);
  const jobsCol = () => db.collection("jobs");
  const now = () => fb.firestore.FieldValue.serverTimestamp();
  const fmtDur = (s) => Factory.fmtDur(s);
  const jobOf = (key) => DAY_JOBS.find((j) => j.key === key);

  function setMsg(text, kind) {
    const m = g("jMsg");
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

  /* ---------- day jobs ---------- */
  const startShift = (key, hours) => db.runTransaction(async (tx) => {
    const ref = userRef(user.uid);
    const w = (await tx.get(ref)).data() || {};
    const job = jobOf(key);
    if (w.shift) throw new Error("You're already on a shift. Finish it or stop it first.");
    if ((w.workXp || 0) < job.needs) throw new Error(`${job.name} needs ${job.needs} hours of work experience; you have ${w.workXp || 0}.`);
    const t = Date.now();
    tx.update(ref, { shift: { key, hours, wage: job.wage, startedAt: t, endsAt: t + hours * HOUR } });
    return `✓ Started a ${hours}-hour shift as a ${job.name.toLowerCase()}. You'll earn ${fmtCash(job.wage * hours)} when it ends.`;
  });

  // Get paid for a finished shift (or, stopping early, for the whole hours worked so far)
  const endShift = (early) => db.runTransaction(async (tx) => {
    const ref = userRef(user.uid);
    const w = (await tx.get(ref)).data() || {};
    const s = w.shift;
    if (!s) return "";
    const t = Date.now();
    if (!early && t < s.endsAt) return "";
    const hours = early ? Math.min(s.hours, Math.floor((t - s.startedAt) / HOUR)) : s.hours;
    const pay = hours * s.wage;
    const job = jobOf(s.key) || { name: "Shift" };
    tx.update(ref, { shift: null, cash: (w.cash || 0) + pay, workXp: (w.workXp || 0) + hours });
    if (pay) tx.set(ref.collection("history").doc(), { kind: "job", job: job.name, amount: pay, hours, at: now() });
    return pay ? `✓ Paid ${fmtCash(pay)} for ${hours} hour${hours === 1 ? "" : "s"} as a ${job.name.toLowerCase()}.` : "Shift stopped. You hadn't finished an hour yet, so there's no pay.";
  });

  /* ---------- jobs at players' companies ---------- */
  const takeJob = (id) => db.runTransaction(async (tx) => {
    const ref = jobsCol().doc(id);
    const j = (await tx.get(ref)).data();
    if (!j || j.status !== "open") throw new Error("Someone else just took that job.");
    if (st.mine.some((x) => x.status === "taken" || x.status === "active")) throw new Error("You already have a job at a company. Quit it first.");
    const c = Factory.companies().find((x) => x.ticker === j.company);
    if (c && c.controller === user.uid) throw new Error("You run that company: you can't be its employee too.");
    tx.update(ref, { status: "taken", player: user.uid, playerName: (user.displayName || "Player").slice(0, 40), updatedAt: Date.now() });
    return `✓ You took the ${ROLE_NAMES[j.role].toLowerCase()} job at ${j.company}. You start the next time ${j.company}'s factory saves.`;
  });
  const quitJob = (id) => jobsCol().doc(id).update({ quit: true, updatedAt: Date.now() })
    .then(() => "✓ You've handed in your notice. You're paid up to the last full hour.");

  /* ---------- rendering ---------- */
  function renderShift() {
    const box = g("jShift"), w = st.wallet;
    if (!w) { box.replaceChildren(mk("div", "empty", "Loading…")); return; }
    const xp = w.workXp || 0;
    const parts = [mk("p", "co-note", `Work experience: ${xp.toLocaleString()} hour${xp === 1 ? "" : "s"}. Better-paid jobs unlock as it grows.`)];
    const s = w.shift;
    if (s) {
      const job = jobOf(s.key) || { name: "Shift" };
      const t = Date.now(), done = t >= s.endsAt;
      const card = mk("div", "f-line");
      card.append(mk("b", null, `${job.name} · ${s.hours}-hour shift · ${fmtCash(s.wage)}/hour`));
      const bar = mk("div", "progress"); const fill = mk("div"); fill.dataset.shift = "1"; bar.append(fill);
      const status = mk("div", "f-status"); status.dataset.shift = "1";
      card.append(bar, status);
      const row = mk("div", "co-form");
      if (done) {
        const b = mk("button", "btn-primary buy", `Collect ${fmtCash(s.wage * s.hours)}`);
        b.addEventListener("click", () => run(() => endShift(false)));
        row.append(b);
      } else {
        const b = mk("button", "btn-ghost", "Stop early");
        b.addEventListener("click", () => run(() => endShift(true)));
        row.append(b);
      }
      card.append(row);
      parts.push(card);
    }
    box.replaceChildren(...parts);
    tick();
  }

  function renderDayJobs() {
    const box = g("jDayJobs"), w = st.wallet || {};
    const xp = w.workXp || 0, busy = !!w.shift;
    box.replaceChildren(...DAY_JOBS.map((j) => {
      const row = mk("div", "f-person");
      const info = mk("div", "f-person-info");
      info.append(mk("b", null, `${j.name} · ${fmtCash(j.wage)}/hour`), mk("span", null, j.does),
        mk("span", null, j.needs ? `Needs ${j.needs} hours of experience` : "No experience needed"));
      const acts = mk("div", "f-person-acts");
      if (xp < j.needs) acts.append(mk("span", "chip", `${j.needs - xp} more hours to unlock`));
      else {
        const sel = mk("select", "f-recipe"); sel.id = `jHours-${j.key}`;
        sel.setAttribute("aria-label", `Shift length for ${j.name}`);
        sel.replaceChildren(...SHIFTS.map((h) => { const o = mk("option", null, `${h} hour${h === 1 ? "" : "s"} · ${fmtCash(h * j.wage)}`); o.value = h; return o; }));
        const b = mk("button", "btn-ghost", "Start shift");
        b.disabled = busy;
        if (busy) b.title = "You're already on a shift";
        b.addEventListener("click", () => run(() => startShift(j.key, Number(sel.value))));
        acts.append(sel, b);
      }
      row.append(info, acts);
      return row;
    }));
  }

  function renderBoard() {
    const mineBox = g("jMine");
    const current = st.mine.filter((j) => j.status === "taken" || j.status === "active");
    mineBox.replaceChildren(...(current.length ? current.map((j) => {
      const row = mk("div", "f-person");
      const info = mk("div", "f-person-info");
      const skill = Math.min(5, 1 + Math.floor((j.hours || 0) / 24));
      info.append(mk("b", null, `${ROLE_NAMES[j.role]} at ${j.company} · ${fmtCash(j.wage)}/hour`),
        mk("span", null, j.status === "taken"
          ? `Starting the next time ${j.company}'s factory saves`
          : `${(j.hours || 0).toLocaleString()} hours worked · skill ${skill}${skill < 5 ? ` (next level after ${24 * skill} hours)` : ""} · paid hourly from ${j.company}'s treasury`));
      if (j.quit) info.append(mk("span", null, "You've handed in your notice: you leave at the company's next save."));
      const acts = mk("div", "f-person-acts");
      if (!j.quit) { const b = mk("button", "btn-ghost", "Quit"); b.addEventListener("click", () => run(() => quitJob(j.id))); acts.append(b); }
      row.append(info, acts);
      return row;
    }) : [mk("div", "empty", "You don't work at a company. Take a job below.")]));

    const box = g("jBoard");
    const open = st.board.filter((j) => j.status === "open");
    box.replaceChildren(...(open.length ? open.map((j) => {
      const row = mk("div", "f-person");
      const info = mk("div", "f-person-info");
      info.append(mk("b", null, `${ROLE_NAMES[j.role]} at ${j.company} · ${fmtCash(j.wage)}/hour`), mk("span", null, j.companyName));
      const acts = mk("div", "f-person-acts");
      const b = mk("button", "btn-ghost", "Take this job");
      b.disabled = current.length > 0;
      if (current.length) b.title = "You already have a job at a company";
      b.addEventListener("click", () => run(() => takeJob(j.id)));
      acts.append(b);
      row.append(info, acts);
      return row;
    }) : [mk("div", "empty", "No openings right now. Companies post them from their Employees panel.")]));
  }

  function tick() {
    const s = st.wallet && st.wallet.shift;
    const fill = document.querySelector('#jShift .progress > div[data-shift]');
    const status = document.querySelector('#jShift .f-status[data-shift]');
    if (!s || !fill || !status) return;
    const t = Date.now();
    fill.style.width = Math.min(100, ((t - s.startedAt) / (s.endsAt - s.startedAt)) * 100) + "%";
    status.textContent = t >= s.endsAt ? "Shift done: collect your pay." : `${fmtDur((s.endsAt - t) / 1000)} to go · ${Math.floor((t - s.startedAt) / HOUR)} of ${s.hours} hours done`;
    if (t >= s.endsAt && !document.querySelector("#jShift .btn-primary")) renderShift();
  }

  function render() { if (g("jShift")) { renderShift(); renderDayJobs(); renderBoard(); } }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore) {
    fb = firebaseNs; db = firestore;
    setInterval(() => { if (user) tick(); }, 1000);
  }
  function signIn(u) {
    signOut();
    user = u;
    unsubs.push(userRef(u.uid).onSnapshot((s) => {
      st.wallet = s.data() || {};
      render();
      // A finished shift pays out by itself while you're here
      if (st.wallet.shift && Date.now() >= st.wallet.shift.endsAt && !st.busy) run(() => endShift(false));
    }, () => {}));
    unsubs.push(jobsCol().where("status", "==", "open").limit(50).onSnapshot((s) => {
      st.board = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderBoard();
    }, () => {}));
    unsubs.push(jobsCol().where("player", "==", u.uid).onSnapshot((s) => {
      st.mine = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderBoard();
    }, () => {}));
  }
  function signOut() {
    unsubs.forEach((u) => u());
    unsubs = [];
    user = null;
    Object.assign(st, { wallet: null, board: [], mine: [], busy: false });
  }
  // 5-minute upkeep: pay out a finished shift
  async function upkeep() {
    if (user && st.wallet && st.wallet.shift && Date.now() >= st.wallet.shift.endsAt) await endShift(false).catch(() => {});
  }

  return { init, signIn, signOut, upkeep, DAY_JOBS, ROLE_NAMES };
})();
