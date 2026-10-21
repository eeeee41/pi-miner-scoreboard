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
  const lineMult = (line) => ROBOTS[line.robots || 0].mult;
  const unitMs = (line) => (RECIPES[line.recipe].secs * 1000) / lineMult(line);

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
  const blank = () => ({ inventory: {}, lines: [], carsSold: 0, revenue: 0, research: {}, project: null });
  // Every writer of the factory doc goes through this, so no field is ever dropped
  const clone = (f) => JSON.parse(JSON.stringify({
    inventory: f.inventory || {}, lines: f.lines || [], carsSold: f.carsSold || 0, revenue: f.revenue || 0,
    research: f.research || {}, project: f.project || null
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
      const per = unitMs(line);
      const n = Math.min(line.queued, Math.floor((now - line.startedAt) / per));
      if (n <= 0) continue;
      line.queued -= n;
      line.made = (line.made || 0) + n;
      line.startedAt = line.queued ? line.startedAt + n * per : null;
      if (RECIPES[line.recipe].sellsFor) {
        const cash = n * RECIPES[line.recipe].sellsFor;
        f.carsSold += n;
        f.revenue += cash;
        income += cash;
      } else {
        f.inventory[line.recipe] = (f.inventory[line.recipe] || 0) + n;
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
      const f = snap.exists ? clone(snap.data()) : blank();
      const before = JSON.stringify(f);
      const now = Date.now();
      let treasury = c.treasury + settle(f, now);
      if (!change && JSON.stringify(f) === before) return "";   // nothing finished: no write
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
    const ms = (r.hours * 3600000) / (f.research.labs ? 2 : 1);
    f.project = { key, startedAt: now, endsAt: now + ms };
    return { treasury: treasury - r.cost, msg: `✓ Started researching ${r.name}. Done in ${fmtDur(ms / 1000)}.` };
  });

  const upgradeRobots = (i) => act((f, treasury, now) => {
    const line = f.lines[i], tier = (line.robots || 0) + 1, next = ROBOTS[tier];
    if (!next) throw new Error(`Line ${i + 1} is already fully automated.`);
    if (!f.research[next.needs]) throw new Error(`Research ${RESEARCH[next.needs].name} first.`);
    if (treasury < next.cost) throw new Error(`${next.name} cost ${fmtCash(next.cost)}; the treasury has ${fmtCash(treasury)}.`);
    // Keep the unit in progress at the same percent done, then carry on at the new speed
    if (line.queued && line.startedAt) {
      const old = unitMs(line), into = now - line.startedAt;
      line.robots = tier;
      line.startedAt = now - into * (unitMs(line) / old);
    } else line.robots = tier;
    return { treasury: treasury - next.cost, msg: `✓ Line ${i + 1} now has ${next.name.toLowerCase()}: ${next.mult}× speed.` };
  });

  // Count finished units (and bank car sales) without changing anything else.
  async function settleNow() {
    if (!iControl() || !st.factory) return;
    st.lastSettle = Date.now();
    await act(null);
  }

  /* ---------- rendering ---------- */
  function setMsg(text, kind) {
    const m = g("fMsg");
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

  // What the factory looks like right now, counting units finished since the last save.
  function projected() {
    const f = clone(st.factory || blank());
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
      k("Cars sold", f.carsSold.toLocaleString(), `to everyday buyers at ${fmtCash(CAR_PRICE)} each`),
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
      const robo = mk("span", "chip" + (line.robots ? " robo" : ""), line.robots ? `${tier.name} · ${tier.mult}×` : "Workers only");
      head.append(name, what, robo, mk("span", "f-made", `${(line.made || 0).toLocaleString()} made`));
      const inputs = line.queued && line.inputs
        ? Object.entries(line.inputs).map(([k, n]) => qtyName(k, n)).join(" + ")
        : inputsText(line.recipe, f.research);
      const recipe = mk("div", "f-recipe-text", `${inputs} → 1 ${ITEMS[line.recipe].one} · ${fmtDur(unitMs(line) / 1000)} each${r.sellsFor ? ` · sold instantly for ${fmtCash(r.sellsFor)}` : ""}`);
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
      const per = unitMs(line);
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
      const ms = (r.hours * 3600000) / (f.research.labs && key !== "labs" ? 2 : 1);
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
        mk("td", null, r.sellsFor ? `Sold instantly to everyday buyers for ${fmtCash(r.sellsFor)}` : "Kept in the warehouse"));
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

  function renderAll() { renderPicker(); renderSummary(); renderLines(); renderWarehouse(); renderResearch(); renderRecipes(); }

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
    renderRecipes();
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
