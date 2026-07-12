/* ============================================================
   DERIVE — turns authored recipe data into everything the app needs.
   Ported from the Python build so the browser can do it at load time.
   Edit data/dishes.json and data/ingredients.json; this recomputes.
   ============================================================ */
const UNIT_SYN={tablespoon:"tbsp",tablespoons:"tbsp",tbsp:"tbsp",tbs:"tbsp",teaspoon:"tsp",teaspoons:"tsp",tsp:"tsp",cup:"cup",cups:"cup",gram:"g",grams:"g",g:"g",kilogram:"kg",kg:"kg",pound:"lb",pounds:"lb",lb:"lb",lbs:"lb",ounce:"oz",ounces:"oz",oz:"oz",can:"can",cans:"can",clove:"clove",cloves:"clove",slice:"slice",slices:"slice",bunch:"bunch",bunches:"bunch",stalk:"stalk",stalks:"stalk",block:"block",blocks:"block",cob:"cob",cobs:"cob",ml:"ml",l:"l",liter:"l",litre:"l",piece:"piece",pieces:"piece",pinch:"pinch",head:"head",heads:"head"};

function esc(s){return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
function wb(alias,text){return new RegExp("\\b"+esc(alias)+"\\b").test(text);}
function frac(f){const [a,b]=f.split("/").map(Number);return a/b;}

function parseQty(raw){
  const s=raw.trim().toLowerCase();
  const pats=[
    [/^(\d+)\s+(\d+\/\d+)\s+(.*)$/, m=>[Number(m[1])+frac(m[2]), m[3]]],
    [/^(\d+\/\d+)\s+(.*)$/,          m=>[frac(m[1]), m[2]]],
    [/^(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s+(.*)$/, m=>[Number(m[2]), m[3]]],
    [/^(\d+(?:\.\d+)?)\s+(.*)$/,     m=>[Number(m[1]), m[2]]],
  ];
  for(const [re,conv] of pats){
    const m=s.match(re);
    if(m){const [qty,rest]=conv(m);const parts=rest.split(/\s+/);
      const unit=parts.length?(UNIT_SYN[parts[0].replace(/[.,]+$/,"")]||""):"";
      return {qty:Math.round(qty*1000)/1000, unit};}
  }
  return {qty:null,unit:""};
}

/* ingredient matching: longest alias that appears on a word boundary */
function makeMatcher(ingredients){
  const pairs=[];
  ingredients.forEach(ing=>(ing.aliases||[]).forEach(a=>pairs.push([a.toLowerCase(),ing.id])));
  pairs.sort((x,y)=>y[0].length-x[0].length);   // longest first
  return raw=>{const low=raw.toLowerCase();
    for(const [a,id] of pairs){if(wb(a,low))return id;}
    return null;};
}

/* recipe line may state its own cut: "3 cloves garlic, minced" -> "mince" */
const CUT_NORM={sliced:"slice",chopped:"chop",minced:"mince",diced:"dice",cubed:"cube",grated:"grate",shredded:"shred",julienned:"julienne",trimmed:"trim",crushed:"crush",halved:"halve",quartered:"quarter",chunked:"cut into chunks",deveined:"devein",sifted:"sift"};
function statedCut(raw){
  const low=raw.toLowerCase();
  const m=low.match(/cut into [a-z ]+/);
  if(m)return m[0].trim();
  for(const k of Object.keys(CUT_NORM)){if(low.includes(k))return CUT_NORM[k];}
  return null;
}

function buildReference(ingData){
  const list=ingData.ingredients;
  const byId={}, GROC_CAT={}, PREP_VERB={}, hasChild=new Set();
  list.forEach(i=>{byId[i.id]=i;GROC_CAT[i.name]=i.aisle;PREP_VERB[i.name]=i.prep_verb;if(i.parent)hasChild.add(i.parent);});
  const anc={};
  list.forEach(i=>{const s=new Set();let p=i.parent;while(p){s.add(p);p=byId[p]?byId[p].parent:null;}anc[i.id]=s;});
  return {list,byId,anc,GROC_CAT,PREP_VERB,isLeaf:id=>!hasChild.has(id),
          match:makeMatcher(list),taste:ingData.taste_rules};
}

/* ---- the derived layers ---- */
function groceryItems(ings,R,misses){
  const out=[];
  ings.forEach(raw=>{const id=R.match(raw);
    if(!id){if(misses)misses.push(raw);return;}
    const q=parseQty(raw);
    let name=R.byId[id].name;
    // "mince" is a FORM, not a node: derive the shopping name for minced meat
    const ing=R.byId[id];
    if(ing.category==="proteins" && /\b(minced|ground)\b/.test(raw.toLowerCase()) && !/^minced/i.test(name)){
      name="Minced "+name.toLowerCase();
    }
    out.push({name,id,qty:q.qty,unit:q.unit});});
  return out;
}
function bucket(x){return x<=0?0:(x<1.5?1:(x<2.5?2:3));}
function tasteOf(items,R){
  const T=R.taste, S={sweet:0,sour:0,salty:0,umami:0,fat:0,heat:0};
  items.forEach(it=>{const ing=R.byId[it.id];if(!ing)return;const pv=new Set(ing.provides||[]);
    if(/^minced /i.test(it.name))pv.add("fat_solid");   // minced meat carries fat (from the trim it's made of)
    for(const axis in T.from_flags){if(T.from_flags[axis].some(f=>pv.has(f)))S[axis]+=1;}
    if(pv.has("protein"))S.umami+=T.umami_from_protein;
    if(T.umami_ingredients.includes(it.id))S.umami+=1;
    S.heat+=(T.heat_weights[it.id]||0);});
  const o={};for(const k in S)o[k]=bucket(S[k]);return o;
}
function proteinTagOf(items,R){
  const SKIP=new Set(["dried_shrimp"]);
  const prots=[];let egg=null;
  items.forEach(it=>{const ing=R.byId[it.id];if(!ing||SKIP.has(it.id))return;
    if(ing.category!=="proteins")return;
    const nm=it.name.toLowerCase();   // uses the (possibly "minced ...") display name
    if(it.id==="egg")egg=nm; else if(!prots.includes(nm))prots.push(nm);});
  return prots.length?prots.slice(0,2).join(" & "):(egg||"");
}
function prepOverridesOf(ings,R){
  const ov={};
  ings.forEach(raw=>{const id=R.match(raw);if(!id)return;
    const c=statedCut(raw);if(c)ov[R.byId[id].name]=c;});
  return ov;
}
function cookStyleOf(d,R){
  if(d.cuts){const opt=d.cuts.options[d.cuts.default];const mp=dishBehaviour(opt.ingredients,R);
    if(mp)return mp.behaviour==="braise"?"slow":"quick";
    return opt.cut_role==="braise"?"slow":"quick";}
  if(d.role!=="meat"&&d.role!=="fish")return undefined;
  const mp=dishBehaviour(d.ingredients,R);           // two-axis first
  if(mp)return mp.behaviour==="braise"?"slow":"quick";
  return (d.time&&d.time.hands_off_min>=30)?"slow":"quick";   // fallback: walk-away time
}

/* the first meat line in an ingredient list, resolved through the two axes */
function dishBehaviour(ings,R){
  for(const raw of (ings||[])){ const p=meatProfile(raw,R); if(p) return p; }
  return null;
}
/* hydrate a dish (and its cut/swap variants) with everything derived */
function hydrateVariant(v,R,misses){
  const gi=groceryItems(v.ingredients||[],R,misses);
  v.grocery_items=gi;
  v.grocery=gi.map(x=>x.name);
  v.taste=tasteOf(gi,R);
  v.protein_tag=proteinTagOf(gi,R);
  v.prep_overrides=prepOverridesOf(v.ingredients||[],R);
  const mp=dishBehaviour(v.ingredients,R);
  if(mp){ v.cut_role=mp.behaviour; v.cook_style=(mp.behaviour==="braise"?"slow":"quick"); v._muscle=mp.muscle; v._form=mp.form; v.forgiveness=mp.forgiveness;
         if(!v.note) v.note=cutReason(mp.behaviour,mp.forgiveness); }
  else if(v.cut_role){ v.cook_style=v.cut_role==="braise"?"slow":"quick"; }
  return v;
}
/* the time engine, applied to a dish: one analysis per appliance it can cook on */
function timeDish(d,R,M,noMethod){
  const appliances=d.appliances||[d.appliance];
  d.appliance_options=appliances.map(ap=>{
    const native=!!(d.steps_variants&&d.steps_variants[ap]);
    const st=native?d.steps_variants[ap]:d.steps;
    const a=analyzeRecipe(d.ingredients,st,ap,R,M,native);
    if(noMethod&&!a.methodsUsed.length&&ap!=="none")noMethod.push(d.name+" ("+ap+")");
    return {appliance:ap,time:d.time||a.time,_a:a};
  });
  const native=d.appliance_options.find(o=>o.appliance===d.appliance)||d.appliance_options[0];
  if(!d.time)d.time=native.time;
  if(!d.results)d.results=chipsFor(native._a.reactions,M);
  d.appliance_options.forEach(o=>{delete o._a;});
  return d;
}
function timeVariant(v,d,R,M){
  const a=analyzeRecipe(v.ingredients,v.steps,d.appliance,R,M);
  if(!v.time)v.time=a.time;
  if(!v.results)v.results=chipsFor(a.reactions,M);
  return v;
}
function hydrate(dishes,R,M){
  const unknown=[], noMethod=[], archNone=[], archLow=[];
  dishes.forEach(d=>{
    const misses=[];
    hydrateVariant(d,R,misses);
    if(M)timeDish(d,R,M,noMethod);
    const cs=cookStyleOf(d,R); if(cs)d.cook_style=cs;
    const _mp=dishBehaviour(d.ingredients,R); if(_mp)d.forgiveness=_mp.forgiveness;
    if(d.role==="meat"||d.role==="fish"){
      const c=classifyArchetype(d,R);
      d.build=c.archetype; d._buildConfidence=c.confidence;
      if(c.confidence==="none") archNone.push(d.name);
      else if(c.confidence==="low") archLow.push(d.name+" ("+c.archetype+" \u2014 "+c.reason+")");
    }
    ["cuts","swaps"].forEach(f=>{
      if(d[f])Object.values(d[f].options).forEach(o=>{
        hydrateVariant(o,R,misses);
        if(M)timeVariant(o,d,R,M);
      });
    });
    if(misses.length)unknown.push({dish:d.name,lines:[...new Set(misses)]});
  });
  if(unknown.length){
    console.warn("[Dinner How?] "+unknown.length+" dish(es) name an ingredient that is not in data/ingredients.json. "+
      "Those lines are missing from the grocery list, the taste profile and the prep steps. Add an alias, or reword the line.");
    unknown.forEach(u=>console.warn("   "+u.dish+": "+u.lines.map(l=>JSON.stringify(l)).join(", ")));
  }
  if(noMethod.length){
    console.warn("[Dinner How?] "+noMethod.length+" dish/appliance pair(s) have steps in which no cooking method was recognised, "+
      "so their time is prep-only and probably wrong. Reword the step, or add an alias in data/methods.json.");
    noMethod.forEach(n=>console.warn("   "+n));
  }
  if(archNone.length){
    console.warn("[Dinner How?] "+archNone.length+" protein dish(es) could not be classified by construction, "+
      "so protein-swap advice may be wrong. Add a \"build\" field (coat | braise | simmer | poach | steam | stir_fry | fry_dry).");
    archNone.forEach(n=>console.warn("   "+n));
  }
  if(archLow.length){
    console.warn("[Dinner How?] "+archLow.length+" protein dish(es) were classified with LOW confidence \u2014 the construction is ambiguous, "+
      "so protein-swap advice is a guess. Pin it with a \"build\" field if the guess is wrong.");
    archLow.forEach(n=>console.warn("   "+n));
  }
  hydrate.unknown=unknown; hydrate.noMethod=noMethod; hydrate.archNone=archNone; hydrate.archLow=archLow;
  return dishes;
}

/* ============================================================
   TIME ENGINE — ported from the Python build, line for line.
   Reads a recipe's steps, works out what cooking happens,
   which reactions fire, and how long it all takes.
   ============================================================ */

/* Python's round() is round-half-to-even. Math.round() is not. */
function pyRound(x){
  const f=Math.floor(x), d=x-f;
  if(d>0.5)return f+1;
  if(d<0.5)return f;
  return (f%2===0)?f:f+1;
}

const WORDNUM={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,fifteen:15,twenty:20,thirty:30,half:0.5,a:1,an:1};
function explicitMinutes(text){
  const low=text.toLowerCase();
  let m=low.match(/(\d+)\s*(hours?|hrs?|minutes?|mins?)/);
  if(m)return /^(hour|hr)/.test(m[2])?parseInt(m[1],10)*60:parseInt(m[1],10);
  m=low.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|half|a|an)\s+(?:more\s+|other\s+)?(hours?|hrs?|minutes?|mins?)/);
  if(!m)return null;
  const v=WORDNUM[m[1]];
  if(v===undefined)return null;
  return /^(hour|hr)/.test(m[2])?Math.trunc(v*60):Math.max(1,pyRound(v));
}

