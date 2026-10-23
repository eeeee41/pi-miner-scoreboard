/* =====================================================================
   Pi Miner — facility revamp: software, retail and finance
   ---------------------------------------------------------------------
   Software, Retail and Finance companies run sites (kept with the others
   in the factory doc's `sites` list, see sites.js) instead of lines.
   Everything here pays the treasury directly; most of it is counted once
   an hour, catching up on every hour that passed since the last save.

   Software
     office   { kind: "office", job, taken, last, earned }
              Clients offer projects (a fresh set of 4 every 3 hours, the
              same for everyone looking at the company). Take one and the
              office works on it; it's paid in full on time, half if late.
     app      { kind: "app", name, price, devLeft, version, freshAt, subs, earned }
              Develop it, then sell subscriptions at a daily price you set.
              Fewer people subscribe the higher the price. Apps go stale
              over time; shipping an update brings them back and makes
              them a bit better.
     dc       { kind: "dc", servers, customers, price, powerFrom, earned }
              A cloud data centre: install servers (electronics), and
              customers sign up to cloud plans at your price, up to what
              the servers can host. Servers draw power every hour, from the
              grid or an Energy company.
   Retail
     store    { kind: "store", type: boutique|shoes|toys, price, stock, earned, lastHour }
              A back-room workshop turns materials from the warehouse into
              stock; customers come in every hour and buy at your shelf
              price (fewer the higher it is).
   Finance
     branch   { kind: "branch", depRate, loanRate, deposits, loans, earned }
              Pay depositors interest to attract their money, lend up to
              80% of it at your loan rate, and keep the difference, less
              the loans that go bad. Customers' money stays off the books:
              only the interest earned and paid goes through the treasury.
     insurer  { kind: "insurer", premium, policies, earned, lastHour }
              Sell policies at a daily premium; claims come in at random
              (and now and then a storm brings ten times as many).
   ===================================================================== */
