/* =====================================================================
   Pi Miner — Phase 3: production
   ---------------------------------------------------------------------
   companies/{TICKER}/factory/main
     inventory  { item: count }     the company's warehouse
     lines      [ { id, recipe, queued, startedAt, made } ]
     carsSold, revenue              running totals

   • Each company's industry decides what its lines can make: food companies
     turn crops into bread and burgers, car makers build cars, and so on.
     Mining, Farming, Energy, and Steel and metals run sites instead
     (mines, fields, power plants, furnaces: sites.js). Anything else
     comes from other companies on the Market, or from game suppliers
     (raw materials at list price, made goods at a 60% markup).
   • Wholesalers buy anything in a warehouse at once, for half its value.
   • A production line costs $1,000 (max 10 per company) and makes one
     recipe at a time, working through its queue in real time. Inputs are
     taken from the warehouse when units are queued and handed back if
     the queue is cleared.
   • Consumer products (cars, phones, bread, gasoline, apps…) never sit in
     the warehouse: everyday people (game buyers, not players) buy each one
     the moment it's made, and the money goes into the treasury.
   • No server runs on the free plan, so output is worked out from the
     clock: whenever the controller's page saves anything (or checks in
     every 2 minutes while the factory is open, and on the 15-minute upkeep),
     every unit finished since the last save is counted at once.
   Only the company's controller runs the factory.
   ===================================================================== */