const NEG=["not ","don't","avoid","without"];
/* "Preheat the oven to 350 F" heats the box, it does not cook the dish. */
const PREHEAT=/\bpreheat\s+(?:the\s+)?(?:oven|air[- ]?fryer|grill|broiler)(?:\s+to\s+\d+\s*\u00b0?\s*[cf]\b)?/gi;
function detectMethods(text,M){
  const low=text.toLowerCase().replace(PREHEAT," "), hits=[];
  for(const mid in M.methods){
    for(const a of M.methods[mid].aliases){
      if(wb(a,low)){
        const idx=low.indexOf(a);
        const before=low.slice(Math.max(0,idx-12),idx);
        if(!NEG.some(nw=>before.includes(nw)))hits.push(mid);
        break;
      }
    }
  }
  /* 'brown' as a verb, only if nothing else fired: "nicely browned" describes a bake's result. */
  if(!hits.length&&/\bbrown(ed)?\b/.test(low)&&!/golden brown|brown sugar|brown rice|brown bread/.test(low))hits.push("sear_pan_fry");
  return [...new Set(hits)];
}

/* which reactions fire: pure declaration, read off the reaction's own conditions */
const DRY=new Set(["dry_air","dry_fat","radiant"]);
function gate(mids,props,M){
  const p=new Set(props);
  if(mids.some(m=>M.methods[m].heat_mode==="moist"||M.methods[m].heat_mode==="combination"))p.add("water");
  const fired=new Set();
  mids.forEach(mid=>{
    const m=M.methods[mid], dry=DRY.has(m.heat_mode);
    (m.candidate_reactions||[]).forEach(rid=>{
      const r=M.reactions[rid]; if(!r)return;
      if((r.requires_all||[]).some(f=>!p.has(f)))return;
      if(r.requires_any&&r.requires_any.length&&!r.requires_any.some(f=>p.has(f)))return;
      if(r.needs_dry_surface&&!dry)return;
      if(r.heat_modes&&r.heat_modes.length&&!r.heat_modes.includes(m.heat_mode))return;
      fired.add(rid);
    });
  });
  return [...fired].sort();
}

/* which of the recipe's ingredients this step is talking about,
   including generic references ("add the meat" -> the declared pork) */
function activeInStep(text,declared,R){
  const low=text.toLowerCase(), active=new Set();
  declared.forEach(nid=>{
    const al=(R.byId[nid]||{}).aliases||[];
    if(al.some(a=>wb(a,low)))active.add(nid);
  });
  R.list.forEach(ing=>{
    if(R.isLeaf(ing.id))return;
    if((ing.aliases||[]).some(a=>wb(a,low)))
      declared.forEach(d=>{if(R.anc[d]&&R.anc[d].has(ing.id))active.add(d);});
  });
  return active;
}

const RESET=["meanwhile","separate","drain","remove","set aside","serve","garnish","transfer"];
const VAGUE=["cook","heat"];
const BRIEF=["until bubbly","until thick","until set","until coat","until combin","until glossy","until hot","until warmed","until fragrant","to coat","until wilted","until just","until the sauce","heat through","warm through","warmed through"];
const LIQ_OFF=["drain","remove from","off the heat","transfer to","bake"];
/* "Heat the oil" cooks. "Remove from the heat" does not. */
const HEAT_NOUN=/\b(the|off|low|medium|high|gentle|residual)\s+$/;
function heatIsVerb(low){
  const re=/\bheat\b/g; let m;
  while((m=re.exec(low))){ if(!HEAT_NOUN.test(low.slice(Math.max(0,m.index-9),m.index))) return true; }
  return false;
}
const SET_FORGET=new Set(["slow_cooker","pressure_cooker","oven","air_fryer"]);
const RESCALE_STATED=new Set(["pressure_cooker","slow_cooker","air_fryer"]);
const PREP_COMP_CATS=new Set(["proteins","vegetables","fruits"]);

