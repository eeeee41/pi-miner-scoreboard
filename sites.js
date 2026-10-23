/* =====================================================================
   Pi Miner — facility revamp, part 1: mines and farms
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

   Workers assigned to a site speed it up just like on a line (and a
   MissingNo. multiplies what it turns out). Sites pay hourly upkeep with
   the lines, and stop if the treasury can't pay it.
   ===================================================================== */
const Sites = (() => {
  const HOUR = 3600000;
  const INDUSTRIES = ["Mining", "Farming"];
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
  const COST = { survey: 50000, pit: 80000, shaft: 250000, field: 100000, plantation: 200000, pen: 150000 };
  const UPKEEP = { pit: 4000, shaft: 6000, depleted: 1000, field: 1500, plantation: 2500, pen: 2000 };   // cents an hour
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
    breed:      { name: "Selective breeding",  cost: 600000, hours: 2,   needs: null,      ind: ["Farming"], does: "Cattle herds grow every 3 fed hours instead of 6" }
  };
  const isSiteIndustry = (ind) => INDUSTRIES.includes(ind);
  const builds = (ind) => (ind === "Mining" ? ["survey"] : ind === "Farming" ? ["field", "plantation", "pen"] : []);

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
    if (s.kind === "mine") return depleted(s) ? UPKEEP.depleted : UPKEEP[s.method];
    return UPKEEP[s.kind] || 0;
  }

  /* ---------- catching up (called from every factory save) ----------
     H = { research, crew(site), out(site) } from the factory. Adds output to the warehouse and to
     `made` (so supply contracts get it), pays for seed when replanting; returns the treasury after. */
  function settle(f, now, made, treasury, H) {
    const research = H.research || {};
    const add = (k, n) => { if (n > 0) { f.inventory[k] = (f.inventory[k] || 0) + n; made[k] = (made[k] || 0) + n; } };
    for (const s of f.sites || []) {
      if (s.paused) { s.lastAt = now; continue; }           // stopped for unpaid upkeep: nothing piles up meanwhile
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
      }
    }
    return treasury;
  }
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

  const survey = (ore) => act((f, treasury) => {
    room(f);
    treasury = spend(treasury, COST.survey, "A survey");
    const o = ORES[ore], better = f.research.survey1 ? 1.5 : 1;
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

  // The sites list and the build buttons (Factory tab, in place of production lines)
  function render(box, f, can, c, run) {
    runFn = run;
    const sites = f.sites || [];
    const cards = sites.map((s) => s.kind === "mine" ? mineCard(s, f, can) : s.kind === "field" ? fieldCard(s, f, can)
      : s.kind === "plantation" ? plantationCard(s, f, can) : penCard(s, f, can));
    if (!cards.length) cards.push(mk("div", "empty", c.industry === "Mining"
      ? (can ? "No mines yet. Survey for a deposit to start." : "This company hasn't opened any mines.")
      : (can ? "No fields yet. Build a field, a rubber plantation or a cattle pen." : "This company hasn't built anything yet.")));
    if (can && sites.length < MAX_SITES) {
      const row = mk("div", "co-form s-build");
      if (c.industry === "Mining") {
        const sel = mk("select", "f-recipe"); sel.id = "sOre"; sel.setAttribute("aria-label", "Ore to survey for");
        sel.replaceChildren(...Object.keys(ORES).map((k) => { const o = mk("option", null, name(k)); o.value = k; return o; }));
        row.append(sel, button(`Survey for a deposit · ${fmtCash(COST.survey)}`, () => survey(sel.value), "btn-primary buy"));
      } else {
        row.append(button(`Build a field · ${fmtCash(COST.field)}`, () => build("field"), "btn-primary buy"),
          button(`Rubber plantation · ${fmtCash(COST.plantation)}`, () => build("plantation")),
          button(`Cattle pen · ${fmtCash(COST.pen)}`, () => build("pen")));
      }
      cards.push(row);
    }
    box.replaceChildren(...cards);
  }

  // What the company can do, for the "What this company can make" card
  function guide(industry) {
    const p = (t) => mk("p", "co-note", t);
    if (industry === "Mining") return [
      p(`Survey (${fmtCash(COST.survey)}) for a deposit of iron ore, coal, copper or sand. Each has a size and a richness; survey again for a better one.`),
      p(`Open-pit mine (${fmtCash(COST.pit)}, ${fmtCash(UPKEEP.pit)}/hour): starts digging at once, reaches 60% of the deposit. Shaft mine (${fmtCash(COST.shaft)}, ${fmtCash(UPKEEP.shaft)}/hour): ${DIG_HOURS} hours to dig, reaches all of it at 80% speed.`),
      p("Mines dig around the clock until they run out. Workers speed them up; mining research makes them dig faster, find richer ore and refine more out of it.")];
    return [
      p(`Fields (${fmtCash(COST.field)}, ${fmtCash(UPKEEP.field)}/hour): ${Object.entries(CROPS).map(([k, c]) => `${name(k).toLowerCase()} grows in ${c.hours} h and yields about ${c.yield}`).join("; ")}. The harvest depends on the soil and the weather; the same crop twice wears the soil out.`),
      p(`Rubber plantation (${fmtCash(COST.plantation)}, ${fmtCash(UPKEEP.plantation)}/hour): ${PLANT_HOURS} hours to mature, then ${RUBBER_RATE} rubber an hour.`),
      p(`Cattle pen (${fmtCash(COST.pen)}, ${fmtCash(UPKEEP.pen)}/hour): up to ${PEN_CAP} head. They eat 1 wheat each per hour and the herd grows by a quarter every ${BREED_EVERY} fed hours.`)];
  }

  return { INDUSTRIES, RESEARCH, isSiteIndustry, settle, upkeepOf, pauseAll, resumeAll, render, guide, builds, CROPS, ORES, COST, MAX_SITES };
})();
