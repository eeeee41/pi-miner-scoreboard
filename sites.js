/* =====================================================================
   Pi Miner — facility revamp: mines, farms, power and furnaces
   ---------------------------------------------------------------------
   Mining and Farming companies don't use production lines. They run
   sites, kept in the factory doc as `sites` (a list):

   Mining
     mine        { kind: "mine", ore, size, rich, method, builtAt, mined, carry, lastAt }
                 Survey for a deposit of an ore: it has a size (units in
                 the ground) and a richness (units an hour). Open it as an
                 open-pit mine (cheap, quick, reaches 60% of the ore) or a
                 shaft mine (dearer, 2 hours to dig, reaches all of it at
                 80% speed). A mine produces around the clock until it has
                 dug out everything it can reach.
   Farming
     field       { kind: "field", crop, plantedAt, readyAt, auto, soil, lastCrop, emptySince, lastHarvest }
                 Plant wheat, vegetables or cotton (seed costs Cash), wait
                 for it to grow, and the harvest goes to the warehouse. How
                 much comes in depends on the soil and the weather. The same
                 crop twice in a row wears the soil out; a different crop
                 brings it back, and so does leaving the field empty.
                 "Keep planting" replants the same crop after each harvest.
     plantation  { kind: "plantation", builtAt, carry, lastAt }
                 Rubber trees: 4 hours to mature, then rubber around the clock.
     pen         { kind: "pen", head, fedHours, lastAt }
                 Cattle eat 1 bushel of wheat each per hour from the warehouse.
                 Every 6 fed hours the herd grows by a quarter. Move cattle
                 in from the warehouse, and out to sell or to supply contracts.

   Energy
     plant       { kind: "plant", type: coal|gas|solar, on, builtAt, carry, fuelFrac, lastAt, made }
                 Power plants make electricity around the clock and sell it
                 to everyday buyers as it's made (after covering what miners
                 bought from the company). Coal and gas plants burn fuel from
                 the warehouse; solar farms need none but only make power
                 while the sun is up (06:00–18:00 UTC), less when it's cloudy.
     well        { kind: "well", r0, builtAt, frackedAt, carry, lastAt, made }
                 An oil well pumps crude oil into the warehouse. It starts
                 strong and declines 4% an hour, levelling off at 15% of
                 where it started. Fracking research lets you re-frack it.
     refinery    { kind: "refinery", mode: fuel|chem, on, builtAt, carry, lastAt, made }
                 Takes crude oil from the warehouse around the clock and
                 splits it into gasoline (sold as it's made) and plastic
                 (kept). Fuel mode makes more gasoline, chemicals mode more
                 plastic.
   Steel and metals
     furnace     { kind: "furnace", type: blast|kiln|arc, builtAt, size, auto, batch: { n, startedAt, endsAt }, last, stall, powerFrom }
                 Works in batches: load it (the materials are taken at once),
                 wait, and the whole batch comes out together. Batches are
                 much bigger than a line's output. "Keep going" starts the
                 same batch again whenever the materials are there. Arc
                 furnaces melt iron with electricity, bought from the grid
                 or from an Energy company when each batch starts.
     Steel and metals companies can also survey and mine iron ore, coal
     and sand; Energy companies can mine coal.

   Workers assigned to a site speed it up just like on a line (and a
   MissingNo. multiplies what it turns out). Sites pay hourly upkeep with
   the lines, and stop if the treasury can't pay it.
   ===================================================================== */