function analyzeRecipe(ingStrings,steps,appliance,R,M,nativeSteps){
  const TM=M.time_model;
  const ings=ingStrings.map(raw=>({raw,id:R.match(raw)}));
  const declared=new Set(ings.filter(i=>i.id).map(i=>i.id));
  const stepsText=steps.join(" ").replace(/([.!?])\s+/g,"$1\u0000").split("\u0000").map(s=>s.trim()).filter(Boolean);

  let nComp=0;
  ings.forEach(i=>{if(!i.id)return;
    const a=new Set(R.anc[i.id]||[]); a.add(i.id);
    for(const c of a){if(PREP_COMP_CATS.has(c)){nComp++;break;}}});

  const prep=TM.prep.base_minutes+TM.prep.minutes_per_ingredient*nComp;
  let total=prep, beThere=prep, handsOff=0, makeahead=0;
  const mult=(TM.appliance_time_multiplier[appliance]!==undefined)?TM.appliance_time_multiplier[appliance]:1.0;
  let hasLiquid=false, noCookCharged=false, active=new Set();
  const allR=new Set(), stepRecs=[];

  stepsText.forEach(text=>{
    const low=text.toLowerCase();
    let mids=detectMethods(text,M);
    let mentioned=activeInStep(text,declared,R);
    if(low.includes("all ingredients")||low.includes("everything"))mentioned=new Set(declared);
    active = RESET.some(c=>low.includes(c)) ? new Set(mentioned) : new Set([...active,...mentioned]);
    const props=new Set();
    active.forEach(a=>((R.byId[a]||{}).provides||[]).forEach(p=>props.add(p)));
    if(appliance!=="none"&&props.has("water"))hasLiquid=true;
    if(LIQ_OFF.some(c=>low.includes(c)))hasLiquid=false;
    if(!mids.length&&(wb("cook",low)||heatIsVerb(low))){
      // A step that names the fat is frying, whatever else is in the pot.
      if(/\b(oil|butter|ghee|lard|margarine)\b/.test(low)) mids=["saute"];
      else if(hasLiquid) mids=["simmer_reduce"];
      else if(props.has("fat_liquid")) mids=["saute"];
      else mids=[];
    }
    const fired=mids.length?gate(mids,props,M):[];
    fired.forEach(r=>allR.add(r));
    mids.forEach(mid=>{
      // Assembling a dish is one activity, however many sentences describe it.
      if(mid==="no_cook"){ if(noCookCharged)return; noCookCharged=true; }
      const mt=M.methods[mid].timing;
      let att=mt.attention;
      const exp=explicitMinutes(text);
      let mins=exp||mt.minutes;
      if(mid==="simmer_reduce"&&!exp&&BRIEF.some(b=>low.includes(b))){att="active";mins=2;}
      if(att==="semi_active"&&SET_FORGET.has(appliance))att="passive";
      const scale=(!exp||(RESCALE_STATED.has(appliance)&&!nativeSteps))?mult:1;
      if(att==="waiting")makeahead+=mins;
      else if(att==="active"){total+=mins;beThere+=mins;}
      else if(att==="passive"){mins*=scale;total+=mins;handsOff+=mins;}
      else {mins*=scale;const tend=pyRound(mins*0.2);total+=mins;beThere+=tend;handsOff+=mins-tend;}
    });
    stepRecs.push({text,methods:mids,reactions:fired});
  });

  const allp=new Set();
  ings.forEach(i=>{if(i.id)((R.byId[i.id]||{}).provides||[]).forEach(p=>allp.add(p));});
  let leavened=allp.has("leavening_chem")||allp.has("leavening_bio");
  stepsText.forEach(t=>{const tl=t.toLowerCase();
    if(/\b(beat|whip|whisk)\b/.test(tl)&&/\b(foam|foamy|stiff|peaks?)\b/.test(tl))leavened=true;});
  const baked=stepRecs.some(s=>s.methods.includes("roast_bake"));
  if(baked&&leavened)allR.add("leavening");
  if(baked&&stepsText.some(t=>t.toLowerCase().includes("knead"))&&ings.some(i=>i.id==="flour"))allR.add("gluten_development");

  const cap=TM.appliance_passive_cap_min[appliance];
  if(cap!==undefined&&handsOff>cap){total-=(handsOff-cap);handsOff=cap;}

  return {reactions:[...allR].sort(),
    methodsUsed:[...new Set(stepRecs.flatMap(s=>s.methods))],
    time:{ready_in_min:pyRound(total),be_there_min:pyRound(beThere),hands_off_min:pyRound(handsOff),
      make_ahead_min:pyRound(makeahead),prep_min:pyRound(prep),active_cook_min:pyRound(beThere-prep)}};
}

function chipsFor(reactionIds,M){
  return reactionIds.map(r=>M.reactions[r]).filter(r=>r&&r.chip)
    .sort((a,b)=>a.chip_order-b.chip_order).map(r=>r.chip).slice(0,M._meta.max_chips||4);
}

/* ============================================================
   THE TWO AXES OF MEAT
     HIERARCHY (muscle): which part of the animal -> collagen -> texture
     FORM (cross-cutting): how it is cut -> how fast heat gets in -> time
   Cook behaviour is DERIVED from their combination, not hand-set.
   ============================================================ */

/* FORM — read off the recipe line. Applies to any muscle of any meat. */
const FORM_RULES=[
  [/\b(minced|ground)\b/, "mince"],
  [/\b(thinly sliced|thin[- ]sliced|shabu|sukiyaki|bulgogi|hotpot|shaved)\b/, "slice"],
  [/\b(sliced|strips|shredded|julienned)\b/, "slice"],
  [/\b(cubed|diced|chunks?|cut into chunks|bite[- ]sized|stewing|braising)\b/, "chunk"],
];
function detectForm(raw){
  const low=raw.toLowerCase();
  for(const [re,f] of FORM_RULES){ if(re.test(low)) return f; }
  return "whole";
}

/* COLLAGEN — from the muscle node's flags (the hierarchy).
   A generic meat line can still imply collagen via braise-words. */
function collagenOf(id,raw,R){
  const flags=(R.byId[id]||{}).provides||[];
  if(flags.includes("collagen_rich")) return true;
  if(raw && /\b(stewing|braising|shin|shank)\b/i.test(raw)) return true;   // line-level hint
  return false;
}

/* BEHAVIOUR — the two axes combine. One universal function; the VALUES
   (which muscles are collagen-rich) are per-species, carried in the data. */
function meatBehaviour(collagen, form){
  if(form==="mince") return "mince";       // ground: fast, any muscle
  if(form==="slice") return "quick";       // thin: fast regardless of muscle (sukiyaki, galbi, bulgogi)
  return collagen ? "braise" : "quick";    // whole/chunk: collagen wants slow; lean wants a fast sear
}
/* FORGIVENESS — a second muscle property (fat) that matters most where collagen is
   absent: it separates a fatty, hard-to-dry cut (chicken thigh, pork belly) from a
   lean one that overcooks in seconds (breast, loin, sirloin). */
function forgivenessOf(id,R){
  const f=(R.byId[id]||{}).provides||[];
  if(f.includes("collagen_rich")) return "forgiving";        // braises are very forgiving
  if(f.includes("fat_solid")||f.includes("fat_liquid")) return "forgiving";
  return "delicate";
}
/* the reasoning line, derived from behaviour x forgiveness (authored notes still win) */
function cutReason(behaviour,forgiveness,mins){
  const t = mins?(" \u2014 about "+mins+" min."):".";
  if(behaviour==="braise") return "A collagen-rich cut, braised low and slow until it pulls apart"+t;
  if(behaviour==="mince")  return "Minced, so it cooks fast"+t;
  if(forgiveness==="forgiving") return "A fattier, forgiving cut \u2014 cooks fast and stays moist even if a little overdone"+t;
  return "A lean cut \u2014 cook it quick and gently, it dries out if overdone"+t;
}

/* Resolve a meat ingredient line to {muscle, meat, collagen, form, behaviour}. */
function meatProfile(raw,R){
  const id=R.match(raw); if(!id) return null;
  const ing=R.byId[id]; if(!ing) return null;
  const anc=R.anc[id]||new Set();
  const isMeat = ing.category==="proteins" && (anc.has("meat")||["beef","pork","chicken","mutton"].some(m=>anc.has(m)||id===m||ing.parent===m));
  if(!isMeat) return null;
  // walk up to the species node (child of "meat"/"proteins")
  let meat=id, p=ing.parent;
  while(p && !["meat","proteins",null].includes(p)){ meat=p; p=(R.byId[p]||{}).parent; }
  const collagen=collagenOf(id,raw,R);
  const form=detectForm(raw);
  const flags=(R.byId[id]||{}).provides||[];
  const fat=flags.includes("fat_solid")||flags.includes("fat_liquid");
  return {muscle:id, meat, collagen, fat, form,
          behaviour:meatBehaviour(collagen,form), forgiveness:forgivenessOf(id,R)};
}

/* ============================================================
   DISH ARCHETYPE — how a dish is CONSTRUCTED, which governs whether
   a protein swap is free or needs a method change.
     coat    : protein cooked alone, then tossed in a separate sauce  -> swap any protein freely
     braise  : protein cooked long in liquid (collagen-driven)        -> swap only among braise-suited; flag lean
     simmer  : protein cooked in liquid, shorter                      -> flag when behaviour differs
     poach/steam : gentle wet cooking                                 -> flag when behaviour differs
     stir_fry: protein + aromatics cooked fast together               -> quick swaps safe
     bake/fry_dry : protein cooked dry, no sauce to couple to         -> swap fry-able proteins
   Detected from the steps; an authored `build` field overrides. */
function classifyArchetype(d,R){
  if(d.build) return {archetype:d.build, confidence:"authored", reason:"set by build tag"};
  const t=(d.steps||[]).join(" ").toLowerCase();
  const coat = /\b(set aside|drain|remove from)/.test(t) && /\b(toss|coat|return the|back (in|to))/.test(t);
  const braiseKw=/\b(brais|stew)/.test(t), poach=/\bpoach/.test(t), steam=/\bsteam/.test(t),
        simmer=/\bsimmer/.test(t), stir=/stir[- ]?fry/.test(t),
        dry=/\b(bake|baked|roast|air[- ]?fry|deep[- ]?fry|fry|grill)/.test(t);
  const b=dishBehaviour(d.ingredients,R);
  const braise = braiseKw || (b&&b.behaviour==="braise");
  if(coat){
    if(stir) return {archetype:"coat", confidence:"low", reason:"reads as both coat and stir-fry \u2014 confirm which"};
    return {archetype:"coat", confidence:"high", reason:"protein cooked apart, then sauced"};
  }
  if(braise) return {archetype:"braise", confidence:"high", reason:"protein cooked long in liquid"};
  if(poach)  return {archetype:"poach",  confidence:"high", reason:"gentle wet cooking"};
  if(steam)  return {archetype:"steam",  confidence:"high", reason:"steamed"};
  if(simmer) return {archetype:"simmer", confidence:"medium", reason:"protein simmered in liquid"};
  if(stir)   return {archetype:"stir_fry", confidence:"medium", reason:"stir-fried"};
  if(dry)    return {archetype:"fry_dry", confidence:"medium", reason:"cooked dry \u2014 no sauce to couple to"};
  return {archetype:"unknown", confidence:"none", reason:"no construction signal found"};
}
function dishArchetype(d,R){ return classifyArchetype(d,R).archetype; }

/* Given a dish's archetype + its current protein behaviour, is swapping to a
   protein of `newBehaviour` free, or does it need a heads-up? (the (c) hybrid) */