const Factory = (() => {
  const LINE_COST = 100000;      // $1,000
  const MAX_LINES = 10;
  const MAX_QUEUE = 1000;
  const CAR_PRICE = 25000;       // $250, paid by everyday car buyers

  // Every good in the game. `price` = what game suppliers charge for it (things dug, drilled or grown,
  // plus plastic). Made goods without a price are sold by suppliers at a 60% markup on their materials.
  const ITEMS = {
    // dug, drilled or grown
    iron:        { name: "Iron ore",    one: "iron ore",    many: "iron ore",    price: 200 },
    coal:        { name: "Coal",        one: "coal",        many: "coal",        price: 100 },
    sand:        { name: "Sand",        one: "sand",        many: "sand",        price: 50 },
    copper:      { name: "Copper",      one: "copper",      many: "copper",      price: 400 },
    oil:         { name: "Crude oil",   one: "barrel of oil", many: "barrels of oil", price: 250 },
    wheat:       { name: "Wheat",       one: "bushel of wheat", many: "bushels of wheat", price: 80 },
    vegetables:  { name: "Vegetables",  one: "crate of vegetables", many: "crates of vegetables", price: 60 },
    cotton:      { name: "Cotton",      one: "bale of cotton", many: "bales of cotton", price: 150 },
    rubber:      { name: "Rubber",      one: "rubber",      many: "rubber",      price: 300 },
    // made, kept in the warehouse, traded on the Market
    plastic:     { name: "Plastic",     one: "plastic",     many: "plastic",     price: 150 },
    cattle:      { name: "Cattle",      one: "head of cattle", many: "head of cattle" },
    steel:       { name: "Steel",       one: "steel",       many: "steel" },
    glass:       { name: "Glass",       one: "glass",       many: "glass" },
    electronics: { name: "Electronics", one: "electronics", many: "electronics" },
    tire:        { name: "Tires",       one: "tire",        many: "tires" },
    engine:      { name: "Engines",     one: "engine",      many: "engines" },
    flour:       { name: "Flour",       one: "sack of flour", many: "sacks of flour" },
    beef:        { name: "Beef",        one: "pound of beef", many: "pounds of beef" },
    // sold straight to everyday buyers the moment they're made
    car:         { name: "Cars",        one: "car",         many: "cars" },
    gasoline:    { name: "Gasoline",    one: "tank of gasoline", many: "tanks of gasoline" },
    power:       { name: "Electricity", one: "megawatt-hour", many: "megawatt-hours" },
    phone:       { name: "Phones",      one: "phone",       many: "phones" },
    computer:    { name: "Computers",   one: "computer",    many: "computers" },
    bread:       { name: "Bread",       one: "batch of bread", many: "batches of bread" },
    canned:      { name: "Canned vegetables", one: "case of canned vegetables", many: "cases of canned vegetables" },
    burger:      { name: "Burgers",     one: "burger",      many: "burgers" },
    clothing:    { name: "Clothing",    one: "box of clothing", many: "boxes of clothing" },
    shoes:       { name: "Shoes",       one: "pair of shoes", many: "pairs of shoes" },
    toys:        { name: "Toys",        one: "box of toys", many: "boxes of toys" },
    app:         { name: "Apps",        one: "app",         many: "apps" },
    cloud:       { name: "Cloud plans", one: "cloud plan",  many: "cloud plans" },
    account:     { name: "Bank accounts", one: "bank account", many: "bank accounts" },
    insurance:   { name: "Insurance policies", one: "insurance policy", many: "insurance policies" }
  };
  const RAW = Object.keys(ITEMS).filter((k) => ITEMS[k].price);

  // What each industry can make. A company's lines only run its own industry's recipes; everything
  // else it needs comes from other companies on the Market, or from suppliers at their prices.
  const INDUSTRIES = ["Cars", "Electronics", "Steel and metals", "Mining", "Energy", "Farming", "Food", "Retail", "Software", "Finance", "Security"];
  // Mining, Farming, Energy, Steel and metals, Software, Retail and Finance run sites instead of lines
  // (sites.js, services.js); these recipes are for the others
  const MINES = [], FARMS = ["Food"];
  // inputs → `yields` units (default 1) every `secs`; `how` = where it comes from when it needs no inputs;
  // `sellsFor` = everyday buyers take it the moment it's made, for this many cents
  const RECIPES = {
    iron:        { inputs: {}, secs: 20, ind: MINES, how: "mined" },
    coal:        { inputs: {}, secs: 15, ind: MINES, how: "mined" },
    copper:      { inputs: {}, secs: 30, ind: MINES, how: "mined" },
    sand:        { inputs: {}, secs: 10, ind: MINES, how: "dug from a quarry" },
    steel:       { inputs: { iron: 2, coal: 1 },       secs: 60,  ind: ["Cars"] },                 // and Steel and metals furnaces
    glass:       { inputs: { sand: 2, coal: 1 },       secs: 45,  ind: ["Cars", "Electronics"] },  // and Steel and metals kilns
    // Energy runs oil wells, refineries and power plants (sites.js)
    oil:         { inputs: {}, secs: 30, ind: [], how: "drilled" },
    plastic:     { inputs: { oil: 1 }, secs: 30, yields: 2, ind: [] },
    gasoline:    { inputs: { oil: 2 }, secs: 60, ind: [], sellsFor: 900 },
    power:       { inputs: { coal: 3 }, secs: 30, ind: [], sellsFor: 550 },
    wheat:       { inputs: {}, secs: 20, yields: 2, ind: FARMS, how: "grown" },
    vegetables:  { inputs: {}, secs: 15, yields: 2, ind: FARMS, how: "grown" },
    cotton:      { inputs: {}, secs: 25, ind: [], how: "grown" },                    // Farming fields (sites.js)
    rubber:      { inputs: {}, secs: 40, ind: [], how: "tapped from rubber trees" }, // Farming plantations (sites.js)
    cattle:      { inputs: { wheat: 10 }, secs: 300, ind: FARMS },
    flour:       { inputs: { wheat: 3 }, secs: 30, ind: ["Food"] },
    beef:        { inputs: { cattle: 1 }, secs: 120, yields: 10, ind: ["Food"] },
    bread:       { inputs: { flour: 2 }, secs: 60, ind: ["Food"], sellsFor: 900 },
    canned:      { inputs: { vegetables: 4, steel: 1 }, secs: 90, ind: ["Food"], sellsFor: 1400 },
    burger:      { inputs: { beef: 1, flour: 1, vegetables: 1 }, secs: 45, ind: ["Food"], sellsFor: 800 },
    electronics: { inputs: { copper: 2, plastic: 1 },  secs: 120, ind: ["Electronics", "Cars"] },
    phone:       { inputs: { electronics: 2, glass: 1, plastic: 2 }, secs: 240, ind: ["Electronics"], sellsFor: 4500 },
    computer:    { inputs: { electronics: 4, steel: 2, plastic: 4, glass: 1 }, secs: 480, ind: ["Electronics"], sellsFor: 10000 },
    tire:        { inputs: { rubber: 2, steel: 1 },    secs: 90,  ind: ["Cars"] },
    engine:      { inputs: { steel: 4, electronics: 2 }, secs: 300, ind: ["Cars"] },
    car:         { inputs: { engine: 1, tire: 4, steel: 6, glass: 2, electronics: 2 }, secs: 600, ind: ["Cars"], sellsFor: CAR_PRICE },
    clothing:    { inputs: { cotton: 3 }, secs: 90, ind: [], sellsFor: 1000 },
    shoes:       { inputs: { rubber: 1, cotton: 1, plastic: 1 }, secs: 60, ind: [], sellsFor: 1000 },
    toys:        { inputs: { plastic: 3 }, secs: 45, ind: [], sellsFor: 700 },
    app:         { inputs: {}, secs: 300, ind: [], how: "written by your team", sellsFor: 1500 },
    cloud:       { inputs: { electronics: 2 }, secs: 600, ind: [], sellsFor: 5000 },
    account:     { inputs: {}, secs: 300, ind: [], how: "opened for customers", sellsFor: 1200 },
    insurance:   { inputs: {}, secs: 600, ind: [], how: "written for customers", sellsFor: 2500 }
  };
  const recipesFor = (industry) => Object.keys(RECIPES).filter((k) => RECIPES[k].ind.includes(industry));
  const canMake = (industry, k) => RECIPES[k].ind.includes(industry);
  const extracts = (k) => !Object.keys(RECIPES[k].inputs).length && !RECIPES[k].sellsFor;   // dug, drilled or grown
  // Goods that sit in a warehouse and trade on the Market (everything not sold straight to everyday buyers)
  const GOODS = Object.keys(ITEMS).filter((k) => !(RECIPES[k] && RECIPES[k].sellsFor));
  const SUPPLIER_MARKUP = 1.6, WHOLESALE = 0.5;

  // Everyday buyers only want so much. Each product has a game-wide appetite (what about 20 plain
  // lines make in an hour), shared by every company that sells it. Recent sales across the game
  // (fading over about an hour) push the price down, to 30% of full price at the most.
  const DEMAND_LINES = 20, PRICE_FLOOR = 0.3, DEMAND_TAU = 3600000;
  const PRODUCTS = Object.keys(RECIPES).filter((k) => RECIPES[k].sellsFor);
  const demandOf = (k) => Math.round((DEMAND_LINES * 3600) / RECIPES[k].secs);       // units an hour
  const loadAt = (d, t) => (d && d.load ? d.load * Math.exp(-Math.max(0, t - (d.at || 0)) / DEMAND_TAU) : 0);
  const priceMult = (load, k) => Math.max(PRICE_FLOOR, 1 - ((1 - PRICE_FLOOR) * load) / demandOf(k));
  // The price multiplier summed over n units sold one after another, starting from `load`
  function sellMult(load, n, k) {
    const D = demandOf(k);
    const F = (x) => (x <= D ? x - ((1 - PRICE_FLOOR) * x * x) / (2 * D) : (D * (1 + PRICE_FLOOR)) / 2 + PRICE_FLOOR * (x - D));
    return F(load + n) - F(load);
  }

  // Line upkeep, billed every hour from the treasury: $20 for an hour sitting idle, $100 for an
  // hour running the whole time, and in between by how long it ran.
  const UPKEEP_IDLE = 2000, UPKEEP_BUSY = 10000;

  // Research: real-time projects paid from the treasury, one at a time per company
  const RESEARCH = {
    robots1: { name: "Robot arms",              cost: 200000,  hours: 0.5, needs: null,      lines: true, does: "Lets you fit robot arms to production lines: 1.5× faster" },
    robots2: { name: "Assembly robots",         cost: 800000,  hours: 2,   needs: "robots1", lines: true, does: "Lets you fit assembly robots: 2.5× faster" },
    robots3: { name: "Fully automated lines",    cost: 2000000, hours: 6,   needs: "robots2", lines: true, does: "Lets you fully automate a line: 4× faster" },
    alloy1:  { name: "Cheaper alloys",          cost: 300000,  hours: 1,   needs: null,      lines: true, does: "Steel needs 1 iron ore instead of 2" },
    alloy2:  { name: "Lightweight alloys",      cost: 1000000, hours: 3,   needs: "alloy1",  lines: true, does: "Cars need 4 steel instead of 6" },
    harvest: { name: "Heavy machinery and better seeds", cost: 400000, hours: 1, needs: null, lines: true, does: "Everything your lines mine, drill or grow comes out 2 at a time" },
    labs:    { name: "Better research methods", cost: 500000,  hours: 1,   needs: null,      does: "All research after this finishes twice as fast" }
  };
  // Mining and Farming have their own research (sites.js)
  if (typeof Sites !== "undefined") Object.assign(RESEARCH, Sites.RESEARCH);
  const siteInd = (ind) => typeof Sites !== "undefined" && Sites.isSiteIndustry(ind);
  // Which research a company of this industry can do
  const researchFor = (ind) => Object.keys(RESEARCH).filter((k) => {
    const r = RESEARCH[k];
    return r.ind ? r.ind.includes(ind) : r.lines ? !siteInd(ind) : true;
  });
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
    Math.round(Object.entries(RECIPES[k].inputs).reduce((a, [i, n]) => a + n * valueOf(i), 0) / (RECIPES[k].yields || 1)));
  Object.keys(ITEMS).forEach(valueOf);
  // What game suppliers charge per unit, and what wholesalers pay for anything in a warehouse
  const supplierPrice = (k) => ITEMS[k].price || Math.round(BASE_VALUE[k] * SUPPLIER_MARKUP);
  const wholesalePrice = (k) => Math.max(1, Math.floor(BASE_VALUE[k] * WHOLESALE));
  // Units a line turns out per run, after research (MissingNo.'s multiplier is separate)
  const yieldOf = (k, research = {}) => (RECIPES[k].yields || 1) * (research.harvest && extracts(k) ? 2 : 1);

  // Recipe inputs after research
  function inputsFor(recipe, research = {}) {
    const inp = { ...RECIPES[recipe].inputs };
    if (recipe === "steel" && research.alloy1) inp.iron = 1;
    if (recipe === "car" && research.alloy2) inp.steel = 4;
    return inp;
  }
  // Employees: hired from an hourly pool, paid hourly from the treasury
  const HOUR = 3600000;
  const MAX_STAFF = 40;
  const MAX_WORKERS_PER_LINE = 3;
  const ROLES = {
    worker:     { name: "Worker",      base: 800,  does: (s) => `+${10 * s}% speed on their line` },
    researcher: { name: "Researcher",  base: 2000, does: (s) => `+${10 * s}% research speed` },
    sales:      { name: "Salesperson", base: 1200, does: (s) => `+${2 * s}% on everything sold to everyday buyers` },
    manager:    { name: "Manager",     base: 3000, does: (s) => `boosts every other employee by ${5 * s}%` },
    glitch:     { name: "Glitch",      base: 0,    does: (s) => `works every job at once: line speed, research, sales and managing (skill ${s}), and his line makes 5× as much. Can't quit; goes on strike if unpaid` }
  };
  // Hard-coded staff: always on the payroll of these companies, for free, and can't be let go or trained
  const FIXED_STAFF = {
    // Eighteen MissingNo.s: the original plus #2–#18
    TSLA: ["", ...Array.from({ length: 17 }, (_, i) => i + 2)].map((n) => ({
      id: n ? `missingno${n}` : "missingno", name: n ? `MissingNo. #${n}` : "MissingNo.",
      role: "glitch", skill: 5, wage: 10000, line: null, fixed: true, outputMult: 5
    }))
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
  // Staff on strike (unpaid permanent staff) are on the books but do nothing
  const active = (f) => staffOf(f).filter((s) => !s.striking);
  const is = (s, role) => s.role === role || s.role === "glitch";   // a glitch counts as every role
  const managerBoost = (f) => 1 + active(f).filter((s) => is(s, "manager")).reduce((a, s) => a + 0.05 * s.skill, 0);
  const workersOn = (f, line, all = false) => (all ? staffOf(f) : active(f)).filter((s) => is(s, "worker") && s.line === line.id);
  // Units that come off a line for each unit queued (MissingNo.'s line makes 5)
  const outMult = (line, f) => active(f).filter((s) => s.line === line.id && s.outputMult).reduce((a, s) => a * s.outputMult, 1);
  // Make sure a company's hard-coded staff are on its books
  function addFixedStaff(f, ticker) {
    for (const p of FIXED_STAFF[ticker] || []) {
      const have = f.staff.find((s) => s.id === p.id);
      if (!have) f.staff.splice(f.staff.filter((x) => x.fixed).length, 0, { ...p, hiredAt: Date.now() });
      else Object.assign(have, { ...p, line: have.line, hiredAt: have.hiredAt });
    }
    return f;
  }
  // Speed-up from the workers on a site (sites have no robots)
  const crewMult = (site, f) => 1 + workersOn(f, site).reduce((a, s) => a + 0.1 * s.skill, 0) * managerBoost(f);
  const lineMult = (line, f) =>
    ROBOTS[line.robots || 0].mult * (1 + workersOn(f, line).reduce((a, s) => a + 0.1 * s.skill, 0) * managerBoost(f));
  const unitMs = (line, f) => (RECIPES[line.recipe].secs * 1000) / lineMult(line, f);
  const researchSpeed = (f) => 1 + active(f).filter((s) => is(s, "researcher")).reduce((a, s) => a + 0.1 * s.skill, 0) * managerBoost(f);
  // Salespeople raise what everyday buyers pay (up to +50%)
  const salesBonus = (f) => Math.min(0.5, active(f).filter((s) => is(s, "sales")).reduce((a, s) => a + 0.02 * s.skill, 0) * managerBoost(f));
  const salePrice = (f, k) => Math.round(RECIPES[k].sellsFor * (1 + salesBonus(f)));
  const wagesOf = (list) => list.reduce((a, s) => a + s.wage, 0);
  const payrollPerHour = (f) => wagesOf(staffOf(f));
  // What everyday buyers pay for one more unit right now, given recent sales across the game
  const priceNow = (f, k, dem, now = Date.now()) => Math.round(salePrice(f, k) * priceMult(loadAt(dem && dem[k], now), k));
  const lineCostNow = (l) => (l.queued && l.startedAt ? UPKEEP_BUSY : UPKEEP_IDLE);
  const builtAt = (l) => parseInt(l.id, 36) || 0;

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

  // Pay every whole hour since the last payday. If the treasury runs short, regular staff quit,
  // best-paid first; permanent staff can't quit, so the ones it can't pay go on strike until a payday works.
  function payroll(f, now, treasury, credits = new Map()) {
    const hourNow = Math.floor(now / HOUR) * HOUR;
    if (!staffOf(f).length) { f.wagesPaidTo = hourNow; return treasury; }
    const from = f.wagesPaidTo || hourNow;
    const hours = Math.min(168, Math.floor((now - from) / HOUR));
    const note = (msg) => { f.news = [msg, ...(f.news || [])].slice(0, 8); };
    for (let h = 0; h < hours && f.staff.length; h++) {
      if (treasury >= payrollPerHour(f)) {
        if (f.staff.some((s) => s.striking)) {
          rebase(f, now, () => f.staff.forEach((s) => { delete s.striking; }));
          note("Payday worked: everyone on strike is back at work");
        }
        treasury -= payrollPerHour(f);
        paidHour(f, credits);
        continue;
      }
      rebase(f, now, () => {
        const regular = () => f.staff.filter((s) => !s.fixed);
        while (regular().length && treasury < wagesOf(regular())) {
          const top = regular().reduce((a, s) => (s.wage > a.wage ? s : a));
          f.staff = f.staff.filter((s) => s !== top);
          note(`${top.name} (${ROLES[top.role].name.toLowerCase()}) quit: the treasury couldn't pay their wage`);
        }
        let left = treasury - wagesOf(regular()), struck = 0;
        for (const s of f.staff.filter((x) => x.fixed)) {
          const strike = left < s.wage;
          if (!strike) left -= s.wage;
          if (strike && !s.striking) struck++;
          if (strike) s.striking = true; else delete s.striking;
        }
        if (struck) note(`${struck} permanent employee${struck === 1 ? "" : "s"} went on strike: the treasury couldn't pay them`);
      });
      treasury -= wagesOf(f.staff.filter((s) => !s.striking));
      paidHour(f, credits);
    }
    f.wagesPaidTo = hours ? from + hours * HOUR : from;
    if (now - f.wagesPaidTo >= 168 * HOUR) f.wagesPaidTo = hourNow;   // more than a week behind: forgive the rest
    return treasury;
  }

  // One hour's wages went out: players on the staff get theirs in their wallet, and grow in skill
  function paidHour(f, credits) {
    for (const s of f.staff) {
      if (!s.player || s.striking) continue;
      const c = credits.get(s.player) || { amount: 0, hours: 0, jobId: s.jobId };
      c.amount += s.wage; c.hours += 1;
      credits.set(s.player, c);
      s.hoursWorked = (s.hoursWorked || 0) + 1;
      s.skill = Math.min(5, 1 + Math.floor(s.hoursWorked / 24));
    }
  }

  // Players taking, working and leaving jobs posted by this company (jobs/{id}, see work.js)
  function settleJobs(f, now, jobs) {
    const note = (msg) => { f.news = [msg, ...(f.news || [])].slice(0, 8); };
    for (const k of jobs) {
      const j = k.data, sid = `p-${j.player}`;
      const onStaff = f.staff.find((s) => s.id === sid);
      if (j.status === "taken") {
        if (f.staff.length >= MAX_STAFF) { j.status = "ended"; note(`${j.playerName} couldn't start: the company already has ${MAX_STAFF} employees`); }
        else {
          rebase(f, now, () => f.staff.push({ id: sid, name: j.playerName, role: j.role, skill: 1, wage: j.wage, line: null,
            hiredAt: now, player: j.player, jobId: k.id, hoursWorked: j.hours || 0 }));
          j.status = "active";
          note(`${j.playerName} (a player) started as a ${ROLES[j.role].name.toLowerCase()} at ${fmtCash(j.wage)}/hour`);
        }
        k.dirty = true;
      } else if (j.status === "active") {
        if (!onStaff) { j.status = "ended"; k.dirty = true; }                  // let go, or quit for lack of pay
        else if (j.quit) {
          rebase(f, now, () => { f.staff = f.staff.filter((s) => s.id !== sid); });
          j.status = "ended"; k.dirty = true;
          note(`${j.playerName} (a player) quit`);
        } else if ((onStaff.hoursWorked || 0) !== (j.hours || 0)) { j.hours = onStaff.hoursWorked || 0; k.dirty = true; }
      }
    }
  }

  // Running time, split into finished hours (billed at the next upkeep) and the hour under way
  function addBusy(line, a, b, hourNow) {
    if ((line.busyHour || 0) < hourNow) {
      line.busyDone = (line.busyDone || 0) + (line.busyNow || 0);
      line.busyNow = 0;
      line.busyHour = hourNow;
    }
    if (!(b > a)) return;
    line.busyDone = (line.busyDone || 0) + Math.max(0, Math.min(b, hourNow) - a);
    line.busyNow = (line.busyNow || 0) + Math.max(0, b - Math.max(a, hourNow));
  }

  // Bill line upkeep for every whole hour since the last bill. If the treasury can't cover it,
  // it pays what it has and every running line stops where it is until there's money again.
  function lineUpkeep(f, now, treasury) {
    const hourNow = Math.floor(now / HOUR) * HOUR;
    if (!f.upkeepPaidTo) { f.upkeepPaidTo = hourNow; return treasury; }
    const hours = Math.floor((hourNow - f.upkeepPaidTo) / HOUR);
    if (hours <= 0) return treasury;
    let cost = 0;
    for (const l of f.lines) {
      const since = Math.max(f.upkeepPaidTo, Math.ceil(builtAt(l) / HOUR) * HOUR);   // whole hours it existed
      const idleHours = Math.max(0, Math.min(hours, (hourNow - since) / HOUR));
      const busy = Math.min(l.busyDone || 0, hours * HOUR);
      cost += Math.round(UPKEEP_IDLE * idleHours + ((UPKEEP_BUSY - UPKEEP_IDLE) * busy) / HOUR);
      l.busyDone = 0;
    }
    // Mines, fields, plantations and pens: a flat rate for each whole hour they existed
    for (const x of f.sites || []) {
      if (!x.builtAt || typeof Sites === "undefined") continue;
      const since = Math.max(f.upkeepPaidTo, Math.ceil(x.builtAt / HOUR) * HOUR);
      cost += Sites.upkeepOf(x) * Math.max(0, Math.min(hours, (hourNow - since) / HOUR));
    }
    f.upkeepPaidTo = hourNow;
    if (cost <= treasury) return treasury - cost;
    const sitesStopped = typeof Sites !== "undefined" ? Sites.pauseAll(f) : 0;
    let stopped = 0;
    for (const l of f.lines) {
      if (!l.queued || !l.startedAt) continue;
      l.paused = Math.min(0.999, Math.max(0, (now - l.startedAt) / unitMs(l, f)));
      l.startedAt = null;
      stopped++;
    }
    const what = [stopped && `${stopped} line${stopped === 1 ? "" : "s"}`, sitesStopped && `${sitesStopped} site${sitesStopped === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
    f.news = [`The treasury couldn't pay ${fmtCash(cost)} of upkeep${what ? `, so ${what} stopped until there's money again` : ""}`, ...(f.news || [])].slice(0, 8);
    return 0;
  }

  // Companies whose industry runs sites (mines, fields, plants, furnaces) don't keep production lines.
  // Any left over are taken down: what was paid to build them and fit robots goes back to the treasury,
  // materials still queued go back to the warehouse, and workers on them are free for a site.
  function retireLines(f, c, treasury) {
    if (!siteInd(c.industry) || !f.lines.length) return treasury;
    let refund = 0;
    for (const l of f.lines) {
      refund += LINE_COST;
      for (let t = 1; t <= (l.robots || 0); t++) refund += ROBOTS[t].cost;
      if (l.queued) for (const [k, q] of Object.entries(l.inputs || inputsFor(l.recipe, f.research))) f.inventory[k] = (f.inventory[k] || 0) + q * l.queued;
      for (const p of f.staff) if (p.line === l.id) p.line = null;
    }
    const n = f.lines.length;
    f.lines = [];
    f.news = [`${c.industry} companies run sites instead of production lines, so ${n === 1 ? "the old line was" : `the ${n} old lines were`} taken down: ${fmtCash(refund)} back to the treasury, and anything queued back to the warehouse.`, ...(f.news || [])].slice(0, 8);
    return treasury + refund;
  }

  // Lines stopped for unpaid upkeep pick up where they left off once the treasury has money
  function resume(f, now, treasury) {
    if (treasury <= 0) return;
    if (typeof Sites !== "undefined") Sites.resumeAll(f);
    for (const l of f.lines) {
      if (l.paused == null) continue;
      if (l.queued) l.startedAt = now - l.paused * unitMs(l, f);
      delete l.paused;
    }
  }

  let fb = null, db = null, user = null, unsubs = [], factoryUnsub = null;
  const st = { companies: [], ticker: null, factory: null, busy: false, lastSettle: 0, demand: {}, demandKey: "", openings: [], openingsLoaded: false };
  let openingsUnsub = null;
  // Other modules (the rig card) that redraw when any company changes
  const companyWatchers = [];
  const onCompanies = (fn) => companyWatchers.push(fn);
  let demandUnsubs = [];

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
  const blank = () => ({ inventory: {}, lines: [], sites: [], carsSold: 0, revenue: 0, research: {}, project: null, staff: [], wagesPaidTo: null, news: [], upkeepPaidTo: null, settledAt: null });
  // Every writer of the factory doc goes through this, so no field is ever dropped
  const clone = (f) => JSON.parse(JSON.stringify({
    inventory: f.inventory || {}, lines: f.lines || [], sites: f.sites || [], carsSold: f.carsSold || 0, revenue: f.revenue || 0,
    research: f.research || {}, project: f.project || null,
    staff: f.staff || [], wagesPaidTo: f.wagesPaidTo || null, news: f.news || [],
    upkeepPaidTo: f.upkeepPaidTo || null, settledAt: f.settledAt || null
  }));
  const company = () => st.companies.find((c) => c.ticker === st.ticker);
  const myCompanies = () => st.companies.filter((c) => user && c.controller === user.uid);
  const iControl = () => { const c = company(); return !!(c && user && c.controller === user.uid); };
  const fmtDur = (s) => {
    s = Math.max(0, Math.ceil(s));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  };
  const aAn = (w) => (/^[aeiou]/i.test(w) ? "an" : "a");
  const qtyName = (k, n) => `${n.toLocaleString()} ${n === 1 ? ITEMS[k].one : ITEMS[k].many}`;
  const inputsText = (r, research) => Object.entries(inputsFor(r, research)).map(([k, n]) => qtyName(k, n)).join(" + ") || `nothing (${RECIPES[r].how})`;
  // "→ 2 bushels of wheat · sold instantly for $9.00"
  const outText = (k, n) => n === 1 ? `1 ${ITEMS[k].one}` : qtyName(k, n);

  // Count every unit finished by `now`. Things everyday buyers want are sold the moment each one is
  // made, at the price recent sales across the game allow; `dem` holds that shared demand and is
  // updated in place. Also notes how long each line ran, for upkeep. Returns the Cash the sales brought in.
  // grid.kwh: electricity this company has already sold to miners and still has to deliver (Energy, rig.js)
  // money: { treasury, buyPower } for the sites (sites.js), which can spend on seed, fuel and power;
  // the treasury they leave is put back in money.treasury
  function settle(f, now, dem = {}, made = {}, grid = { kwh: 0 }, money = null) {
    let income = 0;
    if (f.project && now >= f.project.endsAt) {          // finished research
      f.research[f.project.key] = true;
      f.project = null;
    }
    const from = f.settledAt || now, hourNow = Math.floor(now / HOUR) * HOUR;
    const sales = [];
    for (const line of f.lines) {
      if (!line.queued || !line.startedAt) { addBusy(line, 0, 0, hourNow); continue; }
      const per = unitMs(line, f);
      addBusy(line, Math.max(from, line.startedAt), Math.min(now, line.startedAt + line.queued * per), hourNow);
      const n = Math.min(line.queued, Math.floor((now - line.startedAt) / per));
      if (n <= 0) continue;
      const each = yieldOf(line.recipe, f.research) * outMult(line, f);   // units that come off the line per run
      if (RECIPES[line.recipe].sellsFor) {
        for (let i = 1; i <= n; i++) sales.push({ t: Math.round(line.startedAt + i * per), k: line.recipe, n: each });
        f.carsSold += n * each;
      } else {
        f.inventory[line.recipe] = (f.inventory[line.recipe] || 0) + n * each;
        made[line.recipe] = (made[line.recipe] || 0) + n * each;
      }
      line.queued -= n;
      line.made = (line.made || 0) + n * each;
      line.startedAt = line.queued ? line.startedAt + n * per : null;
    }
    if (typeof Sites !== "undefined" && (f.sites || []).length) {
      const m = money || { treasury: 0 };
      m.treasury = Sites.settle(f, now, made, m.treasury, {
        research: f.research, crew: (x) => crewMult(x, f), out: (x) => outMult(x, f),
        sell: (t, k, n) => { if (n > 0) { sales.push({ t, k, n }); f.carsSold += n; } },
        buyPower: m.buyPower || gridPower });
    }
    // Sell in the order things were made, so recent sales by anyone keep pushing the price down
    sales.sort((x, y) => x.t - y.t);
    for (const e of sales) {
      // Power goes to miners who've already paid for it before any is sold to everyday buyers
      if (e.k === "power" && grid.kwh > 0) {
        const cover = Math.min(e.n, Math.ceil(grid.kwh / 1000));
        grid.kwh = Math.max(0, grid.kwh - cover * 1000);
        e.n -= cover;
        if (!e.n) continue;
      }
      const d = dem[e.k] || (dem[e.k] = { load: 0, at: 0 });
      d.load = loadAt(d, e.t);
      d.at = Math.max(d.at || 0, e.t);
      const cash = Math.round(salePrice(f, e.k) * sellMult(d.load, e.n, e.k));
      d.load += e.n;
      d.touched = true;
      f.revenue += cash;
      income += cash;
    }
    f.settledAt = now;
    return income;
  }

  // Electricity bought by a site (an arc furnace): the grid's price, and that money leaves the game
  // budget: what the treasury can spend; null back means it can't afford it (nothing is recorded)
  const gridPower = (from, kwh, budget = Infinity) => { const cost = Math.ceil((kwh * GRID_TARIFF) / 1000); return cost > budget ? null : { cost, from: null }; };
  const GRID_TARIFF = 800;   // cents per MWh, as rig.js
  // Power bought from Energy companies during one save: { ticker: { c, kwh, cost } }, read in the transaction
  function powerBuyer(suppliers) {
    return (from, kwh, budget = Infinity) => {
      const s = from && suppliers[from];
      const max = typeof Rig !== "undefined" ? Rig.MAX_OWED_KWH : 100000;
      if (!s || !(s.c.tariff > 0) || s.c.industry !== "Energy" || (s.c.powerOwed || 0) + s.kwh >= max) return gridPower(null, kwh, budget);
      const cost = Math.ceil((kwh * s.c.tariff) / 1000);
      if (cost > budget) return null;
      s.kwh += kwh; s.cost += cost;
      return { cost, from };
    };
  }

  const demandRef = (k) => db.collection("demand").doc(k);
  const contractsCol = () => db.collection("contracts");

  /* ---------- supply contracts ----------
     contracts/{id}: `from` supplies `qty` units of `item` to `to`; `to` pays `per` (cents, or units of the
     `pay` good) for every `every` units delivered. The payment is set aside (`escrow`) when the receiving
     company signs. Deliveries wait in the contract (`waiting`) until the receiver's factory collects them,
     and payments wait (`owed`) until the supplier's collects them, because each factory is private. */
  const MAX_CONTRACTS_PER_ACT = 6;    // with MAX_JOBS_PER_ACT, keeps every save under Firestore's 20 rule lookups
  const MAX_JOBS_PER_ACT = 4;
  const MAX_OPENINGS = 4;              // job openings a company can have posted at once
  const jobsCol = () => db.collection("jobs");
  const OPEN = ["offered", "active"];
  const payDue = (d) => Math.floor(d.delivered / d.every) * d.per;
  // Units the supplier can hand over now: what's left of a fixed contract, or, for an ongoing one,
  // only whole batches the deposit can already pay for (so the supplier never delivers unpaid)
  const room = (d) => (d.ongoing
    ? Math.max(0, (Math.floor(d.delivered / d.every) + Math.floor(d.escrow / d.per)) * d.every - d.delivered)
    : d.qty - d.delivered);
  // Ongoing contracts: the receiver keeps enough set aside for `qty` units, refilled on every save
  const depositTarget = (d) => (d.qty / d.every) * d.per;
  const needsMe = (d, t) => OPEN.includes(d.status)
    || (d.from === t && d.owed > 0) || (d.to === t && (d.waiting > 0 || d.escrow > 0));
  // Contracts this company should look at on its next save (read outside the transaction: queries can't run inside one)
  async function contractIds(t) {
    // The contracts panel already follows the open company's contracts live; otherwise ask
    let docs = typeof Contracts !== "undefined" ? Contracts.cached(t) : null;
    if (!docs) {
      const [a, b] = await Promise.all([contractsCol().where("from", "==", t).get(), contractsCol().where("to", "==", t).get()]);
      docs = [...a.docs, ...b.docs].map((d) => ({ id: d.id, data: d.data() }));
    }
    return docs.filter((d) => needsMe(d.data, t))
      .sort((x, y) => (x.data.status === "active" ? 0 : 1) - (y.data.status === "active" ? 0 : 1))
      .slice(0, MAX_CONTRACTS_PER_ACT).map((d) => d.id);
  }
  // Move goods along the company's contracts. `made` = what its lines just turned out.
  function settleContracts(f, t, treasury, list, made) {
    for (const k of list) {
      const d = k.data;
      if (d.from === t) {
        // Freshly made goods go to the buyer first, up to what's left on the contract
        const left = room(d);
        const u = d.status === "active" ? Math.min(made[d.item] || 0, left, f.inventory[d.item] || 0) : 0;
        if (u > 0) {
          f.inventory[d.item] -= u;
          made[d.item] -= u;
          deliver(d, u);
          k.dirty = true;
        }
        if (d.owed > 0) {
          if (d.pay === "cash") treasury += d.owed; else f.inventory[d.pay] = (f.inventory[d.pay] || 0) + d.owed;
          d.owed = 0;
          k.dirty = true;
        }
      }
      if (d.to === t) {
        if (d.waiting > 0) { f.inventory[d.item] = (f.inventory[d.item] || 0) + d.waiting; d.waiting = 0; k.dirty = true; }
        // Ongoing: top the deposit back up from whatever the treasury or warehouse has
        if (d.ongoing && d.status === "active" && d.escrow < depositTarget(d)) {
          const have = d.pay === "cash" ? treasury : f.inventory[d.pay] || 0;
          const add = Math.min(depositTarget(d) - d.escrow, Math.max(0, have));
          if (add > 0) {
            if (d.pay === "cash") treasury -= add; else f.inventory[d.pay] -= add;
            d.escrow += add;
            k.dirty = true;
          }
        }
        // Over or called off: whatever payment was set aside and not earned comes back
        if (!OPEN.includes(d.status) && d.escrow > 0) {
          if (d.pay === "cash") treasury += d.escrow; else f.inventory[d.pay] = (f.inventory[d.pay] || 0) + d.escrow;
          d.escrow = 0;
          k.dirty = true;
        }
      }
    }
    return treasury;
  }
  // Hand over u units: they wait for the buyer, and the payment they've earned moves out of escrow
  function deliver(d, u) {
    const before = payDue(d);
    d.delivered += u;
    d.waiting += u;
    const pay = Math.min(d.escrow, payDue(d) - before);
    d.escrow -= pay;
    d.owed += pay;
    if (!d.ongoing && d.delivered >= d.qty) d.status = "done";
  }
  const sig = (f) => JSON.stringify({ ...f, settledAt: null,
    lines: f.lines.map(({ busyDone, busyNow, busyHour, ...l }) => l) });

  // Every factory change: re-read, catch up on finished units and bills, apply the change, save.
  async function act(change, t = st.ticker, opts = {}) {
    const uid = user.uid;
    const ids = [...new Set([...(await contractIds(t).catch(() => [])), ...(opts.contracts || [])])];
    // Job postings that need attention (the Employees panel already follows the open company's live)
    const posted = t === st.ticker && st.openingsLoaded ? st.openings
      : await jobsCol().where("company", "==", t).limit(100).get().then((q) => q.docs.map((d) => ({ id: d.id, ...d.data() })));
    const jobIds = posted.filter((j) => j.status === "taken" || j.status === "active").slice(0, MAX_JOBS_PER_ACT).map((j) => j.id);
    return db.runTransaction(async (tx) => {
      const c = (await tx.get(companyRef(t))).data();
      if (!c || c.controller !== uid) throw new Error("Only the company's controller can run its factory.");
      const snap = await tx.get(factoryRef(t));
      const f = addFixedStaff(snap.exists ? clone(snap.data()) : blank(), t);
      const before = JSON.stringify(snap.exists ? clone(snap.data()) : blank());
      // Running time is worked out again from the last save, so it alone isn't worth a write
      // The shared demand for whatever these lines might sell
      const selling = [...new Set([...f.lines.filter((l) => l.queued && RECIPES[l.recipe].sellsFor).map((l) => l.recipe),
        ...(typeof Sites !== "undefined" ? Sites.sells(f) : [])])];
      const dem = {};
      for (const k of selling) { const d = await tx.get(demandRef(k)); dem[k] = d.exists ? { ...d.data() } : { load: 0, at: 0 }; }
      const contracts = [];
      for (const id of ids) {
        const d = await tx.get(contractsCol().doc(id));
        if (d.exists) contracts.push({ id, ref: d.ref, data: { ...d.data() }, dirty: false });
      }
      const jobs = [];
      for (const id of jobIds) {
        const d = await tx.get(jobsCol().doc(id));
        if (d.exists) jobs.push({ id, ref: d.ref, data: { ...d.data() }, dirty: false });
      }
      // Energy companies this company's arc furnaces buy power from
      const suppliers = {};
      for (const k of typeof Sites !== "undefined" ? Sites.powerSuppliers(f) : []) {
        if (k === t) continue;
        const d = await tx.get(companyRef(k));
        if (d.exists) suppliers[k] = { c: d.data(), kwh: 0, cost: 0 };
      }
      // Paid actions cost a Pi fee from the player's wallet
      const meSnap = opts.fee ? await tx.get(db.collection("users").doc(uid)) : null;
      const now = Date.now(), made = {};
      const grid = { kwh: c.powerOwed || 0 };
      const money = { treasury: c.treasury, buyPower: powerBuyer(suppliers) };
      const income = settle(f, now, dem, made, grid, money);
      let treasury = money.treasury + income;
      treasury = settleContracts(f, t, treasury, contracts, made);
      treasury = lineUpkeep(f, now, treasury);
      settleJobs(f, now, jobs);
      const credits = new Map();
      treasury = payroll(f, now, treasury, credits);
      settleJobs(f, now, jobs);                 // anyone who just quit for lack of pay
      treasury = retireLines(f, c, treasury);
      resume(f, now, treasury);
      const ctx = { contracts, created: [], sets: [], buyPower: money.buyPower };
      const res = change ? change(f, treasury, now, c, ctx) || {} : {};
      if (res.treasury != null) treasury = res.treasury;
      treasury = settleContracts(f, t, treasury, contracts, made);   // collect anything the change freed up (a refund, a delivery)
      settleJobs(f, now, jobs);                 // someone the change let go
      resume(f, now, treasury);
      const bought = Object.entries(suppliers).filter(([, s]) => s.kwh > 0);
      if (!change && sig(f) === sig(JSON.parse(before)) && treasury === c.treasury && grid.kwh === (c.powerOwed || 0) && !bought.length && !contracts.some((k) => k.dirty) && !jobs.some((k) => k.dirty)) return "";   // nothing to save
      if (treasury < 0) throw new Error(`The treasury only has ${fmtCash(c.treasury)}.`);
      if (meSnap) tx.update(meSnap.ref, { coins: Economy.payFee(tx, meSnap.data() || {}, opts.fee === true ? "That" : opts.fee) });
      tx.set(factoryRef(t), { ...f, updatedAt: fb.firestore.FieldValue.serverTimestamp() });
      if (grid.kwh !== (c.powerOwed || 0)) tx.update(companyRef(t), { treasury, powerOwed: grid.kwh });
      else if (treasury !== c.treasury) tx.update(companyRef(t), { treasury });
      // Power bought from other Energy companies: paid into their treasuries, and their plants owe it
      for (const [k, s] of bought) tx.update(companyRef(k), { treasury: s.c.treasury + s.cost, powerOwed: (s.c.powerOwed || 0) + s.kwh });
      for (const [k, d] of Object.entries(dem)) if (d.touched) tx.set(demandRef(k), { load: d.load, at: Math.round(d.at) });
      for (const k of contracts) if (k.dirty) tx.set(k.ref, { ...k.data, updatedAt: now });
      for (const d of ctx.created) tx.set(contractsCol().doc(), { ...d, createdAt: fb.firestore.FieldValue.serverTimestamp(), updatedAt: now });
      for (const k of jobs) if (k.dirty) tx.set(k.ref, { ...k.data, updatedAt: now });
      for (const w of ctx.sets) tx.set(w.ref, w.data);
      // Wages for player employees go straight into their wallets
      for (const [player, cr] of credits) {
        if (!cr.amount) continue;
        tx.update(db.collection("users").doc(player), { cash: fb.firestore.FieldValue.increment(cr.amount) });
        tx.set(db.collection("users").doc(player).collection("history").doc(),
          { kind: "wage", asset: t, amount: cr.amount, hours: cr.hours, at: fb.firestore.FieldValue.serverTimestamp() });
      }
      return res.msg || "";
    });
  }

  const buyRaw = (item, qty) => act((f, treasury) => {
    if (!GOODS.includes(item)) throw new Error("Suppliers don't sell that.");
    const cost = supplierPrice(item) * qty;
    if (cost > treasury) throw new Error(`${qtyName(item, qty)} costs ${fmtCash(cost)}; the treasury has ${fmtCash(treasury)}.`);
    f.inventory[item] = (f.inventory[item] || 0) + qty;
    return { treasury: treasury - cost, msg: `✓ Bought ${qtyName(item, qty)} for ${fmtCash(cost)}.` };
  }, undefined, { fee: "Buying from suppliers" });

  // Sell straight from the warehouse to game wholesalers, for half the materials value
  const sellWholesale = (item, qty) => act((f, treasury) => {
    if (!GOODS.includes(item)) throw new Error("Wholesalers don't buy that.");
    if ((f.inventory[item] || 0) < qty) throw new Error(`The warehouse only has ${qtyName(item, f.inventory[item] || 0)}.`);
    const cash = wholesalePrice(item) * qty;
    f.inventory[item] -= qty;
    f.revenue += cash;
    return { treasury: treasury + cash, msg: `✓ Sold ${qtyName(item, qty)} to wholesalers for ${fmtCash(cash)}.` };
  }, undefined, { fee: "Selling to wholesalers" });

  const buildLine = () => act((f, treasury, now, c) => {
    if (siteInd(c.industry)) throw new Error(`${c.industry} companies run sites, not production lines.`);
    if (f.lines.length >= MAX_LINES) throw new Error(`A company can have at most ${MAX_LINES} production lines.`);
    if (treasury < LINE_COST) throw new Error(`A line costs ${fmtCash(LINE_COST)}; the treasury has ${fmtCash(treasury)}.`);
    f.lines.push({ id: Date.now().toString(36), recipe: recipesFor(c.industry)[0] || "steel", queued: 0, startedAt: null, made: 0 });
    return { treasury: treasury - LINE_COST, msg: `✓ Built line ${f.lines.length}.` };
  }, undefined, { fee: "Building a line" });

  const cantMake = (c, k) => new Error(`${c.industry} companies can't make ${ITEMS[k].many}. Buy them on the Market from a company that can, or switch this company's industry on the Stocks tab.`);
  const setRecipe = (i, recipe) => act((f, treasury, now, c) => {
    const line = f.lines[i];
    if (line.queued) throw new Error("Clear this line's queue before switching what it makes.");
    if (!canMake(c.industry, recipe)) throw cantMake(c, recipe);
    line.recipe = recipe;
    return { msg: `✓ Line ${i + 1} now makes ${ITEMS[recipe].many}.` };
  });

  const queue = (i, n) => act((f, treasury, now, c) => {
    const line = f.lines[i];
    if (!canMake(c.industry, line.recipe)) throw cantMake(c, line.recipe);
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
    const y = yieldOf(line.recipe, f.research) * outMult(line, f);
    return { msg: y > 1 ? `✓ Queued ${n.toLocaleString()} run${n === 1 ? "" : "s"} on line ${i + 1}: ${qtyName(line.recipe, n * y)}.` : `✓ Queued ${qtyName(line.recipe, n)} on line ${i + 1}.` };
  });

  const clearQueue = (i) => act((f) => {
    const line = f.lines[i], r = { inputs: line.inputs || inputsFor(line.recipe) };
    if (!line.queued) return { msg: "That line's queue is already empty." };
    for (const [k, q] of Object.entries(r.inputs)) f.inventory[k] = (f.inventory[k] || 0) + q * line.queued;
    const n = line.queued;
    line.queued = 0; line.startedAt = null; delete line.paused;
    return { msg: `✓ Cleared ${n.toLocaleString()} unmade units from line ${i + 1}; their materials are back in the warehouse.` };
  });

  const startResearch = (key) => act((f, treasury, now, c) => {
    const r = RESEARCH[key];
    if (f.research[key]) throw new Error(`${r.name} is already researched.`);
    if (f.project) throw new Error(`Your lab is busy with ${RESEARCH[f.project.key].name}. One project at a time.`);
    if (r.needs && !f.research[r.needs]) throw new Error(`Research ${RESEARCH[r.needs].name} first.`);
    if (!researchFor(c.industry).includes(key)) throw new Error(`${c.industry} companies can't research that.`);
    if (treasury < r.cost) throw new Error(`${r.name} costs ${fmtCash(r.cost)}; the treasury has ${fmtCash(treasury)}.`);
    const baseMs = (r.hours * 3600000) / (f.research.labs ? 2 : 1);
    const ms = baseMs / researchSpeed(f);
    f.project = { key, startedAt: now, endsAt: now + ms, baseMs };
    return { treasury: treasury - r.cost, msg: `✓ Started researching ${r.name}. Done in ${fmtDur(ms / 1000)}.` };
  }, undefined, { fee: "Starting research" });

  const upgradeRobots = (i) => act((f, treasury, now) => {
    const line = f.lines[i], tier = (line.robots || 0) + 1, next = ROBOTS[tier];
    if (!next) throw new Error(`Line ${i + 1} is already fully automated.`);
    if (!f.research[next.needs]) throw new Error(`Research ${RESEARCH[next.needs].name} first.`);
    if (treasury < next.cost) throw new Error(`${next.name} cost ${fmtCash(next.cost)}; the treasury has ${fmtCash(treasury)}.`);
    // Keep the unit in progress at the same percent done, then carry on at the new speed
    rebase(f, now, () => { line.robots = tier; });
    return { treasury: treasury - next.cost, msg: `✓ Line ${i + 1} now has ${next.name.toLowerCase()}: ${next.mult}× speed.` };
  }, undefined, { fee: "A robot upgrade" });

  const hire = (cand) => act((f) => {
    if (f.staff.length >= MAX_STAFF) throw new Error(`A company can employ at most ${MAX_STAFF} people.`);
    if (f.staff.some((s) => s.id === cand.id)) throw new Error(`${cand.name} already works here.`);
    rebase(f, Date.now(), () => {
      f.staff.push({ ...cand, line: null, hiredAt: Date.now() });
    });
    return { msg: `✓ Hired ${cand.name} as a ${ROLES[cand.role].name.toLowerCase()} for ${fmtCash(cand.wage)}/hour.` };
  }, undefined, { fee: "Hiring" });

  const assign = (id, lineId) => act((f, treasury, now) => {
    const s = f.staff.find((x) => x.id === id);
    if (!s) throw new Error("That person no longer works here.");
    const line = f.lines.find((l) => l.id === lineId) || (f.sites || []).find((x) => x.id === lineId && x.builtAt);
    if (line && workersOn(f, line, true).filter((x) => x.id !== id).length >= MAX_WORKERS_PER_LINE)
      throw new Error(`A line takes at most ${MAX_WORKERS_PER_LINE} workers.`);
    if (!is(s, "worker")) throw new Error(`${s.name} doesn't work on lines.`);
    rebase(f, now, () => { s.line = line ? line.id : null; });
    return { msg: line ? `✓ ${s.name} now works on ${f.lines.includes(line) ? `line ${f.lines.indexOf(line) + 1}` : "that site"}.` : `✓ ${s.name} is unassigned.` };
  });

  const train = (id) => act((f, treasury, now) => {
    const s = f.staff.find((x) => x.id === id);
    if (!s) throw new Error("That person no longer works here.");
    if (s.fixed) throw new Error(`${s.name} can't be trained. He's already off the charts.`);
    if (s.player) throw new Error(`${s.name} is a player: their skill grows by working.`);
    if (s.skill >= 5) throw new Error(`${s.name} is already at the top skill level.`);
    const cost = trainCost(s.skill);
    if (treasury < cost) throw new Error(`Training costs ${fmtCash(cost)}; the treasury has ${fmtCash(treasury)}.`);
    rebase(f, now, () => { s.skill += 1; s.wage = wageFor(s.role, s.skill); });
    return { treasury: treasury - cost, msg: `✓ ${s.name} is now skill ${s.skill}; their wage is ${fmtCash(s.wage)}/hour.` };
  }, undefined, { fee: "Training" });

  // Post a job opening for players (see work.js)
  const postJob = (role, wage) => act((f, treasury, now, c, ctx) => {
    const open = st.openings.filter((j) => j.status === "open" || j.status === "taken").length;
    if (open >= MAX_OPENINGS) throw new Error(`A company can have at most ${MAX_OPENINGS} openings posted at once.`);
    if (f.staff.length >= MAX_STAFF) throw new Error(`A company can employ at most ${MAX_STAFF} people.`);
    ctx.sets.push({ ref: jobsCol().doc(), data: { company: st.ticker, companyName: c.name.slice(0, 40), role, wage, status: "open",
      player: null, playerName: null, hours: 0, quit: false, createdAt: fb.firestore.FieldValue.serverTimestamp(), updatedAt: now } });
    return { msg: `✓ Posted a ${ROLES[role].name.toLowerCase()} opening at ${fmtCash(wage)}/hour. It's on every player's Work tab.` };
  }, undefined, { fee: "Posting a job" });
  const withdrawJob = (id) => jobsCol().doc(id).update({ status: "closed", updatedAt: Date.now() }).then(() => "✓ Opening withdrawn.");

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
    const dem = JSON.parse(JSON.stringify(st.demand));
    const c = company();
    const m = { treasury: c ? c.treasury : 0 };
    // Sales just made, less anything sites spent catching up (seed, fuel bought with power)
    const income = settle(f, Date.now(), dem, {}, { kwh: (c && c.powerOwed) || 0 }, m) + m.treasury - (c ? c.treasury : 0);
    return { f, income, dem };
  }

  // Live game-wide demand for everything this company sells or could sell
  function watchDemand() {
    const c = company();
    const keys = [...new Set([...(c ? recipesFor(c.industry) : []), ...((st.factory && st.factory.lines) || []).map((l) => l.recipe),
      ...(c && typeof Sites !== "undefined" ? Sites.sellsFor(c.industry) : [])])]
      .filter((k) => RECIPES[k] && RECIPES[k].sellsFor).sort();
    const key = keys.join(",");
    if (!db || !user || key === st.demandKey) return;
    demandUnsubs.forEach((u) => u());
    st.demandKey = key;
    st.demand = {};
    demandUnsubs = keys.map((k) => demandRef(k).onSnapshot((s) => {
      if (s.exists) st.demand[k] = s.data(); else delete st.demand[k];
      renderSummary(); renderLines(); renderRecipes();
    }, () => {}));
  }
  // "$187.50 now (75% of full price: a lot sold lately)"
  function priceText(f, k, dem) {
    const now = Date.now(), m = priceMult(loadAt(dem[k], now), k);
    return `${fmtCash(priceNow(f, k, dem, now))}${m < 0.995 ? ` (${Math.round(m * 100)}% of full price: a lot sold across the game lately)` : ""}`;
  }

  function renderPicker() {
    const sel = g("fCompany");
    // A factory is private: you only see the ones you run
    const opts = myCompanies().map((c) => {
      const o = mk("option", null, `${c.ticker} · ${c.name}`);
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
    if (!c) { box.replaceChildren(mk("div", "empty", "You don't run a company yet. Found one on the Stocks tab (or have a controller hand one over to you), then come back to build its factory. Factories are private: only whoever runs a company can see inside it.")); return; }
    const { f, income } = projected();
    const kpis = mk("div", "kpis four");
    const k = (label, value, sub) => { const d = mk("div", "kpi"); d.append(mk("span", "k", label), mk("b", null, value)); if (sub) d.append(mk("span", "ks", sub)); return d; };
    kpis.append(
      k("Treasury", fmtCash(c.treasury + income), income ? `includes ${fmtCash(income)} from sales just made` : "pays for materials and lines"),
      siteInd(c.industry)
        ? k("Sites", `${(f.sites || []).length} / ${Sites.MAX_SITES}`, `${(f.sites || []).filter((x) => x.builtAt && !x.paused).length} working`)
        : k("Production lines", `${f.lines.length} / ${MAX_LINES}`, `${f.lines.filter((l) => l.queued).length} running`),
      k("Sold to everyday buyers", f.carsSold.toLocaleString(), salesBonus(f) ? `at +${Math.round(salesBonus(f) * 100)}% thanks to your salespeople` : "the moment they're made"),
      k("Sales revenue", fmtCash(f.revenue), "all-time, into the treasury")
    );
    const mine = recipesFor(c.industry);
    const ind = mk("p", "co-note", siteInd(c.industry)
      ? `${c.ticker} is ${aAn(c.industry)} ${c.industry.toLowerCase()} company. ${Sites.blurb(c.industry)}`
      : mine.length
      ? `${c.ticker} is ${aAn(c.industry)} ${c.industry.toLowerCase()} company. Its lines can make ${mine.map((k) => ITEMS[k].name.toLowerCase()).join(", ")}.`
      : c.industry === "Security" ? `${c.ticker} is a security company: it sells protection to players and companies against robberies and heists (set a daily price on the Stocks tab). It needs no factory.`
      : `${c.ticker}'s industry (${c.industry}) has nothing to make yet.`);
    const perHour = f.lines.reduce((a, l) => a + lineCostNow(l), 0);
    const nextBill = Math.max(1, Math.ceil(((f.upkeepPaidTo || Math.floor(Date.now() / HOUR) * HOUR) + HOUR - Date.now()) / 60000));
    const siteCost = (f.sites || []).reduce((a, x) => a + (typeof Sites !== "undefined" ? Sites.upkeepOf(x) : 0), 0);
    const costs = mk("p", "co-note", siteInd(c.industry)
      ? `Sites pay upkeep every hour from the treasury (see each one). Right now that's ${fmtCash(siteCost + perHour)}/hour${staffOf(f).length ? `, plus ${fmtCash(payrollPerHour(f))}/hour in wages` : ""}${siteCost + perHour ? ` · next bill in about ${nextBill} min` : ""}.`
      : f.lines.length
      ? `Line upkeep: ${fmtCash(UPKEEP_IDLE)}/hour for each idle line, up to ${fmtCash(UPKEEP_BUSY)}/hour for each line running the whole hour, billed hourly from the treasury. Right now that's about ${fmtCash(perHour)}/hour${staffOf(f).length ? `, plus ${fmtCash(payrollPerHour(f))}/hour in wages` : ""} · next bill in about ${nextBill} min.`
      : `Each line costs ${fmtCash(UPKEEP_IDLE)}/hour sitting idle and up to ${fmtCash(UPKEEP_BUSY)}/hour running, billed hourly from the treasury.`);
    const stopped = f.lines.filter((l) => l.paused != null).length;
    const notes = [kpis, ind, costs];
    if (stopped) notes.push(mk("p", "co-note neg", `${stopped} line${stopped === 1 ? " is" : "s are"} stopped: the treasury couldn't pay upkeep. ${iControl() ? "Add Cash to the treasury on the Stocks tab" : "Once the treasury has money again,"} and they pick up where they left off.`));
    const striking = staffOf(f).filter((s) => s.striking).length;
    if (striking) notes.push(mk("p", "co-note neg", `${striking} permanent employee${striking === 1 ? " is" : "s are"} on strike until a payday works.`));
    const who = mk("p", "co-note", iControl()
      ? "You control this company, so you run its factory."
      : `Only ${c.controllerName}, who controls ${c.ticker}, can run this factory. You can look around.`);
    box.replaceChildren(...notes, who);
  }

  function renderLines() {
    const box = g("fLines");
    const { f, dem } = projected();
    const can = iControl(), c = company();
    const allowed = c ? recipesFor(c.industry) : [];
    // Mining and Farming: sites instead of lines (old lines keep going until their queues are done)
    const sitesMode = !!c && siteInd(c.industry);
    g("fLinesTitle").textContent = !sitesMode ? "Production lines" : Sites.title(c.industry);
    g("fSites").classList.toggle("hidden", !sitesMode);
    if (sitesMode) Sites.render(g("fSites"), f, can, c, run);
    g("fBuild").classList.toggle("hidden", !can || sitesMode || f.lines.length >= MAX_LINES);
    g("fBuild").textContent = `Build a production line (${fmtCash(LINE_COST)})`;
    if (sitesMode) { box.replaceChildren(); return; }   // leftover lines are taken down at the next save
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
        const keys = allowed.includes(line.recipe) ? allowed : [line.recipe, ...allowed];
        for (const key of keys) { const o = mk("option", null, ITEMS[key].name + (allowed.includes(key) ? "" : " (not this industry)")); o.value = key; what.append(o); }
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
      const per = yieldOf(line.recipe, f.research) * om;
      const recipe = mk("div", "f-recipe-text", `${inputs || `nothing (${r.how})`} → ${outText(line.recipe, per)} · ${fmtDur(unitMs(line, f) / 1000)} each run${r.sellsFor ? ` · everyday buyers pay ${priceText(f, line.recipe, dem)} each` : ""}`);
      if (c && !allowed.includes(line.recipe)) recipe.append(mk("span", "neg", ` · ${c.industry} companies can't make this any more: let the queue finish, then switch the line`));
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
        status.textContent = `Idle (upkeep ${fmtCash(UPKEEP_IDLE)}/hour). Queue some units to start.`;
        return;
      }
      if (!line.startedAt) {
        fill.style.width = Math.min(100, (line.paused || 0) * 100) + "%";
        status.textContent = `Stopped: the treasury couldn't pay upkeep. ${line.queued.toLocaleString()} still in the queue.`;
        return;
      }
      const into = now - line.startedAt;
      fill.style.width = Math.min(100, (into / per) * 100) + "%";
      status.textContent = `Running (upkeep ${fmtCash(UPKEEP_BUSY)}/hour) · ${line.queued.toLocaleString()} in the queue · next one in ${fmtDur((per - into) / 1000)} · all done in ${fmtDur((line.queued * per - into) / 1000)}`;
    });
  }

  function renderResearch() {
    const box = g("fResearch");
    const { f } = projected();
    const can = iControl();
    const c = company();
    const keys = c ? researchFor(c.industry) : Object.keys(RESEARCH);
    box.replaceChildren(...keys.map((key) => [key, RESEARCH[key]]).map(([key, r]) => {
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

  const siteLabel = (x, j) => `${x.kind === "mine" ? `${ITEMS[x.ore].name} mine` : x.kind === "field" ? "Field" : x.kind === "pen" ? "Cattle pen" : "Plantation"} ${j + 1}`;
  const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);

  function renderStaff() {
    const { f } = projected();
    const can = iControl(), c = company();
    const pay = payrollPerHour(f);
    const nextPay = Math.max(0, Math.ceil(((f.wagesPaidTo || Math.floor(Date.now() / HOUR) * HOUR) + HOUR - Date.now()) / 60000));
    const sum = g("fPayroll");
    sum.replaceChildren(mk("p", "co-note", f.staff.length
      ? `${f.staff.length} of ${MAX_STAFF} employees · ${fmtCash(pay)}/hour in wages, paid hourly from the treasury · next payday in about ${nextPay} min` +
        (c && c.treasury < pay ? " · the treasury can't cover the next payday: regular staff quit, best-paid first, and permanent staff go on strike" : "")
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
          sel.append(none, ...f.lines.map((l, j) => { const o = mk("option", null, `Line ${j + 1} (${ITEMS[l.recipe].many})`); o.value = l.id; return o; }),
            ...(f.sites || []).filter((x) => x.builtAt).map((x, j) => { const o = mk("option", null, siteLabel(x, j)); o.value = x.id; return o; }));
          sel.value = sf.line || "";
          sel.addEventListener("change", (e) => run(() => assign(sf.id, e.target.value || null)));
          acts.append(sel);
        }
        if (sf.fixed) acts.append(mk("span", "chip robo", "permanent · can't quit"));
        if (sf.player) acts.append(mk("span", "chip crew", `player · ${(sf.hoursWorked || 0).toLocaleString()} h worked`));
        if (sf.striking) acts.append(mk("span", "chip neg", "on strike: unpaid"));
        if (sf.skill < 5 && !sf.fixed && !sf.player) {
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

  // Job openings for players (Employees panel)
  function renderOpenings() {
    const box = g("fOpenings"), card = g("fJobsCard");
    if (!box) return;
    const can = iControl();
    card.classList.toggle("hidden", !can);
    if (!can) return;
    const list = st.openings.filter((j) => j.status === "open" || j.status === "taken");
    box.replaceChildren(...(list.length ? list.map((j) => {
      const row = mk("div", "f-person");
      const info = mk("div", "f-person-info");
      info.append(mk("b", null, `${ROLES[j.role].name} · ${fmtCash(j.wage)}/hour`),
        mk("span", null, j.status === "open" ? "Waiting for a player to take it" : `${j.playerName} took it: they join at the next save`));
      const acts = mk("div", "f-person-acts");
      if (j.status === "open") { const b = mk("button", "btn-ghost", "Withdraw"); b.addEventListener("click", () => run(() => withdrawJob(j.id))); acts.append(b); }
      row.append(info, acts);
      return row;
    }) : [mk("div", "empty", "No openings posted. Players who take one join your staff and are paid from the treasury every hour.")]));
  }

  function renderWarehouse() {
    const box = g("fInv");
    const { f } = projected();
    // What's in stock, plus whatever this company's recipes use or make
    const c = company(), used = new Set();
    for (const k of c ? recipesFor(c.industry) : []) { used.add(k); Object.keys(RECIPES[k].inputs).forEach((i) => used.add(i)); }
    const rows = GOODS.filter((k) => (f.inventory[k] || 0) > 0 || used.has(k));
    if (!rows.length) { box.replaceChildren(mk("div", "empty", "Empty.")); }
    else box.replaceChildren(...rows.map((k) => {
      const d = mk("div", "f-item" + ((f.inventory[k] || 0) ? "" : " none"));
      d.append(mk("span", null, ITEMS[k].name), mk("b", null, (f.inventory[k] || 0).toLocaleString()));
      return d;
    }));
    g("fBuyBox").classList.toggle("hidden", !iControl());
    g("fSellBox").classList.toggle("hidden", !iControl());
    // Only what's actually in the warehouse can go to wholesalers
    const sel = g("fSell"), keep = sel.value;
    const stock = GOODS.filter((k) => (f.inventory[k] || 0) > 0);
    const key = stock.map((k) => `${k}:${f.inventory[k]}`).join("|");
    if (sel.dataset.key !== key) {
      sel.replaceChildren(...(stock.length ? stock.map((k) => { const o = mk("option", null, `${ITEMS[k].name} (${(f.inventory[k]).toLocaleString()} in stock, ${fmtCash(wholesalePrice(k))} each)`); o.value = k; return o; })
        : [Object.assign(mk("option", null, "Nothing in the warehouse"), { value: "" })]));
      sel.dataset.key = key;
      if (stock.includes(keep)) sel.value = keep;
    }
    renderCost();
  }

  function renderCost() {
    const item = g("fRaw").value, qty = Math.floor(Number(g("fRawQty").value));
    g("fRawCost").textContent = qty > 0 && item ? `Costs ${fmtCash(supplierPrice(item) * qty)} from the treasury` : "";
    const sItem = g("fSell").value, sQty = Math.floor(Number(g("fSellQty").value));
    g("fSellCash").textContent = sItem && sQty > 0
      ? `Pays ${fmtCash(wholesalePrice(sItem) * sQty)} into the treasury right away: half what the materials are worth. The Market usually pays more.`
      : "Wholesalers buy anything in your warehouse right away, for half what its materials are worth.";
  }

  function renderRecipes() {
    const { f: pf, dem } = st.factory ? projected() : { f: blank(), dem: {} };
    const c = company();
    if (c && siteInd(c.industry)) {
      const more = mk("details", "f-others");
      more.append(mk("summary", null, "What other industries make"), ...INDUSTRIES.filter((i) => i !== c.industry && !siteInd(i)).map((i) => {
        const p = mk("p", "co-note"); p.append(mk("b", null, `${i}: `), recipesFor(i).map((k) => ITEMS[k].name.toLowerCase()).join(", ")); return p;
      }));
      g("fRecipes").replaceChildren(...Sites.guide(c.industry), more);
      return;
    }
    const keys = c ? recipesFor(c.industry) : [];
    const rows = keys.map((k) => {
      const r = RECIPES[k];
      const y = yieldOf(k, pf.research);
      const tr = mk("tr");
      tr.append(mk("td", null, ITEMS[k].name), mk("td", null, `${inputsText(k, pf.research)} → ${outText(k, y)}`), mk("td", "num", fmtDur(r.secs)),
        mk("td", null, r.sellsFor
          ? `Sold instantly to everyday buyers: ${priceText(pf, k, dem)} each now, up to ${fmtCash(salePrice(pf, k))}. They want about ${demandOf(k).toLocaleString()} an hour across the whole game`
          : `Kept in the warehouse · worth about ${fmtCash(BASE_VALUE[k])} each`));
      return tr;
    });
    const table = mk("table", "f-table");
    const head = mk("tr");
    for (const h of ["Makes", "From", "Time per run", "Then"]) head.append(mk("th", null, h));
    const thead = mk("thead"); thead.append(head);
    const tbody = mk("tbody"); tbody.append(...rows);
    table.append(thead, tbody);
    const wrap = mk("div", "f-table-wrap"); wrap.append(table);
    const others = INDUSTRIES.filter((i) => !c || i !== c.industry).map((i) => {
      const p = mk("p", "co-note");
      p.append(mk("b", null, `${i}: `), recipesFor(i).map((k) => ITEMS[k].name.toLowerCase()).join(", "));
      return p;
    });
    const more = mk("details", "f-others");
    more.append(mk("summary", null, "What other industries make"), ...others);
    g("fRecipes").replaceChildren(
      ...(c ? [mk("p", "co-note", `As ${aAn(c.industry)} ${c.industry.toLowerCase()} company, ${c.ticker} can make:`), wrap] : [mk("div", "empty", "Pick a company to see what it can make.")]),
      mk("p", "co-note", "Anything a recipe needs that you don't make yourself comes from other companies on the Market, or from suppliers: raw materials at their list price, made goods at a 60% markup. Times are for a line without robots or workers; this company's research is already counted."),
      mk("p", "co-note", "Everyday buyers are shared by every company in the game. The more of something anyone sells, the less buyers pay for the next one, down to 30% of full price; the price climbs back as sales slow down, mostly within an hour."),
      more);
  }

  function renderAll() { if (typeof Contracts !== "undefined") Contracts.watch(st.ticker); watchDemand(); renderOpenings(); renderPicker(); renderSummary(); renderLines(); renderWarehouse(); renderResearch(); renderStaff(); renderRecipes(); }

  function watchFactory(ticker) {
    if (factoryUnsub) factoryUnsub();
    st.ticker = ticker;
    st.factory = null;
    factoryUnsub = ticker ? factoryRef(ticker).onSnapshot((s) => {
      st.factory = s.exists ? s.data() : blank();
      renderAll();
    }, (e) => { if (iControl()) setMsg(errText(e), "err"); }) : null;   // losing control ends access: not an error
    if (openingsUnsub) openingsUnsub();
    st.openings = []; st.openingsLoaded = false;
    openingsUnsub = ticker ? jobsCol().where("company", "==", ticker).limit(100).onSnapshot((q) => {
      st.openings = q.docs.map((d) => ({ id: d.id, ...d.data() }));
      st.openingsLoaded = true;
      renderOpenings();
    }, () => {}) : null;
    renderAll();
  }

  /* ---------- lifecycle ---------- */
  function init(firebaseNs, firestore) {
    fb = firebaseNs; db = firestore;
    g("fRaw").replaceChildren(...GOODS.map((k) => { const o = mk("option", null, `${ITEMS[k].name} (${fmtCash(supplierPrice(k))} each${ITEMS[k].price ? "" : ", made"})`); o.value = k; return o; }));
    g("fRaw").addEventListener("change", renderCost);
    g("fSell").addEventListener("change", renderCost);
    g("fSellQty").addEventListener("input", renderCost);
    g("fSellBtn").addEventListener("click", () => {
      const item = g("fSell").value, qty = Math.floor(Number(g("fSellQty").value));
      if (!item) return setMsg("The warehouse is empty.", "err");
      if (!(qty >= 1)) return setMsg("Enter how many to sell.", "err");
      run(() => sellWholesale(item, qty));
    });
    g("fRawQty").addEventListener("input", renderCost);
    g("fBuy").addEventListener("click", () => {
      const qty = Math.floor(Number(g("fRawQty").value));
      if (!(qty >= 1)) return setMsg("Enter how many to buy.", "err");
      run(() => buyRaw(g("fRaw").value, qty));
    });
    g("fBuild").addEventListener("click", () => run(buildLine));
    g("fJobRole").replaceChildren(...["worker", "researcher", "sales", "manager"].map((r) => { const o = mk("option", null, ROLES[r].name); o.value = r; return o; }));
    g("fJobPost").addEventListener("click", () => {
      const wage = Math.round(Number(g("fJobWage").value) * 100);
      if (!(wage >= 100) || wage > 100000) return setMsg("Set a wage between $1 and $1,000 an hour.", "err");
      run(() => postJob(g("fJobRole").value, wage));
    });
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
      // While the factory tab is open, bank finished units every 2 minutes
      if (!g("tab-factory").classList.contains("hidden") && Date.now() - st.lastSettle > 120000 && !st.busy) {
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
      for (const fn of companyWatchers) { try { fn(); } catch (e) { console.warn(e); } }
      // Only factories you run can be opened; if you just lost control of this one, switch away
      if (!st.ticker || !company() || !iControl()) {
        const mine = myCompanies()[0];
        if ((mine && mine.ticker) !== st.ticker || !st.ticker) watchFactory(mine ? mine.ticker : null);
        else renderAll();
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
    demandUnsubs.forEach((u) => u());
    demandUnsubs = [];
    if (openingsUnsub) openingsUnsub();
    openingsUnsub = null;
    Object.assign(st, { companies: [], ticker: null, factory: null, busy: false, lastSettle: 0, demand: {}, demandKey: "", openings: [], openingsLoaded: false });
    if (g("fMsg")) { setMsg("", ""); renderAll(); }
  }

  // 15-minute upkeep: bank finished units for every company this player runs
  async function upkeep() {
    if (!user) return;
    for (const c of st.companies.filter((x) => x.controller === user.uid)) {
      await act(null, c.ticker).catch((e) => console.warn("Factory catch-up", c.ticker, e));
    }
  }

  // For the contracts panel: run a change through the controller's factory save
  const actFor = (t, change, opts) => act(change, t, opts);
  const companies = () => st.companies;
  // exported below as onCompanies
  return { onCompanies, init, signIn, signOut, upkeep, actFor, companies, crewMult, workersOn, outMult, deliver, payDue, room, MAX_CONTRACTS_PER_ACT, fmtDur, RECIPES, ITEMS, RAW, GOODS, INDUSTRIES, PRODUCTS, BASE_VALUE, supplierPrice, clone, blank, qtyName };
})();