const Sites = (() => {
  const HOUR = 3600000;
  const SV = () => typeof Services !== "undefined";       // Software, Retail and Finance sites (services.js)
  const INDUSTRIES = ["Mining", "Farming", "Energy", "Steel and metals", ...(SV() ? Services.INDUSTRIES : [])];
  const MAX_SITES = 10;
  const ORES = {
    iron:   { rich: [120, 300], size: [8000, 30000] },
    coal:   { rich: [150, 360], size: [10000, 40000] },
    copper: { rich: [60, 150],  size: [5000, 20000] },
    sand:   { rich: [200, 500], size: [15000, 50000] }
  };
  const CROPS = {
    wheat:      { hours: 2, yield: 600, seed: 3000 },
    vegetables: { hours: 1, yield: 300, seed: 2000 },
    cotton:     { hours: 3, yield: 450, seed: 4000 }
  };
  // Which ores each industry can survey for (Mining has the research to mine them best)
  const SURVEYS = { Mining: ["iron", "coal", "copper", "sand"], "Steel and metals": ["iron", "coal", "sand"], Energy: ["coal"] };
  const COST = { survey: 50000, pit: 80000, shaft: 250000, field: 100000, plantation: 200000, pen: 150000,
    coal: 250000, gas: 400000, solar: 800000, well: 150000, refinery: 500000, refrack: 100000,
    blast: 300000, kiln: 200000, arc: 600000 };
  const UPKEEP = { pit: 4000, shaft: 6000, depleted: 1000, field: 1500, plantation: 2500, pen: 2000,
    coal: 4000, gas: 5000, solar: 1500, well: 2500, refinery: 5000, blast: 3000, kiln: 2000, arc: 4000 };   // cents an hour
  // Energy
  const PLANTS = {
    coal:  { name: "Coal power plant", rate: 150, fuel: "coal", per: 2,  perR: 1.5 },   // MWh an hour; fuel per MWh (with Efficient boilers)
    gas:   { name: "Gas power plant",  rate: 200, fuel: "oil",  per: 1,  perR: 0.75 },
    solar: { name: "Solar farm",       peak: 240 }                                        // MWh an hour at noon on a clear day
  };
  const WELL = { r0: [80, 160], decline: 0.04, floor: 0.15 };                             // barrels an hour at the start
  const REFINERY = { rate: 240, modes: {                                                   // barrels of oil an hour
    fuel: { name: "Fuel", oil: 4, gasoline: 2, plastic: 1 },
    chem: { name: "Chemicals", oil: 4, gasoline: 1, plastic: 4 } } };
  // Steel and metals: batch furnaces
  const FURNACES = {
    blast: { name: "Blast furnace",        out: "steel", mins: 60, cap: 200 },
    kiln:  { name: "Glass kiln",           out: "glass", mins: 45, cap: 300 },
    arc:   { name: "Electric arc furnace", out: "steel", mins: 30, cap: 300 }
  };
  const SLICE = 10 * 60000;            // continuous output is sold in 10-minute slices, so demand moves with it
  const PIT_REACH = 0.6, SHAFT_SPEED = 0.8, DIG_HOURS = 2, PLANT_HOURS = 4, RUBBER_RATE = 60;
  const PEN_CAP = 200, BREED_EVERY = 6;
  // Research only Mining or Farming companies can do (added to the factory's lab)
  const RESEARCH = {
    survey1:    { name: "Geological surveys",  cost: 300000, hours: 1,   needs: null,      ind: ["Mining"],  does: "New surveys find deposits half as big again and half as rich again" },
    drill1:     { name: "Heavy drills",        cost: 600000, hours: 2,   needs: null,      ind: ["Mining"],  does: "Every mine digs 1.5× faster" },
    refine1:    { name: "Ore refining",        cost: 800000, hours: 3,   needs: "drill1",  ind: ["Mining"],  does: "Every 4 units dug come out as 5" },
    deep1:      { name: "Deep shafts",         cost: 500000, hours: 1.5, needs: null,      ind: ["Mining"],  does: "Shaft mines take 1 hour to dig and work at full speed" },
    irrigate:   { name: "Irrigation",          cost: 300000, hours: 1,   needs: null,      ind: ["Farming"], does: "Crops grow 30% faster" },
    fert:       { name: "Fertiliser",          cost: 500000, hours: 2,   needs: null,      ind: ["Farming"], does: "Harvests are 25% bigger, and soil wears out half as fast" },
    greenhouse: { name: "Greenhouses",         cost: 900000, hours: 3,   needs: "irrigate", ind: ["Farming"], does: "No more poor harvests from bad weather" },
    breed:      { name: "Selective breeding",  cost: 600000, hours: 2,   needs: null,      ind: ["Farming"], does: "Cattle herds grow every 3 fed hours instead of 6" },
    boiler:     { name: "Efficient boilers",   cost: 400000, hours: 1.5, needs: null,      ind: ["Energy"],  does: "Coal plants burn 1.5 coal per MWh instead of 2, and gas plants 3 barrels for every 4 MWh instead of 1 each" },
    panels:     { name: "Better solar panels", cost: 600000, hours: 2,   needs: null,      ind: ["Energy"],  does: "Solar farms make 50% more" },
    eor:        { name: "Enhanced oil recovery", cost: 500000, hours: 2, needs: null,      ind: ["Energy"],  does: "Oil wells decline half as fast" },
    frack:      { name: "Hydraulic fracturing", cost: 800000, hours: 3,  needs: "eor",     ind: ["Energy"],  does: "Re-frack a tired well ($1,000) to bring it back to where it started" },
    crack:      { name: "Catalytic cracking",  cost: 600000, hours: 2,   needs: null,      ind: ["Energy"],  does: "Refineries take 50% more oil an hour" },
    hotblast:   { name: "Hot blast",           cost: 400000, hours: 1.5, needs: null,      ind: ["Steel and metals"], does: "Furnace and kiln batches finish 40% sooner" },
    oxygen:     { name: "Basic oxygen steelmaking", cost: 600000, hours: 2, needs: "hotblast", ind: ["Steel and metals"], does: "Blast-furnace steel needs 1 iron ore instead of 2" },
    bigfurnace: { name: "Bigger furnaces",     cost: 500000, hours: 2,   needs: null,      ind: ["Steel and metals"], does: "Every furnace and kiln takes batches twice as big" },
    floatglass: { name: "Float glass",         cost: 400000, hours: 1,   needs: null,      ind: ["Steel and metals"], does: "Glass needs 1 sand instead of 2" },
    uhp:        { name: "Ultra-high-power arcs", cost: 700000, hours: 2.5, needs: null,    ind: ["Steel and metals"], does: "Arc furnaces use 0.3 MWh per steel instead of 0.5" },
    ...(SV() ? Services.RESEARCH : {})
  };
  const isSiteIndustry = (ind) => INDUSTRIES.includes(ind);
  const builds = (ind) => (ind === "Mining" ? ["survey"] : ind === "Farming" ? ["field", "plantation", "pen"]
    : ind === "Energy" ? ["survey", "well", "refinery", "coal", "gas", "solar"] : ind === "Steel and metals" ? ["survey", "blast", "kiln", "arc"]
    : SV() ? Services.builds(ind) : []);

  // Same random numbers every time for the same site and moment, so the page's preview matches what's saved
  function roll(key) {
    let h = 2166136261;
    for (const ch of String(key)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  }
  function weather(site, plantedAt, research) {
    const r = roll(`${site.id}:${plantedAt}`);
    const w = r < 0.1 ? { m: 0.6, name: "drought" } : r < 0.3 ? { m: 0.8, name: "a poor season" } : r < 0.95 ? { m: 1, name: "good weather" } : { m: 1.3, name: "a bumper season" };
    return research.greenhouse && w.m < 1 ? { m: 1, name: "good weather (greenhouse)" } : w;
  }
  const growMs = (crop, research, crew) => (CROPS[crop].hours * HOUR * (research.irrigate ? 0.7 : 1)) / crew;
  const reach = (s) => Math.floor(s.size * (s.method === "pit" ? PIT_REACH : 1));
  const digMs = (research) => (research.deep1 ? 1 : DIG_HOURS) * HOUR;
  const mineRate = (s, research, crew) => s.rich * (s.method === "shaft" && !research.deep1 ? SHAFT_SPEED : 1) * (research.drill1 ? 1.5 : 1) * crew;
  const depleted = (s) => s.kind === "mine" && s.method && s.mined >= reach(s);
  function upkeepOf(s) {
    if (!s.builtAt) return 0;                              // a surveyed deposit nobody has opened costs nothing
    if (SV() && Services.handles(s.kind)) return Services.upkeepOf(s);
    if (s.kind === "mine") return depleted(s) ? UPKEEP.depleted : UPKEEP[s.method];
    if (s.kind === "plant" || s.kind === "furnace") return UPKEEP[s.type] || 0;
    return UPKEEP[s.kind] || 0;
  }
  // Energy
  const fuelPer = (type, research) => (research.boiler ? PLANTS[type].perR : PLANTS[type].per);
  // How strong the sun is at time t (0 at night, 1 at noon UTC), and whether that hour is cloudy
  function sunAt(t) { const h = (t / HOUR) % 24; return h > 6 && h < 18 ? Math.sin((Math.PI * (h - 6)) / 12) : 0; }
  const cloudy = (s, t) => roll(`${s.id}:${Math.floor(t / HOUR)}`) < 0.3;
  const solarRate = (s, t, research) => PLANTS.solar.peak * (research.panels ? 1.5 : 1) * sunAt(t) * (cloudy(s, t) ? 0.5 : 1);
  const wellK = (research) => WELL.decline * (research.eor ? 0.5 : 1);
  // Barrels a well (starting at 1 an hour) has pumped by t hours: e^(−kt) decline, then flat at the floor
  function wellCum(k, t) {
    const tf = Math.log(1 / WELL.floor) / k;
    return t <= tf ? (1 - Math.exp(-k * t)) / k : (1 - WELL.floor) / k + WELL.floor * (t - tf);
  }
  const wellRate = (s, t, research) => s.r0 * Math.max(WELL.floor, Math.exp(-wellK(research) * Math.max(0, t - (s.frackedAt || s.builtAt)) / HOUR));
  const refineRate = (research) => REFINERY.rate * (research.crack ? 1.5 : 1);
  // Steel and metals
  const batchCap = (type, research) => FURNACES[type].cap * (research.bigfurnace ? 2 : 1);
  const batchMs = (type, research, crew) => (FURNACES[type].mins * 60000 * (research.hotblast ? 0.6 : 1)) / crew;
  const furnaceInputs = (type, research) => type === "blast" ? { iron: research.oxygen ? 1 : 2, coal: 1 }
    : type === "kiln" ? { sand: research.floatglass ? 1 : 2, coal: 1 } : { iron: 1 };
  const arcMwh = (research) => (research.uhp ? 0.3 : 0.5);
  // Sell n units made evenly between a and b, in slices, so shared demand fills up as it goes
  function spread(H, k, n, a, b) {
    if (n <= 0) return;
    const m = Math.max(1, Math.min(24, Math.ceil((b - a) / SLICE)));
    let left = n;
    for (let i = 1; i <= m; i++) {
      const q = i === m ? left : Math.floor(n / m);
      left -= q;
      H.sell(Math.round(a + ((b - a) * i) / m), k, q);
    }
  }
  // Load a furnace: take the materials (and buy the power) for a batch starting at t. Returns the treasury after.
  function startBatch(s, f, t, treasury, H) {
    const research = H.research || f.research || {};
    const n = Math.min(s.size || 0, batchCap(s.type, research));
    if (n < 1) return { why: "Pick a batch size." };
    const need = furnaceInputs(s.type, research);
    for (const [k, q] of Object.entries(need)) {
      if ((f.inventory[k] || 0) < q * n) return { why: `needs ${(q * n).toLocaleString()} ${Factory.ITEMS[k].many}; the warehouse has ${(f.inventory[k] || 0).toLocaleString()}` };
    }
    let power = null;
    if (s.type === "arc") {
      power = H.buyPower(s.powerFrom || null, Math.round(n * arcMwh(research) * 1000), treasury);
      if (!power) return { why: `can't pay for ${(n * arcMwh(research)).toLocaleString()} MWh of electricity` };
      treasury -= power.cost;
    }
    for (const [k, q] of Object.entries(need)) f.inventory[k] -= q * n;
    s.batch = { n, startedAt: t, endsAt: Math.round(t + batchMs(s.type, research, H.crew(s))) };
    if (power) s.batch.power = { cost: power.cost, from: power.from };
    s.stall = null;
    return { ok: true, treasury };
  }

  /* ---------- catching up (called from every factory save) ----------
     H = { research, crew(site), out(site) } from the factory. Adds output to the warehouse and to
     `made` (so supply contracts get it), pays for seed when replanting; returns the treasury after. */
  function settle(f, now, made, treasury, H) {
    const research = H.research || {};
    const add = (k, n) => { if (n > 0) { f.inventory[k] = (f.inventory[k] || 0) + n; made[k] = (made[k] || 0) + n; } };
    for (const s of f.sites || []) {
      if (s.paused) {                                       // stopped for unpaid upkeep: nothing piles up meanwhile
        if (s.kind === "furnace" && s.batch && s.lastAt) s.batch.endsAt += Math.max(0, now - s.lastAt);
        s.lastAt = now;
        continue;
      }
      if (s.kind === "mine" && s.method) {
        const start = s.builtAt + (s.method === "shaft" ? digMs(research) : 0);
        const from = Math.max(s.lastAt || start, start);
        if (now <= from) continue;
        const left = reach(s) - (s.mined || 0);
        if (left <= 0) { s.lastAt = now; continue; }
        const raw = (mineRate(s, research, H.crew(s)) * (now - from)) / HOUR + (s.carry || 0);
        const n = Math.min(left, Math.floor(raw));
        s.carry = n < left ? raw - n : 0;
        s.mined = (s.mined || 0) + n;
        s.lastAt = now;
        add(s.ore, Math.floor(n * (research.refine1 ? 1.25 : 1) * H.out(s)));
      } else if (s.kind === "plantation") {
        const start = s.builtAt + PLANT_HOURS * HOUR;
        const from = Math.max(s.lastAt || start, start);
        if (now <= from) continue;
        const raw = (RUBBER_RATE * H.crew(s) * (now - from)) / HOUR + (s.carry || 0);
        const n = Math.floor(raw);
        s.carry = raw - n; s.lastAt = now;
        add("rubber", Math.floor(n * H.out(s)));
      } else if (s.kind === "field") {
        for (let i = 0; i < 100 && s.crop && now >= s.readyAt; i++) {
          const c = CROPS[s.crop], w = weather(s, s.plantedAt, research);
          const qty = Math.floor(c.yield * (s.soil ?? 1) * w.m * (research.fert ? 1.25 : 1) * H.out(s));
          add(s.crop, qty);
          s.lastHarvest = { crop: s.crop, qty, weather: w.name, at: s.readyAt };
          // The soil wears out growing the same crop again; a different crop helps it recover
          s.soil = s.lastCrop === s.crop ? Math.max(0.3, (s.soil ?? 1) - (research.fert ? 0.075 : 0.15)) : Math.min(1, (s.soil ?? 1) + 0.1);
          s.lastCrop = s.crop;
          if (s.auto && treasury >= c.seed) {
            treasury -= c.seed;
            s.plantedAt = s.readyAt;
            s.readyAt = s.plantedAt + growMs(s.crop, research, H.crew(s));
          } else {
            s.emptySince = s.readyAt;
            s.crop = null; s.plantedAt = null; s.readyAt = null;
            if (s.auto) s.auto = false;                     // out of Cash for seed: stop replanting
          }
        }
        if (!s.crop && s.emptySince) {                      // resting soil recovers 5% an hour
          const h = Math.floor((now - s.emptySince) / HOUR);
          if (h > 0) { s.soil = Math.min(1, (s.soil ?? 1) + 0.05 * h); s.emptySince += h * HOUR; }
        }
      } else if (s.kind === "pen") {
        const from = s.lastAt || s.builtAt;
        const hours = Math.min(168, Math.floor((now - from) / HOUR));
        for (let i = 0; i < hours; i++) {
          if (!s.head) continue;
          if ((f.inventory.wheat || 0) < s.head) continue;  // no feed, no growth
          f.inventory.wheat -= s.head;
          s.fedHours = (s.fedHours || 0) + 1;
          if (s.head >= 2 && s.fedHours % (research.breed ? BREED_EVERY / 2 : BREED_EVERY) === 0)
            s.head = Math.min(PEN_CAP, s.head + Math.max(1, Math.floor(s.head / 4)));
        }
        if (hours > 0) s.lastAt = from + hours * HOUR;
      } else if (s.kind === "plant") {
        const from = Math.max(s.lastAt || s.builtAt, s.builtAt);
        if (now <= from) continue;
        if (!s.on) { s.lastAt = now; s.carry = 0; continue; }
        const crew = H.crew(s), out = H.out(s);
        if (s.type === "solar") {
          // Hour by hour (at most a week back), since the sun and the clouds change every hour
          let a = Math.max(from, now - 168 * HOUR), carry = s.carry || 0;
          while (a < now) {
            const b = Math.min(now, (Math.floor(a / HOUR) + 1) * HOUR);
            const raw = (solarRate(s, (a + b) / 2, research) * crew * (b - a)) / HOUR + carry;
            const n = Math.floor(raw);
            carry = raw - n;
            if (n) { H.sell(b, "power", Math.floor(n * out)); s.made = (s.made || 0) + n; }
            a = b;
          }
          s.carry = carry;
        } else {
          const p = PLANTS[s.type], per = fuelPer(s.type, research), rate = p.rate * crew;
          const raw = (rate * (now - from)) / HOUR + (s.carry || 0);
          const fuel = f.inventory[p.fuel] || 0;
          let n = Math.floor(raw);
          const can = Math.floor(fuel / per);
          if (n > can) { n = can; s.carry = 0; s.noFuel = true; } else { s.carry = raw - n; s.noFuel = false; }
          const use = n * per + (s.fuelFrac || 0), take = Math.min(fuel, Math.floor(use));
          s.fuelFrac = use - take;
          f.inventory[p.fuel] = fuel - take;
          if (n) { spread(H, "power", Math.floor(n * out), from, from + (n / rate) * HOUR); s.made = (s.made || 0) + n; }
        }
        s.lastAt = now;
      } else if (s.kind === "well") {
        const base = s.frackedAt || s.builtAt;
        const from = Math.max(s.lastAt || base, base);
        if (now <= from) continue;
        const k = wellK(research);
        const raw = s.r0 * H.crew(s) * (wellCum(k, (now - base) / HOUR) - wellCum(k, (from - base) / HOUR)) + (s.carry || 0);
        const n = Math.floor(raw);
        s.carry = raw - n; s.lastAt = now; s.made = (s.made || 0) + n;
        add("oil", Math.floor(n * H.out(s)));
      } else if (s.kind === "refinery") {
        const from = Math.max(s.lastAt || s.builtAt, s.builtAt);
        if (now <= from) continue;
        if (!s.on) { s.lastAt = now; s.carry = 0; continue; }
        const m = REFINERY.modes[s.mode] || REFINERY.modes.fuel, rate = refineRate(research) * H.crew(s);
        const raw = (rate * (now - from)) / HOUR + (s.carry || 0);
        let runs = Math.floor(raw / m.oil);
        const can = Math.floor((f.inventory.oil || 0) / m.oil);
        if (runs > can) { runs = can; s.carry = 0; s.noFuel = true; } else { s.carry = raw - runs * m.oil; s.noFuel = false; }
        if (runs) {
          const o = H.out(s);
          f.inventory.oil -= runs * m.oil;
          add("plastic", Math.floor(runs * m.plastic * o));
          spread(H, "gasoline", Math.floor(runs * m.gasoline * o), from, from + ((runs * m.oil) / rate) * HOUR);
          s.made = (s.made || 0) + runs * m.oil;
        }
        s.lastAt = now;
      } else if (s.kind === "furnace") {
        for (let i = 0; i < 100 && s.batch && now >= s.batch.endsAt; i++) {
          const b = s.batch, F = FURNACES[s.type];
          add(F.out, Math.floor(b.n * H.out(s)));
          s.made = (s.made || 0) + b.n;
          s.last = { n: b.n, at: b.endsAt };
          s.batch = null;
          if (s.auto) {
            const r = startBatch(s, f, b.endsAt, treasury, { ...H, research });
            if (r.ok) treasury = r.treasury; else s.stall = r.why;
          }
        }
        s.lastAt = now;
      } else if (SV() && Services.handles(s.kind)) {
        treasury = Services.settle(s, f, now, treasury, { ...H, research });
      }
    }
    return treasury;
  }
  // What a company's sites sell to everyday buyers right now (so its save reads that shared demand)
  const sells = (f) => [...new Set((f.sites || []).filter((s) => s.on && !s.paused && (s.kind === "plant" || s.kind === "refinery"))
    .map((s) => (s.kind === "plant" ? "power" : "gasoline")))];
  const sellsFor = (ind) => (ind === "Energy" ? ["power", "gasoline"] : []);
  // Energy companies this company's arc furnaces buy from (read in its saves)
  const powerSuppliers = (f) => [...new Set((f.sites || []).filter((s) => ((s.kind === "furnace" && s.type === "arc") || s.kind === "dc") && s.powerFrom).map((s) => s.powerFrom))].slice(0, 3);
  // Sites stop where they are when upkeep can't be paid, and start again once there's money
  const pauseAll = (f) => { let n = 0; for (const s of f.sites || []) if (s.builtAt && !s.paused) { s.paused = true; n++; } return n; };
  const resumeAll = (f) => { for (const s of f.sites || []) delete s.paused; };

  /* ---------- actions ---------- */
  const fmtCash = (c) => Economy.fmtCash(c);
  const name = (k) => Factory.ITEMS[k].name;
  const many = (k) => Factory.ITEMS[k].many;
  const act = (change, fee) => Factory.actFor(undefined, change, fee ? { fee } : {});
  const pick = (lo, hi) => lo + Math.random() * (hi - lo);
  const spend = (treasury, cost, what) => {
    if (cost > treasury) throw new Error(`${what} costs ${fmtCash(cost)}; the treasury has ${fmtCash(treasury)}.`);
    return treasury - cost;
  };
  const room = (f) => { if ((f.sites || []).length >= MAX_SITES) throw new Error(`A company can have at most ${MAX_SITES} sites. Close one first.`); };
  const find = (f, id) => { const s = (f.sites || []).find((x) => x.id === id); if (!s) throw new Error("That site is gone."); return s; };
  const newId = () => `s${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

  const survey = (ore) => act((f, treasury, now, c) => {
    room(f);
    if (!(SURVEYS[c.industry] || []).includes(ore)) throw new Error(`${c.industry} companies can't mine ${name(ore).toLowerCase()}.`);
    treasury = spend(treasury, COST.survey, "A survey");
    const o = ORES[ore], better = f.research.survey1 && c.industry === "Mining" ? 1.5 : 1;
    const s = { id: newId(), kind: "mine", ore, size: Math.round(pick(...o.size) * better), rich: Math.round(pick(...o.rich) * better), method: null, mined: 0 };
    (f.sites = f.sites || []).push(s);
    return { treasury, msg: `✓ Found a ${name(ore).toLowerCase()} deposit: ${s.size.toLocaleString()} units at ${s.rich.toLocaleString()} an hour. Open it as a mine, or survey again.` };
  }, "A survey");
  const openMine = (id, method) => act((f, treasury, now) => {
    const s = find(f, id);
    if (s.method) throw new Error("That mine is already open.");
    treasury = spend(treasury, COST[method], method === "pit" ? "An open-pit mine" : "A shaft mine");
    Object.assign(s, { method, builtAt: now, mined: 0, carry: 0, lastAt: null });
    return { treasury, msg: method === "pit" ? `✓ Open-pit mine started: digging ${many(s.ore)} now.` : `✓ Shaft being dug: it starts producing in ${f.research.deep1 ? 1 : DIG_HOURS} hour${f.research.deep1 ? "" : "s"}.` };
  }, "Opening a mine");
  const build = (kind) => act((f, treasury, now) => {
    room(f);
    treasury = spend(treasury, COST[kind], kind === "field" ? "A field" : kind === "plantation" ? "A plantation" : "A cattle pen");
    const base = { id: newId(), kind, builtAt: now };
    (f.sites = f.sites || []).push(kind === "field" ? { ...base, crop: null, soil: 1, auto: false, emptySince: now }
      : kind === "pen" ? { ...base, head: 0, fedHours: 0, lastAt: now } : { ...base, carry: 0, lastAt: null });
    return { treasury, msg: kind === "plantation" ? `✓ Rubber trees planted. They start producing in ${PLANT_HOURS} hours.` : `✓ Built a ${kind === "pen" ? "cattle pen" : "field"}.` };
  }, "Building a site");
  // Energy and Steel and metals facilities
  const BUILT = {
    well: () => ({ kind: "well", r0: Math.round(pick(...WELL.r0)), carry: 0, lastAt: null }),
    refinery: () => ({ kind: "refinery", mode: "fuel", on: true, carry: 0, lastAt: null }),
    coal: () => ({ kind: "plant", type: "coal", on: true, carry: 0, fuelFrac: 0, lastAt: null }),
    gas: () => ({ kind: "plant", type: "gas", on: true, carry: 0, fuelFrac: 0, lastAt: null }),
    solar: () => ({ kind: "plant", type: "solar", on: true, carry: 0, lastAt: null }),
    blast: () => ({ kind: "furnace", type: "blast", size: FURNACES.blast.cap, auto: false, batch: null }),
    kiln: () => ({ kind: "furnace", type: "kiln", size: FURNACES.kiln.cap, auto: false, batch: null }),
    arc: () => ({ kind: "furnace", type: "arc", size: FURNACES.arc.cap, auto: false, batch: null, powerFrom: null })
  };
  const LABEL = { well: "An oil well", refinery: "A refinery", coal: "A coal power plant", gas: "A gas power plant", solar: "A solar farm",
    blast: "A blast furnace", kiln: "A glass kiln", arc: "An electric arc furnace" };
  const buildFacility = (key) => act((f, treasury, now, c) => {
    room(f);
    if (!builds(c.industry).includes(key)) throw new Error(`${c.industry} companies can't build that.`);
    treasury = spend(treasury, COST[key], LABEL[key]);
    const s = { id: newId(), builtAt: now, made: 0, ...BUILT[key]() };
    (f.sites = f.sites || []).push(s);
    const msg = key === "well" ? `✓ Struck oil: ${s.r0} barrels an hour to start with. Wells decline over time.`
      : key === "refinery" ? "✓ Refinery built. It takes crude oil from the warehouse around the clock."
      : s.kind === "plant" ? `✓ ${PLANTS[key].name} built. It sells electricity around the clock${key === "solar" ? " while the sun is up" : ` while there's ${PLANTS[key].fuel === "oil" ? "oil" : "coal"} in the warehouse`}.`
      : `✓ ${FURNACES[key].name} built. Load a batch to start.`;
    return { treasury, msg };
  }, "Building a site");
  const toggle = (id) => act((f, treasury, now) => {
    const s = find(f, id);
    s.on = !s.on; s.lastAt = now; s.carry = 0;
    return { msg: s.on ? "✓ Switched on." : "✓ Switched off: it uses no fuel and makes nothing, but upkeep is still due." };
  });
  const setMode = (id, mode) => act((f) => {
    const s = find(f, id);
    if (!REFINERY.modes[mode]) throw new Error("Pick fuel or chemicals.");
    s.mode = mode;
    return { msg: `✓ The refinery now runs in ${REFINERY.modes[mode].name.toLowerCase()} mode.` };
  });
  const refrack = (id) => act((f, treasury, now) => {
    const s = find(f, id);
    if (!f.research.frack) throw new Error("Re-fracking needs the Hydraulic fracturing research.");
    treasury = spend(treasury, COST.refrack, "Re-fracking");
    Object.assign(s, { frackedAt: now, lastAt: now, carry: 0 });
    return { treasury, msg: `✓ Re-fracked: back to ${s.r0} barrels an hour.` };
  }, "Re-fracking a well");
  const loadFurnace = (id, size, auto) => act((f, treasury, now, c, ctx) => {
    const s = find(f, id);
    if (s.batch) throw new Error("A batch is already in.");
    s.size = size; s.auto = !!auto;
    const r = startBatch(s, f, now, treasury, { research: f.research, crew: (x) => Factory.crewMult(x, f), buyPower: ctx.buyPower });
    if (!r.ok) throw new Error(`That batch ${r.why}.`);
    const F = FURNACES[s.type];
    return { treasury: r.treasury, msg: `✓ Loaded ${s.batch.n.toLocaleString()} ${many(F.out)}: ready in ${Factory.fmtDur((s.batch.endsAt - now) / 1000)}${s.batch.power ? `. Electricity: ${fmtCash(s.batch.power.cost)} from ${s.batch.power.from || "the grid"}` : ""}.` };
  }, "Loading a furnace");
  const setFurnace = (id, upd) => act((f) => {
    const s = find(f, id);
    if ("auto" in upd) s.auto = !!upd.auto;
    if ("powerFrom" in upd) s.powerFrom = upd.powerFrom || null;
    if (!s.auto) s.stall = null;
    return { msg: "powerFrom" in upd ? `✓ This furnace now buys power from ${upd.powerFrom || "the grid"}.` : s.auto ? "✓ It'll start the same batch again whenever the materials are there." : "✓ It'll stop after this batch." };
  });
  const close = (id) => act((f) => {
    const s = find(f, id);
    f.sites = f.sites.filter((x) => x !== s);
    for (const p of f.staff) if (p.line === id) p.line = null;
    return { msg: s.kind === "pen" && s.head ? `✓ Closed the pen; its ${s.head} cattle went to the warehouse.` : "✓ Site closed. It no longer costs upkeep." };
  });
  const closePen = (id) => act((f) => {
    const s = find(f, id);
    if (s.head) f.inventory.cattle = (f.inventory.cattle || 0) + s.head;
    f.sites = f.sites.filter((x) => x !== s);
    for (const p of f.staff) if (p.line === id) p.line = null;
    return { msg: s.head ? `✓ Closed the pen; its ${s.head} cattle went to the warehouse.` : "✓ Pen closed." };
  });
  const plant = (id, crop, auto) => act((f, treasury, now) => {
    const s = find(f, id);
    if (s.crop) throw new Error("Something's already growing there.");
    treasury = spend(treasury, CROPS[crop].seed, `${name(crop)} seed`);
    const crew = Factory.crewMult(s, f);
    Object.assign(s, { crop, plantedAt: now, readyAt: now + growMs(crop, f.research, crew), auto: !!auto, emptySince: null });
    return { treasury, msg: `✓ Planted ${name(crop).toLowerCase()}. Ready in ${Factory.fmtDur(growMs(crop, f.research, crew) / 1000)}.` };
  }, "Planting");
  const setAuto = (id, auto) => act((f) => { find(f, id).auto = auto; return { msg: auto ? "✓ This field will keep replanting the same crop." : "✓ This field will stop after the current harvest." }; });
  const penMove = (id, n, into) => act((f, treasury, now) => {
    const s = find(f, id);
    if (into) {
      if ((f.inventory.cattle || 0) < n) throw new Error(`The warehouse has ${(f.inventory.cattle || 0).toLocaleString()} head of cattle.`);
      if ((s.head || 0) + n > PEN_CAP) throw new Error(`A pen holds at most ${PEN_CAP} head.`);
      f.inventory.cattle -= n; s.head = (s.head || 0) + n;
      if (!s.lastAt) s.lastAt = now;
      return { msg: `✓ Moved ${n} head into the pen.` };
    }
    if ((s.head || 0) < n) throw new Error(`The pen has ${s.head || 0} head.`);
    s.head -= n; f.inventory.cattle = (f.inventory.cattle || 0) + n;
    return { msg: `✓ Moved ${n} head to the warehouse, ready to sell or ship.` };
  });

  /* ---------- rendering ---------- */
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const pct = (x) => `${Math.round(x * 100)}%`;
  let runFn = null;
  const button = (label, fn, cls = "btn-ghost") => { const b = mk("button", cls, label); b.addEventListener("click", () => runFn(fn)); return b; };

  function crewChip(s, f) {
    const crew = Factory.workersOn(f, s), out = Factory.outMult(s, f);
    const chips = [mk("span", "chip" + (crew.length ? " crew" : ""), crew.length ? `${crew.length} worker${crew.length === 1 ? "" : "s"} · ${Factory.crewMult(s, f).toFixed(2).replace(/\.?0+$/, "")}×` : "No workers")];
    if (out > 1) chips.push(mk("span", "chip glitch", `×${out} output`));
    return chips;
  }

  function mineCard(s, f, can) {
    const card = mk("div", "f-line"), head = mk("div", "f-line-head");
    const research = f.research || {};
    head.append(mk("b", null, `${name(s.ore)} ${s.method ? (s.method === "pit" ? "open-pit mine" : "shaft mine") : "deposit (surveyed)"}`));
    if (s.method) head.append(...crewChip(s, f));
    card.append(head);
    const t = Date.now();
    if (!s.method) {
      card.append(mk("div", "f-recipe-text", `${s.size.toLocaleString()} units in the ground · ${s.rich.toLocaleString()} an hour at full speed`));
      if (can) {
        const row = mk("div", "co-form");
        row.append(button(`Open-pit mine · ${fmtCash(COST.pit)} (reaches ${(Math.floor(s.size * PIT_REACH)).toLocaleString()})`, () => openMine(s.id, "pit")),
          button(`Shaft mine · ${fmtCash(COST.shaft)} (all ${s.size.toLocaleString()}, ${research.deep1 ? 1 : DIG_HOURS} h to dig)`, () => openMine(s.id, "shaft")),
          button("Forget it", () => close(s.id)));
        card.append(row);
      }
      return card;
    }
    const done = s.mined || 0, cap = reach(s);
    const digging = s.method === "shaft" && t < s.builtAt + digMs(research);
    const rate = mineRate(s, research, Factory.crewMult(s, f));
    const bar = mk("div", "progress"); const fill = mk("div"); fill.style.width = Math.min(100, (done / cap) * 100) + "%"; bar.append(fill);
    card.append(mk("div", "f-recipe-text", depleted(s)
      ? `Dug out: all ${cap.toLocaleString()} reachable units are gone. Close it to stop paying upkeep.`
      : digging ? `Digging the shaft: producing in ${Factory.fmtDur((s.builtAt + digMs(research) - t) / 1000)}`
        : `${Math.round(rate).toLocaleString()} ${many(s.ore)} an hour${research.refine1 ? " (+25% from refining)" : ""} · upkeep ${fmtCash(upkeepOf(s))}/hour`),
      bar, mk("div", "f-status", `${done.toLocaleString()} of ${cap.toLocaleString()} dug${s.method === "pit" ? ` (open pits reach 60% of the ${s.size.toLocaleString()})` : ""}${s.paused ? " · stopped: upkeep unpaid" : ""}`));
    if (can) { const row = mk("div", "co-form"); row.append(button("Close mine", () => close(s.id))); card.append(row); }
    return card;
  }

  function fieldCard(s, f, can) {
    const card = mk("div", "f-line"), head = mk("div", "f-line-head");
    head.append(mk("b", null, `Field · soil ${pct(s.soil ?? 1)}`), ...crewChip(s, f));
    card.append(head);
    const t = Date.now();
    if (s.crop) {
      const bar = mk("div", "progress"); const fill = mk("div"); fill.style.width = Math.min(100, ((t - s.plantedAt) / (s.readyAt - s.plantedAt)) * 100) + "%"; bar.append(fill);
      card.append(mk("div", "f-recipe-text", `Growing ${name(s.crop).toLowerCase()}: about ${Math.floor(CROPS[s.crop].yield * (s.soil ?? 1) * (f.research.fert ? 1.25 : 1)).toLocaleString()} ${many(s.crop)} if the weather's good`),
        bar, mk("div", "f-status", t >= s.readyAt ? "Ready: harvested at the next save" : `Harvest in ${Factory.fmtDur((s.readyAt - t) / 1000)}${s.auto ? " · keeps replanting" : ""}`));
    } else card.append(mk("div", "f-recipe-text", `Empty. Resting soil recovers 5% an hour.${s.lastCrop ? ` Last crop: ${name(s.lastCrop).toLowerCase()}, so a different crop grows better.` : ""}`));
    if (s.lastHarvest) card.append(mk("div", "f-status", `Last harvest: ${s.lastHarvest.qty.toLocaleString()} ${many(s.lastHarvest.crop)} after ${s.lastHarvest.weather}`));
    if (can) {
      const row = mk("div", "co-form");
      if (!s.crop) {
        const sel = mk("select", "f-recipe"); sel.setAttribute("aria-label", "Crop to plant"); sel.id = `sCrop-${s.id}`;
        sel.replaceChildren(...Object.keys(CROPS).map((k) => { const o = mk("option", null, `${name(k)} · ${CROPS[k].hours} h · seed ${fmtCash(CROPS[k].seed)}`); o.value = k; return o; }));
        if (s.lastCrop) { const other = Object.keys(CROPS).find((k) => k !== s.lastCrop); if (other) sel.value = other; }
        const auto = mk("label", "check-row"); const box = mk("input"); box.type = "checkbox"; box.id = `sAuto-${s.id}`; auto.append(box, mk("span", null, "Keep planting"));
        row.append(sel, auto, button("Plant", () => plant(s.id, sel.value, box.checked), "btn-primary buy"));
      } else row.append(button(s.auto ? "Stop replanting" : "Keep planting", () => setAuto(s.id, !s.auto)));
      row.append(button("Close field", () => close(s.id)));
      card.append(row);
    }
    return card;
  }

  function plantationCard(s, f, can) {
    const card = mk("div", "f-line"), head = mk("div", "f-line-head");
    head.append(mk("b", null, "Rubber plantation"), ...crewChip(s, f));
    const t = Date.now(), ready = s.builtAt + PLANT_HOURS * HOUR;
    card.append(head, mk("div", "f-recipe-text", t < ready
      ? `Trees maturing: rubber starts in ${Factory.fmtDur((ready - t) / 1000)}`
      : `${Math.round(RUBBER_RATE * Factory.crewMult(s, f)).toLocaleString()} rubber an hour · upkeep ${fmtCash(UPKEEP.plantation)}/hour${s.paused ? " · stopped: upkeep unpaid" : ""}`));
    if (can) { const row = mk("div", "co-form"); row.append(button("Close plantation", () => close(s.id))); card.append(row); }
    return card;
  }

  function penCard(s, f, can) {
    const card = mk("div", "f-line"), head = mk("div", "f-line-head");
    head.append(mk("b", null, `Cattle pen · ${(s.head || 0).toLocaleString()} of ${PEN_CAP} head`), ...crewChip(s, f));
    const wheat = f.inventory.wheat || 0, every = f.research.breed ? BREED_EVERY / 2 : BREED_EVERY;
    const fedFor = s.head ? Math.floor(wheat / s.head) : 0;
    card.append(head, mk("div", "f-recipe-text", !s.head ? "Empty. Move cattle in from the warehouse (buy them from suppliers or other companies)."
      : s.head < 2 ? "One head can't breed. Add more."
        : `Eats ${s.head.toLocaleString()} wheat an hour · ${fedFor ? `feed for ${fedFor.toLocaleString()} hour${fedFor === 1 ? "" : "s"}` : "no wheat in the warehouse: not growing"} · grows by a quarter every ${every} fed hours (next in ${every - ((s.fedHours || 0) % every)} h)`));
    if (can) {
      const row = mk("div", "co-form");
      const l = mk("label", "field"); const inp = mk("input"); inp.type = "number"; inp.min = 1; inp.step = 1; inp.value = 10; inp.id = `sPen-${s.id}`;
      l.htmlFor = inp.id; l.append(mk("span", null, "Head of cattle"), inp);
      row.append(l, button("Move in", () => penMove(s.id, Math.floor(Number(inp.value)), true)), button("Send to warehouse", () => penMove(s.id, Math.floor(Number(inp.value)), false)));
      card.append(row);
      const row2 = mk("div", "co-form"); row2.append(button("Close pen", () => closePen(s.id))); card.append(row2);
    }
    return card;
  }

  const progress = (x) => { const bar = mk("div", "progress"); const fill = mk("div"); fill.style.width = Math.max(0, Math.min(100, x * 100)) + "%"; bar.append(fill); return bar; };
  const onOff = (s) => button(s.on ? "Switch off" : "Switch on", () => toggle(s.id));
  const closeRow = (s, label) => { const row = mk("div", "co-form"); row.append(button(label, () => close(s.id))); return row; };

  function plantCard(s, f, can) {
    const card = mk("div", "f-line"), head = mk("div", "f-line-head");
    const p = PLANTS[s.type], research = f.research || {}, crew = Factory.crewMult(s, f), t = Date.now();
    head.append(mk("b", null, p.name), ...crewChip(s, f));
    card.append(head);
    let text;
    if (!s.on) text = "Switched off: making nothing.";
    else if (s.type === "solar") {
      const now = solarRate(s, t, research) * crew;
      const sunrise = sunAt(t) ? "" : ` · the sun rises in ${Factory.fmtDur(((((6 - ((t / HOUR) % 24)) + 24) % 24) * HOUR) / 1000)}`;
      text = `${Math.round(now).toLocaleString()} MWh an hour right now${sunAt(t) ? (cloudy(s, t) ? " (cloudy: half as much)" : " (clear skies)") : " (night)"}${sunrise} · up to ${Math.round(p.peak * (research.panels ? 1.5 : 1) * crew).toLocaleString()} at noon UTC`;
    } else {
      const per = fuelPer(s.type, research), rate = p.rate * crew, fuel = f.inventory[p.fuel] || 0;
      const lasts = fuel / (per * rate);
      text = `${Math.round(rate).toLocaleString()} MWh an hour · burns ${per} ${p.fuel === "oil" ? "barrel" + (per === 1 ? "" : "s") + " of oil" : "coal"} per MWh (${Math.ceil(per * rate).toLocaleString()} an hour) · ${fuel >= per
        ? `the warehouse's ${fuel.toLocaleString()} ${many(p.fuel)} lasts about ${Factory.fmtDur(lasts * 3600)}` : `out of ${many(p.fuel)}: buy some or sign a supply contract`}`;
    }
    card.append(mk("div", "f-recipe-text", text),
      mk("div", "f-status", `${(s.made || 0).toLocaleString()} MWh made · sold to everyday buyers as it's made (miners who bought from you get theirs first) · upkeep ${fmtCash(upkeepOf(s))}/hour${s.paused ? " · stopped: upkeep unpaid" : ""}`));
    if (can) { const row = mk("div", "co-form"); row.append(onOff(s), button("Close plant", () => close(s.id))); card.append(row); }
    return card;
  }

  function wellCard(s, f, can) {
    const card = mk("div", "f-line"), head = mk("div", "f-line-head"), research = f.research || {}, t = Date.now();
    head.append(mk("b", null, "Oil well"), ...crewChip(s, f));
    const rate = wellRate(s, t, research) * Factory.crewMult(s, f);
    card.append(head, mk("div", "f-recipe-text", `Pumping ${Math.round(rate).toLocaleString()} barrels an hour (started at ${s.r0}) · declines ${Math.round(wellK(research) * 100 * 10) / 10}% an hour, levelling off at ${Math.round(s.r0 * WELL.floor)}`),
      progress(rate / (s.r0 * Factory.crewMult(s, f))),
      mk("div", "f-status", `${(s.made || 0).toLocaleString()} barrels pumped · upkeep ${fmtCash(UPKEEP.well)}/hour${s.paused ? " · stopped: upkeep unpaid" : ""}`));
    if (can) {
      const row = mk("div", "co-form");
      if (research.frack) row.append(button(`Re-frack · ${fmtCash(COST.refrack)}`, () => refrack(s.id)));
      row.append(button("Cap the well", () => close(s.id)));
      card.append(row);
    }
    return card;
  }

  function refineryCard(s, f, can) {
    const card = mk("div", "f-line"), head = mk("div", "f-line-head"), research = f.research || {};
    const m = REFINERY.modes[s.mode] || REFINERY.modes.fuel, rate = refineRate(research) * Factory.crewMult(s, f), oil = f.inventory.oil || 0;
    head.append(mk("b", null, `Refinery · ${m.name.toLowerCase()} mode`), ...crewChip(s, f));
    card.append(head, mk("div", "f-recipe-text", !s.on ? "Switched off: taking no oil."
      : `Takes ${Math.round(rate).toLocaleString()} barrels of oil an hour: every ${m.oil} make ${m.gasoline} gasoline (sold as it's made) and ${m.plastic} plastic (kept) · ${oil >= m.oil ? `the warehouse's ${oil.toLocaleString()} barrels last about ${Factory.fmtDur((oil / rate) * 3600)}` : "out of crude oil: drill a well, buy some, or sign a supply contract"}`),
      mk("div", "f-status", `${(s.made || 0).toLocaleString()} barrels refined · upkeep ${fmtCash(UPKEEP.refinery)}/hour${s.paused ? " · stopped: upkeep unpaid" : ""}`));
    if (can) {
      const row = mk("div", "co-form");
      const sel = mk("select", "f-recipe"); sel.id = `sMode-${s.id}`; sel.setAttribute("aria-label", "Refinery mode");
      sel.replaceChildren(...Object.entries(REFINERY.modes).map(([k, x]) => { const o = mk("option", null, `${x.name}: ${x.gasoline} gasoline + ${x.plastic} plastic per ${x.oil} barrels`); o.value = k; return o; }));
      sel.value = s.mode;
      sel.addEventListener("change", () => runFn(() => setMode(s.id, sel.value)));
      row.append(sel, onOff(s), button("Close refinery", () => close(s.id)));
      card.append(row);
    }
    return card;
  }

  function furnaceCard(s, f, can) {
    const card = mk("div", "f-line"), head = mk("div", "f-line-head"), research = f.research || {}, t = Date.now();
    const F = FURNACES[s.type], need = furnaceInputs(s.type, research), cap = batchCap(s.type, research);
    head.append(mk("b", null, F.name), ...crewChip(s, f));
    card.append(head);
    const per = Object.entries(need).map(([k, q]) => `${q} ${Factory.ITEMS[k].many}`).join(" + ") + (s.type === "arc" ? ` + ${arcMwh(research)} MWh` : "");
    card.append(mk("div", "f-recipe-text", `Batches of up to ${cap.toLocaleString()} ${many(F.out)} in ${Factory.fmtDur(batchMs(s.type, research, Factory.crewMult(s, f)) / 1000)} · each takes ${per} · upkeep ${fmtCash(upkeepOf(s))}/hour`));
    if (s.batch) {
      card.append(progress((t - s.batch.startedAt) / (s.batch.endsAt - s.batch.startedAt)),
        mk("div", "f-status", `${s.batch.n.toLocaleString()} ${many(F.out)} ${t >= s.batch.endsAt ? "ready: they go to the warehouse at the next save" : `in ${Factory.fmtDur((s.batch.endsAt - t) / 1000)}`}${s.auto ? " · keeps going" : ""}${s.paused ? " · stopped: upkeep unpaid" : ""}`));
    } else card.append(mk("div", "f-status", s.stall ? `Stopped: the next batch ${s.stall}.` : "Empty."));
    if (s.last) card.append(mk("div", "f-status", `Last batch: ${s.last.n.toLocaleString()} ${many(F.out)} · ${(s.made || 0).toLocaleString()} made in all`));
    if (can) {
      const row = mk("div", "co-form");
      if (!s.batch) {
        const l = mk("label", "field"); const inp = mk("input"); inp.type = "number"; inp.min = 1; inp.max = cap; inp.step = 1; inp.value = Math.min(s.size || cap, cap); inp.id = `sSize-${s.id}`;
        l.htmlFor = inp.id; l.append(mk("span", null, `Batch (${many(F.out)})`), inp);
        const auto = mk("label", "check-row"); const box = mk("input"); box.type = "checkbox"; box.id = `sKeep-${s.id}`; box.checked = !!s.auto; auto.append(box, mk("span", null, "Keep going"));
        row.append(l, auto, button("Load batch", () => loadFurnace(s.id, Math.floor(Number(inp.value)), box.checked), "btn-primary buy"));
      } else row.append(button(s.auto ? "Stop after this batch" : "Keep going", () => setFurnace(s.id, { auto: !s.auto })));
      if (s.type === "arc") {
        const sel = mk("select", "f-recipe"); sel.id = `sPower-${s.id}`; sel.setAttribute("aria-label", "Buy electricity from");
        const sellers = (Factory.companies() || []).filter((c) => c.industry === "Energy" && c.tariff > 0);
        sel.replaceChildren(Object.assign(mk("option", null, `Grid · ${fmtCash(800)}/MWh`), { value: "" }),
          ...sellers.map((c) => Object.assign(mk("option", null, `${c.ticker} · ${fmtCash(c.tariff)}/MWh`), { value: c.ticker })));
        sel.value = s.powerFrom && sellers.some((c) => c.ticker === s.powerFrom) ? s.powerFrom : "";
        sel.addEventListener("change", () => runFn(() => setFurnace(s.id, { powerFrom: sel.value })));
        row.append(sel);
      }
      row.append(button("Close furnace", () => close(s.id)));
      card.append(row);
    }
    return card;
  }

  // The sites list and the build buttons (Factory tab, in place of production lines)
  function render(box, f, can, c, run) {
    runFn = run;
    // Keep what the player has picked or typed: this redraws every time the factory updates
    const kept = new Map([...box.querySelectorAll("select[id], input[id]")].map((e) => [e.id, e.type === "checkbox" ? e.checked : e.value]));
    const sites = f.sites || [];
    const CARDS = { mine: mineCard, field: fieldCard, plantation: plantationCard, pen: penCard, plant: plantCard, well: wellCard, refinery: refineryCard, furnace: furnaceCard };
    const cards = sites.map((s) => (SV() && Services.handles(s.kind) ? Services.card(s, f, can, c, run, crewChip) : (CARDS[s.kind] || penCard)(s, f, can)));
    if (!cards.length) cards.push(mk("div", "empty", !can ? "This company hasn't built anything yet."
      : c.industry === "Mining" ? "No mines yet. Survey for a deposit to start."
      : c.industry === "Farming" ? "No fields yet. Build a field, a rubber plantation or a cattle pen."
      : c.industry === "Energy" ? "Nothing built yet. Drill an oil well, build a refinery, or build a power plant."
      : SV() && Services.INDUSTRIES.includes(c.industry) ? Services.empty(c.industry)
      : "Nothing built yet. Build a blast furnace, a glass kiln or an arc furnace, or survey for ore."));
    if (can && sites.length < MAX_SITES) {
      const row = mk("div", "co-form s-build");
      if (SV() && Services.INDUSTRIES.includes(c.industry)) {
        box.replaceChildren(...cards, Services.buildRow(c, run));
        restore(box, kept);
        return;
      }
      if (c.industry === "Mining") {
        const sel = mk("select", "f-recipe"); sel.id = "sOre"; sel.setAttribute("aria-label", "Ore to survey for");
        sel.replaceChildren(...Object.keys(ORES).map((k) => { const o = mk("option", null, name(k)); o.value = k; return o; }));
        row.append(sel, button(`Survey for a deposit · ${fmtCash(COST.survey)}`, () => survey(sel.value), "btn-primary buy"));
      } else if (c.industry === "Energy" || c.industry === "Steel and metals") {
        const keys = builds(c.industry).filter((k) => k !== "survey");
        const sel = mk("select", "f-recipe"); sel.id = "sBuild"; sel.setAttribute("aria-label", "What to build");
        sel.replaceChildren(...keys.map((k) => { const o = mk("option", null, `${LABEL[k].replace(/^An? /, "").replace(/^./, (x) => x.toUpperCase())} · ${fmtCash(COST[k])} (${fmtCash(UPKEEP[k])}/hour)`); o.value = k; return o; }));
        row.append(sel, button("Build", () => buildFacility(sel.value), "btn-primary buy"));
        const ores = SURVEYS[c.industry];
        const s2 = mk("select", "f-recipe"); s2.id = "sOre"; s2.setAttribute("aria-label", "Ore to survey for");
        s2.replaceChildren(...ores.map((k) => { const o = mk("option", null, name(k)); o.value = k; return o; }));
        row.append(...(ores.length > 1 ? [s2] : []), button(`Survey for ${ores.length > 1 ? "ore" : name(ores[0]).toLowerCase()} · ${fmtCash(COST.survey)}`, () => survey(ores.length > 1 ? s2.value : ores[0])));
      } else {
        row.append(button(`Build a field · ${fmtCash(COST.field)}`, () => build("field"), "btn-primary buy"),
          button(`Rubber plantation · ${fmtCash(COST.plantation)}`, () => build("plantation")),
          button(`Cattle pen · ${fmtCash(COST.pen)}`, () => build("pen")));
      }
      cards.push(row);
    }
    box.replaceChildren(...cards);
    restore(box, kept);
  }
  // Put back what the player had picked or typed before the redraw
  function restore(box, kept) {
    for (const [id, v] of kept) {
      const e = document.getElementById(id);
      if (!e) continue;
      if (e.type === "checkbox") e.checked = v;
      else if (e.tagName !== "SELECT" || [...e.options].some((o) => o.value === v)) e.value = v;
    }
  }

  // What the company can do, for the "What this company can make" card
  function guide(industry) {
    const p = (t) => mk("p", "co-note", t);
    if (SV() && Services.INDUSTRIES.includes(industry)) return Services.guide(industry);
    if (industry === "Energy") return [
      p(`Oil well (${fmtCash(COST.well)}, ${fmtCash(UPKEEP.well)}/hour): pumps ${WELL.r0[0]}–${WELL.r0[1]} barrels of crude an hour to start, declining ${WELL.decline * 100}% an hour until it levels off at ${WELL.floor * 100}% of that.`),
      p(`Refinery (${fmtCash(COST.refinery)}, ${fmtCash(UPKEEP.refinery)}/hour): takes ${REFINERY.rate} barrels an hour. Fuel mode: every 4 barrels make 2 gasoline and 1 plastic. Chemicals mode: 1 gasoline and 4 plastic. Gasoline sells to everyday buyers as it's made; plastic goes to the warehouse.`),
      p(`Power plants sell electricity around the clock, to miners who bought from you first (set a tariff on the Stocks tab), then to everyday buyers. Coal plant (${fmtCash(COST.coal)}, ${fmtCash(UPKEEP.coal)}/hour): ${PLANTS.coal.rate} MWh an hour, burning 2 coal per MWh. Gas plant (${fmtCash(COST.gas)}, ${fmtCash(UPKEEP.gas)}/hour): ${PLANTS.gas.rate} MWh an hour, 1 barrel of oil per MWh. Solar farm (${fmtCash(COST.solar)}, ${fmtCash(UPKEEP.solar)}/hour): no fuel, up to ${PLANTS.solar.peak} MWh an hour at noon UTC, nothing at night, half on cloudy hours.`),
      p(`You can also survey for coal (${fmtCash(COST.survey)}) and mine it yourself. Switch plants and refineries off when prices are too low to cover their fuel.`)];
    if (industry === "Steel and metals") return [
      p(`Furnaces work in batches: load one, the materials are taken at once, and the whole batch comes out together. Tick "Keep going" to start the same batch again whenever the materials are in the warehouse.`),
      p(`Blast furnace (${fmtCash(COST.blast)}, ${fmtCash(UPKEEP.blast)}/hour): up to ${FURNACES.blast.cap} steel an hour, each from 2 iron ore and 1 coal. Glass kiln (${fmtCash(COST.kiln)}, ${fmtCash(UPKEEP.kiln)}/hour): up to ${FURNACES.kiln.cap} glass every ${FURNACES.kiln.mins} minutes, each from 2 sand and 1 coal. Electric arc furnace (${fmtCash(COST.arc)}, ${fmtCash(UPKEEP.arc)}/hour): up to ${FURNACES.arc.cap} steel every ${FURNACES.arc.mins} minutes, each from 1 iron ore and 0.5 MWh of electricity, bought from the grid ($8/MWh) or an Energy company.`),
      p(`You can survey for iron ore, coal and sand (${fmtCash(COST.survey)}) and mine your own. Research makes batches faster, bigger and leaner.`)];
    if (industry === "Mining") return [
      p(`Survey (${fmtCash(COST.survey)}) for a deposit of iron ore, coal, copper or sand. Each has a size and a richness; survey again for a better one.`),
      p(`Open-pit mine (${fmtCash(COST.pit)}, ${fmtCash(UPKEEP.pit)}/hour): starts digging at once, reaches 60% of the deposit. Shaft mine (${fmtCash(COST.shaft)}, ${fmtCash(UPKEEP.shaft)}/hour): ${DIG_HOURS} hours to dig, reaches all of it at 80% speed.`),
      p("Mines dig around the clock until they run out. Workers speed them up; mining research makes them dig faster, find richer ore and refine more out of it.")];
    return [
      p(`Fields (${fmtCash(COST.field)}, ${fmtCash(UPKEEP.field)}/hour): ${Object.entries(CROPS).map(([k, c]) => `${name(k).toLowerCase()} grows in ${c.hours} h and yields about ${c.yield}`).join("; ")}. The harvest depends on the soil and the weather; the same crop twice wears the soil out.`),
      p(`Rubber plantation (${fmtCash(COST.plantation)}, ${fmtCash(UPKEEP.plantation)}/hour): ${PLANT_HOURS} hours to mature, then ${RUBBER_RATE} rubber an hour.`),
      p(`Cattle pen (${fmtCash(COST.pen)}, ${fmtCash(UPKEEP.pen)}/hour): up to ${PEN_CAP} head. They eat 1 wheat each per hour and the herd grows by a quarter every ${BREED_EVERY} fed hours.`)];
  }

  const title = (ind) => (SV() && Services.INDUSTRIES.includes(ind) ? Services.title(ind) : null) || ({ Mining: "Mines", Farming: "Fields, plantations and pens", Energy: "Power plants, wells and refineries", "Steel and metals": "Furnaces and mines" })[ind] || "Sites";
  const blurb = (ind) => (SV() && Services.INDUSTRIES.includes(ind) ? Services.blurb(ind) : null) || ({
    Mining: "It surveys deposits and runs mines that dig around the clock.",
    Farming: "It grows crops in fields, taps rubber on plantations and raises cattle in pens.",
    Energy: "It drills oil wells, refines crude into gasoline and plastic, and runs power plants that sell electricity around the clock.",
    "Steel and metals": "It smelts steel and glass in batch furnaces, and can mine its own iron ore, coal and sand."
  })[ind] || "";

  return { INDUSTRIES, RESEARCH, isSiteIndustry, settle, upkeepOf, pauseAll, resumeAll, render, guide, builds, close, sells, sellsFor, powerSuppliers, title, blurb,
    CROPS, ORES, COST, UPKEEP, PLANTS, WELL, REFINERY, FURNACES, SURVEYS, MAX_SITES, sunAt };
})();