function swapSafety(arch,curBehaviour,newBehaviour){
  if(arch==="coat"||arch==="fry_dry") return {safe:true,flag:null};   // protein cooked to its own doneness
  if(arch==="stir_fry")
    return newBehaviour==="braise" ? {safe:true,flag:"this cut wants a slow braise, not a quick stir-fry"} : {safe:true,flag:null};
  // coupled wet methods: braise / simmer / poach / steam
  if(newBehaviour===curBehaviour) return {safe:true,flag:null};
  if(curBehaviour==="braise"&&newBehaviour!=="braise")
    return {safe:true,flag:"cooks much faster than a braise \\u2014 shorten it to a simmer"};
  if(curBehaviour!=="braise"&&newBehaviour==="braise")
    return {safe:true,flag:"needs a long braise \\u2014 a quick simmer won't tenderise it"};
  return {safe:true,flag:"cooks differently \\u2014 adjust the time"};
}

/* ============================================================
   SUBSTITUTION + SEARCH — "what can I cook with what I have,
   and what can stand in for what's missing."
   Candidates are ranked by SHARED PROPERTIES and behaviour, not
   just a shared parent (the tree is too flat for that alone).
   ============================================================ */

/* how alike are two ingredients? higher = closer substitute. */
const SUB_FAMILY_FLAGS=["grain_rice","collagen_rich","leafy","root_veg","allium","fruit_sweet","fish_family"]; // fine-grained "same kind" tags
function subScore(aId,bId,R){
  const A=R.byId[aId], B=R.byId[bId];
  if(!A||!B||aId===bId) return -1;
  if(A.category!==B.category) return -1;                 // never cross protein/veg/starch
  const pa=new Set(A.provides||[]), pb=new Set(B.provides||[]);
  // require a SHARED PARENT or a shared fine-grained family flag — same category alone is NOT enough.
  const sameParent = A.parent && A.parent===B.parent && A.parent!==A.category;
  const sharedFamily = SUB_FAMILY_FLAGS.some(f=>pa.has(f)&&pb.has(f));
  if(!sameParent && !sharedFamily) return -1;            // e.g. carrot !-> spinach, rice !-> flour
  const shared=[...pa].filter(f=>pb.has(f)).length;
  const union=new Set([...pa,...pb]).size||1;
  let s=shared/union;
  if(sameParent) s+=1;
  if(sharedFamily) s+=1;
  const anc=R.anc[aId]||new Set(), bnc=R.anc[bId]||new Set();
  s+=([...anc].filter(x=>bnc.has(x)).length)*0.15;
  const ba=meatBehaviour(pa.has("collagen_rich"),"whole"), bb=meatBehaviour(pb.has("collagen_rich"),"whole");
  if(A.category==="proteins" && ba===bb) s+=0.5;
  // VEG/STARCH discriminators: matching starchy/holds_shape rewards; differing sweetness penalises
  const DISC=["starchy","holds_shape"];
  if(A.category==="vegetables"||A.category==="starches"){
    DISC.forEach(p=>{ if(pa.has(p)===pb.has(p)) s+=0.4; else s-=0.6; });   // texture/starch must align
    if(pa.has("sweet")!==pb.has("sweet")) s-=0.8;                          // sweet vs not = poor swap
  }
  return s;
}

/* ranked substitutes for one ingredient.
   have = Set of ingredient ids the cook has on hand (for the toggle). */
function substitutesFor(id,R,{have=null,limit=5,dish=null}={}){
  const cands=[];
  for(const other in R.byId){
    let s=subScore(id,other,R);
    if(s<=0) continue;
    let flag=null, rename=null;
    if(dish){
      const c=swapConstraint(dish,id,other,R);
      if(c.block) continue;                // property is essential -> not offered
      flag=c.flag||null; rename=c.rename||null;
    }
    cands.push({id:other, name:R.byId[other].name, score:s, flag, rename, onHand: have?have.has(other):false});
  }
  cands.sort((a,b)=> (b.onHand-a.onHand) || (b.score-a.score));   // on-hand first, then closeness
  return cands.slice(0,limit);
}

/* SEARCH: score every dish by how well the cook's ingredients cover it.
   mode "have"  -> only count an ingredient as covered if the cook has it or a substitute they have
   mode "shop"  -> count near-misses too, and report what to buy / swap */
function searchByIngredients(dishes,pantry,R,{mode="have",assumed=null,pax=null}={}){
  // pantry: { id: {qty, ...} }  — qty is grams for weigh items, pieces for count items.
  const have=new Set(Object.keys(pantry));
  const IGNORE=new Set(["water"]);
  const staples=assumed||new Set(["water","salt","pepper","white_sugar","vegetable_oil","sesame_oil","soy_sauce"]);
  const out=[];
  dishes.forEach(d=>{
    const scale = (pax && d.serves) ? (pax/d.serves) : 1;      // size the recipe to the diners
    const STAPLE_MANAGED=new Set(["salt","pepper","white_sugar","vegetable_oil","sesame_oil","soy_sauce"]);
    const comps=(d.grocery_items||[]).filter(g=>{
      if(IGNORE.has(g.id)||staples.has(g.id))return false;
      // aromatics/seasonings are assumed present, so they are NOT evidence of a match —
      // they don't count toward coverage. Unticked staples stay checkable.
      return measureTypeOf(R.byId[g.id])!=="assumed" || STAPLE_MANAGED.has(g.id);
    });
    if(!comps.length) return;
    let covered=0; const missing=[], subs=[], short=[];
    comps.forEach(g=>{
      const mt=measureTypeOf(R.byId[g.id]);
      // --- do we have it at all? (self, or an on-hand substitute) ---
      let sourceId=null;
      if(have.has(g.id)) sourceId=g.id;
      else {
        // OWNING A SPECIFIC CUT SATISFIES A GENERIC REQUIREMENT.
        // "300g chicken" is covered by chicken thigh; "beef" by beef chuck; etc.
        const kin=[...have].find(hid=>(R.anc[hid]||new Set()).has(g.id));
        if(kin){ sourceId=kin; if(kin!==g.id) subs.push({need:g.name,use:(R.byId[kin]||{}).name||kin,flag:null,rename:null}); }
        else {
          const sub=substitutesFor(g.id,R,{have,limit:3,dish:d}).find(x=>x.onHand);
          if(sub){sourceId=sub.id; subs.push({need:g.name,use:sub.name,flag:sub.flag,rename:sub.rename});}
        }
      }
      if(!sourceId){ missing.push(g); return; }
      // --- do we have ENOUGH? (only where units line up; otherwise presence is enough) ---
      const p=pantry[sourceId]||{};
      if(mt==="weigh"){
        const need=requiredGrams(g.qty,g.unit);
        if(need!=null && p.qty!=null){
          const needScaled=need*scale;
          if(p.qty >= needScaled){ covered++; }
          else { covered++; short.push({item:g.name, have:Math.round(p.qty), need:Math.round(needScaled), unit:"g"}); }
        } else covered++;                                       // can't compare units -> presence counts
      } else if(mt==="count"){
        const need=requiredCount(g.qty,g.unit);
        if(need!=null && p.qty!=null){
          const needScaled=Math.ceil(need*scale);
          if(p.qty >= needScaled){ covered++; }
          else { covered++; short.push({item:g.name, have:p.qty, need:needScaled, unit:""}); }
        } else covered++;
      } else covered++;                                         // assumed -> presence
    });
    const ratio=covered/comps.length;
    if(mode==="have"){ if(ratio<1) return; }                    // strict: must be fully covered
    const renamed=(subs.find(x=>x.rename)||{}).rename||null;
    out.push({
      dish:d.name, displayName:renamed||d.name, role:d.role, ratio, covered, total:comps.length, subs, short,
      buy: missing.map(m=>{ const best=substitutesFor(m.id,R,{have,limit:1,dish:d})[0];
        return {item:m.name, closest: best?best.name:null}; })
    });
  });

  out.sort((a,b)=> b.ratio-a.ratio || a.buy.length-b.buy.length);
  return out;
}

/* ============================================================
   MEASURE TYPE — how an ingredient is quantity-checked for pantry management.
     weigh  : bought & used by weight (proteins, leafy greens, rice)   -> grams
     count  : bought & used by the piece (eggs, onions, potatoes)      -> pieces
     assumed: aromatics, seasonings, condiments, oils                  -> presence only
   Derived from category + a small explicit list; an ingredient may carry
   its own `measure_type` to override. */
const MT_ASSUMED=new Set(["garlic","ginger","chilli","lemongrass","galangal","scallion","curry_leaves",
  "pandan","dried_orange_peel","dang_gui","dried_shrimp","belacan"]);
const MT_COUNT=new Set(["egg","onion","potato","sweet_potato","tomato","carrot","cucumber","bell_pepper",
  "eggplant","zucchini","corn","tofu","lemon","lime","apple","banana","pineapple","okra","daikon","shallot"]);
function measureTypeOf(ing){
  if(!ing) return "assumed";
  if(ing.measure_type) return ing.measure_type;                 // authored override
  const cat=ing.category, id=ing.id;
  if(MT_ASSUMED.has(id)) return "assumed";
  if(["seasonings","condiments","fats_oils","sweeteners","acids","leaveners"].includes(cat)) return "assumed";
  if(cat==="dairy") return "assumed";                           // milk/cream by volume; rarely the limiter
  if(MT_COUNT.has(id)) return "count";
  if(cat==="fruits") return "count";
  if(cat==="proteins") return "weigh";                          // egg already caught above as count
  if(cat==="starches") return "weigh";
  if(cat==="vegetables") return "weigh";                        // leafy greens etc. by weight
  return "assumed";
}