const Services = (() => {
  const HOUR = 3600000;
  const INDUSTRIES = ["Software", "Retail", "Finance"];
  const COST = { office: 300000, app: 200000, update: 100000, dc: 600000, boutique: 400000, shoes: 400000, toys: 400000, branch: 500000, insurer: 400000 };
  const UPKEEP = { office: 3000, app: 2000, dc: 4000, boutique: 3500, shoes: 3500, toys: 3500, branch: 4000, insurer: 3000 };   // cents an hour
  const BUILDS = { Software: ["office", "app", "dc"], Retail: ["boutique", "shoes", "toys"], Finance: ["branch", "insurer"] };
  const NAMES = { office: "Dev office", app: "App", dc: "Cloud data centre", boutique: "Boutique", shoes: "Shoe shop", toys: "Toy shop", branch: "Bank branch", insurer: "Insurance office" };
  const KINDS = ["office", "app", "dc", "store", "branch", "insurer"];
  const MAX_CATCHUP = 168;              // hours counted at most after a long time away

  // Software
  const SLOT = 3 * HOUR;                // a fresh set of client projects every 3 hours
  const CLIENTS = ["Kim's Bakery", "Northside Dental", "Hart & Co. Law", "Pixel Arcade", "Green Valley Farm", "Bluebird Hotel", "Metro Gym",
    "Riverside School", "Sunny Day Care", "Oak Street Garage", "Lumen Studio", "Harbor Shipping", "City Library", "Maple Vets"];
  const JOBS = [{ what: "a website", w: [2, 4] }, { what: "a booking system", w: [3, 6] }, { what: "a mobile app", w: [5, 9] },
    { what: "an online shop", w: [4, 7] }, { what: "a data dashboard", w: [2, 5] }, { what: "a payroll system", w: [6, 10] }];
  const APP = { devHours: 4, updateHours: 3, potential: 2000, maxPrice: 800, stale: 0.01, floor: 0.3, maxVersion: 5, catchUp: 0.15 };   // maxPrice: cents a day nobody pays
  const DC = { potential: 600, maxPrice: 3000, perServer: 5, kwh: 20, maxServers: 200, catchUp: 0.2 };
  // Retail
  const STORES = {
    boutique: { item: "clothing", inputs: { cotton: 3 }, ref: 1000 },
    shoes:    { item: "shoes",    inputs: { rubber: 1, cotton: 1, plastic: 1 }, ref: 1000 },
    toys:     { item: "toys",     inputs: { plastic: 3 }, ref: 700 }
  };
  const STORE = { rate: 40, cap: 500, footfall: 60, top: 3 };   // top: nobody buys at this many times the usual price
  // Finance: rates in hundredths of a percent a day (25 = 0.25% a day)
  const BANK = { deposits: 100000000, depRef: 25, depMax: 2, borrow: 150000000, loanMax: 300, lend: 0.8, bad: 0.00005, catchUp: 0.1 };
  const INS = { policies: 10000, maxPremium: 300, claimOdds: 0.015, claim: 6000, storm: 0.01, catchUp: 0.1 };

  const RESEARCH = {
    agile:     { name: "Agile methods",     cost: 400000, hours: 1.5, needs: null,      ind: ["Software"], does: "Client projects and app development go 30% faster" },
    growth:    { name: "Growth marketing",  cost: 600000, hours: 2,   needs: null,      ind: ["Software"], does: "Apps can win 50% more subscribers" },
    codeq:     { name: "Code quality",      cost: 500000, hours: 2,   needs: "agile",   ind: ["Software"], does: "Apps go stale half as fast" },
    scaling:   { name: "Cloud scaling",     cost: 700000, hours: 2.5, needs: null,      ind: ["Software"], does: "Each server hosts 8 customers instead of 5" },
    displays:  { name: "Window displays",   cost: 400000, hours: 1.5, needs: null,      ind: ["Retail"],   does: "30% more customers come into every store" },
    supply:    { name: "Supply chain",      cost: 500000, hours: 2,   needs: null,      ind: ["Retail"],   does: "Store workshops make 50% more an hour" },
    loyalty:   { name: "Loyalty cards",     cost: 600000, hours: 2,   needs: "displays", ind: ["Retail"],  does: "Customers keep buying at prices 25% higher" },
    scoring:   { name: "Credit scoring",    cost: 500000, hours: 2,   needs: null,      ind: ["Finance"],  does: "Half as many loans go bad" },
    network:   { name: "Branch network",    cost: 600000, hours: 2,   needs: null,      ind: ["Finance"],  does: "Branches attract 50% more deposits" },
    actuary:   { name: "Actuaries",         cost: 500000, hours: 2,   needs: null,      ind: ["Finance"],  does: "Claims cost 25% less" },
    reinsure:  { name: "Reinsurance",       cost: 800000, hours: 3,   needs: "actuary", ind: ["Finance"],  does: "No hour's claims ever cost more than 3 times the usual" }
  };

  // Same random numbers every time for the same key (so every page agrees)
  function roll(key) {
    let h = 2166136261;
    for (const ch of String(key)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  }
  function poisson(lambda, u) {
    let k = 0, p = Math.exp(-lambda), F = p;
    while (u > F && k < 500) { k++; p *= lambda / k; F += p; }
    return k;
  }
  const handles = (kind) => KINDS.includes(kind);
  const upkeepOf = (s) => (s.kind === "store" ? UPKEEP[s.type] : UPKEEP[s.kind]) || 0;
  const builds = (ind) => BUILDS[ind] || [];

  /* ---------- the numbers ---------- */
  const workRate = (research, crew) => crew * (research.agile ? 1.3 : 1);       // work hours done per hour
  function offers(ticker, slot) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const r = (k) => roll(`${ticker}:${slot}:${i}:${k}`);
      const job = JOBS[Math.floor(r("j") * JOBS.length)], client = CLIENTS[Math.floor(r("c") * CLIENTS.length)];
      const work = job.w[0] + Math.floor(r("w") * (job.w[1] - job.w[0] + 1));
      const pay = Math.round((25000 + r("p") * 15000) * work / 1000) * 1000;   // $250–$400 per hour of work, to the $10
      out.push({ id: `${slot}-${i}`, name: `${job.what.replace(/^./, (x) => x.toUpperCase())} for ${client}`, work, pay, hours: Math.ceil(work * 1.6) + 2 });
    }
    return out;
  }
  const appVersionBoost = (s) => 1 + 0.2 * (Math.min(APP.maxVersion, s.version || 1) - 1);
  const freshness = (s, t, research) => Math.max(APP.floor, 1 - APP.stale * (research.codeq ? 0.5 : 1) * Math.max(0, t - s.freshAt) / HOUR);
  const appTarget = (s, t, research) => APP.potential * (research.growth ? 1.5 : 1) * appVersionBoost(s) * freshness(s, t, research) * Math.max(0, 1 - s.price / APP.maxPrice);
  const dcCap = (s, research) => (s.servers || 0) * (research.scaling ? 8 : DC.perServer);
  const dcTarget = (s, research) => Math.min(dcCap(s, research), DC.potential * Math.max(0, 1 - s.price / DC.maxPrice));
  const storeMax = (s, research) => STORES[s.type].ref * STORE.top * (research.loyalty ? 1.25 : 1);
  const storeCustomers = (s, research) => Math.round(STORE.footfall * (research.displays ? 1.3 : 1) * Math.max(0, 1 - s.price / storeMax(s, research)));
  const storeRate = (research, crew, out) => Math.floor(STORE.rate * (research.supply ? 1.5 : 1) * crew * out);
  const depTarget = (s, research) => BANK.deposits * Math.min(BANK.depMax, s.depRate / BANK.depRef) * (research.network ? 1.5 : 1);
  const loanTarget = (s) => Math.min(BANK.lend * (s.deposits || 0), BANK.borrow * Math.max(0, 1 - s.loanRate / BANK.loanMax));
  const badRate = (s, research) => BANK.bad * (s.loanRate / 100) ** 2 * (research.scoring ? 0.5 : 1);   // share of loans that go bad an hour
  const bankHour = (s, research) => Math.round((s.loans * s.loanRate) / 1e4 / 24 - (s.deposits * s.depRate) / 1e4 / 24 - s.loans * badRate(s, research));
  const polTarget = (s) => INS.policies * Math.max(0, 1 - s.premium / INS.maxPremium);
  const claimExpected = (s, research) => (s.policies * INS.claimOdds / 24) * INS.claim * (research.actuary ? 0.75 : 1);

  /* ---------- catching up (from Sites.settle) ----------
     Returns the treasury after. H = { research, crew(site), out(site), buyPower }; ticker for the offers. */
  function settle(s, f, now, treasury, H) {
    const research = H.research || {};
    const pay = (n) => { treasury += n; s.earned = (s.earned || 0) + n; f.revenue = (f.revenue || 0) + Math.max(0, n); };
    if (s.kind === "office") {
      if (s.job) {
        const j = s.job, from = Math.max(s.lastAt || j.startedAt, j.startedAt), rate = workRate(research, H.crew(s) * H.out(s));
        const did = (rate * Math.max(0, now - from)) / HOUR;
        if (j.done + did >= j.work) {
          const t = from + ((j.work - j.done) / rate) * HOUR, late = t > j.due;
          const amount = late ? Math.round(j.pay / 2) : j.pay;
          pay(amount);
          s.last = { name: j.name, pay: amount, late, at: Math.round(t) };
          s.job = null;
        } else j.done += did;
      }
      s.lastAt = now;
      return treasury;
    }
    if (s.kind === "app" && s.devLeft > 0) {
      // Development (a new app, or an update while the old version keeps selling)
      const from = Math.max(s.devAt || s.builtAt, s.builtAt), rate = workRate(research, H.crew(s) * H.out(s));
      const did = (rate * Math.max(0, now - from)) / HOUR;
      s.devAt = now;
      if (did >= s.devLeft) {
        const t = Math.round(from + (s.devLeft / rate) * HOUR);
        s.devLeft = 0; s.version = (s.version || 0) + 1; s.freshAt = t;
        if (!s.lastAt) s.lastAt = t;                       // the first release starts the subscription clock
      } else { s.devLeft -= did; if (!s.version) return treasury; }
    }
    if (s.kind === "app" && !s.version) return treasury;
    // Hour by hour from here on
    let from = s.lastAt || s.builtAt;
    let hours = Math.floor((now - from) / HOUR);
    if (hours > MAX_CATCHUP) { from += (hours - MAX_CATCHUP) * HOUR; hours = MAX_CATCHUP; }
    for (let i = 0; i < hours; i++) {
      const t = from + (i + 1) * HOUR;
      if (s.kind === "app") {
        s.subs = Math.max(0, Math.round((s.subs || 0) + (appTarget(s, t, research) - (s.subs || 0)) * APP.catchUp));
        pay(Math.round((s.subs * s.price) / 24));
      } else if (s.kind === "dc") {
        const kwh = (s.servers || 0) * DC.kwh;
        const power = kwh ? H.buyPower(s.powerFrom || null, kwh, treasury) : { cost: 0 };
        if (!power) { s.noPower = true; s.customers = Math.floor((s.customers || 0) * 0.8); continue; }
        s.noPower = false;
        treasury -= power.cost; s.powerCost = (s.powerCost || 0) + power.cost;
        const target = dcTarget(s, research);
        s.customers = Math.min(dcCap(s, research), Math.max(0, Math.round((s.customers || 0) + (target - (s.customers || 0)) * DC.catchUp)));
        pay(Math.round((s.customers * s.price) / 24));
      } else if (s.kind === "store") {
        const st = STORES[s.type];
        let make = Math.min(storeRate(research, H.crew(s), H.out(s)), STORE.cap - (s.stock || 0));
        for (const [k, q] of Object.entries(st.inputs)) make = Math.min(make, Math.floor((f.inventory[k] || 0) / q));
        make = Math.max(0, make);
        for (const [k, q] of Object.entries(st.inputs)) f.inventory[k] -= q * make;
        s.stock = (s.stock || 0) + make;
        const sold = Math.min(s.stock, storeCustomers(s, research));
        s.stock -= sold; s.sold = (s.sold || 0) + sold;
        f.carsSold = (f.carsSold || 0) + sold;
        pay(sold * s.price);
        s.lastHour = { made: make, sold, revenue: sold * s.price, short: make < storeRate(research, H.crew(s), H.out(s)) && s.stock < STORE.cap };
      } else if (s.kind === "branch") {
        s.deposits = Math.max(0, Math.round((s.deposits || 0) + (depTarget(s, research) - (s.deposits || 0)) * BANK.catchUp));
        s.loans = Math.max(0, Math.round((s.loans || 0) + (loanTarget(s) - (s.loans || 0)) * BANK.catchUp));
        const net = bankHour(s, research);
        if (treasury + net < 0) { pay(-treasury); s.deposits = Math.round(s.deposits * 0.8); s.trouble = true; }   // can't pay depositors: they leave
        else { pay(net); s.trouble = false; }
        s.lastHour = { net };
      } else if (s.kind === "insurer") {
        s.policies = Math.max(0, Math.round((s.policies || 0) + (polTarget(s) - (s.policies || 0)) * INS.catchUp));
        const premiums = Math.round((s.policies * s.premium) / 24);
        const hourKey = `${s.id}:${Math.floor(t / HOUR)}`;
        const lambda = (s.policies * INS.claimOdds) / 24;
        let n = poisson(lambda, roll(hourKey));
        const storm = roll(`${hourKey}:storm`) < INS.storm;
        if (storm) n *= 10;
        let claims = Math.round(n * INS.claim * (0.5 + roll(`${hourKey}:size`)) * (research.actuary ? 0.75 : 1));
        if (research.reinsure) claims = Math.min(claims, Math.round(3 * claimExpected(s, research)));
        const net = premiums - claims;
        if (treasury + net < 0) { pay(-treasury); s.policies = Math.round(s.policies * 0.7); s.trouble = true; }   // claims it couldn't pay: customers leave
        else { pay(net); s.trouble = false; }
        s.lastHour = { premiums, claims, n, storm };
      }
    }
    if (hours > 0) s.lastAt = from + hours * HOUR;
    return treasury;
  }

  /* ---------- actions ---------- */
  const fmtCash = (c) => Economy.fmtCash(c);
  const act = (change, fee) => Factory.actFor(undefined, change, fee ? { fee } : {});
  const find = (f, id) => { const s = (f.sites || []).find((x) => x.id === id); if (!s) throw new Error("That site is gone."); return s; };
  const spend = (treasury, cost, what) => { if (cost > treasury) throw new Error(`${what} costs ${fmtCash(cost)}; the treasury has ${fmtCash(treasury)}.`); return treasury - cost; };
  const newId = () => `s${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const cents = (v) => Math.round(Number(v) * 100);
  const MADE = {
    office: () => ({ kind: "office", job: null, taken: [] }),
    app: () => ({ kind: "app", name: "", price: 400, devLeft: APP.devHours, version: 0, subs: 0 }),
    dc: () => ({ kind: "dc", servers: 0, customers: 0, price: 1500, powerFrom: null }),
    boutique: () => ({ kind: "store", type: "boutique", price: 1500, stock: 0 }),
    shoes: () => ({ kind: "store", type: "shoes", price: 1500, stock: 0 }),
    toys: () => ({ kind: "store", type: "toys", price: 1000, stock: 0 }),
    branch: () => ({ kind: "branch", depRate: 25, loanRate: 150, deposits: 0, loans: 0 }),
    insurer: () => ({ kind: "insurer", premium: 200, policies: 0 })
  };
  const build = (key, appName) => act((f, treasury, now, c) => {
    if ((f.sites || []).length >= Sites.MAX_SITES) throw new Error(`A company can have at most ${Sites.MAX_SITES} sites. Close one first.`);
    if (!builds(c.industry).includes(key)) throw new Error(`${c.industry} companies can't build that.`);
    treasury = spend(treasury, COST[key], key === "app" ? "A new app" : `A ${NAMES[key].toLowerCase()}`);
    const s = { id: newId(), builtAt: now, earned: 0, ...MADE[key]() };
    if (key === "app") { s.name = String(appName || "").trim().slice(0, 30) || `App ${(f.sites || []).filter((x) => x.kind === "app").length + 1}`; s.devAt = now; }
    (f.sites = f.sites || []).push(s);
    const msg = key === "app" ? `✓ Started building ${s.name}: about ${APP.devHours} hours of development (workers speed it up).`
      : key === "office" ? "✓ Dev office open. Take a client project to start earning."
      : key === "dc" ? "✓ Data centre built. Install servers (electronics from the warehouse) so it can host customers."
      : s.kind === "store" ? `✓ ${NAMES[key]} open. Its workshop turns ${Object.keys(STORES[key].inputs).map((k) => Factory.ITEMS[k].many).join(", ")} from the warehouse into ${Factory.ITEMS[STORES[key].item].many}.`
      : key === "branch" ? "✓ Bank branch open. Depositors and borrowers start coming in over the next few hours."
      : "✓ Insurance office open. Customers start buying policies over the next few hours.";
    return { treasury, msg };
  }, "Building a site");
  const takeJob = (id, offerId) => act((f, treasury, now, c) => {
    const s = find(f, id);
    if (s.job) throw new Error("The office is busy with a project already.");
    const slot = Math.floor(now / SLOT);
    const o = offers(c.ticker, slot).find((x) => x.id === offerId);
    if (!o) throw new Error("That offer has expired. Pick one of the new ones.");
    if ((s.taken || []).includes(o.id)) throw new Error("You've already done that one.");
    s.job = { ...o, startedAt: now, due: now + o.hours * HOUR, done: 0 };
    s.taken = [...(s.taken || []), o.id].slice(-12);
    s.lastAt = now;
    return { msg: `✓ Started: ${o.name}. ${o.work} hours of work, due in ${o.hours} hours, pays ${fmtCash(o.pay)}.` };
  });
  const dropJob = (id) => act((f) => { const s = find(f, id); if (!s.job) return { msg: "" }; const n = s.job.name; s.job = null; return { msg: `✓ Dropped ${n}. No pay for it.` }; });
  const shipUpdate = (id) => act((f, treasury, now) => {
    const s = find(f, id);
    if (!s.version) throw new Error("Finish the first version first.");
    if (s.devLeft > 0) throw new Error("An update is already being built.");
    treasury = spend(treasury, COST.update, "An update");
    Object.assign(s, { devLeft: APP.updateHours, devAt: now });
    return { treasury, msg: `✓ Working on version ${s.version + 1} (about ${APP.updateHours} hours). The current version keeps selling meanwhile.` };
  }, "Starting an update");
  const setFields = (id, upd, msg) => act((f) => { Object.assign(find(f, id), upd); return { msg }; });
  const install = (id, n, out) => act((f) => {
    const s = find(f, id);
    if (out) {
      if (n > (s.servers || 0)) throw new Error(`It has ${s.servers || 0} servers.`);
      s.servers -= n; f.inventory.electronics = (f.inventory.electronics || 0) + n;
      s.customers = Math.min(s.customers || 0, dcCap(s, f.research));
      return { msg: `✓ Took out ${n} servers.` };
    }
    if ((s.servers || 0) + n > DC.maxServers) throw new Error(`A data centre holds at most ${DC.maxServers} servers.`);
    if ((f.inventory.electronics || 0) < n) throw new Error(`The warehouse has ${(f.inventory.electronics || 0).toLocaleString()} electronics. Buy some from suppliers or an Electronics company.`);
    f.inventory.electronics -= n; s.servers = (s.servers || 0) + n;
    if (!s.lastAt) s.lastAt = Date.now();
    return { msg: `✓ Installed ${n} servers: room for ${dcCap(s, f.research).toLocaleString()} customers.` };
  });
  const takeStock = (id) => act((f) => {
    const s = find(f, id), st = STORES[s.type];
    const n = s.stock || 0;
    if (!n) return { msg: "The shelves are empty." };
    s.stock = 0;
    return { msg: `✓ Cleared ${n} ${Factory.ITEMS[st.item].many} off the shelves (they're given away to charity).` };
  });

  /* ---------- rendering ---------- */
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let runFn = null;
  const button = (label, fn, cls = "btn-ghost") => { const b = mk("button", cls, label); b.addEventListener("click", () => runFn(fn)); return b; };
  const progress = (x) => { const bar = mk("div", "progress"); const fill = mk("div"); fill.style.width = Math.max(0, Math.min(100, x * 100)) + "%"; bar.append(fill); return bar; };
  const field = (id, label, value, step = "0.01") => {
    const l = mk("label", "field"), inp = mk("input"); inp.type = "number"; inp.min = 0; inp.step = step; inp.value = value; inp.id = id;
    l.htmlFor = id; l.append(mk("span", null, label), inp); return { l, inp };
  };
  const pctDay = (r) => `${(r / 100).toFixed(2)}% a day`;
  const head = (s, f, title, crewChip) => { const card = mk("div", "f-line"), h = mk("div", "f-line-head"); h.append(mk("b", null, title), ...crewChip(s, f)); card.append(h); return card; };
  const status = (s, extra) => mk("div", "f-status", `${extra ? extra + " · " : ""}${fmtCash(s.earned || 0)} earned so far · upkeep ${fmtCash(upkeepOf(s))}/hour${s.paused ? " · stopped: upkeep unpaid" : ""}`);
  const nextHour = (s) => { const t = Date.now(), from = s.lastAt || s.builtAt; return Factory.fmtDur((HOUR - ((t - from) % HOUR)) / 1000); };

  function card(s, f, can, c, run, crewChip) {
    runFn = run;
    const research = f.research || {}, t = Date.now();
    if (s.kind === "office") {
      const k = head(s, f, NAMES.office, crewChip), rate = workRate(research, Factory.crewMult(s, f) * Factory.outMult(s, f));
      if (s.job) {
        const j = s.job, done = Math.min(j.work, j.done + (rate * Math.max(0, t - (s.lastAt || j.startedAt))) / HOUR);
        const finish = t + ((j.work - done) / rate) * HOUR;
        k.append(mk("div", "f-recipe-text", `${j.name}: ${fmtCash(j.pay)} on delivery, half if late`), progress(done / j.work),
          mk("div", "f-status", `${done.toFixed(1)} of ${j.work} hours of work · done in about ${Factory.fmtDur((finish - t) / 1000)} · due in ${j.due > t ? Factory.fmtDur((j.due - t) / 1000) : "— it's late"}${finish > j.due ? " · it'll be late: add workers" : ""}`));
        if (can) { const row = mk("div", "co-form"); row.append(button("Drop project", () => dropJob(s.id))); k.append(row); }
      } else {
        const slot = Math.floor(t / SLOT), list = offers(c.ticker, slot).filter((o) => !(s.taken || []).includes(o.id));
        k.append(mk("div", "f-recipe-text", `Free. ${list.length ? "Clients are offering:" : "No offers left right now."} New offers in ${Factory.fmtDur((SLOT - (t % SLOT)) / 1000)}.`));
        for (const o of list) {
          const row = mk("div", "co-form s-offer");
          row.append(mk("span", "f-status", `${o.name} · ${o.work} h of work (${(o.work / rate).toFixed(1)} h for this team) · due in ${o.hours} h · ${fmtCash(o.pay)}`));
          if (can) row.append(button("Take it", () => takeJob(s.id, o.id), "btn-primary buy"));
          k.append(row);
        }
      }
      if (s.last) k.append(mk("div", "f-status", `Last: ${s.last.name} · paid ${fmtCash(s.last.pay)}${s.last.late ? " (late: half)" : ""}`));
      k.append(status(s));
      if (can) { const row = mk("div", "co-form"); row.append(Sites.closeButton(s.id, "Close office")); k.append(row); }
      return k;
    }
    if (s.kind === "app") {
      const k = head(s, f, `${s.name}${s.version ? ` · version ${s.version}` : " · in development"}`, crewChip);
      const rate = workRate(research, Factory.crewMult(s, f) * Factory.outMult(s, f));
      if (s.devLeft > 0) {
        const left = Math.max(0, s.devLeft - (rate * Math.max(0, t - (s.devAt || s.builtAt))) / HOUR), total = s.version ? APP.updateHours : APP.devHours;
        k.append(progress(1 - left / total), mk("div", "f-status", `${s.version ? `Version ${s.version + 1}` : "First version"} ready in about ${Factory.fmtDur((left / rate) * 3600)}`));
      }
      if (s.version) {
        const target = Math.round(appTarget(s, t, research));
        k.append(mk("div", "f-recipe-text", `${(s.subs || 0).toLocaleString()} subscribers at ${fmtCash(s.price)} a day · about ${fmtCash(Math.round(((s.subs || 0) * s.price) / 24))} an hour · heading for ${target.toLocaleString()} at this price · freshness ${Math.round(freshness(s, t, research) * 100)}% (updates bring it back)`));
      }
      k.append(status(s, s.version ? `next count in ${nextHour(s)}` : ""));
      if (can) {
        const row = mk("div", "co-form"), p = field(`sAppPrice-${s.id}`, "Price ($ a day)", (s.price / 100).toFixed(2));
        row.append(p.l, button("Set price", () => { const v = cents(p.inp.value); if (!(v >= 1)) throw new Error("Enter a price."); return setFields(s.id, { price: v }, `✓ ${s.name} now costs ${fmtCash(v)} a day.`); }));
        if (s.version && !(s.devLeft > 0)) row.append(button(`Ship an update · ${fmtCash(COST.update)}`, () => shipUpdate(s.id)));
        row.append(Sites.closeButton(s.id, "Shut down app"));
        k.append(row, mk("p", "co-note", `Nobody pays ${fmtCash(APP.maxPrice)} a day; half as many subscribe at half that. The most money is usually around ${fmtCash(APP.maxPrice / 2)}.`));
      }
      return k;
    }
    if (s.kind === "dc") {
      const k = head(s, f, NAMES.dc, crewChip), cap = dcCap(s, research);
      k.append(mk("div", "f-recipe-text", `${(s.customers || 0).toLocaleString()} customers at ${fmtCash(s.price)} a day (room for ${cap.toLocaleString()} on ${(s.servers || 0).toLocaleString()} servers) · heading for ${Math.round(dcTarget(s, research)).toLocaleString()} · power ${((s.servers || 0) * DC.kwh / 1000).toFixed(2)} MWh an hour from ${s.powerFrom || "the grid"}${s.noPower ? " · couldn't pay for power: customers are leaving" : ""}`),
        status(s, `next count in ${nextHour(s)}`));
      if (can) {
        const row = mk("div", "co-form"), n = field(`sServers-${s.id}`, "Servers", 10, "1");
        row.append(n.l, button("Install", () => install(s.id, Math.floor(Number(n.inp.value)), false)), button("Take out", () => install(s.id, Math.floor(Number(n.inp.value)), true)));
        const row2 = mk("div", "co-form"), p = field(`sDcPrice-${s.id}`, "Price ($ a day)", (s.price / 100).toFixed(2));
        row2.append(p.l, button("Set price", () => { const v = cents(p.inp.value); if (!(v >= 1)) throw new Error("Enter a price."); return setFields(s.id, { price: v }, `✓ Cloud plans now cost ${fmtCash(v)} a day.`); }));
        const sel = mk("select", "f-recipe"); sel.id = `sDcPower-${s.id}`; sel.setAttribute("aria-label", "Buy electricity from");
        const sellers = (Factory.companies() || []).filter((x) => x.industry === "Energy" && x.tariff > 0);
        sel.replaceChildren(Object.assign(mk("option", null, `Grid · ${fmtCash(800)}/MWh`), { value: "" }), ...sellers.map((x) => Object.assign(mk("option", null, `${x.ticker} · ${fmtCash(x.tariff)}/MWh`), { value: x.ticker })));
        sel.value = s.powerFrom && sellers.some((x) => x.ticker === s.powerFrom) ? s.powerFrom : "";
        sel.addEventListener("change", () => runFn(() => setFields(s.id, { powerFrom: sel.value || null }, `✓ Buying power from ${sel.value || "the grid"}.`)));
        row2.append(sel, Sites.closeButton(s.id, "Close data centre"));
        k.append(row, row2, mk("p", "co-note", `Each server hosts ${research.scaling ? 8 : DC.perServer} customers and uses ${DC.kwh} kWh an hour. Nobody pays ${fmtCash(DC.maxPrice)} a day. Closing it loses the servers: take them out first.`));
      }
      return k;
    }
    if (s.kind === "store") {
      const st = STORES[s.type], item = Factory.ITEMS[st.item], k = head(s, f, NAMES[s.type], crewChip);
      const per = Object.entries(st.inputs).map(([x, q]) => `${q} ${Factory.ITEMS[x].many}`).join(" + ");
      const lh = s.lastHour;
      k.append(mk("div", "f-recipe-text", `${(s.stock || 0).toLocaleString()} ${item.many} on the shelves at ${fmtCash(s.price)} · about ${storeCustomers(s, research)} customers an hour at that price · the workshop makes up to ${storeRate(research, Factory.crewMult(s, f), Factory.outMult(s, f))} an hour from ${per} each`),
        lh ? mk("div", "f-status", `Last hour: made ${lh.made}, sold ${lh.sold} for ${fmtCash(lh.revenue)}${lh.short ? " · the workshop ran short of materials" : ""}`) : mk("div", "f-status", "Sales are counted every hour."),
        status(s, `next count in ${nextHour(s)}`));
      if (can) {
        const row = mk("div", "co-form"), p = field(`sShelf-${s.id}`, `Shelf price (usually ${fmtCash(st.ref)})`, (s.price / 100).toFixed(2));
        row.append(p.l, button("Set price", () => { const v = cents(p.inp.value); if (!(v >= 1)) throw new Error("Enter a price."); return setFields(s.id, { price: v }, `✓ ${item.name} now sell for ${fmtCash(v)}.`); }),
          Sites.closeButton(s.id, "Close store"));
        k.append(row, mk("p", "co-note", `Nobody buys at ${fmtCash(storeMax(s, research))}; the most money is usually around half that, as long as the shelves stay stocked.`));
      }
      return k;
    }
    if (s.kind === "branch") {
      const k = head(s, f, NAMES.branch, crewChip);
      const net = bankHour({ ...s, deposits: s.deposits || 0, loans: s.loans || 0 }, research);
      k.append(mk("div", "f-recipe-text", `Deposits ${fmtCash(s.deposits || 0)} (heading for ${fmtCash(Math.round(depTarget(s, research)))}) at ${pctDay(s.depRate)} · loans ${fmtCash(s.loans || 0)} (heading for ${fmtCash(Math.round(loanTarget(s)))}) at ${pctDay(s.loanRate)} · about ${fmtCash(net)} an hour after interest and bad loans${s.trouble ? " · couldn't pay depositors: some left" : ""}`),
        status(s, `next count in ${nextHour(s)}`));
      if (can) {
        const row = mk("div", "co-form");
        const d = field(`sDep-${s.id}`, "Deposit rate (% a day)", (s.depRate / 100).toFixed(2)), l = field(`sLoan-${s.id}`, "Loan rate (% a day)", (s.loanRate / 100).toFixed(2));
        row.append(d.l, l.l, button("Set rates", () => {
          const dr = Math.round(Number(d.inp.value) * 100), lr = Math.round(Number(l.inp.value) * 100);
          if (!(dr >= 0 && dr <= 200 && lr >= 1 && lr <= 1000)) throw new Error("Deposit rates go from 0 to 2% a day, loan rates from 0.01% to 10%.");
          return setFields(s.id, { depRate: dr, loanRate: lr }, `✓ Paying ${pctDay(dr)} on deposits, charging ${pctDay(lr)} on loans.`);
        }), Sites.closeButton(s.id, "Close branch"));
        k.append(row, mk("p", "co-note", `Higher deposit rates bring in more money to lend (up to twice as much at ${pctDay(BANK.depRef * BANK.depMax)}). Fewer people borrow as the loan rate rises (none at ${pctDay(BANK.loanMax)}), and more of them can't pay it back.`));
      }
      return k;
    }
    if (s.kind === "insurer") {
      const k = head(s, f, NAMES.insurer, crewChip), lh = s.lastHour;
      k.append(mk("div", "f-recipe-text", `${(s.policies || 0).toLocaleString()} policies at ${fmtCash(s.premium)} a day (heading for ${Math.round(polTarget(s)).toLocaleString()}) · about ${fmtCash(Math.round(((s.policies || 0) * s.premium) / 24))} an hour in premiums, ${fmtCash(Math.round(claimExpected({ ...s, policies: s.policies || 0 }, research)))} in claims on an average hour${s.trouble ? " · couldn't pay every claim: customers left" : ""}`),
        lh ? mk("div", "f-status", `Last hour: ${fmtCash(lh.premiums)} in premiums, ${lh.n} claim${lh.n === 1 ? "" : "s"} for ${fmtCash(lh.claims)}${lh.storm ? " — a storm!" : ""}`) : mk("div", "f-status", "Premiums and claims are counted every hour."),
        status(s, `next count in ${nextHour(s)}`));
      if (can) {
        const row = mk("div", "co-form"), p = field(`sPrem-${s.id}`, "Premium ($ a day)", (s.premium / 100).toFixed(2));
        row.append(p.l, button("Set premium", () => { const v = cents(p.inp.value); if (!(v >= 1)) throw new Error("Enter a premium."); return setFields(s.id, { premium: v }, `✓ Policies now cost ${fmtCash(v)} a day.`); }),
          Sites.closeButton(s.id, "Close office"));
        k.append(row, mk("p", "co-note", `Nobody buys at ${fmtCash(INS.maxPremium)} a day. Each policy costs about ${fmtCash(Math.round(INS.claimOdds * INS.claim * (research.actuary ? 0.75 : 1)))} a day in claims on average, but claims come in lumps, and about one hour in a hundred a storm brings ten times as many: keep Cash in the treasury.`));
      }
      return k;
    }
    return mk("div");
  }
  // The build row for these industries
  function buildRow(c, run) {
    runFn = run;
    const row = mk("div", "co-form s-build");
    const sel = mk("select", "f-recipe"); sel.id = "sBuild"; sel.setAttribute("aria-label", "What to build");
    sel.replaceChildren(...builds(c.industry).map((k) => { const o = mk("option", null, `${NAMES[k]} · ${fmtCash(COST[k])} (${fmtCash(UPKEEP[k])}/hour)`); o.value = k; return o; }));
    row.append(sel);
    if (c.industry === "Software") {
      const n = mk("input"); n.id = "sAppName"; n.placeholder = "App name"; n.maxLength = 30; n.setAttribute("aria-label", "App name");
      const sync = () => n.classList.toggle("hidden", sel.value !== "app");
      sel.addEventListener("change", sync); sync();
      row.append(n, button("Build", () => build(sel.value, n.value), "btn-primary buy"));
    } else row.append(button("Build", () => build(sel.value), "btn-primary buy"));
    return row;
  }

  const p = (t) => mk("p", "co-note", t);
  function guide(industry) {
    if (industry === "Software") return [
      p(`Dev office (${fmtCash(COST.office)}, ${fmtCash(UPKEEP.office)}/hour): clients offer projects, 4 at a time and new ones every 3 hours, paying $250–$400 per hour of work. Paid in full on time, half if late. Workers on the office get it done sooner.`),
      p(`App (${fmtCash(COST.app)} and ${APP.devHours} hours to build, ${fmtCash(UPKEEP.app)}/hour): sell subscriptions at a daily price. Up to ${APP.potential.toLocaleString()} subscribers, fewer the higher the price (none at ${fmtCash(APP.maxPrice)}). It goes stale by 1% an hour; an update (${fmtCash(COST.update)}, ${APP.updateHours} hours) freshens it and makes it 20% more popular, up to version ${APP.maxVersion}.`),
      p(`Cloud data centre (${fmtCash(COST.dc)}, ${fmtCash(UPKEEP.dc)}/hour): install servers (1 electronics each, ${DC.perServer} customers per server, ${DC.kwh} kWh an hour each). Up to ${DC.potential} customers, fewer the higher the price (none at ${fmtCash(DC.maxPrice)} a day).`)];
    if (industry === "Retail") return [
      p(`Boutique, shoe shop or toy shop (${fmtCash(COST.boutique)} each, ${fmtCash(UPKEEP.boutique)}/hour): a workshop in the back makes up to ${STORE.rate} an hour from the warehouse (clothing from 3 cotton; shoes from rubber, cotton and plastic; toys from 3 plastic), up to ${STORE.cap} on the shelves.`),
      p(`You set the shelf price. About ${STORE.footfall} customers an hour come in; the higher the price, the fewer buy (nobody at ${STORE.top} times the usual price). Sales are counted every hour.`)];
    if (industry === "Finance") return [
      p(`Bank branch (${fmtCash(COST.branch)}, ${fmtCash(UPKEEP.branch)}/hour): set what you pay depositors and charge borrowers, as % a day. Better deposit rates bring in more money; up to 80% of it is lent out. Higher loan rates earn more per loan but fewer people borrow and more loans go bad.`),
      p(`Insurance office (${fmtCash(COST.insurer)}, ${fmtCash(UPKEEP.insurer)}/hour): set a daily premium; up to ${INS.policies.toLocaleString()} policies, fewer the higher it is. Claims come in at random, and now and then a storm brings ten times as many, so keep Cash in the treasury.`),
      p("Finance companies can also sell robbery insurance to players, on the Stocks tab.")];
    return [];
  }
  const TITLES = { Software: "Offices, apps and data centres", Retail: "Stores", Finance: "Branches and insurance offices" };
  const BLURBS = {
    Software: "It takes on client projects, sells app subscriptions and hosts cloud customers.",
    Retail: "It runs stores that make their own stock and sell it at the shelf price you set.",
    Finance: "It takes deposits and makes loans, and sells insurance policies."
  };
  const empty = (ind) => ({ Software: "Nothing built yet. Open a dev office, build an app, or build a data centre.", Retail: "No stores yet. Open a boutique, a shoe shop or a toy shop.", Finance: "Nothing yet. Open a bank branch or an insurance office." })[ind];

  return { INDUSTRIES, RESEARCH, KINDS, handles, upkeepOf, builds, settle, card, buildRow, guide, empty, title: (i) => TITLES[i], blurb: (i) => BLURBS[i],
    offers, COST, UPKEEP, APP, DC, STORES, STORE, BANK, INS, NAMES };
})();
