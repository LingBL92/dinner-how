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
const SUB_FAMILY_FLAGS=["grain_rice","collagen_rich","leafy","root_veg","allium"]; // fine-grained "same kind" tags
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
  return s;
}

/* ranked substitutes for one ingredient.
   have = Set of ingredient ids the cook has on hand (for the toggle). */
function substitutesFor(id,R,{have=null,limit=5}={}){
  const cands=[];
  for(const other in R.byId){
    const s=subScore(id,other,R);
    if(s<=0) continue;
    cands.push({id:other, name:R.byId[other].name, score:s, onHand: have?have.has(other):false});
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
    const comps=(d.grocery_items||[]).filter(g=>!IGNORE.has(g.id) && !staples.has(g.id));
    if(!comps.length) return;
    let covered=0; const missing=[], subs=[], short=[];
    comps.forEach(g=>{
      const mt=measureTypeOf(R.byId[g.id]);
      if(mt==="assumed"){ covered++; return; }   // aromatics/seasonings: always on hand
      // --- do we have it at all? (self, or an on-hand substitute) ---
      let sourceId=null;
      if(have.has(g.id)) sourceId=g.id;
      else { const sub=substitutesFor(g.id,R,{have,limit:3}).find(x=>x.onHand);
             if(sub){sourceId=sub.id; subs.push({need:g.name,use:sub.name});} }
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
    out.push({
      dish:d.name, role:d.role, ratio, covered, total:comps.length, subs, short,
      buy: missing.map(m=>{ const best=substitutesFor(m.id,R,{have,limit:1})[0];
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