/* normalise a recipe requirement to grams (for weigh) or pieces (for count). null = can't tell. */
const _TO_G={g:1,kg:1000,gram:1,grams:1,pound:454,pounds:454,lb:454,oz:28,ounce:28,ounces:28};
function requiredGrams(qty,unit){ if(qty==null)return null; const f=_TO_G[unit]; return f?qty*f:null; }
function requiredCount(qty,unit){
  if(qty==null)return null;
  // a bare number, or a piece-y unit, counts as pieces; a weight/volume unit does not
  if(!unit||["piece","pieces","whole","clove","cloves","block","can","stalk","stalks","sheet"].includes(unit)) return qty;
  return null;
}

/* ============================================================
   SWAP CONSTRAINTS — one table for "the dish's context defines a property
   a swap must respect." Every rule that governs whether an ingredient can be
   swapped lives here, so there's a single place to reason about and extend.
   Returns {block, flag, rename}:
     block  : this swap is not allowed (the property is essential)
     flag   : allowed, but note the difference
     rename : allowed, but the dish should be renamed (title-named ingredient)
   ============================================================ */
function swapConstraint(dish, fromId, toId, R){
  const from=R.byId[fromId]||{}, to=R.byId[toId]||{};
  const fp=new Set(from.provides||[]), tp=new Set(to.provides||[]);
  const dishName=(dish.name||"").toLowerCase();
  const fromName=(from.name||"").toLowerCase();
  const toName=(to.name||"").toLowerCase();

  // RULE 1 — TITLE-NAMED INGREDIENT. If the dish is named after this ingredient,
  // it's the dish's identity. Two flavours:
  //   * mandatory word ("... soup/bean") -> BLOCK (no red bean = not red bean soup)
  //   * otherwise -> RENAME (apple muffin made with pineapple = pineapple muffin)
  if(fromName && dishName.includes(fromName)){
    const mandatory=/\b(soup|bean|beans)\b/.test(dishName);   // named + a "must-contain" word
    if(mandatory) return {block:true};
    return {rename: dish.name.replace(new RegExp(from.name,"i"), to.name)};
  }

  // RULE 2 — DESSERT PROTECTS SWEETNESS. In a dessert, a sweet ingredient can't
  // become a non-sweet one.
  if(dish.role==="dessert" && fp.has("sweet") && !tp.has("sweet")) return {block:true};

  // RULE 3 — BRAISE PROTECTS COLLAGEN. A braise's protein must stay braise-suited.
  if(dish.build==="braise" && fp.has("collagen_rich") && !tp.has("collagen_rich"))
    return {flag:"cooks faster than a braise \u2014 shorten it to a simmer"};

  // RULE 4 — SWEETNESS SHIFT (savoury). A sweet<->savoury swap is usable but noted.
  if((from.category==="vegetables"||from.category==="starches") && fp.has("sweet")!==tp.has("sweet"))
    return {flag: tp.has("sweet")?"sweeter than the original":"less sweet than the original"};

  return {};   // no constraint
}

/* ============================================================
   VARIANT GENERATOR — draft a protein variant of an existing dish.
   Derives everything derivable (name, ingredients, renamed steps,
   behaviour) and FLAGS what only a curator can verify — chiefly the
   stated cook times, which are authored for the ORIGINAL protein.
   Output is a ready-to-paste swaps option. NEVER commit unblessed.
   ============================================================ */
function _titleCaseName(s){ return s.replace(/\b\w/g,c=>c.toUpperCase()); }
function generateVariant(dish, targetId, R, allDishes){
  const tgt=R.byId[targetId];
  if(!tgt || tgt.category!=="proteins") return {ok:false, reason:"target is not a protein in the taxonomy"};
  // find the dish's protein line
  const prot=(dish.grocery_items||[]).find(g=>(R.byId[g.id]||{}).category==="proteins" && g.id!=="egg");
  if(!prot) return {ok:false, reason:"dish has no swappable protein line"};
  const rawLine=(dish.ingredients||[]).find(l=>R.match(l)===prot.id);
  if(!rawLine) return {ok:false, reason:"could not locate the protein ingredient line"};

  // constraint gate (title-mandatory, dessert-sweet, etc.)
  const con=swapConstraint(dish, prot.id, targetId, R);
  if(con.block) return {ok:false, reason:"blocked: this ingredient is essential to the dish's identity"};

  // behaviour comparison — the honest core
  const srcProf=meatProfile(rawLine,R);
  const tgtLine=rawLine.toLowerCase().replace(new RegExp((R.byId[prot.id].name||"").toLowerCase(),"i"), tgt.name.toLowerCase());
  const tgtLine2 = tgtLine!==rawLine.toLowerCase()? tgtLine :
      rawLine.toLowerCase().replace(/\b(chicken thigh|chicken breast|chicken|beef chuck|beef brisket|beef short rib|beef|pork ribs|pork belly|pork shoulder|pork loin|pork|mutton|fish|prawn|salmon)\b/i, tgt.name.toLowerCase());
  const tgtProf=meatProfile(tgtLine2,R) || {behaviour:"quick",forgiveness:forgivenessOf(targetId,R)};

  // name: replace the original protein's name in the title, else prefix
  const srcName=(R.byId[prot.id].name||"");
  const baseMeat=srcName.split(" ")[0];
  let newName=dish.name;
  if(new RegExp(srcName,"i").test(newName)) newName=newName.replace(new RegExp(srcName,"i"), tgt.name);
  else if(new RegExp("\\b"+baseMeat+"\\b","i").test(newName)) newName=newName.replace(new RegExp("\\b"+baseMeat+"\\b","i"), tgt.name);
  else newName=tgt.name+" "+newName;
  newName=_titleCaseName(newName);

  // ingredients + steps: rename the protein everywhere
  const renameRe=new RegExp("\\b"+srcName.replace(/ /g,"[ -]")+"\\b|\\b"+baseMeat+"\\b","gi");
  const ingredients=(dish.ingredients||[]).map(l=> l===rawLine ? l.replace(renameRe, tgt.name.toLowerCase()) : l);
  const steps=(dish.steps||[]).map(s=>s.replace(renameRe, tgt.name.toLowerCase()));

  // FLAGS — what a human must verify
  const flags=[];
  if(con.flag) flags.push("behaviour: "+con.flag);
  if(srcProf && srcProf.behaviour!==tgtProf.behaviour)
    flags.push("cook behaviour changes "+srcProf.behaviour+" \u2192 "+tgtProf.behaviour+" \u2014 the method and times below were written for "+srcName.toLowerCase()+".");
  (dish.steps||[]).forEach((s,i)=>{
    const mins=explicitMinutes(s);
    if(mins!=null){
      const dir = (srcProf&&srcProf.behaviour!=="braise"&&tgtProf.behaviour==="braise") ? "likely needs LONGER"
                : (srcProf&&srcProf.behaviour==="braise"&&tgtProf.behaviour!=="braise") ? "likely needs SHORTER"
                : "verify for "+tgt.name.toLowerCase();
      flags.push("step "+(i+1)+" states "+mins+" min \u2014 authored for "+srcName.toLowerCase()+"; "+dir+".");
    }
  });
  if(/skin[- ]side/i.test((dish.steps||[]).join(" ")) && !/chicken|duck/i.test(tgt.name))
    flags.push("steps mention 'skin-side' \u2014 reword for "+tgt.name.toLowerCase()+".");
  flags.push("quantity kept at the original's \u2014 confirm it suits "+tgt.name.toLowerCase()+".");

  if(allDishes && allDishes.some(x=>x.name.toLowerCase()===newName.toLowerCase()))
    return {ok:false, reason:"'"+newName+"' already exists in the catalogue \u2014 no draft needed"};

  return { ok:true, name:newName,
    swapsOption:{ key:targetId, label:tgt.name, name:newName, ingredients, steps,
                  handson_action:dish.handson_action },
    behaviour:{from:srcProf?srcProf.behaviour:"?", to:tgtProf.behaviour},
    flags };
}

/* ============================================================
   AFFINITY — what goes with what, learned from the recipes themselves.
   Co-occurrence is counted WITHIN A COOKING CONTEXT (soup with soup,
   stir-fry with stir-fry), because a pairing that works in a soup may be
   wrong in a stir-fry. Aromatics are excluded: they're in everything and
   would swamp the signal.

   This is DERIVED, never stored. Add a recipe and the graph sharpens by
   itself. It reports PRECEDENT and its strength, never a verdict:
     "seen 3x in soups"  /  "seen once"  /  "no precedent"
   Physics (does it survive the pot?) stays with the property rules.
   ============================================================ */
