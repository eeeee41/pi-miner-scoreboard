/* =====================================================================
   Pi Miner — Phase 3: production
   ---------------------------------------------------------------------
   companies/{TICKER}/factory/main
     inventory  { item: count }     the company's warehouse
     lines      [ { id, recipe, queued, startedAt, made } ]
     carsSold, revenue              running totals

   • Raw materials come from game suppliers at fixed prices, paid from the
     company treasury.
   • A production line costs $1,000 (max 10 per company) and makes one
     recipe at a time, working through its queue in real time. Inputs are
     taken from the warehouse when units are queued and handed back if
     the queue is cleared.
   • Cars never sit in the warehouse: everyday people (game buyers, not
     players) buy each one for $250 the moment it rolls off the line, and
     the money goes into the treasury.
   • No server runs on the free plan, so output is worked out from the
     clock: whenever the controller's page saves anything (or checks in
     every 30 s while the factory is open, and on the 5-minute upkeep),
     every unit finished since the last save is counted at once.
   Only the company's controller runs the factory.
   ===================================================================== */
const Factory = (() => {
  const LINE_COST = 100000;      // $1,000
  const MAX_LINES = 10;
  const MAX_QUEUE = 1000;
  const CAR_PRICE = 25000;       // $250, paid by everyday car buyers

  const ITEMS = {
    iron:        { name: "Iron ore",    one: "iron ore",    many: "iron ore",    price: 200 },
    coal:        { name: "Coal",        one: "coal",        many: "coal",        price: 100 },
    sand:        { name: "Sand",        one: "sand",        many: "sand",        price: 50 },
    rubber:      { name: "Rubber",      one: "rubber",      many: "rubber",      price: 300 },
    copper:      { name: "Copper",      one: "copper",      many: "copper",      price: 400 },
    plastic:     { name: "Plastic",     one: "plastic",     many: "plastic",     price: 150 },
    steel:       { name: "Steel",       one: "steel",       many: "steel" },
    glass:       { name: "Glass",       one: "glass",       many: "glass" },
    tire:        { name: "Tires",       one: "tire",        many: "tires" },
    electronics: { name: "Electronics", one: "electronics", many: "electronics" },
    engine:      { name: "Engines",     one: "engine",      many: "engines" },
    car:         { name: "Cars",        one: "car",         many: "cars" }
  };
  const RAW = ["iron", "coal", "sand", "rubber", "copper", "plastic"];
  // Each recipe makes one unit of the item with the same name
  const RECIPES = {
    steel:       { inputs: { iron: 2, coal: 1 },       secs: 60 },
    glass:       { inputs: { sand: 2, coal: 1 },       secs: 45 },
    tire:        { inputs: { rubber: 2, steel: 1 },    secs: 90 },
    electronics: { inputs: { copper: 2, plastic: 1 },  secs: 120 },
    engine:      { inputs: { steel: 4, electronics: 2 }, secs: 300 },
    car:         { inputs: { engine: 1, tire: 4, steel: 6, glass: 2, electronics: 2 }, secs: 600, sellsFor: CAR_PRICE }
  };

  // Research: real-time projects paid from the treasury, one at a time per company
  const RESEARCH = {
    robots1: { name: "Robot arms",              cost: 200000,  hours: 0.5, needs: null,      does: "Lets you fit robot arms to production lines: 1.5× faster" },
    robots2: { name: "Assembly robots",         cost: 800000,  hours: 2,   needs: "robots1", does: "Lets you fit assembly robots: 2.5× faster" },
    robots3: { name: "Automated car lines",     cost: 2000000, hours: 6,   needs: "robots2", does: "Lets you fully automate a line: 4× faster" },
    alloy1:  { name: "Cheaper alloys",          cost: 300000,  hours: 1,   needs: null,      does: "Steel needs 1 iron ore instead of 2" },
    alloy2:  { name: "Lightweight alloys",      cost: 1000000, hours: 3,   needs: "alloy1",  does: "Cars need 4 steel instead of 6" },
    labs:    { name: "Better research methods", cost: 500000,  hours: 1,   needs: null,      does: "All research after this finishes twice as fast" }
  };
  // Robot tiers a line can be upgraded to (each needs its research first)
  const ROBOTS = [
    { name: "Workers only",    mult: 1 },
    { name: "Robot arms",      mult: 1.5, cost: 150000,  needs: "robots1" },
    { name: "Assembly robots", mult: 2.5, cost: 500000,  needs: "robots2" },
    { name: "Fully automated", mult: 4,   cost: 1200000, needs: "robots3" }
  ];
  // What an item's materials cost at supplier prices (used to price never-sold items)
  const BASE_VALUE = {};
  const valueOf = (k) => BASE_VALUE[k] ?? (BASE_VALUE[k] = ITEMS[k].price ||
    Object.entries(RECIPES[k].inputs).reduce((a, [i, n]) => a + n * valueOf(i), 0));
  Object.keys(ITEMS).forEach(valueOf);

  // Recipe inputs after research
  function inputsFor(recipe, research = {}) {
    const inp = { ...RECIPES[recipe].inputs };
    if (recipe === "steel" && research.alloy1) inp.iron = 1;
    if (recipe === "car" && research.alloy2) inp.steel = 4;
    return inp;
  }
  // Employees: hired from an hourly pool, paid hourly from the treasury
  const HOUR = 3600000;
  const MAX_STAFF = 30;
  const MAX_WORKERS_PER_LINE = 3;
  const ROLES = {
    worker:     { name: "Worker",      base: 800,  does: (s) => `+${10 * s}% speed on their line` },
    researcher: { name: "Researcher",  base: 2000, does: (s) => `+${10 * s}% research speed` },
    sales:      { name: "Salesperson", base: 1200, does: (s) => `+${2 * s}% on every car's price` },
    manager:    { name: "Manager",     base: 3000, does: (s) => `boosts every other employee by ${5 * s}%` },
    glitch:     { name: "Glitch",      base: 0,    does: (s) => `works every job at once: line speed, research, car prices and managing (skill ${s}), and his line makes 5× as much` }
  };
  // Hard-coded staff: always on the payroll of these companies, for free, and can't be let go or trained
  const FIXED_STAFF = {
    TSLA: [{ id: "missingno", name: "MissingNo.", role: "glitch", skill: 5, wage: 0, line: null, fixed: true, outputMult: 5 }]
  };
  const POOL_MS = 5 * 60 * 1000;      // a new batch of candidates every 5 minutes
  const wageFor = (role, skill) => Math.round(ROLES[role].base * (1 + 0.5 * (skill - 1)));
  const trainCost = (skill) => 50000 * skill;            // $500 × current skill
  const FIRST = ["Ava", "Ben", "Chloe", "Dev", "Elena", "Femi", "Gus", "Hana", "Ivan", "Jade", "Kofi", "Lena", "Mateo", "Nia",
                 "Omar", "Priya", "Quinn", "Rosa", "Sam", "Tariq", "Uma", "Vik", "Wren", "Yuki", "Zoe", "Leo", "Mira", "Noah"];
  const LAST = ["Alvarez", "Brooks", "Chen", "Diaz", "Evans", "Fischer", "Gupta", "Hughes", "Ito", "Jensen", "Kim", "Lopez", "Mensah",
                "Novak", "Okafor", "Patel", "Reyes", "Sato", "Torres", "Ueda", "Vargas", "Walsh", "Young", "Zhang"];

  // The same 6 candidates for everyone looking at a company in this 5-minute slot (seeded by ticker + slot)
  function candidates(ticker, hour) {
    let h = 2166136261;
    for (const ch of `${ticker}:${hour}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const rand = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
    const roles = ["worker", "worker", "researcher", "sales", "manager", Object.keys(ROLES)[Math.floor(rand() * 4)]];
    return roles.map((role, i) => {
      const r = rand();
      const skill = r < 0.35 ? 1 : r < 0.65 ? 2 : r < 0.85 ? 3 : r < 0.96 ? 4 : 5;
      const name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
      return { id: `${hour}-${i}`, name, role, skill, wage: wageFor(role, skill) };
    });
  }

  const staffOf = (f) => f.staff || [];
  const is = (s, role) => s.role === role || s.role === "glitch";   // a glitch counts as every role
  const managerBoost = (f) => 1 + staffOf(f).filter((s) => is(s, "manager")).reduce((a, s) => a + 0.05 * s.skill, 0);
  const workersOn = (f, line) => staffOf(f).filter((s) => is(s, "worker") && s.line === line.id);
  // Units that come off a line for each unit queued (MissingNo.'s line makes 5)
  const outMult = (line, f) => staffOf(f).filter((s) => s.line === line.id && s.outputMult).reduce((a, s) => a * s.outputMult, 1);
  // Make sure a company's hard-coded staff are on its books
  function addFixedStaff(f, ticker) {
    for (const p of FIXED_STAFF[ticker] || []) {
      const have = f.staff.find((s) => s.id === p.id);
      if (!have) f.staff.unshift({ ...p, hiredAt: Date.now() });
      else Object.assign(have, { ...p, line: have.line, hiredAt: have.hiredAt });
    }
    return f;
  }
  const lineMult = (line, f) =>
    ROBOTS[line.robots || 0].mult * (1 + workersOn(f, line).reduce((a, s) => a + 0.1 * s.skill, 0) * managerBoost(f));
  const unitMs = (line, f) => (RECIPES[line.recipe].secs * 1000) / lineMult(line, f);
  const researchSpeed = (f) => 1 + staffOf(f).filter((s) => is(s, "researcher")).reduce((a, s) => a + 0.1 * s.skill, 0) * managerBoost(f);
  const carPrice = (f) => Math.round(CAR_PRICE * (1 + Math.min(0.5, staffOf(f).filter((s) => is(s, "sales")).reduce((a, s) => a + 0.02 * s.skill, 0) * managerBoost(f))));
  const payrollPerHour = (f) => staffOf(f).reduce((a, s) => a + s.wage, 0);

  // Change something that affects speed without losing progress: every running unit and the
  // research project keep the same percent done and carry on at the new speed.
  function rebase(f, now, mutate) {
    const prog = f.lines.map((l) => (l.queued && l.startedAt ? (now - l.startedAt) / unitMs(l, f) : null));
    const rp = f.project ? (now - f.project.startedAt) / (f.project.endsAt - f.project.startedAt) : null;
    mutate();
    f.lines.forEach((l, i) => { if (prog[i] != null) l.startedAt = now - prog[i] * unitMs(l, f); });
    if (f.project && rp != null) {
      const total = (f.project.baseMs || f.project.endsAt - f.project.startedAt) / researchSpeed(f);
      f.project.startedAt = now - rp * total;
      f.project.endsAt = f.project.startedAt + total;
    }
  }

  // Pay every whole hour since the last payday. If the treasury runs short, the best-paid quit first.
  function payroll(f, now, treasury) {
    const hourNow = Math.floor(now / HOUR) * HOUR;
    if (!staffOf(f).length) { f.wagesPaidTo = hourNow; return treasury; }
    const from = f.wagesPaidTo || hourNow;
    const hours = Math.min(168, Math.floor((now - from) / HOUR));
    for (let h = 0; h < hours && f.staff.length; h++) {
      if (treasury < payrollPerHour(f)) {
        rebase(f, now, () => {
          while (f.staff.length && treasury < payrollPerHour(f)) {
            const top = f.staff.reduce((a, s) => (s.wage > a.wage ? s : a));
            f.staff = f.staff.filter((s) => s !== top);
            f.news = [`${top.name} (${ROLES[top.role].name.toLowerCase()}) quit: the treasury couldn't pay their wage`, ...(f.news || [])].slice(0, 8);
          }
        });
      }
      treasury -= payrollPerHour(f);
    }
    f.wagesPaidTo = hours ? from + hours * HOUR : from;
    if (now - f.wagesPaidTo >= 168 * HOUR) f.wagesPaidTo = hourNow;   // more than a week behind: forgive the rest
    return treasury;
  }

  let fb = null, db = null, user = null, unsubs = [], factoryUnsub = null;
  const st = { companies: [], ticker: null, factory: null, busy: false, lastSettle: 0 };

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
  const companyRef = (t) => db.collection("companies").doc(t);
  const factoryRef = (t) => companyRef(t).collection("factory").doc("main");
  const blank = () => ({ inventory: {}, lines: [], carsSold: 0, revenue: 0, research: {}, project: null, staff: [], wagesPaidTo: null, news: [] });
  // Every writer of the factory doc goes through this, so no field is ever dropped
  const clone = (f) => JSON.parse(JSON.stringify({
    inventory: f.inventory || {}, lines: f.lines || [], carsSold: f.carsSold || 0, revenue: f.revenue || 0,
    research: f.research || {}, project: f.project || null,
    staff: f.staff || [], wagesPaidTo: f.wagesPaidTo || null, news: f.news || []
  }));
  const company = () => st.companies.find((c) => c.ticker === st.ticker);
  const iControl = () => { const c = company(); return !!(c && user && c.controller === user.uid); };
  const fmtDur = (s) => {
    s = Math.max(0, Math.ceil(s));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  };
  const qtyName = (k, n) => `${n.toLocaleString()} ${n === 1 ? ITEMS[k].one : ITEMS[k].many}`;
  const inputsText = (r, research) => Object.entries(inputsFor(r, research)).map(([k, n]) => qtyName(k, n)).join(" + ");

  // Count every unit finished by `now`. Cars are sold on the spot; returns the Cash they brought in.
  function settle(f, now) {
    let income = 0;
    if (f.project && now >= f.project.endsAt) {          // finished research
      f.research[f.project.key] = true;
      f.project = null;
    }
    for (const line of f.lines) {
      if (!line.queued || !line.startedAt) continue;
      const per = unitMs(line, f);
      const n = Math.min(line.queued, Math.floor((now - line.startedAt) / per));
      if (n <= 0) continue;
      const out = n * outMult(line, f);                 // units that actually come off the line
      line.queued -= n;
      line.made = (line.made || 0) + out;
      line.startedAt = line.queued ? line.startedAt + n * per : null;
      if (RECIPES[line.recipe].sellsFor) {
        const cash = out * carPrice(f);
        f.carsSold += out;
        f.revenue += cash;
        income += cash;
      } else {
        f.inventory[line.recipe] = (f.inventory[line.recipe] || 0) + out;
      }
    }
    return income;
  }

  // Every factory change: re-read, catch up on finished units, apply the change, save.
  async function act(change, t = st.ticker) {
    const uid = user.uid;
    return db.runTransaction(async (tx) => {
      const c = (await tx.get(companyRef(t))).data();
      if (!c || c.controller !== uid) throw new Error("Only the company's controller can run its factory.");
      const snap = await tx.get(factoryRef(t));
      const f = addFixedStaff(snap.exists ? clone(snap.data()) : blank(), t);
      const before = JSON.stringify(snap.exists ? clone(snap.data()) : blank());
      const now = Date.now();
      let treasury = c.treasury + settle(f, now);
      treasury = payroll(f, now, treasury);
      if (!change && JSON.stringify(f) === before && treasury === c.treasury) return "";   // nothing to save
      const res = change ? change(f, treasury, now) || {} : {};
      if (res.treasury != null) treasury = res.treasury;
      if (treasury < 0) throw new Error(`The treasury only has ${fmtCash(c.treasury)}.`);
      tx.set(factoryRef(t), { ...f, updatedAt: fb.firestore.FieldValue.serverTimestamp() });
      if (treasury !== c.treasury) tx.update(companyRef(t), { treasury });
      return res.msg || "";
    });
  }

  const buyRaw = (item, qty) => act((f, treasury) => {
    const cost = ITEMS[item].price * qty;
    if (cost > treasury) throw new Error(`${qtyName(item, qty)} costs ${fmtCash(cost)}; the treasury has ${fmtCash(treasury)}.`);
    f.inventory[item] = (f.inventory[item] || 0) + qty;
    return { treasury: treasury - cost, msg: `✓ Bought ${qtyName(item, qty)} for ${fmtCash(cost)}.` };
  });

  const buildLine = () => act((f, treasury) => {
    if (f.lines.length >= MAX_LINES) throw new Error(`A company can have at most ${MAX_LINES} production lines.`);
    if (treasury < LINE_COST) throw new Error(`A line costs ${fmtCash(LINE_COST)}; the treasury has ${fmtCash(treasury)}.`);
    f.lines.push({ id: Date.now().toString(36), recipe: "steel", queued: 0, startedAt: null, made: 0 });
    return { treasury: treasury - LINE_COST, msg: `✓ Built line ${f.lines.length}.` };
  });

  const setRecipe = (i, recipe) => act((f) => {
    const line = f.lines[i];
    if (line.queued) throw new Error("Clear this line's queue before switching what it makes.");
    line.recipe = recipe;
    return { msg: `✓ Line ${i + 1} now makes ${ITEMS[recipe].many}.` };
  });

  const queue = (i, n) => act((f, treasury, now) => {
    const line = f.lines[i];
    if (line.queued + n > MAX_QUEUE) throw new Error(`A line's queue holds at most ${MAX_QUEUE.toLocaleString()} units.`);
    // A queue keeps the inputs it started with, so a refund always matches what was taken
    if (!line.queued || !line.inputs) line.inputs = inputsFor(line.recipe, f.research);
    const r = { inputs: line.inputs };
    const short = Object.entries(r.inputs).filter(([k, q]) => (f.inventory[k] || 0) < q * n)
      .map(([k, q]) => `${(q * n - (f.inventory[k] || 0)).toLocaleString()} more ${q * n - (f.inventory[k] || 0) === 1 ? ITEMS[k].one : ITEMS[k].many}`);
    if (short.length) throw new Error(`Not enough in the warehouse: you need ${short.join(", ")}.`);
    for (const [k, q] of Object.entries(r.inputs)) f.inventory[k] -= q * n;
    if (!line.queued) line.startedAt = now;
    line.queued += n;
    return { msg: `✓ Queued ${qtyName(line.recipe, n)} on line ${i + 1}.` };
  });

  const clearQueue = (i) => act((f) => {
    const line = f.lines[i], r = { inputs: line.inputs || inputsFor(line.recipe) };
    if (!line.queued) return { msg: "That line's queue is already empty." };
    for (const [k, q] of Object.entries(r.inputs)) f.inventory[k] = (f.inventory[k] || 0) + q * line.queued;
    const n = line.queued;
    line.queued = 0; line.startedAt = null;
    return { msg: `✓ Cleared ${n.toLocaleString()} unmade units from line ${i + 1}; their materials are back in the warehouse.` };
  });

  const startResearch = (key) => act((f, treasury, now) => {
    const r = RESEARCH[key];
    if (f.research[key]) throw new Error(`${r.name} is already researched.`);
    if (f.project) throw new Error(`Your lab is busy with ${RESEARCH[f.project.key].name}. One project at a time.`);
    if (r.needs && !f.research[r.needs]) throw new Error(`Research ${RESEARCH[r.needs].name} first.`);
    if (treasury < r.cost) throw new Error(`${r.name} costs ${fmtCash(r.cost)}; the treasury has ${fmtCash(treasury)}.`);
    const baseMs = (r.hours * 3600000) / (f.research.labs ? 2 : 1);
    const ms = baseMs / researchSpeed(f);
    f.project = { key, startedAt: now, endsAt: now + ms, baseMs };
    return { treasury: treasury - r.cost, msg: `✓ Started researching ${r.name}. Done in ${fmtDur(ms / 1000)}.` };
  });

  const upgradeRobots = (i) => act((f, treasury, now) => {
    const line = f.lines[i], tier = (line.robots || 0) + 1, next = ROBOTS[tier];
    if (!next) throw new Error(`Line ${i + 1} is already fully automated.`);
    if (!f.research[next.needs]) throw new Error(`Research ${RESEARCH[next.needs].name} first.`);
    if (treasury < next.cost) throw new Error(`${next.name} cost ${fmtCash(next.cost)}; the treasury has ${fmtCash(treasury)}.`);
    // Keep the unit in progress at the same percent done, then carry on at the new speed
    rebase(f, now, () => { line.robots = tier; });
    return { treasury: treasury - next.cost, msg: `✓ Line ${i + 1} now has ${next.name.toLowerCase()}: ${next.mult}× speed.` };
  });

  const hire = (cand) => act((f) => {
    if (f.staff.length >= MAX_STAFF) throw new Error(`A company can employ at most ${MAX_STAFF} people.`);
    if (f.staff.some((s) => s.id === cand.id)) throw new Error(`${cand.name} already works here.`);
    rebase(f, Date.now(), () => {
      f.staff.push({ ...cand, line: null, hiredAt: Date.now() });
    });
    return { msg: `✓ Hired ${cand.name} as a ${ROLES[cand.role].name.toLowerCase()} for ${fmtCash(cand.wage)}/hour.` };
  });

  const assign = (id, lineId) => act((f, treasury, now) => {
    const s = f.staff.find((x) => x.id === id);
    if (!s) throw new Error("That person no longer works here.");
    const line = f.lines.find((l) => l.id === lineId);
    if (line && workersOn(f, line).filter((x) => x.id !== id).length >= MAX_WORKERS_PER_LINE)
      throw new Error(`A line takes at most ${MAX_WORKERS_PER_LINE} workers.`);
    if (!is(s, "worker")) throw new Error(`${s.name} doesn't work on lines.`);
    rebase(f, now, () => { s.line = line ? line.id : null; });
    return { msg: line ? `✓ ${s.name} now works on line ${f.lines.indexOf(line) + 1}.` : `✓ ${s.name} is unassigned.` };
  });

  const train = (id) => act((f, treasury, now) => {
    const s = f.staff.find((x) => x.id === id);
    if (!s) throw new Error("That person no longer works here.");
    if (s.fixed) throw new Error(`${s.name} can't be trained. He's already off the charts.`);
    if (s.skill >= 5) throw new Error(`${s.name} is already at the top skill level.`);
    const cost = trainCost(s.skill);
    if (treasury < cost) throw new Error(`Training costs ${fmtCash(cost)}; the treasury has ${fmtCash(treasury)}.`);
    rebase(f, now, () => { s.skill += 1; s.wage = wageFor(s.role, s.skill); });
    return { treasury: treasury - cost, msg: `✓ ${s.name} is now skill ${s.skill}; their wage is ${fmtCash(s.wage)}/hour.` };
  });

  const fire = (id) => act((f, treasury, now) => {
    const s = f.staff.find((x) => x.id === id);
    if (!s) throw new Error("That person no longer works here.");
    if (s.fixed) throw new Error(`${s.name} can't be let go. He's part of the company now.`);
    rebase(f, now, () => { f.staff = f.staff.filter((x) => x.id !== id); });
    return { msg: `✓ ${s.name} has left the company.` };
  });

  // Count finished units (and bank car sales) without changing anything else.
  async function settleNow() {
    if (!iControl() || !st.factory) return;
    st.lastSettle = Date.now();
    await act(null);
  }

  /* ---------- rendering ---------- */
  function setMsg(text, kind) {
    // Shown at the top of the factory and inside the Employees panel, so it's seen wherever you clicked
    for (const id of ["fMsg", "staffMsg"]) {
      const m = g(id);
      if (!m) continue;
      m.textContent = text;
      m.className = "status" + (kind ? " " + kind : "");
    }
  }

  /* ---------- Employees side panel ---------- */
  function setDrawer(open) {
    const d = g("staffDrawer");
    d.classList.toggle("open", open);
    document.body.classList.toggle("staff-open", open);
    g("staffHandle").setAttribute("aria-expanded", String(open));
    try { localStorage.setItem("staffDrawerOpen", open ? "1" : "0"); } catch (e) { /* storage blocked: fine */ }
    if (open) { renderStaff(); g("staffClose").focus(); } else if (document.activeElement && d.contains(document.activeElement)) g("staffHandle").focus();
    if (user) setTimeout(renderLines, 250);          // the factory column changes width on wide screens
  }

  async function run(fn) {
    if (st.busy) return;
    st.busy = true;
    setMsg("", "");
    try { const msg = await fn(); if (msg) setMsg(msg, "ok"); }
    catch (e) { setMsg(errText(e), "err"); }
    finally { st.busy = false; }
  }

  // What the factory looks like right now, counting units finished since the last save.
  function projected() {
    const f = addFixedStaff(clone(st.factory || blank()), st.ticker);
    const income = settle(f, Date.now());
    return { f, income };
  }

  function renderPicker() {
    const sel = g("fCompany");
    const mine = st.companies.filter((c) => user && c.controller === user.uid);
    const others = st.companies.filter((c) => !(user && c.controller === user.uid));
    const opts = [...mine, ...others].map((c) => {
      const o = mk("option", null, `${c.ticker} · ${c.name}${user && c.controller === user.uid ? " (you run it)" : ""}`);
      o.value = c.ticker;
      return o;
    });
    const key = opts.map((o) => o.textContent).join("|");
    if (sel.dataset.key !== key) { sel.replaceChildren(...opts); sel.dataset.key = key; }
    if (st.ticker) sel.value = st.ticker;
  }

  function renderSummary() {
    const box = g("fSummary");
    const c = company();
    if (!c) { box.replaceChildren(mk("div", "empty", "No companies yet. Found one on the Stocks tab, then come back to build its factory.")); return; }
    const { f, income } = projected();
    const kpis = mk("div", "kpis four");
    const k = (label, value, sub) => { const d = mk("div", "kpi"); d.append(mk("span", "k", label), mk("b", null, value)); if (sub) d.append(mk("span", "ks", sub)); return d; };
    kpis.append(
      k("Treasury", fmtCash(c.treasury + income), income ? `includes ${fmtCash(income)} from cars just sold` : "pays for materials and lines"),
      k("Production lines", `${f.lines.length} / ${MAX_LINES}`, `${f.lines.filter((l) => l.queued).length} running`),
      k("Cars sold", f.carsSold.toLocaleString(), `to everyday buyers at ${fmtCash(carPrice(f))} each`),
      k("Car revenue", fmtCash(f.revenue), "all-time, into the treasury")
    );
    const who = mk("p", "co-note", iControl()
      ? "You control this company, so you run its factory."
      : `Only ${c.controllerName}, who controls ${c.ticker}, can run this factory. You can look around.`);
    box.replaceChildren(kpis, who);
  }

  function renderLines() {
    const box = g("fLines");
    const { f } = projected();
    const can = iControl();
    g("fBuild").classList.toggle("hidden", !can || f.lines.length >= MAX_LINES);
    g("fBuild").textContent = `Build a production line (${fmtCash(LINE_COST)})`;
    if (!f.lines.length) {
      box.replaceChildren(mk("div", "empty", can ? "No lines yet. Build one to start making things." : "This company hasn't built any lines."));
      return;
    }
    box.replaceChildren(...f.lines.map((line, i) => {
      const r = RECIPES[line.recipe];
      const card = mk("div", "f-line");
      const head = mk("div", "f-line-head");
      const name = mk("b", null, `Line ${i + 1}`);
      let what;
      if (can && !line.queued) {
        what = mk("select", "f-recipe");
        what.id = `fRecipe${i}`;
        what.setAttribute("aria-label", `What line ${i + 1} makes`);
        for (const key of Object.keys(RECIPES)) { const o = mk("option", null, ITEMS[key].name); o.value = key; what.append(o); }
        what.value = line.recipe;
        what.addEventListener("change", (e) => run(() => setRecipe(i, e.target.value)));
      } else {
        what = mk("span", "chip", `makes ${ITEMS[line.recipe].many}`);
      }
      const tier = ROBOTS[line.robots || 0];
      const robo = mk("span", "chip" + (line.robots ? " robo" : ""), line.robots ? `${tier.name} · ${tier.mult}×` : "No robots");
      const crew = workersOn(f, line);
      const people = mk("span", "chip" + (crew.length ? " crew" : ""), crew.length ? `${crew.length} worker${crew.length === 1 ? "" : "s"} · ${lineMult(line, f).toFixed(2).replace(/\.?0+$/, "")}× total` : "No workers");
      const om = outMult(line, f);
      head.append(name, what, robo, people);
      if (om > 1) head.append(mk("span", "chip glitch", `×${om} output`));
      head.append(mk("span", "f-made", `${(line.made || 0).toLocaleString()} made`));
      const inputs = line.queued && line.inputs
        ? Object.entries(line.inputs).map(([k, n]) => qtyName(k, n)).join(" + ")
        : inputsText(line.recipe, f.research);
      const recipe = mk("div", "f-recipe-text", `${inputs} → ${om > 1 ? `${om} ${ITEMS[line.recipe].many}` : `1 ${ITEMS[line.recipe].one}`} · ${fmtDur(unitMs(line, f) / 1000)} each${r.sellsFor ? ` · sold instantly for ${fmtCash(carPrice(f))}` : ""}`);
      const bar = mk("div", "progress"); const fill = mk("div"); fill.dataset.line = i; bar.append(fill);
      const status = mk("div", "f-status"); status.dataset.line = i;
      card.append(head, recipe, bar, status);
      if (can) {
        const row = mk("div", "co-form");
        const l = mk("label", "field"); l.htmlFor = `fQty${i}`;
        const input = mk("input"); input.id = `fQty${i}`; input.type = "number"; input.min = 1; input.step = 1; input.value = 10;
        l.append(mk("span", null, "Add to queue"), input);
        const add = mk("button", "btn-ghost", "Queue");
        add.addEventListener("click", () => {
          const n = Math.floor(Number(input.value));
          if (!(n >= 1)) return setMsg("Enter how many units to queue.", "err");
          run(() => queue(i, n));
        });
        const clear = mk("button", "btn-ghost", "Clear queue");
        clear.addEventListener("click", () => run(() => clearQueue(i)));
        row.append(l, add, clear);
        card.append(row);
        const next = ROBOTS[(line.robots || 0) + 1];
        if (next && f.research[next.needs]) {
          const up = mk("button", "btn-ghost f-upgrade", `Upgrade to ${next.name.toLowerCase()} (${next.mult}× speed) · ${fmtCash(next.cost)}`);
          up.addEventListener("click", () => run(() => upgradeRobots(i)));
          card.append(up);
        }
      }
      return card;
    }));
    tick();
  }

  // Runs every second: progress bars and countdowns, without rebuilding the inputs.
  function tick() {
    if (!st.factory) return;
    const now = Date.now();
    const { f } = projected();
    const rf = document.querySelector('#fResearch .progress > div[data-research]');
    const rl = document.querySelector('#fResearch .f-res-left[data-research]');
    if (f.project && rf && rl) {
      rf.style.width = Math.min(100, ((now - f.project.startedAt) / (f.project.endsAt - f.project.startedAt)) * 100) + "%";
      rl.textContent = `done in ${fmtDur((f.project.endsAt - now) / 1000)}`;
    } else if (!f.project && rf) renderResearch();   // just finished

    f.lines.forEach((line, i) => {
      const fill = document.querySelector(`#fLines .progress > div[data-line="${i}"]`);
      const status = document.querySelector(`#fLines .f-status[data-line="${i}"]`);
      if (!fill || !status) return;
      const per = unitMs(line, f);
      if (!line.queued) {
        fill.style.width = "0%";
        status.textContent = "Idle. Queue some units to start.";
        return;
      }
      const into = now - line.startedAt;
      fill.style.width = Math.min(100, (into / per) * 100) + "%";
      status.textContent = `${line.queued.toLocaleString()} in the queue · next one in ${fmtDur((per - into) / 1000)} · all done in ${fmtDur((line.queued * per - into) / 1000)}`;
    });
  }

  function renderResearch() {
    const box = g("fResearch");
    const { f } = projected();
    const can = iControl();
    box.replaceChildren(...Object.entries(RESEARCH).map(([key, r]) => {
      const row = mk("div", "f-res");
      const done = !!f.research[key];
      const active = f.project && f.project.key === key;
      const locked = r.needs && !f.research[r.needs];
      const ms = (r.hours * 3600000) / (f.research.labs && key !== "labs" ? 2 : 1) / researchSpeed(f);
      const info = mk("div", "f-res-info");
      info.append(mk("b", null, r.name), mk("span", null, r.does));
      const side = mk("div", "f-res-side");
      if (done) side.append(mk("span", "tag saved", "✓ researched"));
      else if (active) {
        const bar = mk("div", "progress"); const fill = mk("div"); fill.dataset.research = "1"; bar.append(fill);
        const left = mk("span", "f-res-left"); left.dataset.research = "1";
        side.append(bar, left);
      } else if (locked) side.append(mk("span", "tag pend", `needs ${RESEARCH[r.needs].name}`));
      else if (can) {
        const b = mk("button", "btn-ghost", `Research · ${fmtCash(r.cost)} · ${fmtDur(ms / 1000)}`);
        b.disabled = !!f.project;
        if (f.project) b.title = "The lab is busy with another project";
        b.addEventListener("click", () => run(() => startResearch(key)));
        side.append(b);
      } else side.append(mk("span", "tag pend", `${fmtCash(r.cost)} · ${fmtDur(ms / 1000)}`));
      row.append(info, side);
      return row;
    }));
    tick();
  }

  const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);

  function renderStaff() {
    const { f } = projected();
    const can = iControl(), c = company();
    const pay = payrollPerHour(f);
    const nextPay = Math.max(0, Math.ceil(((f.wagesPaidTo || Math.floor(Date.now() / HOUR) * HOUR) + HOUR - Date.now()) / 60000));
    const sum = g("fPayroll");
    sum.replaceChildren(mk("p", "co-note", f.staff.length
      ? `${f.staff.length} of ${MAX_STAFF} employees · ${fmtCash(pay)}/hour in wages, paid hourly from the treasury · next payday in about ${nextPay} min` +
        (c && c.treasury < pay ? " · the treasury can't cover the next payday, so the best-paid will quit" : "")
      : `No employees yet. Workers speed up lines, researchers speed up the lab, salespeople raise car prices, and managers boost everyone.`));
    for (const n of f.news || []) sum.append(mk("p", "co-note neg", n));

    g("staffCount").textContent = f.staff.length;
    g("staffCompany").textContent = c ? `${c.ticker} · ${c.name}${can ? "" : ` (run by ${c.controllerName})`}` : "No company selected";
    const box = g("fStaff");
    if (!f.staff.length) box.replaceChildren(mk("div", "empty", "No one works here yet."));
    else box.replaceChildren(...f.staff.map((sf, i) => {
      const row = mk("div", "f-person");
      const info = mk("div", "f-person-info");
      info.append(
        mk("b", null, sf.name),
        mk("span", null, `${ROLES[sf.role].name} · ${stars(sf.skill)} · ${fmtCash(sf.wage)}/hour`),
        mk("span", null, ROLES[sf.role].does(sf.skill) + (managerBoost(f) > 1 && !is(sf, "manager") ? " (more with your managers)" : ""))
      );
      row.append(info);
      if (can) {
        const acts = mk("div", "f-person-acts");
        if (is(sf, "worker")) {
          const sel = mk("select", "f-recipe");
          sel.id = `fAssign${i}`;
          sel.setAttribute("aria-label", `Where ${sf.name} works`);
          const none = mk("option", null, "Not on a line"); none.value = "";
          sel.append(none, ...f.lines.map((l, j) => { const o = mk("option", null, `Line ${j + 1} (${ITEMS[l.recipe].many})`); o.value = l.id; return o; }));
          sel.value = sf.line || "";
          sel.addEventListener("change", (e) => run(() => assign(sf.id, e.target.value || null)));
          acts.append(sel);
        }
        if (sf.fixed) acts.append(mk("span", "chip robo", "permanent · works for free"));
        if (sf.skill < 5 && !sf.fixed) {
          const t = mk("button", "btn-ghost", `Train · ${fmtCash(trainCost(sf.skill))}`);
          t.addEventListener("click", () => run(() => train(sf.id)));
          acts.append(t);
        }
        if (!sf.fixed) {
          const x = mk("button", "btn-ghost", "Let go");
          x.addEventListener("click", () => run(() => fire(sf.id)));
          acts.append(x);
        }
        row.append(acts);
      } else if (is(sf, "worker")) {
        const l = f.lines.findIndex((x) => x.id === sf.line);
        row.append(mk("span", "chip", l >= 0 ? `line ${l + 1}` : "not on a line"));
      }
      return row;
    }));

    const poolBox = g("fPool");
    g("fPoolCard").classList.toggle("hidden", !can);
    if (!can || !c) return;
    const slot = Math.floor(Date.now() / POOL_MS);
    const pool = candidates(c.ticker, slot).filter((p) => !f.staff.some((s) => s.id === p.id));
    const secs = Math.ceil(((slot + 1) * POOL_MS - Date.now()) / 1000);
    poolBox.replaceChildren(mk("p", "co-note", `New candidates in ${secs >= 60 ? `about ${Math.ceil(secs / 60)} min` : `${secs} s`}.`),
      ...(pool.length ? pool.map((p) => {
        const row = mk("div", "f-person");
        const info = mk("div", "f-person-info");
        info.append(mk("b", null, p.name), mk("span", null, `${ROLES[p.role].name} · ${stars(p.skill)} · ${fmtCash(p.wage)}/hour`), mk("span", null, ROLES[p.role].does(p.skill)));
        const b = mk("button", "btn-ghost", "Hire");
        b.addEventListener("click", () => run(() => hire(p)));
        const acts = mk("div", "f-person-acts"); acts.append(b);
        row.append(info, acts);
        return row;
      }) : [mk("div", "empty", "You've hired everyone in this batch. More are coming.")]));
  }

  function renderWarehouse() {
    const box = g("fInv");
    const { f } = projected();
    const rows = Object.keys(ITEMS).filter((k) => k !== "car");
    box.replaceChildren(...rows.map((k) => {
      const d = mk("div", "f-item" + ((f.inventory[k] || 0) ? "" : " none"));
      d.append(mk("span", null, ITEMS[k].name), mk("b", null, (f.inventory[k] || 0).toLocaleString()));
      return d;
    }));
    g("fBuyBox").classList.toggle("hidden", !iControl());
    renderCost();
  }

  function renderCost() {
    const item = g("fRaw").value, qty = Math.floor(Number(g("fRawQty").value));
    g("fRawCost").textContent = qty > 0 ? `Costs ${fmtCash(ITEMS[item].price * qty)} from the treasury` : "";
  }

  function renderRecipes() {
    const research = st.factory ? projected().f.research : {};
    const rows = Object.keys(RECIPES).map((k) => {
      const r = RECIPES[k];
      const tr = mk("tr");
      tr.append(mk("td", null, ITEMS[k].name), mk("td", null, inputsText(k, research)), mk("td", "num", fmtDur(r.secs)),
        mk("td", null, r.sellsFor ? `Sold instantly to everyday buyers for ${fmtCash(st.factory ? carPrice(projected().f) : r.sellsFor)}` : "Kept in the warehouse"));
      return tr;
    });
    const raw = RAW.map((k) => `${ITEMS[k].name} ${fmtCash(ITEMS[k].price)}`).join(" · ");
    const table = mk("table", "f-table");
    const head = mk("tr");
    for (const h of ["Makes", "From", "Time each", "Then"]) head.append(mk("th", null, h));
    const thead = mk("thead"); thead.append(head);
    const tbody = mk("tbody"); tbody.append(...rows);
    table.append(thead, tbody);
    const wrap = mk("div", "f-table-wrap"); wrap.append(table);
    g("fRecipes").replaceChildren(wrap, mk("p", "co-note", `Raw materials from suppliers: ${raw}. A car's materials cost about $136, so each car earns about $114. Times are for a line without robots; this company's research is already counted in the recipes.`));
  }

  function renderAll() { renderPicker(); renderSummary(); renderLines(); renderWarehouse(); renderResearch(); renderStaff(); renderRecipes(); }

  function watchFactory(ticker) {
    if (factoryUnsub) factoryUnsub();
    st.ticker = ticker;
    st.factory = null;
    factoryUnsub = ticker ? factoryRef(ticker).onSnapshot((s) => {
      st.factory = s.exists ? s.data() : blank();
      renderAll();
    }, (e) => setMsg(errText(e), "err")) : null;
    renderAll();
  }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore) {
    fb = firebaseNs; db = firestore;
    g("fRaw").replaceChildren(...RAW.map((k) => { const o = mk("option", null, `${ITEMS[k].name} (${fmtCash(ITEMS[k].price)} each)`); o.value = k; return o; }));
    g("fRaw").addEventListener("change", renderCost);
    g("fRawQty").addEventListener("input", renderCost);
    g("fBuy").addEventListener("click", () => {
      const qty = Math.floor(Number(g("fRawQty").value));
      if (!(qty >= 1)) return setMsg("Enter how many to buy.", "err");
      run(() => buyRaw(g("fRaw").value, qty));
    });
    g("fBuild").addEventListener("click", () => run(buildLine));
    g("fCompany").addEventListener("change", (e) => watchFactory(e.target.value));
    g("staffHandle").addEventListener("click", () => setDrawer(true));
    g("staffClose").addEventListener("click", () => setDrawer(false));
    g("staffBackdrop").addEventListener("click", () => setDrawer(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && g("staffDrawer").classList.contains("open")) setDrawer(false); });
    renderRecipes();
    setInterval(() => { if (user && st.factory) renderStaff(); }, 15000);   // payday countdown + new candidates every 5 min
    setInterval(() => {
      if (!user) return;
      tick();
      // While the factory tab is open, bank finished units every 30 s
      if (!g("tab-factory").classList.contains("hidden") && Date.now() - st.lastSettle > 30000 && !st.busy) {
        st.lastSettle = Date.now();
        settleNow().catch((e) => console.warn("Factory catch-up:", e));
        renderSummary(); renderWarehouse();
      }
    }, 1000);
  }

  function signIn(u) {
    signOut();
    user = u;
    g("staffHandle").classList.remove("hidden");
    let wasOpen = false;
    try { wasOpen = localStorage.getItem("staffDrawerOpen") === "1"; } catch (e) { /* storage blocked */ }
    // Reopen it only on wide screens, where it sits beside the factory instead of covering it
    if (wasOpen && window.matchMedia("(min-width: 1100px)").matches) setTimeout(() => setDrawer(true), 300);
    unsubs.push(db.collection("companies").orderBy("createdAt", "asc").limit(100).onSnapshot((s) => {
      st.companies = s.docs.map((d) => d.data({ serverTimestamps: "estimate" }));
      if (!st.ticker || !company()) {
        const mine = st.companies.find((c) => c.controller === u.uid) || st.companies[0];
        watchFactory(mine ? mine.ticker : null);
      } else renderAll();
    }, (e) => setMsg(errText(e), "err")));
  }

  function signOut() {
    unsubs.forEach((u) => u());
    unsubs = [];
    if (factoryUnsub) factoryUnsub();
    factoryUnsub = null;
    user = null;
    if (g("staffHandle")) {
      g("staffHandle").classList.add("hidden");
      g("staffDrawer").classList.remove("open");
      document.body.classList.remove("staff-open");
    }
    Object.assign(st, { companies: [], ticker: null, factory: null, busy: false, lastSettle: 0 });
    if (g("fMsg")) { setMsg("", ""); renderAll(); }
  }

  // 5-minute upkeep: bank finished units for every company this player runs
  async function upkeep() {
    if (!user) return;
    for (const c of st.companies.filter((x) => x.controller === user.uid)) {
      await act(null, c.ticker).catch((e) => console.warn("Factory catch-up", c.ticker, e));
    }
  }

  return { init, signIn, signOut, upkeep, RECIPES, ITEMS, RAW, BASE_VALUE, clone, blank, qtyName };
})();