function contextOf(d){
  // the cooking frame a pairing was learned in — the "lowest branch" first
  if(d.role==="soup") return "soup";
  if(d.role==="dessert") return "dessert";
  if(d.build==="braise"||d.build==="simmer") return "braise";
  if(d.build==="stir_fry") return "stir_fry";
  if(d.build==="coat"||d.build==="fry_dry") return "fried";
  if(d.role==="base") return "rice_noodle";
  return d.role||"other";
}
function buildAffinity(dishes,R){
  const pairs={};      // "ctx|a+b" -> {n, dishes:[]}
  const seen={};       // "ctx|id"  -> how many dishes in this ctx use it
  const contexts=new Set();
  dishes.forEach(d=>{
    const ctx=contextOf(d); contexts.add(ctx);
    const ids=[...new Set((d.grocery_items||[])
      .filter(g=>g.id!=="water" && measureTypeOf(R.byId[g.id])!=="assumed")
      .map(g=>g.id))];
    ids.forEach(id=>{ const k=ctx+"|"+id; seen[k]=(seen[k]||0)+1; });
    for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
      const [a,b]=[ids[i],ids[j]].sort();
      const k=ctx+"|"+a+"+"+b;
      if(!pairs[k]) pairs[k]={n:0,dishes:[]};
      pairs[k].n++; pairs[k].dishes.push(d.name);
    }
  });
  return {pairs, seen, contexts:[...contexts]};
}
/* what has ingredient `id` been paired with, in this context? */
function affinityFor(id, ctx, AFF, R, limit=5){
  const out=[];
  const pre=ctx+"|";
  Object.keys(AFF.pairs).forEach(k=>{
    if(k.indexOf(pre)!==0) return;
    const body=k.slice(pre.length);
    const [a,b]=body.split("+");
    if(a!==id && b!==id) return;
    const other=(a===id)?b:a;
    out.push({id:other, name:(R.byId[other]||{}).name||other, n:AFF.pairs[k].n, dishes:AFF.pairs[k].dishes});
  });
  out.sort((x,y)=>y.n-x.n);
  return out.slice(0,limit);
}
/* has this exact pairing been done before, in this context? */
function precedentFor(a, b, ctx, AFF){
  const [x,y]=[a,b].sort();
  const hit=AFF.pairs[ctx+"|"+x+"+"+y];
  if(!hit) return {n:0, level:"none", text:"no precedent \u2014 nothing in the recipes pairs these", dishes:[]};
  if(hit.n===1) return {n:1, level:"thin", text:"seen once", dishes:hit.dishes};
  return {n:hit.n, level:"solid", text:"seen "+hit.n+"\u00d7", dishes:hit.dishes};
}

/* ============================================================
   NEAREST DISH — "this reminds me of…"
   Given a set of ingredients (a pot you're building), find the catalogue
   dishes it most resembles, and say what THEY have that you don't — so a
   dead-end "no precedent" becomes a live suggestion.

   Similarity = shared ingredients (weighted), + shared taste character,
   + same cooking context. Honest about how close the match actually is.
   ============================================================ */
function tasteDistance(a,b){
  const axes=["sweet","sour","salty","umami","fat","heat"];
  let d=0; axes.forEach(x=>{ d+=Math.abs((a[x]||0)-(b[x]||0)); });
  return d;
}
function remindsMeOf(ingIds, R, dishes, {ctx=null, limit=3}={}){
  const mine=new Set(ingIds.filter(id=>measureTypeOf(R.byId[id])!=="assumed"));
  if(!mine.size) return [];
  const myTaste=tasteOf([...mine].map(id=>({id, name:(R.byId[id]||{}).name||id})), R);

  const scored=dishes.map(d=>{
    const theirs=(d.grocery_items||[])
      .filter(g=>g.id!=="water" && measureTypeOf(R.byId[g.id])!=="assumed")
      .map(g=>g.id);
    const tset=new Set(theirs);
    const shared=[...mine].filter(id=>tset.has(id));

    const union=new Set([...mine,...tset]).size;
    const overlap=union? shared.length/union : 0;

    const td=tasteDistance(myTaste, d.taste||{});
    const tasteClose=1/(1+td);                            // 1.0 = identical character
    const sameCtx = ctx && contextOf(d)===ctx ? 1 : 0;

    // Ingredient overlap is the ONLY trustworthy similarity signal here: the taste
    // vectors are too coarse (0–3 per axis) to tell dishes apart — nearly everything
    // lands 3–4 apart, so flavour distance would produce nonsense "reminders".
    // Taste is a tiebreak, never a basis.
    if(!shared.length) return null;
    const score = overlap*3 + shared.length*0.5 + tasteClose*0.3 + sameCtx*0.4;

    const missing=theirs.filter(id=>!mine.has(id));       // what THEY have that you don't
    return {dish:d.name, d, score, shared, sharedNames:shared.map(id=>(R.byId[id]||{}).name||id),
            missing, missingNames:missing.map(id=>(R.byId[id]||{}).name||id),
            overlap, tasteGap:td, sameContext:!!sameCtx};
  }).filter(Boolean);

  scored.sort((a,b)=>b.score-a.score);
  return scored.slice(0,limit).map(s=>{
    let closeness;
    if(s.shared.length>=3 || s.overlap>=0.5) closeness="very close";
    else if(s.shared.length>=2)              closeness="close";
    else                                     closeness="a loose echo";   // one ingredient in common
    return {...s, closeness};
  });
}

/* ============================================================
   BROTH CHARACTER — what a protein base gives a pot.
   AUTHORED, NOT DERIVED. The engine knows the physics (collagen breaks
   down, fat renders); it cannot know that pork bones make a sweet milky
   broth while beef makes a deep iron-y one. That is a cook's knowledge,
   written down here so the engine can reason with it.
   A chef should own and correct this table.

   Axes are deliberately different from the six taste axes: these describe
   a BROTH's character, not a dish's flavour.
     body     : how much collagen/mouthfeel it carries      (0-3)
     sweetness: natural sweetness from the bones/flesh       (0-3)
     depth    : savoury weight / heaviness                   (0-3)
     clean    : clarity & lightness (opposite of heavy)      (0-3)
     marine   : sea character                                (0-3)
   ============================================================ */
const BROTH_BASE={
  pork_ribs:      {body:3, sweetness:2, depth:2, clean:1, marine:0, note:"bones give a sweet, rich body"},
  pork_belly:     {body:3, sweetness:2, depth:2, clean:0, marine:0, note:"fatty and rich"},
  pork_shoulder:  {body:2, sweetness:2, depth:2, clean:1, marine:0, note:"gently sweet, medium body"},
  pork:           {body:2, sweetness:2, depth:2, clean:1, marine:0, note:"sweet and rounded"},
  beef_chuck:     {body:3, sweetness:1, depth:3, clean:0, marine:0, gamey:0, note:"deep, heavy, iron-y"},
  beef_brisket:   {body:3, sweetness:1, depth:3, clean:0, marine:0, note:"deep and beefy"},
  beef_short_rib: {body:3, sweetness:1, depth:3, clean:0, marine:0, note:"very rich, unctuous"},
  beef:           {body:2, sweetness:1, depth:3, clean:0, marine:0, note:"deep and savoury"},
  chicken_thigh:  {body:2, sweetness:1, depth:1, clean:2, marine:0, note:"clean, light, gently savoury"},
  chicken_breast: {body:1, sweetness:1, depth:1, clean:3, marine:0, note:"very clean and light"},
  chicken:        {body:2, sweetness:1, depth:1, clean:2, marine:0, note:"clean and comforting"},
  fish:           {body:1, sweetness:1, depth:1, clean:3, marine:2, note:"delicate; goes in late"},
  salmon:         {body:1, sweetness:1, depth:2, clean:2, marine:2, note:"oily, distinctly marine"},
  prawn:          {body:1, sweetness:2, depth:1, clean:2, marine:3, note:"sweet and strongly of the sea"},
  squid:          {body:1, sweetness:1, depth:1, clean:2, marine:2, note:"clean, faintly sweet"},
  oyster:         {body:1, sweetness:1, depth:2, clean:1, marine:3, note:"briny and deep"},
  dried_shrimp:   {body:0, sweetness:1, depth:2, clean:1, marine:3, note:"a seasoning: concentrated sea umami"},
  wakame:         {body:0, sweetness:0, depth:1, clean:3, marine:3, note:"clean oceanic umami, no fat"},
  nori:           {body:0, sweetness:0, depth:1, clean:2, marine:3, note:"oceanic, toasty"},
  tofu:           {body:1, sweetness:0, depth:0, clean:3, marine:0, note:"a carrier \u2014 takes the broth's character"},
  mutton:         {body:3, sweetness:0, depth:3, clean:0, marine:0, gamey:2, note:"strong, gamey, assertive"}
};
const BROTH_AXES=["body","sweetness","depth","clean","marine","gamey"];

/* the base of a pot/dish = its principal protein (the thing the broth is built on) */
function brothBaseOf(ingIds,R){
  // prefer a real protein; bones/collagen-rich win over lean, since they define a broth
  const prots=ingIds.filter(id=>BROTH_BASE[id]);
  if(!prots.length) return null;
  prots.sort((a,b)=>(BROTH_BASE[b].body+BROTH_BASE[b].depth)-(BROTH_BASE[a].body+BROTH_BASE[a].depth));
  return prots[0];
}
function brothCharacter(ingIds,R){
  const bases=ingIds.filter(id=>BROTH_BASE[id]);
  if(!bases.length) return null;
  // BLEND every protein in the pot — a beef+pork broth is not a beef broth.
  // The heaviest base leads (it dominates the character), the others pull it.
  bases.sort((a,b)=>(BROTH_BASE[b].body+BROTH_BASE[b].depth)-(BROTH_BASE[a].body+BROTH_BASE[a].depth));
  const base=bases[0];
  const c={...BROTH_BASE[base]};
  if(bases.length>1){
    BROTH_AXES.forEach(ax=>{
      // weighted: lead base counts double, the rest average in
      const rest=bases.slice(1).reduce((sum,b)=>sum+BROTH_BASE[b][ax],0)/(bases.length-1);
      c[ax]=(c[ax]*2 + rest)/3;
    });
    c.blended=bases.slice(1).map(b=>(R.byId[b]||{}).name||b);
  }
  // vegetables shift the character: sweet roots sweeten it, seaweed cleans+marines it
  ingIds.forEach(id=>{
    if(id===base) return;
    const p=new Set((R.byId[id]||{}).provides||[]);
    if(p.has("sweet")) c.sweetness=Math.min(3,c.sweetness+0.5);
    if(p.has("umami")) c.depth=Math.min(3,c.depth+0.4);
    if(id==="wakame"||id==="nori") { c.marine=Math.min(3,c.marine+1); c.clean=Math.min(3,c.clean+0.5); }
  });
  c.base=base; c.baseName=(R.byId[base]||{}).name||base;
  return c;
}
function brothDistance(a,b){
  if(!a||!b) return 99;
  let d=0; BROTH_AXES.forEach(x=>{ d+=Math.abs((a[x]||0)-(b[x]||0)); });
  return d;
}
/* describe a broth in words */
function describeBroth(c){
  if(!c) return "no protein base \u2014 this will be a vegetable broth";
  const bits=[];
  if(c.milky) bits.push("milky and emulsified");
  if(c.body>=3) bits.push("full-bodied");
  else if(c.body<=1) bits.push("light-bodied");
  if(c.sweetness>=2.5) bits.push("notably sweet");
  else if(c.sweetness>=2) bits.push("gently sweet");
  if(c.depth>=3) bits.push("deep and heavy");
  else if(c.depth<=1) bits.push("delicate");
  if(c.clean>=3 && !c.milky) bits.push("clear and clean");
  if(c.roasted) bits.push("with roasted depth");
  if(c.gamey>=1.5) bits.push("gamey");
  if(c.marine>=2) bits.push("distinctly of the sea");
  return bits.join(", ")||"balanced";
}


/* Which existing dishes share this pot's BROTH CHARACTER? A far better
   similarity signal than the six-axis taste vector, which cannot tell a
   pork broth from a beef one. */
function brothLikeDishes(ingIds, R, dishes, limit=3){
  const mine=brothCharacter(ingIds,R);
  if(!mine) return [];
  const mySeason=seasoningOf(ingIds).map(x=>x.key);
  const out=[];
  dishes.forEach(d=>{
    const ids=(d.grocery_items||[]).map(g=>g.id);
    const theirs=brothCharacter(ids,R);
    if(!theirs) return;
    const dist=brothDistance(mine,theirs);
    const sameBase=theirs.base===mine.base;
    const theirSeason=seasoningOf(ids);
    const theirKeys=theirSeason.map(x=>x.key);
    const seasonShared=mySeason.filter(k=>theirKeys.includes(k));
    // a seasoning MISMATCH is a real distance: a plain pot is NOT a curry
    const seasonGap = seasonShared.length ? 0 : 2.5;
    out.push({dish:d.name, d, base:theirs.baseName, character:describeBroth(theirs),
              dist, total:dist+seasonGap, seasonGap,
              season:theirSeason[0]?theirSeason[0].label:"Clear & simple",
              seasonShared, sameBase,
              soupish:(d.role==="soup"||["braise","simmer"].includes(d.build))});
  });
  out.sort((a,b)=> (a.total-b.total) || (b.sameBase-a.sameBase) || (b.soupish-a.soupish));
  return out.slice(0,limit).map(x=>{
    let closeness;
    if(x.seasonGap>0 && x.dist<=1)      closeness="same broth, but it's seasoned as "+x.season.toLowerCase();
    else if(x.sameBase && x.dist<=1)    closeness="the same base, seasoned the same way";
    else if(x.dist<=1)                  closeness="a broth of the same character";
    else if(x.dist<=2.5)                closeness="a similar broth";
    else                                closeness="a different broth, but related";
    return {...x, closeness};
  });
}


/* ============================================================
   BROTH METHOD — read from the recipe's own steps.
   The same bones make a different broth depending on how they're cooked:
   a hard rolling boil emulsifies fat into the water (milky, rich); a gentle
   simmer keeps it clear and clean. Skimming lightens it. Searing first adds
   roasted depth. Blanching removes scum and cleans the result.
   This is DERIVED — it reads the steps the cook actually wrote.
   ============================================================ */
function brothMethod(d){
  const s=((d.steps||[]).join(" | ")).toLowerCase();
  return {
    hardBoil:  /rolling boil|hard boil|boil vigorously|boil rapidly/.test(s),
    gentle:    /simmer gently|gentle simmer|low heat|barely a simmer|reduce the heat/.test(s),
    simmer:    /simmer/.test(s),
    skimmed:   /skim/.test(s),
    blanched:  /blanch|parboil/.test(s),
    seared:    /\bsear\b|brown(ed)? (the|on|all)/.test(s),
    longCook:  ((d.time||{}).ready_in_min||0) >= 90
  };
}
/* apply the method to a base character — this is where steps change the broth */
function applyMethod(c, m){
  if(!c||!m) return c;
  const out={...c};
  if(m.hardBoil){                       // emulsifies fat -> milky, rich, heavy
    out.body=Math.min(3,out.body+1);
    out.depth=Math.min(3,out.depth+0.5);
    out.clean=Math.max(0,out.clean-2);
    out.milky=true;
  }
  if(m.gentle && !m.hardBoil){          // clear and clean
    out.clean=Math.min(3,out.clean+1);
    out.milky=false;
  }
  if(m.blanched){                       // scum removed -> cleaner
    out.clean=Math.min(3,out.clean+0.5);
  }
  if(m.skimmed){                         // fat removed -> lighter
    out.body=Math.max(0,out.body-0.5);
    out.clean=Math.min(3,out.clean+0.5);
  }
  if(m.seared){                          // maillard -> roasted depth
    out.depth=Math.min(3,out.depth+0.7);
    out.roasted=true;
  }
  if(m.longCook){                        // more collagen extracted
    out.body=Math.min(3,out.body+0.5);
  }
  out.method=m;
  return out;
}
/* the honest full character: base (authored) x method (derived from the steps) */
function brothOf(d,R){
  const ids=(d.grocery_items||[]).map(g=>g.id);
  const base=brothCharacter(ids,R);
  if(!base) return null;
  return applyMethod(base, brothMethod(d));
}


/* Does this dish actually HAVE a broth?
   Strict: a soup, or a dish whose steps put it in liquid and keep it there.
   A stir-fry that splashes in stock is not a broth; a salad certainly isn't. */
function hasBroth(d){
  if(d.role==="soup") return true;
  if(d.role==="veg"||d.role==="dessert"||d.role==="base") return false;
  const txt=((d.steps||[]).join(" ")).toLowerCase();
  // must actually simmer/braise/stew in liquid — not just mention water
  const cooksInLiquid=/\b(simmer|braise|stew)\b/.test(txt) ||
                      /(cover|add).{0,30}\b(broth|stock|water)\b.{0,40}\b(simmer|cook|braise|boil)\b/.test(txt);
  if(!cooksInLiquid) return false;
  // and it must not be a fundamentally dry-cooked dish
  const dryLed=/\b(deep.?fry|air.?fry|roast|bake in the oven|grill)\b/.test(txt);
  if(dryLed && !["braise","simmer"].includes(d.build)) return false;
  return ["braise","simmer"].includes(d.build) || /\bsimmer\b/.test(txt);
}

/* ============================================================
   ONE-POT STAGING — everything cooks in one vessel at one temperature,
   so the only real decision is WHEN each thing goes in.

   The ORDER is derived (collagen > dense root > quick > delicate > leafy,
   all from properties the engine already has). The MINUTES are AUTHORED —
   a cook's estimate of how long each class needs in a simmering pot. A chef
   should own and correct these numbers.
   ============================================================ */
const POT_CLASS=[
  {key:"collagen",  label:"Tough cuts",        mins:50, why:"needs time for the collagen to soften"},
  {key:"dense_root",label:"Dense roots",       mins:20, why:"dense \u2014 needs a good while to soften"},
  {key:"firm_veg",  label:"Firm vegetables",   mins:12, why:"holds its shape"},
  {key:"quick_prot",label:"Quick proteins",    mins:8,  why:"cooks through fast"},
  {key:"soft",      label:"Soft additions",    mins:5,  why:"just needs heating through"},
  {key:"delicate",  label:"Delicate seafood",  mins:4,  why:"overcooks in moments"},
  {key:"leafy",     label:"Leafy greens",      mins:1,  why:"wilts almost instantly \u2014 in at the very end"}
];
const POT_MINS={}; POT_CLASS.forEach(c=>POT_MINS[c.key]=c.mins);

function potClassOf(id,R){
  const i=R.byId[id]; if(!i) return null;
  const p=new Set(i.provides||[]);
  const cat=i.category;
  if(p.has("leafy")) return "leafy";
  if(cat==="proteins"){
    if(["fish","salmon","prawn","squid","oyster"].includes(id)) return "delicate";
    if(p.has("collagen_rich")) return "collagen";
    if(id==="tofu"||id==="egg") return "soft";
    return "quick_prot";
  }
  if(cat==="vegetables"||cat==="starches"){
    if(p.has("starchy") && p.has("holds_shape")) return "dense_root";
    if(p.has("holds_shape")) return "firm_veg";
    if(id==="mushroom") return "soft";
    return "soft";
  }
  return null;   // aromatics/seasonings go in with the broth, not staged
}

/* Build the pot: a base, a staged schedule, and honest gaps. */
function buildOnePot(ingIds, R, dishes){
  // STAGING only cares about things you physically add and time (not seasonings).
  // REASONING (broth character, seasoning direction, similarity) needs the FULL list —
  // otherwise the star anise you added never reaches "what does this remind me of".
  const real=ingIds.filter(id=>measureTypeOf(R.byId[id])!=="assumed");
  const all=ingIds;
  const staged={};
  real.forEach(id=>{
    const k=potClassOf(id,R);
    if(!k) return;
    (staged[k]=staged[k]||[]).push({id, name:(R.byId[id]||{}).name||id});
  });

  // longest thing in the pot sets the total cook time
  let total=0;
  Object.keys(staged).forEach(k=>{ total=Math.max(total, POT_MINS[k]||0); });
  if(!total) total=15;

  // each class goes in so that it finishes at the same moment
  const steps=POT_CLASS
    .filter(c=>staged[c.key])
    .map(c=>({
      at: Math.max(0, total-c.mins),
      cooks: c.mins,
      label: c.label,
      why: c.why,
      items: staged[c.key]
    }))
    .sort((a,b)=>a.at-b.at);

  const character = brothCharacter(all,R);
  const base = character ? character.base : null;

  // what's missing (nudge, never enforce)
  const gaps=[];
  const hasProtein = real.some(id=>(R.byId[id]||{}).category==="proteins");
  const hasVeg     = real.some(id=>(R.byId[id]||{}).category==="vegetables");
  const hasGreen   = real.some(id=>((R.byId[id]||{}).provides||[]).includes("leafy"));
  if(!hasProtein) gaps.push({what:"a protein", why:"nothing is setting the broth's character \u2014 this will be a light vegetable pot"});
  if(!hasVeg)     gaps.push({what:"vegetables", why:"it needs something green or sweet to make it a meal"});
  else if(!hasGreen && character && character.body>=2.5)
    gaps.push({what:"a leafy green", why:"a rich broth wants something fresh to cut it"});

  // hands-off: everything except the moments you add things
  const handsOn = Math.max(6, steps.length*2);

  return {
    base, character,
    describe: character?describeBroth(character):"a light vegetable broth",
    steps, total, handsOn, handsOff: Math.max(0,total-handsOn),
    gaps,
    seasoning: seasoningOf(all),
    reminds: dishes ? brothLikeDishes(all,R,dishes.filter(hasBroth),2) : []
  };
}

/* ============================================================
   SEASONING DIRECTION — where a pot is headed, flavour-wise.
   The broth model knows the PROTEIN base; it was blind to the seasoning,
   so a plain beef pot "reminded" the engine of Beef Curry. It doesn't.
   The curry's identity is its spices.

   Each direction is defined by its MARKERS — ingredients that signal it.
   A dish's direction is DERIVED by matching its ingredients against these.
   (The marker lists are a cook's knowledge; the matching is derived.)
   ============================================================ */
/* ---- CONSISTENCY: derived, canonical. Not authored. ----
   Two independent axes, both grounded in real culinary doctrine:
     opacity    : clear (\u6e05\u6c64 / consomm\u00e9) vs milky-emulsified (\u5976\u6c64 / tonkotsu)
                  \u2014 DERIVED from the steps: a hard rolling boil emulsifies fat into
                    the water; a gentle simmer + skimming keeps it clear.
     thickening : none / roux / pur\u00e9e / cream / starch  (Escoffier's axis)
                  \u2014 DERIVED from ingredients + steps.
   Neither needs a chef. The engine can defend every claim here. */
function consistencyOf(d,R){
  const txt=((d.steps||[]).join(" ")).toLowerCase();
  const ids=new Set((d.grocery_items||[]).map(g=>g.id));
  const m=brothMethod(d);
  const opacity = m.hardBoil ? "milky" : (m.gentle||m.skimmed) ? "clear" : "unspecified";
  let thickening="none";
  if(ids.has("flour")&&/roux|butter and flour/.test(txt)) thickening="roux";
  else if(/blend|pur\u00e9e|puree|mash/.test(txt))         thickening="puree";
  else if(ids.has("cream")||ids.has("coconut_milk"))     thickening="enriched";
  else if(ids.has("cornstarch")&&/thicken|slurry/.test(txt)) thickening="starch";
  return {opacity, thickening,
    note: opacity==="milky" ? "boiled hard \u2014 the fat emulsifies, turning it milky (\u5976\u6c64)"
        : opacity==="clear" ? "gently simmered \u2014 kept clear (\u6e05\u6c64)"
        : "consistency not specified in the steps"};
}

/* ---- SEASONING DIRECTION: AUTHORED. This is the local knowledge. ----
   No public taxonomy provides this. Escoffier classifies soups by thickness,
   not by flavour identity; flavour-network research maps compound sharing, not
   culinary direction. So this table is Singaporean culinary judgment, written
   down. It is CONTESTED, REGIONAL, and INCOMPLETE by nature \u2014 a chef should own it.

   Structure mirrors how ramen is actually taught: BROTH x TARE. The base sets
   the body; the direction sets the identity. */
const SEASONING_DIRS=[
  // --- Chinese / Singaporean ---
  {key:"bkt_teochew", label:"Bak kut teh \u2014 Teochew", region:"Teochew",
   markers:["white_pepper","garlic","pork_ribs"], need:3,          // ALL three, and…
   exclude:["dang_gui","dark_soy_sauce","star_anise","cinnamon","cloves_spice","white_sugar","soy_sauce"],
   note:"peppery and garlicky, kept clear \u2014 no herbs, no dark soy"},
  {key:"bkt_hokkien", label:"Bak kut teh \u2014 Hokkien", region:"Hokkien/Klang",
   markers:["dang_gui","star_anise","cinnamon","cloves_spice","goji","wolfberry","dark_soy_sauce"],
   need:2, note:"dark and herbal \u2014 medicinal warmth"},
  {key:"hong_shao",   label:"Red-braised (\u7ea2\u70e7)", region:"Chinese",
   markers:["dark_soy_sauce","white_sugar","rock_sugar","shaoxing","star_anise"], need:2,
   note:"soy and sugar \u2014 dark, glossy, savoury-sweet"},
  {key:"clear_chinese", label:"Clear Chinese soup (\u6e05\u6c64)", region:"Chinese",
   markers:["ginger","scallion","salt"], need:2, exclude:["dark_soy_sauce","coconut_milk","curry_powder"],
   note:"the broth speaks for itself \u2014 ginger, scallion, salt"},
  // --- Malay / Peranakan ---
  {key:"rempah",      label:"Rempah (Malay/Peranakan)", region:"Malay/Peranakan",
   markers:["belacan","candlenut","lemongrass","galangal","kaffir_lime"], need:1,   // the SEA signature
   also:["turmeric","chilli","shallot","coconut_milk"],
   note:"pounded spice paste \u2014 belacan, lemongrass, galangal"},
  {key:"assam",       label:"Sour-hot (assam / tom yum)", region:"SEA",
   markers:["lemongrass","galangal","kaffir_lime","chilli","fish_sauce"], need:2,
   require:["tamarind","lime"],        // the SOUR agent is the whole point — no sour, no assam
   exclude:["coconut_milk","coriander_seed","cumin"],   // that's a curry, not a tom yum
   note:"tamarind or lime against chilli \u2014 sharp and hot"},
  // --- Indian ---
  {key:"masala",      label:"Indian masala", region:"Indian",
   markers:["turmeric","coriander_seed","cumin","fennel","cardamom","curry_leaves","garam_masala","mustard_seed"],
   need:3, note:"toasted whole spice \u2014 layered and warm"},
  // --- Japanese (broth x tare, as ramen is actually taught) ---
  {key:"dashi_miso",  label:"Dashi + miso", region:"Japanese",
   markers:["miso","dashi","kombu","wakame"], need:1, note:"clean kelp umami, thickened by miso"},
  {key:"dashi_shoyu", label:"Dashi + shoyu", region:"Japanese",
   markers:["dashi","soy_sauce","mirin","sake","kombu"], need:2, exclude:["miso"],
   note:"dashi seasoned with soy \u2014 clear and savoury"},
  {key:"jp_curry",    label:"Japanese curry", region:"Japanese",
   markers:["japanese_curry_roux","curry_powder"], need:1, note:"a roux-thickened, gently sweet curry"},
  // --- Western ---
  {key:"western_herb",label:"Western herb & stock", region:"Western",
   markers:["bay_leaf","parsley","thyme","rosemary","oregano","celery","broth"], need:2,
   note:"herb-and-stock \u2014 homely and clean"},
  // --- fallback ---
  {key:"clear",       label:"Unseasoned", region:"\u2014", markers:[], need:0,
   note:"salt and pepper only \u2014 nothing steering it yet"}
];

function seasoningOf(ingIds){
  const set=new Set(ingIds);
  const hits=[];
  SEASONING_DIRS.forEach(dir=>{
    if(!dir.markers.length) return;
    // an EXCLUDE marker rules a direction out — this is what separates a Teochew
    // bak kut teh (no dang gui, no dark soy) from a Hokkien one.
    if((dir.exclude||[]).some(x=>set.has(x))) return;
    // a REQUIRE list means: at least one of these MUST be present (e.g. a sour agent for tom yum)
    if((dir.require||[]).length && !dir.require.some(x=>set.has(x))) return;
    const found=dir.markers.filter(m=>set.has(m));
    const bonus=(dir.also||[]).filter(m=>set.has(m)).length;
    if(found.length>=dir.need) hits.push({...dir, found, strength:found.length+bonus*0.5});
  });
  hits.sort((a,b)=>b.strength-a.strength);
  const seen=new Set(); const uniq=[];
  hits.forEach(h=>{ if(!seen.has(h.key)){ seen.add(h.key); uniq.push(h); } });
  if(!uniq.length) return [{...SEASONING_DIRS[SEASONING_DIRS.length-1], found:[], strength:0}];
  return uniq;
}
/* do two dishes share a seasoning direction? */
function seasoningMatch(aIds,bIds){
  const a=seasoningOf(aIds).map(x=>x.key);
  const b=seasoningOf(bIds).map(x=>x.key);
  const shared=a.filter(k=>b.includes(k));
  return {shared, aDirs:a, bDirs:b, same: shared.length>0};
}
