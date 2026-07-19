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

/* DERIVED from the taxonomy, not hand-written. A "character" ingredient is one that
   defines what the dish IS \u2014 a paste, or a sauce that names the dish. The taxonomy now
   has a `pastes` category for exactly this, so the engine reads it rather than carrying
   a hand-written list that goes stale. (That pattern has bitten seven times.) */
let CHARACTER_SET=new Set();
function buildCharacterSet(R){
  const s=new Set();
  R.list.forEach(i=>{ if(i.category==="pastes") s.add(i.id); });   // every paste, automatically
  // a handful of condiments genuinely name a dish (soy-braised, oyster-sauce kailan)
  ["oyster_sauce","dark_soy_sauce","fish_sauce","dashi","tamarind","coconut_milk",
   "dried_shrimp","salted_fish","salted_vegetable","star_anise","dang_gui","white_pepper",
   "kaffir_lime","lemongrass","galangal","turmeric","curry_leaves","shaoxing","mirin",
   "wolfberry","kimchi","salted_egg","century_egg"].forEach(x=>{ if(R.byId[x]) s.add(x); });
  return s;
}
const CHARACTER_SEASONINGS={ has(id){ return CHARACTER_SET.has(id); } };

function buildReference(ingData){
  const list=ingData.ingredients;
  const byId={}, GROC_CAT={}, PREP_VERB={}, hasChild=new Set();
  list.forEach(i=>{byId[i.id]=i;GROC_CAT[i.name]=i.aisle;PREP_VERB[i.name]=i.prep_verb;if(i.parent)hasChild.add(i.parent);});
  const anc={};
  list.forEach(i=>{const s=new Set();let p=i.parent;while(p){s.add(p);p=byId[p]?byId[p].parent:null;}anc[i.id]=s;});
  const R={list,byId,anc,GROC_CAT,PREP_VERB,isLeaf:id=>!hasChild.has(id),
          match:makeMatcher(list),taste:ingData.taste_rules};
  CHARACTER_SET=buildCharacterSet(R);   // derived from the taxonomy — never hand-written
  return R;
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
    const form=detectForm(raw);                       // whole / mince / slice / dice / cube...
    if(ing.category==="proteins" && /\b(minced|ground)\b/.test(raw.toLowerCase()) && !/^minced/i.test(name)){
      name="Minced "+name.toLowerCase();
    }
    out.push({name,id,qty:q.qty,unit:q.unit,form});});
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

  /* PREP is not "2 minutes per ingredient". You don't spend two minutes prepping soy
     sauce. Charge only for ingredients that need real knife-work, and charge the small
     ones (a clove of garlic) less than the big ones (jointing a chicken). */
  const NO_PREP=/^(measure|pour|prep|squeeze)$/i;   // pantry pours, seasoning: no knife work
  const LIGHT=/^(rinse|wash|pat dry|zest|crush)/i;
  let prepUnits=0;
  ings.forEach(i=>{
    if(!i.id) return;
    const ing=R.byId[i.id]||{};
    const verb=(ing.prep_verb||"").trim();
    if(!verb || NO_PREP.test(verb)) return;          // nothing to do
    if(measureTypeOf(ing)==="assumed") { prepUnits+=0.25; return; }   // mince a clove: quick
    prepUnits += LIGHT.test(verb) ? 0.5 : 1;
  });
  const prep=Math.round(TM.prep.base_minutes+TM.prep.minutes_per_ingredient*prepUnits);
  let total=prep, beThere=prep, handsOff=0, makeahead=0;
  const mult=(TM.appliance_time_multiplier[appliance]!==undefined)?TM.appliance_time_multiplier[appliance]:1.0;
  let hasLiquid=false, noCookCharged=false, active=new Set();
  let lastUntimedMethod=null;
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
      if(mid==="no_cook"){ if(noCookCharged)return; noCookCharged=true; }   // once per dish, not per step
      const mt=M.methods[mid].timing;
      let att=mt.attention;
      const exp=explicitMinutes(text);
      let mins=exp||mt.minutes;
      /* CONTINUOUS ACTION. "Scramble the eggs" then "stir-fry the tomatoes" then "return
         the eggs" is ONE stint at the wok, not three. Charging each un-timed step the
         method's full default turned a 6-minute stir-fry into a 17-minute one.
         So: the first un-timed step of a run costs full; each further one costs a little. */
      if(!exp){
        if(lastUntimedMethod===mid){ mins=Math.max(1, Math.round(mt.minutes*0.35)); }
        lastUntimedMethod=mid;
      } else {
        lastUntimedMethod=null;
      }
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
  /* SPECIES MATTERS. Chicken wing and beef chuck are both collagen-rich, so the physics
     say they swap — and physically they do. But a beef curry made with chicken wings is
     not a dish. Staying within a species is a far safer swap than crossing one, and the
     scorer was treating them as near-equal. */
  if(A.category==="proteins" && B.category==="proteins"){
    /* FORM IS ABSOLUTE. Mince is a different ingredient from a slab — you cannot make
       a mince dish with a belly, or a braise with mince. No score, ever. */
    const isMinceNode=(x)=>x.form==="mince";
    if(isMinceNode(A)!==isMinceNode(B)) return 0;

    const sp=(id)=>{ const anc=R.anc[id]||new Set();
      for(const k of ["beef","pork","chicken","mutton","fish","prawn"]) if(anc.has(k)||id===k) return k;
      return id; };
    if(sp(aId)!==sp(bId)) s-=1.2;          // crossing species is a real leap
  }
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
let AFFINITY=null;
function setAffinity(a){ AFFINITY=a; }
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
    let covered=0; const missing=[], subs=[], short=[]; let unchartedSwaps=0;
    comps.forEach(g=>{
      const mt=measureTypeOf(R.byId[g.id]);
      // --- do we have it at all? (self, or an on-hand substitute) ---
      /* FORM IS A HARD CONSTRAINT. "300 g minced pork" is not satisfied by a pork belly
         slab, however well they match on collagen and fat — mince is a different
         ingredient in every way that matters to a recipe. Mince only swaps for mince. */
      const needsMince = g.form==="mince";
      const isMince = (id)=>{
        // a pantry item is "mince" only if the cook actually has mince — we cannot know
        // that from a bare id, so treat a generic species node as ambiguous and allow it,
        // but never accept a specific whole cut (pork belly, chicken thigh, beef chuck).
        const ing=R.byId[id]||{};
        if(ing.category!=="proteins") return false;
        if(ing.form==="mince") return true;                // an actual mince node
        return !R.isLeaf(id);                              // generic species: could be mince
      };
      let sourceId=null;
      if(have.has(g.id)) sourceId=g.id;
      else if(needsMince){
        // First: the same species, in mince form (or a generic node that could be mince).
        let kin=[...have].find(hid=>((R.anc[hid]||new Set()).has(g.id)||hid===g.id) && isMince(hid));
        // Then: ANOTHER mince. Beef mince for pork mince is a real swap — a slab never is.
        if(!kin) kin=[...have].find(hid=>(R.byId[hid]||{}).form==="mince");
        if(kin){
          sourceId=kin;
          if(kin!==g.id){
            const cross=!((R.anc[kin]||new Set()).has(g.id));
            subs.push({need:g.name,use:(R.byId[kin]||{}).name||kin,
              flag: cross ? "a different meat, but the right form" : null, rename:null});
          }
        }
        // no whole-cut fallback: a slab is not mince
      }
      else {
        // OWNING A SPECIFIC CUT SATISFIES A GENERIC REQUIREMENT.
        // "300g chicken" is covered by chicken thigh; "beef" by beef chuck; etc.
        const kin=[...have].find(hid=>(R.anc[hid]||new Set()).has(g.id));
        if(kin){ sourceId=kin; if(kin!==g.id) subs.push({need:g.name,use:(R.byId[kin]||{}).name||kin,flag:null,rename:null}); }
        else {
          const sub=substitutesFor(g.id,R,{have,limit:3,dish:d}).find(x=>x.onHand);
          if(sub){
            /* A swap can be PHYSICALLY sound and CULTURALLY absurd. Chicken wing braises
               like beef chuck — but a beef curry made with chicken wings is not a dish.
               The affinity graph knows: it has no precedent for that pairing. Record the
               swap, but mark it uncharted so the ranking can weigh it honestly. */
            let uncharted=false;
            if(AFFINITY && (R.byId[sub.id]||{}).category==="proteins"){
              const ctx=contextOf(d);
              const others=(d.grocery_items||[]).map(x=>x.id)
                .filter(x=>x!==g.id && measureTypeOf(R.byId[x])!=="assumed" && x!=="water");
              /* NB: no kin-pooling here. Chicken wing inherits chicken's precedent for
               SUGGESTIONS, but that does not make it belong in a beef curry — the
               question is whether THIS ingredient has been cooked with THESE ones. */
            uncharted = !others.some(o=>{
              const [p,q]=[sub.id,o].sort();
              return !!AFFINITY.pairs[ctx+"|"+p+"+"+q];
            });
            }
            sourceId=sub.id;
            subs.push({need:g.name,use:sub.name,flag:sub.flag,rename:sub.rename,uncharted});
            if(uncharted) unchartedSwaps++;
          }
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
      dish:d.name, displayName:renamed||d.name, role:d.role, ratio, covered, total:comps.length, subs, short, unchartedSwaps,
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
  "pandan","dried_orange_peel","dang_gui","dried_shrimp","belacan","cornstarch"]);
const MT_COUNT=new Set(["egg","century_egg","onion","potato","sweet_potato","tomato","carrot","cucumber",
  "bell_pepper","eggplant","zucchini","corn","tofu","lemon","lime","apple","banana","pineapple","okra","daikon",
  "pumpkin","yam"]);   // whole things you buy and use by the piece
function measureTypeOf(ing){
  if(!ing) return "assumed";
  if(ing.measure_type) return ing.measure_type;                 // authored override
  // a whole fish is bought by the piece; a fillet by weight. The recipe line decides,
  // but by default a named fish is a whole fish at the market.
  if(ing.id==="chicken_whole") return "count";
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
/* What method does this dish ACTUALLY use? Read the steps, not the archetype — the
   archetype classifier only runs on protein dishes, so 54 of 84 dishes had no build at
   all, and the affinity graph was lumping sambal stir-fries in with braised cabbage. */
function cookMethodOf(d){
  const t=((d.steps||[]).join(" ")).toLowerCase();
  // The DEFINING method is where the dish ends up, not where it starts. A baked rice
  // stir-fries the rice first — but it's a bake.
  const apps=(d.appliances||[d.appliance]||[]);
  if(apps.includes("oven")||apps.includes("air_fryer")){
    if(/\bbake|roast\b/.test(t)) return "roast";
  }
  if(/\bstir[- ]?fry|toss (over|in) high heat|wok\b/.test(t)) return "stir_fry";
  // "let it steam, covered" is a covered-pan cooking step inside a stir-fry or a rice pot,
  // not steamer-steaming. A real steamed dish steams its subject as the main event.
  if(/\bsteam\b/.test(t) && !/let it steam/.test(t) && !/steamer basket for the/.test(t)) return "steam";
  if(/\bbraise|simmer\b/.test(t)) return "braise";
  if(/\bdeep[- ]?fry|shallow[- ]?fry\b/.test(t)) return "deep_fry";
  if(/\broast|bake\b/.test(t)) return "roast";
  if(/\bgrill|char\b/.test(t)) return "grill";
  if(/\bblanch\b/.test(t)) return "blanch";
  if(/\bboil\b/.test(t)) return "boil";
  return null;
}
/* A ONE-DISH RICE BOWL: rice plus one topping, eaten as a single bowl. It splits two ways
   — the topping cooked IN the rice (claypot, yam rice, takikomi: it renders into the grain
   and a crust forms), or cooked separately and ladled OVER plain rice (donburi, lu rou,
   curry: the sauce is the moisture). Either way it is NOT fried rice (that's a stir-fry) and
   NOT plain rice or a herb pilaf (those have no protein topping). */
const RICE_BASE_IDS=new Set(["rice","brown_rice","glutinous_rice"]);
const RICE_TOPPING_PROTEINS=new Set(["chicken","chicken_thigh","chicken_breast","chicken_drumstick",
  "chicken_wing","chicken_whole","chicken_mince","turkey","pork","pork_belly","pork_loin","pork_shoulder",
  "pork_ribs","pork_mince","beef","beef_slices","beef_mince","beef_brisket","beef_chuck","beef_short_rib",
  "beef_steak","mutton","lap_cheong","char_siu","fish","salmon","threadfin","pomfret","seabass","snapper",
  "grouper","cod","mackerel","tuna","sardine","prawn","squid","clams","oyster","scallops","mussels","dried_shrimp","fish_cake","century_egg","egg"]);
function isRiceBowl(d){
  const ids=(d.grocery_items||[]).map(g=>g.id);
  if(!ids.some(id=>RICE_BASE_IDS.has(id))) return false;
  if(cookMethodOf(d)==="stir_fry") return false;         // fried rice, mee goreng, yakisoba
  return ids.some(id=>RICE_TOPPING_PROTEINS.has(id));    // a topping, not plain rice or a herb pilaf
}

function contextOf(d){
  // the cooking frame a pairing was learned in. METHOD first — a vegetable stir-fry is a
  // stir-fry, not a "veg". A soup is a soup whatever's in it.
  if(d.role==="soup") return "soup";
  if(d.role==="dessert") return "dessert";
  if(isRiceBowl(d)) return "rice_bowl";
  const m=cookMethodOf(d);
  if(m==="stir_fry") return "stir_fry";
  if(m==="steam") return "steam";
  if(m==="braise") return "braise";
  if(m==="deep_fry"||m==="grill"||m==="roast") return "fried";
  if(d.build==="braise"||d.build==="simmer") return "braise";
  if(d.build==="coat"||d.build==="fry_dry") return "fried";
  if(d.role==="base") return "rice_noodle";
  return d.role||"other";
}
/* Which ingredients does the affinity graph SEE? A character paste or sauce defines the
   dish (sambal, belacan, miso) and must be visible — or the graph can never learn that
   sambal goes with kangkong. But salt, oil and garlic are BACKGROUND: they are in every
   dish and would swamp the signal. */
function inAffinity(id,R){
  if(id==="water") return false;
  if(CHARACTER_SEASONINGS.has(id)) return true;      // the sauce IS the dish
  return measureTypeOf(R.byId[id])!=="assumed";      // real, weighable ingredients
}
function buildAffinity(dishes,R){
  const pairs={};      // "ctx|a+b" -> {n, dishes:[]}
  const seen={};       // "ctx|id"  -> how many dishes in this ctx use it
  const contexts=new Set();
  dishes.forEach(d=>{
    const ctx=contextOf(d); contexts.add(ctx);
    const ids=[...new Set((d.grocery_items||[])
      .filter(g=>inAffinity(g.id,R))
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
/* Has this pairing been done before, in this context?
   Precedent POOLS ACROSS CUTS: if chicken breast has been cooked with carrot, that is
   precedent for chicken-and-carrot. A whole chicken does not stop being chicken. Without
   this, the graph fragments its knowledge across cuts and reports "no precedent" for
   pairings it has actually seen. */
function kinOf(id, R){
  if(!R) return [id];
  const out=new Set([id]);
  const anc=R.anc[id]||new Set();
  const SPECIES=["beef","pork","chicken","mutton","fish","prawn","squid","oyster"];
  const sp=SPECIES.find(k=>anc.has(k)||id===k);
  if(sp){
    out.add(sp);
    R.list.forEach(i=>{ const a=R.anc[i.id]||new Set(); if(a.has(sp)||i.id===sp) out.add(i.id); });
  }
  return [...out];
}
function precedentFor(a, b, ctx, AFF, R){
  const A=kinOf(a,R), B=kinOf(b,R);
  let n=0; const dishes=new Set();
  A.forEach(x=>B.forEach(y=>{
    const [p,q]=[x,y].sort();
    const hit=AFF.pairs[ctx+"|"+p+"+"+q];
    if(hit){ n+=hit.n; hit.dishes.forEach(d=>dishes.add(d)); }
  }));
  if(!n) return {n:0, level:"none", text:"no precedent \u2014 nothing in the recipes pairs these", dishes:[]};
  if(n===1) return {n:1, level:"thin", text:"seen once", dishes:[...dishes]};
  return {n, level:"solid", text:"seen "+n+"\u00d7", dishes:[...dishes]};
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
  chicken_breast: {body:1, sweetness:1, depth:1, clean:3, marine:0, noBroth:true, note:"lean \u2014 fine as an addition, but it can\u2019t carry a broth"},
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
  mutton:         {body:3, sweetness:0, depth:3, clean:0, marine:0, gamey:2, note:"strong, gamey, assertive"},
  pomfret:        {body:1, sweetness:2, depth:1, clean:3, marine:2, note:"sweet, delicate white flesh"},
  seabass:        {body:1, sweetness:1, depth:1, clean:3, marine:2, note:"clean and mild"},
  threadfin:      {body:1, sweetness:2, depth:1, clean:3, marine:2, note:"sweet and tender"},
  snapper:        {body:2, sweetness:1, depth:2, clean:2, marine:2, note:"firm white flesh, holds together"},
  grouper:        {body:2, sweetness:1, depth:2, clean:2, marine:2, note:"gelatinous \u2014 gives the broth real body"},
  mackerel:       {body:2, sweetness:1, depth:2, clean:1, marine:3, note:"oily and assertive"},
  sardine:        {body:1, sweetness:0, depth:3, clean:0, marine:3, note:"small, oily, intensely savoury"},
  cod:            {body:2, sweetness:1, depth:1, clean:2, marine:2, note:"buttery and forgiving"},
  tuna:           {body:2, sweetness:0, depth:2, clean:1, marine:2, note:"firm and steak-like"},
  chicken_wing:   {body:3, sweetness:1, depth:1, clean:1, marine:0, note:"skin and collagen \u2014 gives a rich, gelatinous broth"},
  chicken_drumstick:{body:2, sweetness:1, depth:1, clean:2, marine:0, note:"dark meat on the bone \u2014 clean and savoury"},
  chicken_whole:  {body:3, sweetness:1, depth:2, clean:2, marine:0, note:"the whole bird \u2014 the classic clear broth"},
  beef_steak:     {body:1, sweetness:1, depth:2, clean:1, marine:0, noBroth:true, note:"a dry-heat cut \u2014 sear it, don\u2019t simmer it"},
  pork_loin:      {body:1, sweetness:2, depth:1, clean:2, marine:0, noBroth:true, note:"lean \u2014 goes dry and stringy in a pot"}
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
/* A simmering pot is FORGIVING. Carrots do not have a moment — they have a window.
   Claiming a carrot goes in at "+38m" and corn at "+30m" asserts an 8-minute distinction
   the physics does not support, and dresses an estimate up as a schedule.
   So each class carries a WINDOW (min..max) and a flag saying whether the timing
   genuinely MATTERS. The greens and the fish matter. The roots do not. */
const POT_CLASS=[
  {key:"collagen",  label:"Tough cuts",       mins:50, lo:40, hi:90, critical:false,
   why:"needs the full time \u2014 the collagen has to soften"},
  {key:"dense_root",label:"Dense vegetables", mins:20, lo:15, hi:30, critical:false,
   why:"anywhere in this window is fine \u2014 they just need to soften"},
  {key:"firm_veg",  label:"Firm vegetables",  mins:12, lo:8,  hi:18, critical:false,
   why:"forgiving \u2014 they hold their shape"},
  {key:"quick_prot",label:"Quick proteins",   mins:8,  lo:6,  hi:12, critical:false,
   why:"cooks through fast"},
  {key:"soft",      label:"Soft additions",   mins:5,  lo:3,  hi:8,  critical:false,
   why:"just needs heating through"},
  {key:"delicate",  label:"Fish and seafood", mins:4,  lo:3,  hi:5,  critical:true,
   why:"THIS ONE MATTERS \u2014 a minute too long and it goes woolly"},
  {key:"leafy",     label:"Leafy greens",     mins:1,  lo:1,  hi:2,  critical:true,
   why:"THIS ONE MATTERS \u2014 in at the very last minute, or it collapses"}
];
const POT_MINS={}; POT_CLASS.forEach(c=>POT_MINS[c.key]=c.mins);

/* Seafood is DERIVED, not listed. A hardcoded list of fish goes stale the moment a
   fish is added — and a pomfret miscategorised as a "quick protein" gets 8 minutes in
   the pot instead of 4, and overcooks. */
const SEAFOOD_ROOTS_D=["fish","prawn","squid","oyster","salmon","dried_shrimp"];
function isSeafoodId(id,R){
  if(SEAFOOD_ROOTS_D.includes(id)) return true;
  const anc=R.anc[id]||new Set();
  return SEAFOOD_ROOTS_D.some(r=>anc.has(r));
}
function potClassOf(id,R){
  const i=R.byId[id]; if(!i) return null;
  const p=new Set(i.provides||[]);
  const cat=i.category;
  if(p.has("leafy")) return "leafy";
  if(cat==="proteins"){
    if(i.form==="mince") return "quick_prot";          // mince cooks fast, breaks up
    if(isSeafoodId(id,R)) return "delicate";           // ALL fish and shellfish overcook fast
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
function buildOnePot(ingIds, R, dishes, opts){
  ingIds=[...new Set(ingIds||[])];        // a pot can never hold the same thing twice
  // STAGING only cares about things you physically add and time (not seasonings).
  // REASONING (broth character, seasoning direction, similarity) needs the FULL list —
  // otherwise the star anise you added never reaches "what does this remind me of".
  const real=ingIds.filter(id=>measureTypeOf(R.byId[id])!=="assumed");
  const all=ingIds;
  const APP=(opts&&opts.appliance)||null;
  const APPD=(opts&&opts.applData)||null;
  const staged={};
  real.forEach(id=>{
    const k=potClassOf(id,R);
    if(!k) return;
    (staged[k]=staged[k]||[]).push({id, name:(R.byId[id]||{}).name||id});
  });

  /* THE VESSEL CHANGES THE COOK. A pressure cooker breaks collagen down in a fraction
     of the time; a slow cooker takes hours. appliances.json already carries these
     multipliers. They apply to the PASSIVE stages (the long softening) — not to a
     leafy green, which wilts in a minute whatever the pot. */
  const mult = APPD && APPD.passive_multiplier!=null ? APPD.passive_multiplier : 1;
  const cap  = APPD ? APPD.passive_cap_min : null;
  function scaled(key){
    const base=POT_MINS[key]||0;
    if(mult===1) return base;
    if(!["collagen","dense_root"].includes(key)) return base;   // quick things stay quick
    let v=Math.round(base*mult);
    if(cap!=null) v=Math.min(v, cap);
    return Math.max(1, v);
  }

  let total=0;
  Object.keys(staged).forEach(k=>{ total=Math.max(total, scaled(k)); });
  if(!total) total=15;

  // each class goes in so that it finishes at the same moment
  const steps=POT_CLASS
    .filter(c=>staged[c.key])
    .map(c=>{
      const mins=scaled(c.key);
      const faster = mins<c.mins, slower = mins>c.mins;
      const scaleW=(v)=>{ if(mult===1||!["collagen","dense_root"].includes(c.key)) return v;
        let x=Math.round(v*mult); if(cap!=null) x=Math.min(x,cap); return Math.max(1,x); };
      const lo=scaleW(c.lo), hi=scaleW(c.hi);
      return {
        at: Math.max(0, total-mins),
        // the honest window: earliest and latest you could add it
        from: Math.max(0, total-hi),
        to:   Math.max(0, total-lo),
        cooks: mins,
        critical: !!c.critical,
        label: c.label,
        why: c.why + ((faster||slower) && APP ? " \u00b7 " + (faster?"much faster":"slower") + " in the " + APP.replace(/_/g," ") : ""),
        items: staged[c.key]
      };
    })
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
    appliance: APP, multiplier: mult,
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
   markers:["white_pepper","garlic","pork_ribs"], need:3, needsLiquid:true, bakeNote:"the broth IS the dish — there is nothing to bake",          // ALL three, and…
   exclude:["dang_gui","dark_soy_sauce","star_anise","cinnamon","cloves_spice","white_sugar","soy_sauce"],
   note:"peppery and garlicky, kept clear \u2014 no herbs, no dark soy"},
  {key:"bkt_hokkien", label:"Bak kut teh \u2014 Hokkien", region:"Hokkien/Klang",
   markers:["dang_gui","star_anise","cinnamon","cloves_spice","goji","wolfberry","dark_soy_sauce"],
   need:2, needsLiquid:true, bakeNote:"the herbs infuse into a simmering broth", note:"dark and herbal \u2014 medicinal warmth"},
  {key:"hong_shao",   label:"Red-braised (\u7ea2\u70e7)", region:"Chinese",
   markers:["dark_soy_sauce","white_sugar","rock_sugar","shaoxing","star_anise"], need:2, needsLiquid:false, bakeNote:"soy, sugar and spice make a glaze — this is how char siu works",
   note:"soy and sugar \u2014 dark, glossy, savoury-sweet"},
  {key:"clear_chinese", label:"Clear Chinese soup (\u6e05\u6c64)", region:"Chinese",
   markers:["ginger","scallion","salt"], need:2, needsLiquid:true, bakeNote:"a clear broth needs a broth",
   exclude:["dark_soy_sauce","coconut_milk","curry_powder","gochugaru","laksa_paste","tom_yum_paste"],
   note:"the broth speaks for itself \u2014 ginger, scallion, salt"},
  {key:"milky_bone",  label:"Milky bone broth (\u5976\u6c64)", region:"Chinese",
   markers:["pork_ribs","garlic","ginger"], need:2, needsLiquid:true, bakeNote:"the milkiness comes from hard-boiling fat into water", requireMilky:true,
   note:"boiled hard until the fat emulsifies \u2014 opaque and rich"},
  // --- Malay / Peranakan ---
  {key:"rempah",      label:"Rempah (Malay/Peranakan)", region:"Malay/Peranakan",
   markers:["belacan","candlenut","laksa_paste","sambal","laksa_leaf","lemongrass","galangal","kaffir_lime"], need:1, needsLiquid:false, bakeNote:"fry the paste, then rub it on and roast — as in sambal grilled fish",
   also:["turmeric","chilli","shallot","coconut_milk"],
   note:"pounded spice paste \u2014 belacan, lemongrass, galangal"},
  {key:"assam",       label:"Sour-hot (assam / tom yum)", region:"SEA",
   markers:["lemongrass","galangal","kaffir_lime","chilli","fish_sauce","tom_yum_paste"], need:2, needsLiquid:true, bakeNote:"the sour goes in off the heat, into a broth",
   require:["tamarind","lime","tom_yum_paste"],        // the SOUR agent is the whole point — no sour, no assam
   exclude:["coconut_milk","coriander_seed","cumin"],   // that's a curry, not a tom yum
   note:"tamarind or lime against chilli \u2014 sharp and hot"},
  // --- Indian ---
  {key:"masala",      label:"Indian masala", region:"Indian",
   markers:["turmeric","coriander_seed","cumin","fennel","cardamom","curry_leaves","garam_masala","mustard_seed"],
   need:3, needsLiquid:false, bakeNote:"a dry spice rub — arguably the more traditional way", note:"toasted whole spice \u2014 layered and warm"},
  // --- Japanese (broth x tare, as ramen is actually taught) ---
  {key:"dashi_miso",  label:"Dashi + miso", region:"Japanese",
   markers:["miso","dashi","kombu","wakame"], need:1, needsLiquid:true, bakeNote:"miso is whisked into a broth — an oven has none", note:"clean kelp umami, thickened by miso"},
  {key:"dashi_shoyu", label:"Dashi + shoyu", region:"Japanese",
   markers:["dashi","soy_sauce","mirin","sake","kombu"], need:2, needsLiquid:true, bakeNote:"dashi is a stock", exclude:["miso"],
   note:"dashi seasoned with soy \u2014 clear and savoury"},
  {key:"jp_curry",    label:"Japanese curry", region:"Japanese",
   markers:["japanese_curry_roux","curry_powder"], need:1, needsLiquid:true, bakeNote:"a roux thickens a liquid", note:"a roux-thickened, gently sweet curry"},
  // --- Korean ---
  {key:"korean",      label:"Korean gochu", region:"Korean",
   markers:["gochugaru","gochujang","kimchi"], need:1, needsLiquid:false, bakeNote:"gochujang makes a fine glaze on a roast",
   note:"fermented chilli \u2014 deep, savoury heat"},
  // --- Western ---
  {key:"western_herb",label:"Western herb & stock", region:"Western",
   markers:["bay_leaf","parsley","thyme","rosemary","oregano","celery","broth"], need:2, needsLiquid:false, bakeNote:"herbs and garlic on a roast — obviously",
   note:"herb-and-stock \u2014 homely and clean"},
  // --- fallback ---
  {key:"clear",       label:"Unseasoned", region:"\u2014", markers:[], need:0,
   note:"salt and pepper only \u2014 nothing steering it yet"}
];

function seasoningOf(ingIds, dish){
  const set=new Set(ingIds);
  const isMilky = dish ? !!brothMethod(dish).hardBoil : false;
  const hits=[];
  SEASONING_DIRS.forEach(dir=>{
    if(!dir.markers.length) return;
    // an EXCLUDE marker rules a direction out — this is what separates a Teochew
    // bak kut teh (no dang gui, no dark soy) from a Hokkien one.
    if((dir.exclude||[]).some(x=>set.has(x))) return;
    // a REQUIRE list means: at least one of these MUST be present (e.g. a sour agent for tom yum)
    if((dir.require||[]).length && !dir.require.some(x=>set.has(x))) return;
    if(dir.requireMilky && !isMilky) return;          // \u5976\u6c64 only if it was actually boiled hard
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


/* ============================================================
   DATA/CODE DRIFT AUDIT
   Three separate bugs in this project came from the same cause: a list written by
   hand in the code, which silently went stale when new ingredients were added to the
   taxonomy. A pomfret classed as a "quick protein" gets 8 minutes in a pot instead of
   4, and overcooks — and nothing warns you.

   So: at load, check that every ingredient the engine must classify actually GETS
   classified. Anything that falls through to a default is reported.
   ============================================================ */
function auditDrift(R, dishes){
  const problems=[];

  // 1. every protein must land in a pot class that isn't the catch-all
  R.list.filter(i=>i.category==="proteins" && R.isLeaf(i.id)).forEach(i=>{
    const k=potClassOf(i.id,R);
    if(!k) problems.push({kind:"pot-class", id:i.id, msg:i.name+" has no pot class — it cannot be staged in a one-pot"});
  });

  // 2. every vegetable should have a browse group, or it lands in "Other"
  R.list.filter(i=>i.category==="vegetables" && R.isLeaf(i.id)).forEach(i=>{
    if(!i.group) problems.push({kind:"group", id:i.id, msg:i.name+" has no group — it will show under \"Other\""});
  });

  // 3. every recipe ingredient must resolve to a taxonomy node
  (dishes||[]).forEach(d=>{
    (d.ingredients||[]).forEach(line=>{
      if(!R.match(line)) problems.push({kind:"unresolved", id:d.name, msg:d.name+': "'+line+'" does not resolve'});
    });
  });

  // 4. a fish that isn't recognised as seafood will be timed as a land animal
  R.list.filter(i=>R.isLeaf(i.id) && (R.anc[i.id]||new Set()).has("fish")).forEach(i=>{
    if(potClassOf(i.id,R)!=="delicate")
      problems.push({kind:"seafood", id:i.id, msg:i.name+" is a fish but is not classed delicate — it will be overcooked"});
  });

  // 5. every protein that could lead a pot needs a broth character — this is exactly
  //    how the nine new fish went missing.
  const LEADS=["beef","pork","chicken","mutton","fish","prawn","squid","oyster"];
  R.list.filter(i=>{
    if(i.category!=="proteins"||!R.isLeaf(i.id)||i.form==="mince") return false;
    const anc=R.anc[i.id]||new Set();
    return LEADS.some(k=>anc.has(k)||i.id===k);      // only meat and fish lead a pot
  }).forEach(i=>{
    if(!BROTH_BASE[i.id])
      problems.push({kind:"broth-base", id:i.id, msg:i.name+" has no broth character — it cannot lead a one-pot"});
  });

  if(problems.length && typeof console!=="undefined"){
    console.warn("[Dinner How?] "+problems.length+" data/code drift issue(s) — the taxonomy has grown past what the code classifies:");
    problems.slice(0,12).forEach(p=>console.warn("   "+p.msg));
  }
  return problems;
}


/* ============================================================
   SEASONING TIMING — when the flavour goes into the pot.
   AUTHORED. This is cook's knowledge: a rempah is fried before anything else touches
   the pan; dang gui infuses for the whole simmer; lime juice goes in off the heat or
   it turns bitter. Getting this wrong ruins the dish, so it belongs in the timeline.
   ============================================================ */
const SEASON_TIMING={
  rempah:      {when:"before", mins:5,  label:"Fry the rempah",
                why:"fry the paste in oil until it darkens — before anything else goes in"},
  masala:      {when:"before", mins:3,  label:"Toast the spices",
                why:"bloom the whole spices in oil first, or they taste raw"},
  jp_curry:    {when:"end",    mins:5,  label:"Stir in the curry roux",
                why:"add the roux near the end and let it thicken"},
  korean:      {when:"before", mins:3,  label:"Fry the gochujang",
                why:"fry the chilli paste until the oil turns red"},
  hong_shao:   {when:"start",  mins:0,  label:"Add the soy and sugar",
                why:"in with the liquid — it needs the whole braise to glaze"},
  bkt_hokkien: {when:"start",  mins:0,  label:"Add the herbs",
                why:"dang gui and spices go in with the water and infuse throughout"},
  bkt_teochew: {when:"start",  mins:0,  label:"Add garlic and white pepper",
                why:"in from the start — the broth takes its whole character from them"},
  clear_chinese:{when:"start", mins:0,  label:"Add ginger and scallion",
                why:"in with the water"},
  milky_bone:  {when:"start",  mins:0,  label:"Aromatics in",
                why:"in from the start, then boil hard"},
  dashi_miso:  {when:"off",    mins:2,  label:"Whisk in the miso",
                why:"OFF the heat — boiling miso kills its aroma"},
  dashi_shoyu: {when:"end",    mins:2,  label:"Season with soy and mirin",
                why:"near the end, so it stays clean"},
  assam:       {when:"off",    mins:2,  label:"Lime, fish sauce, sugar",
                why:"OFF the heat — boiled lime juice turns bitter"},
  western_herb:{when:"start",  mins:0,  label:"Herbs and stock",
                why:"in with the liquid"}
};
function seasoningStep(key){ return SEASON_TIMING[key]||null; }



/* ============================================================
   WHICH POT? \u2014 you own pork AND fish; that does not mean you want a pork-and-fish pot.
   A pot has ONE protein identity. Throwing everything in is a category error: the
   engine should be choosing which pot to make, not making one pot out of everything.

   So: propose a pot per plausible base, then decide what else belongs in it \u2014
   using affinity (has anyone cooked these together?) and physics (does it survive?).
   ============================================================ */
function potSuggestions(baseIds, ctx, R, AFF, {have=[], limit=5}={}){
  const seen={};                       // ingredient id -> total precedent with the base
  baseIds.forEach(b=>{
    kinOf(b,R).forEach(k=>{
      Object.keys(AFF.pairs).forEach(key=>{
        if(key.indexOf(ctx+"|")!==0) return;
        const body=key.slice(ctx.length+1);
        const [x,y]=body.split("+");
        let other=null;
        if(x===k) other=y; else if(y===k) other=x;
        if(!other) return;
        const ing=R.byId[other]||{};
        if(ing.category==="proteins") return;            // a pot has one protein identity
        if(measureTypeOf(ing)==="assumed") return;       // aromatics are a given
        seen[other]=(seen[other]||0)+AFF.pairs[key].n;
      });
    });
  });
  const haveSet=new Set(have);
  const all=Object.entries(seen)
    .map(([id,n])=>({id, name:(R.byId[id]||{}).name||id, n, owned:haveSet.has(id)}))
    .sort((a,b)=>(b.owned-a.owned)||(b.n-a.n));
  return {
    // things you already have that go with this base — you might have forgotten them
    yours: all.filter(x=>x.owned).slice(0,limit),
    // things you'd have to buy, but that genuinely belong
    buy:   all.filter(x=>!x.owned).slice(0,limit)
  };
}

function potCandidates(ingIds, R, dishes, AFF){
  const real=ingIds.filter(id=>measureTypeOf(R.byId[id])!=="assumed");
  // a lean dry-heat cut (steak, loin, breast) can go IN a pot but can never LEAD one
  const canLead=(id)=> !!BROTH_BASE[id] && !BROTH_BASE[id].noBroth;
  const proteins=real.filter(id=>(R.byId[id]||{}).category==="proteins" && canLead(id));
  /* A dry-heat cut has no business in a simmering pot AT ALL — not as a base, and not
     as an addition. You do not drop a steak into a braise. Keep them out entirely and
     report them, so the cook knows why. */
  const dryHeat = real.filter(id=>{
    const b=BROTH_BASE[id];
    return b && b.noBroth;
  });
  const others  = real.filter(id=>!proteins.includes(id) && !dryHeat.includes(id));

  // group the proteins by species \u2014 a pork pot, a fish pot, a beef pot
  const speciesOf=(id)=>{
    const anc=R.anc[id]||new Set();
    for(const k of ["beef","pork","chicken","mutton","fish","prawn","squid","oyster"])
      if(anc.has(k)||id===k) return k;
    return id;
  };
  const bySpecies={};
  proteins.forEach(id=>{ const sp=speciesOf(id); (bySpecies[sp]=bySpecies[sp]||[]).push(id); });

  /* Cuts of one animal are ALTERNATIVES, not a combination. You do not put a thigh,
     a breast AND a whole chicken in the same pot — that is three chickens. Pick the
     one that best leads the broth (most body + depth), and offer the rest as swaps.
     (Pork ribs + pork belly IS a real pairing, but a whole bird excludes its own parts,
     and stacking two lean cuts adds nothing. So: one lead cut per species.) */
  Object.keys(bySpecies).forEach(sp=>{
    let cuts=bySpecies[sp];
    if(cuts.length<2) return;
    cuts=cuts.slice().sort((a,b)=>{
      const A=BROTH_BASE[a]||{}, B=BROTH_BASE[b]||{};
      // a cut that cannot carry a broth never leads, whatever its numbers
      if(!!A.noBroth !== !!B.noBroth) return A.noBroth ? 1 : -1;
      return ((B.body||0)+(B.depth||0)) - ((A.body||0)+(A.depth||0));
    });
    /* A WHOLE animal excludes its own parts — you don't add a thigh to a whole chicken.
       Otherwise, cuts CAN combine if they bring different things (ribs for body, belly
       for fat), but two cuts of the same character add nothing: pick the better one. */
    const whole=cuts.find(id=>/_whole$/.test(id));
    if(whole){
      bySpecies[sp]=[whole];
      bySpecies[sp].alternatives=cuts.filter(id=>id!==whole);
      return;
    }
    const keep=[]; const alts=[];
    cuts.forEach(id=>{
      const c=BROTH_BASE[id]||{};
      // does it add something the kept cuts don't already have?
      const adds = !keep.some(k=>{
        const K=BROTH_BASE[k]||{};
        return Math.abs((K.body||0)-(c.body||0))<=1 && Math.abs((K.depth||0)-(c.depth||0))<=1
            && Math.abs((K.sweetness||0)-(c.sweetness||0))<=1;
      });
      if(!keep.length || adds) keep.push(id); else alts.push(id);
    });
    bySpecies[sp]=keep.slice(0,2);           // at most two cuts in one pot
    bySpecies[sp].alternatives=alts.concat(keep.slice(2));
  });

  const pots=Object.entries(bySpecies).map(([sp,ids])=>{
    // which of your OTHER ingredients belong in THIS pot?
    /* Everything you own goes in the pot — physics permitting. A pot is forgiving:
       spinach in a chicken soup is fine whether or not a recipe in our thin catalogue
       happens to pair them. What affinity gives us is not a VETO but a CONFIDENCE:
       which additions are well-trodden, and which are your own invention. */
    const belongs=[], uncertain=[];
    others.forEach(o=>{
      let seen=0;
      ids.forEach(p=>{
        ["soup","braise"].forEach(ctx=>{
          const pr=AFF?precedentFor(p,o,ctx,AFF,R):{n:0};
          seen=Math.max(seen,pr.n);
        });
      });
      if(seen>0) belongs.push({id:o, n:seen});
      else uncertain.push({id:o, n:0});
    });
    belongs.sort((a,b)=>b.n-a.n);

    // the pot holds EVERYTHING you own — the well-trodden and the uncharted alike
    const contents=[...new Set(ids.concat(belongs.map(x=>x.id)).concat(uncertain.map(x=>x.id)))];
    const ch=brothCharacter(contents,R);
    const alts = ids.alternatives || [];
    return {
      species: sp,
      base: ids,
      baseNames: ids.map(id=>(R.byId[id]||{}).name||id),
      alternatives: alts,
      altNames: alts.map(id=>(R.byId[id]||{}).name||id),
      belongs, uncertain,
      contents,
      character: ch,
      describe: ch?describeBroth(ch):"a light vegetable pot",
      reminds: dishes ? brothLikeDishes(contents,R,dishes.filter(hasBroth),2) : [],
      suggest: AFF ? potSuggestions(ids, "soup", R, AFF, {have:real}) : {yours:[],buy:[]},
      dryHeat: dryHeat.map(id=>({id, name:(R.byId[id]||{}).name||id,
        why:(BROTH_BASE[id]||{}).note||"a dry-heat cut"})),
      // a pot is stronger when the things in it have precedent together
      strength: belongs.reduce((n,b)=>n+b.n,0)
    };
  });

  pots.sort((a,b)=>b.strength-a.strength);
  return pots;
}


/* ============================================================
   WHAT WOULD GO WELL IN THIS POT?
   The affinity graph knows what has been cooked with this base before. Use it to
   SUGGEST — both from what you own (things you might have forgotten) and from what
   you don't (a shopping nudge). This is the graph being generous rather than gatekeeping.
   ============================================================ */


/* ============================================================
   POT MODES — "one-pot" is not one thing.
   A soup, a braise and a baked rice all put everything in one vessel, but they cook by
   DIFFERENT HEAT, and that changes everything: which cuts work, what the liquid does,
   and whether staging even applies.

   • SOUP / BRAISE — wet heat, everything simmers together, staged by how long each
     thing needs. This is what the pot has been all along.
   • BAKED — dry heat in one dish. Nothing is "added at 38 minutes"; it mostly goes in
     together and comes out together. A steak is fine here. A tough cut is not.
   ============================================================ */
const POT_MODES=[
  {key:"soup",  label:"Soup or braise", vessel:["stovetop","pressure_cooker","slow_cooker"],
   heat:"wet",  note:"everything simmers together — staged by how long each thing needs"},
  {key:"baked", label:"Baked in one dish", vessel:["oven","air_fryer"],
   heat:"dry",  note:"dry heat — it mostly goes in together and comes out together"}
];

/* which cuts suit which heat? This is the two-axis meat model doing its job. */
function suitsHeat(id, heat, R){
  const i=R.byId[id]||{};
  const p=new Set(i.provides||[]);
  const b=BROTH_BASE[id]||{};
  if(i.category!=="proteins") return true;                 // vegetables are fine either way
  if(heat==="wet"){
    if(b.noBroth) return false;                            // steak, loin, breast: not in a pot
    return true;
  }
  // DRY heat: a tough collagen cut needs long wet cooking to soften. It will be leather.
  if(p.has("collagen_rich") && !["chicken_wing","chicken_whole","pork_belly"].includes(id)) return false;
  return true;
}

/* what CAN'T go in, given the heat, and why */
function heatMismatch(ingIds, heat, R){
  return ingIds.filter(id=>!suitsHeat(id,heat,R)).map(id=>{
    const i=R.byId[id]||{};
    const p=new Set(i.provides||[]);
    const why = heat==="wet"
      ? ((BROTH_BASE[id]||{}).note||"a dry-heat cut \u2014 sear it, don\u2019t simmer it")
      : (p.has("collagen_rich")
          ? "a tough cut \u2014 it needs long, wet cooking or it turns to leather"
          : "doesn\u2019t suit dry heat");
    return {id, name:i.name||id, why};
  });
}


/* ============================================================
   A BAKED ONE-DISH has no broth — it has a main protein and things roasted around it.
   So it needs its own candidate logic: which protein leads, what roasts alongside,
   and (crucially) which cuts would be ruined by dry heat.
   ============================================================ */
function bakeCandidates(ingIds, R, dishes, AFF){
  const real=ingIds.filter(id=>measureTypeOf(R.byId[id])!=="assumed");
  const ok=real.filter(id=>suitsHeat(id,"dry",R));
  const proteins=ok.filter(id=>(R.byId[id]||{}).category==="proteins");
  const others=ok.filter(id=>!proteins.includes(id));

  const speciesOf=(id)=>{
    const anc=R.anc[id]||new Set();
    for(const k of ["beef","pork","chicken","mutton","fish","prawn","squid","oyster"])
      if(anc.has(k)||id===k) return k;
    return id;
  };
  const bySpecies={};
  proteins.forEach(id=>{ const sp=speciesOf(id); (bySpecies[sp]=bySpecies[sp]||[]).push(id); });

  // one lead cut per species (same rule as the pot: cuts are alternatives)
  Object.keys(bySpecies).forEach(sp=>{
    const cuts=bySpecies[sp];
    if(cuts.length<2) return;
    const whole=cuts.find(id=>/_whole$/.test(id));
    const lead = whole || cuts[0];
    bySpecies[sp]=[lead];
    bySpecies[sp].alternatives=cuts.filter(id=>id!==lead);
  });

  return Object.entries(bySpecies).map(([sp,ids])=>{
    const belongs=[], uncertain=[];
    others.forEach(o=>{
      let seen=0;
      ids.forEach(p=>{
        const pr=AFF?precedentFor(p,o,"fried",AFF,R):{n:0};
        seen=Math.max(seen,pr.n);
      });
      (seen>0?belongs:uncertain).push({id:o, n:seen});
    });
    const contents=[...new Set(ids.concat(belongs.map(x=>x.id)).concat(uncertain.map(x=>x.id)))];
    return {
      species: sp,
      base: ids,
      baseNames: ids.map(id=>(R.byId[id]||{}).name||id),
      alternatives: ids.alternatives||[],
      altNames: (ids.alternatives||[]).map(id=>(R.byId[id]||{}).name||id),
      belongs, uncertain, contents,
      describe: "roasted \u2014 everything in one dish",
      dryHeat: heatMismatch(real,"dry",R),
      suggest: {yours:[],buy:[]},
      reminds: dishes ? dishes.filter(d=>{
        const t=((d.steps||[]).join(" ")).toLowerCase();
        return /roast|bake|oven/.test(t) && (d.grocery_items||[]).some(g=>ids.includes(g.id));
      }).slice(0,2).map(d=>({dish:d.name, closeness:"a baked dish with the same protein"})) : []
    };
  });
}

/* a bake is not staged minute-by-minute — dense things get a head start, that's all */
function buildBake(ingIds, R, opts){
  const real=[...new Set(ingIds.filter(id=>measureTypeOf(R.byId[id])!=="assumed"))];
  const APP=(opts&&opts.appliance)||null;
  const APPD=(opts&&opts.applData)||null;
  const groups={lead:[], dense:[], quick:[]};
  real.forEach(id=>{
    const i=R.byId[id]||{};
    const p=new Set(i.provides||[]);
    if(i.category==="proteins") groups.lead.push({id,name:i.name||id});
    else if(p.has("starchy")||p.has("holds_shape")) groups.dense.push({id,name:i.name||id});
    else groups.quick.push({id,name:i.name||id});
  });
  // the vessel changes the cook: an air fryer runs hotter and faster than an oven
  const mult = APPD && APPD.passive_multiplier!=null ? APPD.passive_multiplier : 1;
  const base = groups.lead.length ? 45 : 30;
  const total = Math.max(12, Math.round(base*mult));

  // ...but it is SMALL. A one-dish bake for four will not fit a 1.8-litre basket.
  const items = groups.lead.length + groups.dense.length + groups.quick.length;
  const vol = APPD && APPD.volume_litres ? APPD.volume_litres : null;
  const tooBig = vol!=null && vol<3 && items>=3;
  const steps=[];
  if(groups.dense.length) steps.push({at:0, from:0, to:0, cooks:total, critical:false,
    label:"Dense vegetables", why:"they take longest — give them a head start",
    items:groups.dense});
  if(groups.lead.length) steps.push({at:0, from:0, to:5, cooks:total, critical:false,
    label:"The protein", why:"in with the vegetables, so everything roasts together",
    items:groups.lead});
  if(groups.quick.length) steps.push({at:Math.round(total*0.6), from:Math.round(total*0.5), to:Math.round(total*0.7),
    cooks:Math.round(total*0.4), critical:false,
    label:"Quicker vegetables", why:"they'd burn if they went in at the start",
    items:groups.quick});
  const gaps=[];
  if(tooBig) gaps.push({what:"more room",
    why:"a "+vol+"-litre basket won\u2019t hold all this at once \u2014 you\u2019ll have to cook it in batches, or use the oven"});

  return {
    steps, total, handsOn:12, handsOff:Math.max(0,total-12),
    appliance: APP, multiplier: mult, tooBig,
    describe:"roasted in one dish",
    gaps,
    baked:true
  };
}

/* ============================================================
   THE WOK \u2014 a stir-fry is not a pot.
   A pot is forgiving: everything simmers, and a few minutes either way is fine.
   A wok is the opposite: high heat, short time, strict order, and the vegetable's
   STRUCTURE decides the technique.

   This is the okra/kangkong problem. Same sambal, different dish:
     kangkong \u2014 straight into the wok, 90 seconds, high heat
     okra     \u2014 blanch it first, and DON'T cut it, or it goes slimy
   The sauce is not what differs. The vegetable is.
   ============================================================ */
const WOK_CLASS=[
  {key:"aromatics", label:"Aromatics",        at:0,  secs:30,
   why:"garlic, ginger, chilli \u2014 30 seconds, until they smell sweet. Don't let them brown."},
  {key:"paste",     label:"The paste",        at:1,  secs:120,
   why:"fry it until the oil separates and it darkens \u2014 this is where the flavour is made"},
  {key:"protein",   label:"The protein",      at:3,  secs:120,
   why:"sear it, get colour, then push it to the side or lift it out"},
  {key:"dense",     label:"Dense vegetables", at:5,  secs:180,
   why:"they need the longest \u2014 blanch them first, or slice them thin"},
  {key:"firm",      label:"Firm vegetables",  at:8,  secs:120,
   why:"a couple of minutes over high heat"},
  {key:"quick",     label:"Quick vegetables", at:10, secs:90,
   why:"90 seconds \u2014 they should stay crisp"},
  {key:"sauce",     label:"The sauce",        at:11, secs:30,
   why:"in at the end, tossed through \u2014 it should coat, not stew"},
  {key:"leafy",     label:"Leafy greens",     at:12, secs:60,
   why:"last, 60 seconds, high heat \u2014 and DON'T cover the wok or they'll steam and go grey"},
  {key:"delicate",  label:"Fish slices, at the very end", at:13, secs:90,
   why:"slide them in off the fiercest heat and fold once or twice \u2014 they cook in about a minute and break apart if tossed"}
];

/* How does this vegetable behave in a wok? Derived from structure \u2014 which is exactly
   what makes okra and kangkong different. */
// a whole fish (pomfret, salmon, snapper…) is bought and cooked whole — you steam it or
// pan-fry it whole. A wok would break a delicate fish apart, so it never goes in one. Fish
// SLICES (dory, batang) are a fillet — they carry the fish family but are marked "filleted",
// and those DO stir-fry (gently, near the end).
function isWholeFish(id, R){ const p=(R.byId[id]||{}).provides||[]; return p.includes("fish_family") && !p.includes("filleted"); }
function wokBehaviour(id, R){
  const i=R.byId[id]||{};
  if(isWholeFish(id,R)) return {id, name:i.name||id, cls:null, wholeFish:true};
  const p=new Set(i.provides||[]);
  const g=i.group;

  /* A SAUCE IS NOT A VEGETABLE. Seasonings and pastes belong to the direction — they are
     not staged like an ingredient. Without this, sambal was appearing twice (once as the
     paste, once as a "quick vegetable") and dried shrimp was being told to "slice thin
     against the grain". */
  // dried shrimp and salted fish DO go in the wok — crisped with the aromatics, not
  // seared like a protein. Check them BEFORE the seasoning catch-all or they vanish.
  if(["dried_shrimp","salted_fish"].includes(id))
    return {id, name:i.name||id, cls:"aromatics", prep:"soak and chop",
      warn:"crisp it in the oil first \u2014 that's where its flavour comes from"};

  if(CHARACTER_SEASONINGS.has(id)) return {id, name:i.name||id, cls:null, seasoning:true};
  if(["condiments","seasonings","acids","sweeteners","fats_oils"].includes(i.category))
    return {id, name:i.name||id, cls:null, seasoning:true};

  // SPECIAL CASES \u2014 vegetables whose structure demands a technique.
  // These are authored because they're culinary facts, not derivable properties.
  const SPECIAL={
    okra:      {cls:"firm", prep:"blanch whole", warn:"don\u2019t cut it and don\u2019t crowd it \u2014 cut okra goes slimy"},
    eggplant:  {cls:"dense",prep:"salt and pre-fry", warn:"it drinks oil \u2014 fry it separately first, or it\u2019ll be greasy"},
    beansprouts:{cls:"quick",prep:"rinse", warn:"90 seconds at most \u2014 they must stay squeaky, not limp"},
    broccoli:  {cls:"dense",prep:"blanch", warn:"blanch it first or the stems will still be raw when the florets are dead"},
    kailan:    {cls:"dense",prep:"blanch the stems", warn:"the stems and the leaves cook at different speeds \u2014 split them"},
    long_beans:{cls:"firm", prep:"cut into lengths", warn:"they need real time \u2014 don\u2019t rush them"},
    carrot:    {cls:"dense",prep:"slice thin", warn:"slice it thin or it won\u2019t cook in wok time"},
    potato:    {cls:"dense",prep:"par-boil", warn:"a wok cannot cook a raw potato \u2014 par-boil it"},
    cabbage:   {cls:"firm", prep:"shred", warn:null},
    napa_cabbage:{cls:"firm",prep:"shred", warn:null}
  };
  if(SPECIAL[id]) return {id, name:i.name||id, ...SPECIAL[id]};

  if(i.category==="proteins"){
    if(p.has("filleted")) return {id,name:i.name,cls:"delicate",
      prep:"pat dry and cut into thick slices \u2014 they go in at the very end",
      warn:"delicate \u2014 fish slices break up if stirred hard"};
    if(i.form==="mince") return {id,name:i.name,cls:"protein",prep:"break it up in the wok",warn:null};
    return {id,name:i.name,cls:"protein",prep:"slice thin against the grain",
      warn:p.has("collagen_rich")?"a tough cut will not tenderise in a wok \u2014 slice it very thin, or use a quicker cut":null};
  }
  if(p.has("leafy")) return {id,name:i.name,cls:"leafy",prep:"wash and cut into lengths",
    warn:"in at the very end \u2014 and don\u2019t cover the wok"};
  if(g==="fungi")    return {id,name:i.name,cls:"quick",prep:"slice",warn:null};
  if(g==="fruiting") return {id,name:i.name,cls:"quick",prep:"chop",warn:null};
  if(g==="root"||p.has("starchy")) return {id,name:i.name,cls:"dense",prep:"slice thin",
    warn:"dense \u2014 slice it thin or par-cook it first"};
  if(g==="pods")     return {id,name:i.name,cls:"firm",prep:"trim",warn:null};
  if(g==="florets")  return {id,name:i.name,cls:"dense",prep:"blanch",warn:null};
  return {id,name:i.name,cls:"quick",prep:"chop",warn:null};
}

/* ---- STIR-FRY SEASONING DIRECTIONS ----
   A wok's sauces are not a pot's. There is no broth: the sauce COATS. AUTHORED \u2014 this is
   Singaporean/Cantonese kitchen convention, and a chef should own it. */
const STIRFRY_DIRS=[
  {key:"sambal",   label:"Sambal / belacan", region:"Malay/Peranakan",
   markers:["sambal","belacan","shrimp_paste"], need:1,
   note:"fry the paste until the oil separates \u2014 that's the whole dish",
   paste:true,
   steps:[
     {t:"Bloom the paste", d:"Fry the sambal (or pounded chilli-belacan) in plenty of oil over medium heat until the oil separates and turns red and fragrant \u2014 this is the base of the whole dish."},
     {t:"Toss through", d:"Turn the heat to high, add the protein and vegetables, and toss so everything is coated."},
     {t:"Balance", d:"Finish with a little sugar, salt and a squeeze of lime or tamarind to round it out."}]},
  {key:"garlic_oyster", label:"Garlic & oyster sauce", region:"Cantonese",
   markers:["oyster_sauce","garlic"], need:1,
   note:"the everyday one \u2014 garlic in the oil, oyster sauce at the end",
   paste:false,
   steps:[
     {t:"Garlic first", d:"Fry the chopped garlic in the hot oil for a few seconds until just fragrant \u2014 don't let it brown."},
     {t:"Mix the sauce", d:"Stir oyster sauce with a splash of light soy, a pinch of sugar and a little water or stock."},
     {t:"Glaze at the end", d:"Add the sauce once the protein and veg are almost done, toss to glaze, and thicken with a little cornstarch slurry if you like."}]},
  {key:"fu_yu",    label:"Fermented beancurd", region:"Cantonese",
   markers:["fermented_beancurd"], need:1,
   note:"mash it with a little water \u2014 funky, savoury, the classic for greens",
   paste:true,
   steps:[
     {t:"Mash it", d:"Mash a cube or two of fermented beancurd with a little of its brine and a splash of water into a smooth paste."},
     {t:"Bloom", d:"Fry garlic in oil, then add the mashed beancurd and let it sizzle for a few seconds."},
     {t:"Toss", d:"Add the greens and toss over high heat just until wilted."}]},
  {key:"salted_fish", label:"Salted fish", region:"Cantonese",
   markers:["salted_fish","dried_shrimp"], need:1,
   note:"crisp it in the oil first, then lift it out and return it at the end",
   paste:false,
   steps:[
     {t:"Crisp it", d:"Fry the diced salted fish in oil over medium heat until golden and crisp, then lift it out and set aside."},
     {t:"Fry in the oil", d:"Use the fragrant oil to fry the garlic, protein and veg over high heat."},
     {t:"Return it", d:"Toss the crisp salted fish back in at the end so it stays crunchy."}]},
  {key:"ginger_scallion", label:"Ginger & scallion", region:"Cantonese",
   markers:["ginger","scallion"], need:2,
   note:"light and clean \u2014 lets the vegetable speak",
   paste:false,
   steps:[
     {t:"Ginger in the oil", d:"Fry sliced ginger in the hot oil until fragrant to perfume it."},
     {t:"High and fast", d:"Add the protein and veg and toss over high heat; season with a splash of shaoxing, a little salt and white pepper."},
     {t:"Scallion last", d:"Add the scallion whites early and the greens at the very end, off the heat, so they stay fresh."}]},
  {key:"dark_soy", label:"Dark soy (mee goreng style)", region:"Singaporean",
   markers:["dark_soy_sauce","ketchup","white_sugar"], need:2,
   note:"sweet, dark and glossy",
   paste:false,
   steps:[
     {t:"Mix the sauce", d:"Stir dark soy, a little light soy, ketchup (or tomato) and sugar into a sweet, glossy sauce."},
     {t:"Toss over high heat", d:"Add it once the noodles or protein are hot, and toss hard so everything takes on the dark glaze."},
     {t:"Char", d:"Let it catch briefly on the hot wok for a smoky edge before serving."}]},
  {key:"mala", label:"Mala (\u9ebb\u8fa3)", region:"Sichuan",
   markers:["sichuan_peppercorn","doubanjiang","dried_chilli"], need:1,
   note:"numbing and hot \u2014 toast the peppercorns, then bloom the chilli and bean paste",
   paste:true,
   steps:[
     {t:"Toast the peppercorns", d:"Toast Sichuan peppercorns in the oil until fragrant, then add dried chilli and doubanjiang and fry until the oil turns red."},
     {t:"Bloom gently", d:"Keep the heat moderate so the bean paste and chilli bloom without burning \u2014 burnt mala turns bitter."},
     {t:"Toss & finish", d:"Toss the protein and veg through, and finish with a little sugar and more ground peppercorn for the numbing hit."}]},
  {key:"dried_chilli", label:"Dried chilli", region:"Sichuan",
   markers:["dried_chilli","chilli"], need:1,
   note:"bloom the chilli in oil until it darkens \u2014 don't burn it or it turns bitter",
   paste:false,
   steps:[
     {t:"Bloom the chilli", d:"Fry the dried chilli in oil over medium heat until it darkens and smells toasty \u2014 stop before it blackens or it turns bitter."},
     {t:"Aromatics", d:"Add garlic and ginger, then the protein, and toss over high heat."},
     {t:"Season", d:"Finish with a splash of soy, a pinch of sugar and a little vinegar for balance."}]},
  {key:"plain_garlic", label:"Just garlic", region:"\u2014",
   markers:[], need:0,
   note:"garlic, oil, salt. Sometimes that's the right answer.",
   paste:false,
   steps:[
     {t:"Garlic in the oil", d:"Fry a generous amount of chopped garlic in the oil until just golden and fragrant."},
     {t:"Toss", d:"Add the vegetable or protein and toss over high heat with a good pinch of salt."},
     {t:"Finish", d:"A splash of water or stock to steam it briefly, and it's done."}]}
];

/* ---- BUILD A STIR-FRY ----
   High heat, short time, strict order. Everything is in SECONDS, not windows: a wok is
   the opposite of a pot. Get it wrong by 60 seconds and you have a different dish. */
function buildStirFry(ingIds, R, dishes, AFF, opts){
  const dir=(opts&&opts.direction)||null;
  const real=[...new Set(ingIds.filter(id=>{
    const i=R.byId[id]||{};
    if(i.id==="water") return false;
    return measureTypeOf(i)!=="assumed" || CHARACTER_SEASONINGS.has(id);
  }))];

  const behaviours=real.map(id=>wokBehaviour(id,R)).filter(w=>w.cls);   // seasonings drop out
  const byClass={};
  behaviours.forEach(w=>{ (byClass[w.cls]=byClass[w.cls]||[]).push(w); });

  // the sauce direction contributes its own step
  const steps=[];
  let t=0;
  const push=(cls,items,extra)=>{
    const c=WOK_CLASS.find(x=>x.key===cls);
    if(!c||!items.length) return;
    const secs=(extra&&extra.secs)||c.secs, why=(extra&&extra.why)||c.why;
    steps.push({key:cls, label:c.label, at:t, secs, why,
      items, warn:items.map(i=>i.warn).filter(Boolean)});
    t+=Math.round(secs/60*10)/10;
  };

  const arom=[{name:"Garlic, and ginger or chilli if you like",warn:null}].concat(byClass.aromatics||[]);
  push("aromatics", arom);
  if(dir && dir.paste)
    push("paste",[{name:dir.label,warn:null}]);
  // the sear is NOT one-size-fits-all: pork belly must render (4-6 min), chicken pieces
  // must cook through (~4 min), squid toughens past 90s. Thin-sliced beef and prawns
  // really are 2-minute jobs. Calibrated against published wok recipes.
  {
    const items=byClass.protein||[];
    let secs=120, why=null;
    const searOf=(w)=>{
      const anc=R.anc[w.id]||new Set();
      if(w.id==="pork_belly") return [330,"pork belly first, on its own \u2014 let the fat render and the edges brown, 5\u20136 minutes, before anything else goes in"];
      if(anc.has("chicken")||w.id==="turkey") return [240,"sear, then keep it moving until no pink remains \u2014 chicken takes a real 4 minutes, longer than you think"];
      if(w.id==="squid") return [90,"90 seconds, no more \u2014 squid turns to rubber past that; it's done when it curls"];
      return [120,null];
    };
    items.forEach(w=>{ const [s,y]=searOf(w); if(s>secs){secs=s; why=y;} else if(s===90&&items.length===1){secs=90; why=y;} });
    push("protein", items, {secs, why:why||undefined});
  }
  push("dense",   byClass.dense||[]);
  push("firm",    byClass.firm||[]);
  push("quick",   byClass.quick||[]);
  if(dir && !dir.paste && dir.key!=="plain_garlic")
    push("sauce",[{name:dir.label,warn:null}]);
  push("leafy",   byClass.leafy||[]);
  push("delicate",byClass.delicate||[]);

  const totalSecs=steps.reduce((n,s)=>n+s.secs,0);
  const total=Math.max(4, Math.ceil(totalSecs/60));

  // PREP is where a stir-fry is won or lost \u2014 you cannot chop while the wok is hot
  const prep=behaviours.filter(w=>w.prep).map(w=>({name:w.name, prep:w.prep, warn:w.warn}));
  const prepMins=Math.max(5, Math.round(prep.length*1.5));

  // what would go well? the affinity graph, scoped to the WOK
  let suggest={yours:[],buy:[]};
  if(AFF){
    const base=real.filter(id=>(R.byId[id]||{}).category==="proteins");
    const key=base.length?base:real.slice(0,1);
    suggest=potSuggestions(key,"stir_fry",R,AFF,{have:real});
  }

  const sauceSteps = (dir&&dir.steps) ? dir.steps
    : [{t:"Garlic in the oil", d:"Fry chopped garlic in the hot oil until just golden, then toss everything through over high heat with a pinch of salt and a splash of water or stock."}];

  return {
    steps, prep, prepMins, total, handsOn: total+prepMins, handsOff: 0,
    direction: dir, sauceSteps,
    suggest,
    warnings: behaviours.map(w=>w.warn).filter(Boolean),
    reminds: dishes ? dishes.filter(d=>contextOf(d)==="stir_fry" &&
      (d.grocery_items||[]).some(g=>real.includes(g.id)))
      .slice(0,2).map(d=>({dish:d.name})) : []
  };
}

/* ============================================================
   WHICH STIR-FRY? \u2014 a wok is not a kitchen sink.
   A stir-fry is one protein and a vegetable or two, or just vegetables. Throwing in
   everything you own is not a dish; it's a mess. So propose coherent options, the way
   the pot proposes pots.
   ============================================================ */
function wokCandidates(ingIds, R, dishes, AFF){
  const real=[...new Set(ingIds.filter(id=>{
    const i=R.byId[id]||{};
    if(i.id==="water") return false;
    return measureTypeOf(i)!=="assumed" || CHARACTER_SEASONINGS.has(id);
  }))];
  const proteins=real.filter(id=>(R.byId[id]||{}).category==="proteins" &&
    !["dried_shrimp","salted_fish"].includes(id) && !isWholeFish(id,R));
  const wholeFish=real.filter(id=>isWholeFish(id,R));
  const veg=real.filter(id=>(R.byId[id]||{}).category==="vegetables");
  const rest=real.filter(id=>!proteins.includes(id) && !veg.includes(id) && !isWholeFish(id,R));

  const speciesOf=(id)=>{
    const anc=R.anc[id]||new Set();
    for(const k of ["beef","pork","chicken","mutton","fish","prawn","squid","oyster"])
      if(anc.has(k)||id===k) return k;
    return id;
  };
  const bySp={};
  proteins.forEach(id=>{ const sp=speciesOf(id); (bySp[sp]=bySp[sp]||[]).push(id); });

  const out=[];

  // one option per protein: that protein + the vegetables that go with it
  Object.entries(bySp).forEach(([sp,ids])=>{
    const lead=ids[0];                       // cuts are alternatives, as in the pot

    /* Rank the vegetables by PRECEDENT. But if nothing has precedent — which is common,
       because the catalogue has almost no meat stir-fries — the sort is a no-op and we'd
       silently return whatever came first in the array, dressed up as a recommendation.
       So fall back to PHYSICS, and say plainly that it's our call, not a precedent. */
    const scored=veg.map(v=>({id:v, n:AFF?precedentFor(lead,v,"stir_fry",AFF,R).n:0}));
    const anyPrecedent = scored.some(x=>x.n>0);

    let pick, basis;
    if(anyPrecedent){
      scored.sort((a,b)=>b.n-a.n);
      pick=scored.filter(x=>x.n>0).slice(0,2).map(x=>x.id);
      basis="precedent";
    } else {
      /* Physics: a stir-fry wants CONTRAST — something with bite against something soft,
         and things that cook in roughly the same time as the meat. Rank by how well the
         vegetable suits a wok, not by array order. */
      const rank=(v)=>{
        const w=wokBehaviour(v,R);
        if(w.cls==="quick") return 3;      // mushroom, tomato, peppers — made for a wok
        if(w.cls==="leafy") return 2;      // greens — the classic partner
        if(w.cls==="firm")  return 2;
        if(w.cls==="dense") return 0;      // needs blanching; more work, but fine
        return 1;
      };
      pick=veg.slice().sort((a,b)=>rank(b)-rank(a)).slice(0,2);
      basis="physics";
    }

    const names=pick.map(v=>(R.byId[v]||{}).name.toLowerCase());
    out.push({
      key:"prot_"+sp,
      label:(R.byId[lead]||{}).name+" stir-fry",
      lead:[lead],
      contents:[lead].concat(pick).concat(rest),
      basis,
      note: !pick.length ? "just the "+((R.byId[lead]||{}).name||"").toLowerCase()
          : basis==="precedent" ? "with "+names.join(" and ")
          : "with "+names.join(" and ")+" — our call, no recipe pairs these yet",
      leftOut: veg.filter(v=>!pick.includes(v)),
      alternatives: ids.slice(1)
    });
  });

  // a vegetable-only stir-fry \u2014 the commonest Singaporean side, and often the right answer
  if(veg.length){
    const pick=veg.slice(0,2);
    out.push({
      key:"veg",
      label:(pick.length>1?"Vegetable stir-fry":((R.byId[pick[0]]||{}).name+" stir-fry")),
      lead:[],
      contents:pick.concat(rest),
      note: pick.length>1 ? pick.map(v=>(R.byId[v]||{}).name.toLowerCase()).join(" and ")
                          : "just the greens",
      leftOut: veg.filter(v=>!pick.includes(v)),
      alternatives: []
    });
  }

  // everything \u2014 offered honestly, and flagged as probably too much
  if(real.length>4){
    out.push({
      key:"all",
      label:"Everything",
      lead:proteins.slice(0,1),
      contents:real.filter(id=>!isWholeFish(id,R)),
      note:"a wok this full will steam, not fry \u2014 do it in two batches or drop something",
      leftOut:[],
      alternatives:[],
      crowded:true
    });
  }
  return out;
}

/* ============================================================
   STEAM — the opposite of the wok.
   A wok has NO hands-off time; a steamer is almost ALL hands-off. You prep, you assemble
   on a plate, you set a timer and walk away, then a 30-second finish. So the model is not
   a sequence of timed stages (that was the wok) — it's: pick the SUBJECT, let its FORM
   decide how long and how hard to steam, dress it, and DON'T over-steam. Over-steaming is
   the one way to ruin a steamed dish: fish goes woolly, custard pockmarks, tofu weeps.
   ============================================================ */

// The subject's FORM decides everything: rolling vs gentle steam, and the minutes.
const STEAM_FORM={
  whole_fish:{label:"a whole fish",       mins:10, vigour:"rolling",
    why:"rolling steam, 8\u201312 min \u2014 the flesh should just part at the bone",
    warn:"take it off the moment it flakes; a minute too long and it turns woolly"},
  shellfish:{label:"shellfish",           mins:7,  vigour:"rolling",
    why:"rolling steam, 5\u20138 min \u2014 until the prawns curl or the shells open",
    warn:"the instant a clam opens it's done \u2014 discard any that stay shut"},
  fish_slices:{label:"fish slices",        mins:7,  vigour:"gentle",
    why:"GENTLE steam, ~6\u20138 min \u2014 sliced fish cooks fast; off the heat the moment it turns opaque",
    warn:"thin slices overcook in seconds \u2014 don't walk away from these"},
  ribs:{label:"pork ribs",                mins:18, vigour:"rolling",
    why:"rolling steam, ~18 min \u2014 the meat should pull from the bone",
    warn:"cut the ribs into 3 cm pieces or the centre stays raw"},
  poultry:{label:"chicken on the bone",   mins:18, vigour:"rolling",
    why:"rolling steam, ~18 min \u2014 bone-in pieces need real time",
    warn:"cut to an even size, or the thick pieces lag the thin ones"},
  mince:{label:"a minced-meat patty",     mins:15, vigour:"rolling",
    why:"rolling steam, ~15 min \u2014 an even, shallow patty cooks through",
    warn:"press it thin and even, or the middle steams slower than the edge"},
  custard:{label:"a savoury egg custard", mins:14, vigour:"gentle",
    why:"GENTLE steam \u2014 low heat, lid ajar, ~14 min",
    warn:"fierce steam pockmarks a custard and turns it spongy \u2014 keep it low"},
  tofu:{label:"tofu",                     mins:9,  vigour:"gentle",
    why:"gentle steam, ~8\u201310 min \u2014 just to heat it through",
    warn:"hard steam splits silken tofu and makes it weep water"},
  dense_veg:{label:"a dense vegetable",   mins:10, vigour:"rolling",
    why:"rolling steam, ~10 min \u2014 until a chopstick slides through with no resistance",
    warn:"tip away the water that collects on the plate, or the dish turns watery"}
};
const STEAM_FISH=["fish","pomfret","seabass","snapper","grouper","threadfin","mackerel","cod","salmon","tuna","sardine","fish_cake"];

// Which form is THIS ingredient, on its own? (seasonings/character pastes return null)
function steamFormOf(id, R){
  const i=R.byId[id]||{};
  if(id==="pork_ribs") return "ribs";
  if(i.form==="mince") return "mince";
  if(/^chicken/.test(id)||id==="turkey") return "poultry";
  if(["prawn","clams","oyster","squid","scallops","mussels"].includes(id)) return "shellfish";
  if((i.provides||[]).includes("filleted")) return "fish_slices";
  if(id==="egg") return "custard";
  if(id==="tofu") return "tofu";
  if(STEAM_FISH.includes(id)) return "whole_fish";
  // a real dense vegetable can be the subject — but an aromatic (ginger, garlic, chilli) cannot
  if(i.category==="vegetables" && measureTypeOf(i)!=="assumed") return "dense_veg";
  return null;   // beef, mutton, aromatics, seasonings — not a steaming subject
}

// form-specific prep for the subject (the thing the recipes actually tell you to do)
function subjectPrep(form, name, id){
  if(form==="shellfish"){
    if(id==="clams") return {name, prep:"purge in salted water for an hour, then scrub", warn:"discard any that don't close"};
    if(id==="prawn") return {name, prep:"butterfly, leaving the shell on the back", warn:null};
    return {name, prep:"clean and leave whole", warn:null};
  }
  const P={
    whole_fish:{prep:"scale, gut and score twice on each side", warn:"scoring lets the steam reach the bone"},
    shellfish: {prep:"clean", warn:null},
    fish_slices:{prep:"cut into thick, even slices and pat dry", warn:"slices this thin cook in minutes \u2014 keep the steam gentle"},
    ribs:      {prep:"cut into 3 cm pieces", warn:"small pieces or the centre stays raw"},
    poultry:   {prep:"cut into even, bite-size pieces", warn:null},
    mince:     {prep:"season, then press into an even, shallow patty", warn:"even and thin, or the middle lags"},
    custard:   {prep:"beat with the liquid, then STRAIN", warn:"straining is what makes it silky"},
    tofu:      {prep:"slice thick, keeping the block shape", warn:"handle silken tofu gently"},
    dense_veg: {prep:"cut into even batons so it cooks evenly", warn:null}
  };
  const e=P[form]||{prep:"prepare",warn:null};
  return {name, prep:e.prep, warn:e.warn};
}

// For a plate of mixed vegetables, each vegetable is prepped for the steamer according to
// its group — roots into batons, leaves separated, mushrooms trimmed, and so on — rather
// than every one getting the generic "batons" line.
function vegPrep(id, R){
  const i=R.byId[id]||{}; const g=i.group; const name=i.name||id;
  let prep;
  if(g==="root")          prep="cut into even batons so it cooks evenly";
  else if(g==="florets")  prep="break into bite-size florets";
  else if(g==="leafy")    prep="separate the leaves; halve any large ones";
  else if(g==="fungi")    prep = id==="enoki" ? "trim the root base and pull into small clumps"
                                              : "trim; halve larger caps, leave small ones whole";
  else if(g==="fruiting") prep="cut into thick rounds so they steam through";
  else if(g==="pods")     prep="trim; cut long ones into lengths";
  else                    prep="cut into even, bite-size pieces";
  return {name, prep, warn:null};
}

/* ---- STEAM SEASONING DIRECTIONS ----
   The topping and the finish. AUTHORED \u2014 this is the construct of a steamed dish across
   the cuisines that steam: Cantonese (hot oil over aromatics), Teochew (salted-veg sour),
   Peranakan (a rempah steamed IN), Thai (a raw sauce poured over), Japanese (restraint). */
const STEAM_DIRS=[
  {key:"ginger_scallion", label:"Ginger, scallion & hot oil", region:"Cantonese",
   markers:["ginger","scallion"], need:2,
   note:"the everyday one \u2014 smoking oil over the scallion, a good soy at the end",
   steps:[
     {t:"Cut the aromatics", d:"Finely shred a big handful of scallion and young ginger; drop them in cold water so they curl."},
     {t:"After steaming", d:"Pour off the watery liquid from the plate, pile the scallion and ginger on top, and drizzle with light soy."},
     {t:"The hot oil", d:"Heat 3 tbsp oil until it just smokes and pour it over so the aromatics sizzle and bloom, then a few drops of sesame oil."}]},
  {key:"superior_soy", label:"Superior soy (clean)", region:"Cantonese",
   markers:["light_soy_sauce","soy_sauce"], need:1,
   note:"just the fish \u2014 a good soy, hot oil, coriander. Let it speak.",
   steps:[
     {t:"The sauce", d:"Warm 3 tbsp light soy with 1 tsp sugar and 2 tbsp water (or the steaming juices) until the sugar melts."},
     {t:"After steaming", d:"Pour the warm soy around the fish and pile shredded scallion and ginger on top."},
     {t:"The hot oil", d:"Pour smoking-hot oil over the aromatics, then scatter coriander."}]},
  {key:"black_bean", label:"Black bean & garlic", region:"Cantonese",
   markers:["fermented_black_bean","garlic"], need:1,
   note:"rinse and mash the black beans with garlic and a little chilli, then steam it on",
   steps:[
     {t:"Mash the beans", d:"Rinse 2 tbsp fermented black beans and lightly mash with garlic, a little chilli and a pinch of sugar."},
     {t:"Onto the subject", d:"Spread the black-bean mix over the fish or ribs before they go in, so it steams into them."},
     {t:"Finish", d:"Scatter scallion and spoon a little hot oil over."}]},
  {key:"minced_garlic", label:"Minced garlic", region:"Cantonese",
   markers:["garlic"], need:1,
   note:"gently fried garlic spooned over \u2014 the classic for prawns and tofu",
   steps:[
     {t:"Fry the garlic", d:"Gently fry a lot of minced garlic in oil until pale gold \u2014 stop before it browns, or it turns bitter."},
     {t:"Onto the subject", d:"Spoon the garlic and its oil over the prawns or tofu before steaming."},
     {t:"Finish", d:"Scatter scallion and a little more hot oil."}]},
  {key:"salted_egg", label:"Salted egg", region:"Cantonese",
   markers:["salted_egg"], need:1,
   note:"mash the salted yolk through minced pork, or set it over the dish",
   steps:[
     {t:"Mash the yolk", d:"Steam or boil the salted egg, then mash the yolk to a paste with a little oil; chop the white."},
     {t:"Work it in", d:"Beat it through minced meat, or spread it over the subject before steaming."},
     {t:"Finish", d:"The yolk turns oily and orange as it steams; finish with scallion."}]},
  {key:"salted_veg", label:"Salted vegetable & sour", region:"Teochew",
   markers:["salted_vegetable","tomato"], need:1,
   note:"kiam chai, tomato and a sour edge \u2014 the Teochew way with fish",
   steps:[
     {t:"Rinse & slice", d:"Rinse the salted vegetable well and slice; if it's very salty, soak it a few minutes first."},
     {t:"Layer & steam", d:"Layer the salted veg, sliced tomato and a little ginger over the fish and steam them together."},
     {t:"Finish", d:"Spoon the tangy plate juices back over, then scallion and a little hot sesame oil."}]},
  {key:"rempah", label:"Spiced paste (otak)", region:"Peranakan",
   markers:["candlenut","shrimp_paste","belacan","laksa_paste","curry_paste_pack","turmeric"], need:1,
   note:"a rempah beaten with coconut and egg, steamed in a banana-leaf parcel",
   paste:true,
   steps:[
     {t:"Pound the rempah", d:"Blend candlenut, turmeric, galangal, lemongrass, soaked dried chilli and shrimp paste to a smooth paste."},
     {t:"Beat it in", d:"Beat the rempah into the mashed fish with coconut milk and egg until thick and sticky."},
     {t:"Wrap & steam", d:"Spoon into banana-leaf parcels or a shallow tray and steam until set and springy \u2014 no finishing sauce."}]},
  {key:"chilli_lime", label:"Chilli, lime & garlic", region:"Thai",
   markers:["lime","fish_sauce"], need:1,
   note:"sharp, sour and hot, poured over at the end \u2014 pla neung manao",
   steps:[
     {t:"Pound & mix", d:"Pound garlic and bird's-eye chilli, then stir in lime juice, fish sauce and a little sugar to a sharp, hot dressing."},
     {t:"After steaming", d:"Pour the raw dressing over the just-cooked fish and return it to the steam for 1 minute."},
     {t:"Finish", d:"Cover with plenty of coriander."}]},
  {key:"dashi_sake", label:"Dashi custard / sake", region:"Japanese",
   markers:["dashi","sake","kombu","mirin"], need:1,
   note:"a savoury dashi custard, or clams opened in sake \u2014 keep it clean",
   steps:[
     {t:"The liquid", d:"For a custard, warm dashi with a little soy and mirin; for clams, scatter garlic and ginger and pour over sake."},
     {t:"Keep it gentle", d:"A custard barely wobbles when set; clams are done the instant they open."},
     {t:"Finish", d:"A swirl of soy, or butter through the sake liquor, then scallion."}]},
  {key:"green_chutney", label:"Green chutney (Parsi)", region:"Indian",
   markers:["coconut","mint","cumin","turmeric"], need:1, wrap:true,
   note:"a fresh coconut-coriander-mint chutney, coated on and steamed in a leaf \u2014 patra ni machi",
   steps:[
     {t:"Blend the chutney", d:"Grind grated coconut, coriander, mint, green chilli, garlic, ginger, cumin, a little sugar and lime into a smooth green paste."},
     {t:"Coat & wrap", d:"Marinate the fish in lime, turmeric and salt, coat it all over with the chutney, and wrap in a softened banana leaf or parchment."},
     {t:"Steam", d:"Steam the parcel 12\u201315 min until the fish flakes and the chutney is set and fragrant \u2014 no finishing sauce."}]},
  {key:"salted_fish", label:"Salted fish", region:"Cantonese",
   markers:["salted_fish"], need:1,
   note:"pungent and savoury \u2014 diced salted fish steamed over a minced-pork patty",
   steps:[
     {t:"Prep the salted fish", d:"Rinse and finely dice the salted fish; fry it briefly in a little oil for a milder, nuttier taste."},
     {t:"Onto the subject", d:"Scatter it over a seasoned minced-pork patty (or the fish) with a little ginger before steaming."},
     {t:"Finish", d:"Spoon the savoury oil back over and finish with scallion."}]},
  {key:"white_wine", label:"White wine & herbs", region:"Western",
   markers:["white_wine","parsley","butter"], need:1,
   note:"garlic, white wine and butter, finished with parsley and lemon \u2014 moules or en papillote",
   steps:[
     {t:"The aromatics", d:"Soften chopped shallot and garlic in butter, then pour in white wine and a bay leaf and bring to a boil."},
     {t:"Steam", d:"Steam mussels covered 3\u20134 min until they open (discard any that stay shut), or seal fish in parchment with wine, butter and lemon and steam ~12 min."},
     {t:"Finish", d:"Stir plenty of chopped parsley through the briny liquor, with a squeeze of lemon."}]},
  {key:"plain", label:"Just ginger", region:"\u2014",
   markers:[], need:0,
   note:"ginger under it, a little soy after. Sometimes that's enough.",
   steps:[
     {t:"After steaming", d:"Pour off the watery liquid, drizzle a little soy, and pour a spoon of hot oil over the top."}]}
];

/* ---- BUILD A STEAMED DISH ----
   Assemble \u2192 steam (form decides) \u2192 finish. Almost all hands-off. */
function buildSteam(ingIds, R, dishes, AFF, opts){
  const dir=(opts&&opts.direction)||null;
  const real=[...new Set(ingIds.filter(id=>{
    const i=R.byId[id]||{};
    if(i.id==="water") return false;
    return measureTypeOf(i)!=="assumed" || CHARACTER_SEASONINGS.has(id);
  }))];

  // the subject: highest-priority steaming protein, else a dense vegetable
  const PRIORITY=["whole_fish","shellfish","fish_slices","ribs","poultry","mince","custard","tofu","dense_veg"];
  const forms=opts&&opts.form ? [opts.form] :
    [...new Set(ingIds.map(id=>steamFormOf(id,R)).filter(Boolean))]
      .sort((a,b)=>PRIORITY.indexOf(a)-PRIORITY.indexOf(b));
  const form=forms[0]||"dense_veg";
  const info=STEAM_FORM[form];

  // the subject ingredient itself (for the name and prep)
  const subjId = (opts&&opts.subject) ||
    ingIds.find(id=>steamFormOf(id,R)===form) || ingIds[0];
  const subjName=((R.byId[subjId]||{}).name)||subjId;

  // prep: the subject (or, for a mixed-vegetable plate, each vegetable), then topping/paste and bed
  const minced  = !!(dir && dir.paste);           // otak: the fish is minced into a paste
  const wrapped = minced || !!(dir && dir.wrap);   // otak / green chutney: steamed in a leaf parcel
  let prep;
  if(form==="dense_veg"){
    const vegIds = real.filter(id=>steamFormOf(id,R)==="dense_veg");
    prep = (vegIds.length?vegIds:[subjId]).map(id=>vegPrep(id,R));
  } else {
    prep = [ minced && form==="whole_fish"
      ? {name:subjName, prep:"fillet and mash to a paste", warn:"a fish paste, not a whole fish \u2014 otak is a custard"}
      : subjectPrep(form, subjName, subjId) ];
  }
  if(dir && dir.paste) prep.push({name:dir.label, prep:"pound to a smooth paste and beat into the mix with coconut and egg", warn:null});
  else if(dir && dir.wrap) prep.push({name:dir.label, prep:"blend to a smooth paste and coat the subject all over", warn:null});
  else if(dir && dir.key==="black_bean") prep.push({name:"Black bean & garlic", prep:"rinse and lightly mash together", warn:null});
  else if(dir && dir.key==="minced_garlic") prep.push({name:"Garlic", prep:"mince and fry gently until pale gold \u2014 don't brown it", warn:"browned garlic turns bitter"});

  // A BED does one of two jobs. (1) A LIFT: a couple of smashed scallion stalks or ginger
  // under a whole fish, holding it off the plate so steam reaches underneath and the skin
  // doesn't stick. (2) A COLLECTOR: an absorbent layer that drinks the flavourful juices the
  // subject renders \u2014 glass noodles, tofu, napa cabbage, lettuce. Collectors go only under
  // things that render (fish and shellfish), and only ONE at a time.
  // the fish's plate partner: an absorbent bed under it, OR — Teochew-style — tomato laid over
  // it for a sweet-sour edge. Absorbent beds win if present; tomato beats a plain lettuce bed,
  // which is the weakest of the four.
  const COLLECTORS=["glass_noodles","tofu","napa_cabbage","tomato","lettuce"];
  const collector = (!wrapped && (form==="whole_fish"||form==="shellfish"))
    ? COLLECTORS.find(id=>real.includes(id) && id!==subjId) : null;
  const collName = collector ? ((R.byId[collector]||{}).name||collector) : null;
  const isBed = collector && collector!=="tomato";   // tomato sits over the fish, not under it
  if(collector) prep.push({name:collName,
    prep: collector==="glass_noodles" ? "soak until pliable, then lay as a bed to drink the juices"
        : collector==="tofu" ? "slice and lay as a bed \u2014 it soaks up the sauce (Hunan-style)"
        : collector==="tomato" ? "cut into wedges and lay over and around the fish \u2014 Teochew-style, for a sweet-sour edge"
        : "shred and lay as a bed under the subject to catch the juices", warn:null});

  const prepMins=Math.max(4, 3+prep.length*2);
  const finishMins=1;
  const total=prepMins+info.mins+finishMins;

  // assembly + finish sentences
  const assemble = minced
    ? "Beat the mix until thick and sticky, then spoon into banana-leaf parcels or a shallow foil tray."
    : wrapped
    ? "Coat the subject all over with the "+(dir?dir.label.toLowerCase().replace(/ \(.*\)/,""):"paste")+" and fold it into a softened banana-leaf or parchment parcel."
    : form==="custard"
    ? "Divide any solids between cups and pour the strained custard over."
    : form==="whole_fish"
    ? "Lay a couple of smashed scallion stalks (and ginger) under the fish so it sits off the plate and steams evenly"+(isBed?", on the "+collName+" bed":"")+(collector==="tomato"?"; lay tomato slices over and around it":"")+", then pile the aromatics over the top."
    : "Lay half the aromatics under the subject and the rest on top"+(isBed?", over the "+collName+" bed":"")+(collector==="tomato"?"; tuck tomato slices alongside":"")+".";
  const sauceSteps = (dir&&dir.steps) ? dir.steps
    : [{t:"After steaming", d:"Pour off the watery liquid, drizzle a little soy, and pour a spoon of hot oil over the top."}];

  // what would go well? the affinity graph, scoped to STEAM
  let suggest={yours:[],buy:[]};
  if(AFF){
    const base=real.filter(id=>steamFormOf(id,R) && steamFormOf(id,R)!=="dense_veg");
    const key=base.length?base:[subjId];
    suggest=potSuggestions(key,"steam",R,AFF,{have:real});
  }

  return {
    subject:subjId, subjectName:subjName, form, formInfo:info,
    prep, prepMins, assemble,
    steam:{mins:info.mins, vigour:info.vigour, why:info.why, warn:info.warn},
    sauceSteps, total, handsOn:prepMins+finishMins, handsOff:info.mins,
    direction:dir, suggest,
    warnings:[info.warn].filter(Boolean),
    reminds: dishes ? dishes.filter(d=>contextOf(d)==="steam" &&
      (d.grocery_items||[]).some(g=>real.includes(g.id)))
      .slice(0,2).map(d=>({dish:d.name})) : []
  };
}

/* ============================================================
   WHICH STEAM? \u2014 a steamer plates one subject, not a pile.
   Offer coherent options the way the wok and the pot do: one fish, or the prawns, or a
   custard \u2014 each a complete dish, with a plain honest note.
   ============================================================ */
function steamCandidates(ingIds, R, dishes, AFF){
  const real=[...new Set(ingIds.filter(id=>{
    const i=R.byId[id]||{};
    if(i.id==="water") return false;
    return measureTypeOf(i)!=="assumed" || CHARACTER_SEASONINGS.has(id);
  }))];
  const nm=id=>((R.byId[id]||{}).name)||id;

  // group by form
  const byForm={};
  ingIds.forEach(id=>{ const f=steamFormOf(id,R); if(f){ (byForm[f]=byForm[f]||[]).push(id); } });

  // the only real "bed" is a single absorbent collector under fish or prawns.
  const COLLECTORS_C=["glass_noodles","tofu","napa_cabbage","tomato","lettuce"];
  const topping=real.filter(id=>CHARACTER_SEASONINGS.has(id));

  const out=[];
  const LABELS={whole_fish:"Steamed ", shellfish:"Steamed ", fish_slices:"Steamed ", ribs:"Steamed ",
    poultry:"Steamed ", mince:"Steamed ", tofu:"Steamed ", dense_veg:"Steamed "};
  const NOTE={
    whole_fish:"a whole fish, on a bed of ginger \u2014 the flesh just parting at the bone",
    shellfish:"quick and briny \u2014 5 to 8 minutes, no more",
    fish_slices:"a delicate fillet \u2014 a quick, gentle steam",
    ribs:"chopped small so they cook through \u2014 about 18 minutes",
    poultry:"bone-in pieces \u2014 they need the full time",
    mince:"an even patty \u2014 the local everyday steam",
    tofu:"gentle \u2014 just to heat it through without splitting it",
    dense_veg:"steamed soft, then dressed \u2014 no protein needed"
  };
  const PRIORITY=["whole_fish","shellfish","fish_slices","ribs","poultry","mince","custard","tofu","dense_veg"];

  // custard is special: egg + a steaming liquid (dashi / stock) = a savoury custard
  const hasLiquid = ingIds.some(id=>["dashi","broth","kombu"].includes(id));
  PRIORITY.forEach(form=>{
    if(form==="custard"){
      if((byForm.custard||[]).length && (hasLiquid || Object.keys(byForm).every(f=>f==="custard"))){
        const solids=real.filter(id=>{const f=steamFormOf(id,R); return f && f!=="custard" && f!=="dense_veg";});
        out.push({key:"custard", label:"Savoury egg custard", subject:"egg", form:"custard",
          contents:["egg"].concat(solids.slice(0,2)).concat(topping),
          note:"chawanmushi-style \u2014 gentle steam, or it goes spongy",
          leftOut:[], alternatives:[]});
      }
      return;
    }
    const ids=byForm[form]; if(!ids||!ids.length) return;
    if(form==="dense_veg"){
      // one clean vegetable option, not a bed bolted onto every subject
      const label = ids.length>1 ? "Steamed vegetables" : "Steamed "+nm(ids[0]);
      out.push({key:"dense_veg", label, subject:ids[0], form:"dense_veg",
        contents:ids.concat(topping),
        note: ids.length>1 ? "a plate of mixed vegetables, steamed soft then dressed" : NOTE.dense_veg,
        leftOut:[], alternatives:[]});
      return;
    }
    const subj=ids[0];
    const bedFor = (form==="whole_fish"||form==="shellfish")
      ? COLLECTORS_C.filter(id=>real.includes(id) && id!==subj).slice(0,1) : [];
    // whole fish and shellfish are distinct dishes per species — a pomfret and a sea bass
    // are different choices, not alternatives of one card. Give each its own candidate.
    // Guard rails: processed fish (fish cake) never gets its own whole-fish card, and the
    // split is capped at 4 so a big seafood haul can't flood the list — extras show as
    // "left out" on the last card instead.
    const PROCESSED_FISH=["fish_cake"];
    const splitIds = form==="whole_fish" ? ids.filter(id=>!PROCESSED_FISH.includes(id)) : ids;
    if((form==="whole_fish"||form==="shellfish") && splitIds.length>1){
      const CAP=4;
      const cardIds=splitIds.slice(0,CAP);
      const overflow=splitIds.slice(CAP).concat(form==="whole_fish"?ids.filter(id=>PROCESSED_FISH.includes(id)):[]);
      cardIds.forEach((fid,idx)=>{
        const bed = COLLECTORS_C.filter(id=>real.includes(id) && id!==fid).slice(0,1);
        out.push({key:form+"_"+fid, label:LABELS[form]+nm(fid), subject:fid, form,
          contents:[fid].concat(bed).concat(topping),
          note:NOTE[form],
          leftOut: idx===cardIds.length-1 ? overflow : [],
          alternatives: cardIds.filter(x=>x!==fid)});
      });
      return;
    }
    // single-card path: for whole fish, a real fish always beats processed (fish cake)
    // as the card's subject, regardless of selection order
    const subj2 = (form==="whole_fish" && splitIds.length) ? splitIds[0] : subj;
    const bedFor2 = (form==="whole_fish"||form==="shellfish")
      ? COLLECTORS_C.filter(id=>real.includes(id) && id!==subj2).slice(0,1) : [];
    out.push({key:form, label:LABELS[form]+nm(subj2), subject:subj2, form,
      contents:[subj2].concat(bedFor2).concat(topping),
      note:NOTE[form],
      leftOut:ids.filter(x=>x!==subj2),
      alternatives:ids.filter(x=>x!==subj2)});
  });

  if(!out.length){
    // nothing obviously steamable — offer the aromatics honestly
    out.push({key:"plain", label:"Steamed \u2014 add a subject", subject:real[0]||null, form:"dense_veg",
      contents:real, note:"add a fish, some prawns, minced pork, tofu or an egg \u2014 the steam builds around it",
      leftOut:[], alternatives:[]});
  }
  return out;
}

/* ============================================================
   ONE-DISH RICE — rice plus one topping, a whole meal in a bowl.
   The decision that defines it is the FORK: do you cook the topping IN the rice, or cook
   the rice SEPARATELY and ladle the topping over?
     • IN the rice (claypot, yam rice, takikomi): the topping's fat and moisture render down
       into the grain as it cooks, and a crust forms at the bottom. One pot, mostly hands-off.
     • OVER the rice (donburi, lu rou, curry, roast): the topping is a braise/simmer/roast with
       its own sauce, made separately and ladled over plain rice. The sauce is the moisture,
       and the rice can be one you already have — leftover rice is ideal.
   A rice bowl is only good if every spoonful carries MOISTURE and at least two TEXTURES. A
   bowl of dry lean meat over rice is the failure mode, so the engine checks for it.
   ============================================================ */
const RICE_MODES={
  in_rice:{key:"in_rice", label:"Cooked in the rice", tag:"one pot \u00b7 renders in \u00b7 crust",
    why:"the topping cooks on the rice and its fat and moisture render down into the grain; a golden crust forms at the bottom"},
  over_rice:{key:"over_rice", label:"Rice cooked separately", tag:"topping ladled over \u00b7 rice can be leftover",
    why:"a braise, simmer or roast in its own pot, ladled over plain rice \u2014 the sauce is the moisture, and the rice can be one you already have"}
};

/* ---- RICE-BOWL DIRECTIONS ---- each carries the MODE it implies. AUTHORED. */
const RICE_DIRS=[
  {key:"claypot", label:"Claypot dark soy", region:"Cantonese", mode:"in_rice",
   markers:["dark_soy_sauce","lap_cheong","chicken_thigh"], need:1,
   note:"marinated chicken and lap cheong on the rice, a dark sweet soy \u2014 the crust at the bottom is the prize",
   steps:[
     {t:"The marinade", d:"Mix dark soy for colour with light soy, oyster sauce, shaoxing and sesame oil."},
     {t:"Marinate", d:"Coat the chicken (and lap cheong) and leave 20 minutes before it goes on the rice."},
     {t:"Finish", d:"Drizzle a little more dark soy over the cooked rice and toss until every grain is glossy."}]},
  {key:"lap_cheong", label:"Lap cheong & mushroom", region:"Cantonese", mode:"in_rice",
   markers:["lap_cheong","shiitake_dried"], need:1,
   note:"the sausage fat is the whole point \u2014 it melts into the rice as it cooks",
   steps:[
     {t:"Slice thin", d:"Slice the lap cheong thin so its sweet fat melts into the rice as it steams."},
     {t:"Season lightly", d:"A little light and dark soy is all it needs \u2014 the sausage does the work."},
     {t:"Finish", d:"Toss through with scallion once the crust has set."}]},
  {key:"yam_shrimp", label:"Yam & dried shrimp", region:"Teochew", mode:"in_rice",
   markers:["yam","dried_shrimp","sweet_potato"], need:1,
   note:"diced yam and dried shrimp fried, then cooked through the rice \u2014 Teochew",
   steps:[
     {t:"Fry the base", d:"Fry sliced shallot and garlic until golden, then the soaked dried shrimp, until fragrant."},
     {t:"Toss the yam", d:"Add the diced yam with dark and light soy and white pepper, then stir it through the raw rice."},
     {t:"Finish", d:"Top with crisp fried shallots and scallion."}]},
  {key:"soy_braise", label:"Soy-braised (lu rou)", region:"Cantonese", mode:"over_rice",
   markers:["pork_belly","star_anise","five_spice"], need:1,
   note:"pork belly braised soft in dark soy and five-spice, ladled over with a braised egg",
   steps:[
     {t:"Brown & aromatics", d:"Brown the pork belly until the fat renders, then add garlic, ginger, star anise and cinnamon."},
     {t:"The braise", d:"Add dark and light soy, sugar, shaoxing and water; slip in peeled boiled eggs and braise gently ~45 min until dark and glossy."},
     {t:"Ladle over", d:"Spoon the pork, an egg and plenty of the sauce over the rice \u2014 the sauce is what makes the bowl."}]},
  {key:"roast", label:"Roast meat over rice", region:"Cantonese", mode:"over_rice",
   markers:["char_siu"], need:1,
   note:"sliced char siu or roast pork, a spoon of glossy sauce, a little blanched green",
   steps:[
     {t:"Slice", d:"Slice the char siu or roast pork thickly."},
     {t:"The sauce", d:"Warm oyster sauce, light and dark soy, sugar, sesame oil and a little water into a glossy sauce."},
     {t:"Assemble", d:"Lay the meat and a blanched green over the rice and spoon the sauce over."}]},
  {key:"hainanese", label:"Hainanese chicken rice", region:"Cantonese", mode:"over_rice",
   markers:["chicken_whole","pandan"], need:1,
   note:"chicken poached gently, rice cooked in its fat and stock, chilli-ginger on the side",
   steps:[
     {t:"Poach & keep the stock", d:"Poach the chicken gently, then plunge it into iced water for glossy skin; keep the poaching stock."},
     {t:"Rice in the fat", d:"Fry garlic and ginger in sesame oil, toss the rice until glossy, then cook it in the reserved stock."},
     {t:"The sauces", d:"Serve with light soy, a chilli-ginger sauce and a bowl of the hot stock on the side."}]},
  {key:"donburi", label:"Donburi (dashi & egg)", region:"Japanese", mode:"over_rice",
   markers:["dashi","mirin"], need:1,
   note:"onion and a protein simmered in dashi-soy, often bound loosely with egg, over rice",
   steps:[
     {t:"The simmer", d:"Simmer sliced onion in dashi, soy and mirin, then add the protein until just cooked."},
     {t:"The egg", d:"Pour beaten egg over in a ring, cover, and cook 1 minute \u2014 keep it soft and barely set."},
     {t:"Slide over", d:"Slide the whole thing over a bowl of hot rice and finish with scallion."}]},
  {key:"curry", label:"Japanese curry", region:"Japanese", mode:"over_rice",
   markers:["japanese_curry_roux","curry_powder"], need:1,
   note:"a thick curry with potato and carrot, simmered and ladled over",
   steps:[
     {t:"Fry & simmer", d:"Fry onion and the protein, add potato, carrot and water, and simmer until tender."},
     {t:"Melt the roux", d:"Off the heat, stir in the curry roux until dissolved, then simmer to a thick gravy."},
     {t:"Ladle over", d:"Ladle the curry over hot rice."}]},
  {key:"herb", label:"Herb & butter (pilaf)", region:"\u2014", mode:"in_rice",
   markers:["thyme","rosemary","parsley","dill","bay_leaf","butter","cilantro","curry_leaves","corn"], need:1,
   note:"rice toasted in butter with aromatics and herbs, cooked in stock \u2014 a fragrant pilaf, no meat needed",
   steps:[
     {t:"Toast in butter", d:"Sizzle aromatics in butter, then add the rice and toast it a minute so the grains stay separate."},
     {t:"Cook in stock", d:"Cook the rice in stock (not water) with bay and thyme for flavour and moisture."},
     {t:"Fold herbs", d:"Fold fresh herbs through at the end and fluff with a fork."}]},
  {key:"plain", label:"Just soy & egg", region:"\u2014", mode:"over_rice",
   markers:[], need:0,
   note:"a fried egg, a spoon of soy, a little sesame oil. The lazy bowl \u2014 but a good one.",
   steps:[
     {t:"Fry an egg", d:"Fry an egg to your liking \u2014 crisp edges, runny yolk."},
     {t:"Dress the rice", d:"Warm a little soy and sesame oil and spoon it over the hot rice."},
     {t:"Top", d:"Slide the egg on top and break the yolk through."}]}
];

// the topping method for an OVER-rice bowl, by style. mins = simmer/braise time (hands-off).
const RICE_STYLE={
  braise:{label:"The braise", mins:45,
    step:"Brown the meat until the fat renders, add aromatics, dark soy and five-spice, cover with water and braise gently \u2014 slip in peeled boiled eggs to braise alongside."},
  donburi:{label:"The simmer", mins:8,
    step:"Simmer sliced onion in dashi, soy and mirin, add the protein until just cooked, then pour beaten egg over in a ring and cook 1 minute \u2014 keep it soft, barely set."},
  curry:{label:"The curry", mins:20,
    step:"Fry onion and the protein, add potato and carrot and water, simmer until tender, then melt in the curry roux and simmer to a thick gravy."},
  roast:{label:"The topping", mins:5,
    step:"Slice the roast meat, warm a glossy soy-and-oyster sauce, and blanch a green briefly."},
  hainanese:{label:"Chicken & rice", mins:35,
    step:"Poach the whole chicken gently, then cook the rinsed rice in its fat and stock in a separate pot; chop the chicken to serve with chilli-ginger and a bowl of the stock."},
  plain:{label:"The topping", mins:4,
    step:"Fry an egg to your liking and warm a little soy and sesame oil."},
  simmer:{label:"The topping", mins:12,
    step:"Cook the protein through in a savoury sauce until it has a little gravy to spoon over."}
};

function riceStyleOf(dir, ingIds){
  if(dir){
    if(dir.key==="soy_braise") return "braise";
    if(dir.key==="donburi")    return "donburi";
    if(dir.key==="curry")      return "curry";
    if(dir.key==="roast")      return "roast";
    if(dir.key==="hainanese")  return "hainanese";
    if(dir.key==="plain")      return "plain";
  }
  const has=id=>ingIds.includes(id);
  if(has("japanese_curry_roux")||has("curry_powder")) return "curry";
  if(has("char_siu")) return "roast";
  if(has("chicken_whole")) return "hainanese";
  if(has("pork_belly")||has("star_anise")||has("five_spice")) return "braise";
  if(has("egg")&&(has("dashi")||has("mirin"))) return "donburi";
  return "simmer";
}

/* Does this bowl carry moisture, and enough texture? The governing check. Over-rice bowls
   are ladled with a braise/simmer/curry sauce by definition — that IS the moisture. The dry
   risk is a lean cut cooked IN the rice with nothing to render. */
function riceMoisture(ingIds, mode){
  const has=id=>ingIds.includes(id);
  const rendersFat = ["lap_cheong","char_siu","pork_belly","pork_shoulder","chicken_thigh",
    "chicken_whole","chicken_drumstick","salmon","beef_short_rib","beef_brisket"].some(has);
  const egg = has("egg");
  const juicy = ["corn","tomato","mushroom","enoki","pumpkin","peas","daikon","zucchini","eggplant"].some(has);
  const hasProtein = ingIds.some(id=>id!=="egg" && RICE_TOPPING_PROTEINS.has(id));
  // over-rice is ladled with a sauce; in-rice needs rendering fat, an egg or a juicy
  // vegetable. A plain veg or herb rice (no meat) is cooked in stock and is fine on its own.
  const ok = mode==="over_rice" || rendersFat || egg || juicy || !hasProtein;
  return {ok, rendersFat, egg, juicy,
    warn: ok?null:"a lean cut cooked in the rice runs dry \u2014 use a cut that renders (thigh, belly, lap cheong), add a soft egg or a juicy vegetable like corn, or ladle a sauce over instead"};
}
function riceTexture(ingIds){
  const has=id=>ingIds.includes(id);
  let n=0; const parts=[];
  const prot=["chicken","chicken_thigh","chicken_whole","pork","pork_belly","beef","beef_slices","char_siu","lap_cheong","salmon","prawn"].filter(has);
  if(prot.length){ n++; parts.push("the meat"); }
  if(has("egg")){ n++; parts.push("a soft egg"); }
  if(["shiitake_dried","mushroom","enoki"].some(has)){ n++; parts.push("mushroom"); }
  if(["bok_choy","kailan","chye_sim","spinach","cucumber","kangkong","broccoli"].some(has)){ n++; parts.push("a green"); }
  if(["yam","potato","sweet_potato"].some(has)){ n++; parts.push("something starchy-soft"); }
  return {n, parts, note: n>=2?null:"one note only \u2014 add a soft egg, some blanched greens, or crisp fried shallots for contrast"};
}

/* Co-cooking with rice-by-absorption (~15 min gentle steam + 10 min rest, one covered pot,
   one appliance). Given the rice is cooking anyway, what else can ride in the SAME pot, at
   the SAME gentle heat, in the SAME time? Each add-in gets a stage:
     • base_in  — in with the rice from the START (sturdy veg, corn, cured meat, chicken pieces)
     • lay_on   — LAID ON near the end (a fish fillet, prawns, an egg cracked on top)
     • fold_end — FOLDED THROUGH at the finish, off the heat (peas, leafy greens)
     • no_along — CANNOT ride along: a different heat/time/appliance (a steak needs a sear,
                  pork belly a long braise) — cook it separately.
   This is exactly the "same temperature and appliance" test: only things whose cooking
   profile matches gentle moist absorption can share the pot. */
function riceAlong(id, R){
  const i=R.byId[id]||{}; const p=new Set(i.provides||[]);
  const FISH=["fish","salmon","cod","snapper","seabass","threadfin","pomfret","mackerel","tuna","sardine","grouper"];
  if(id==="egg") return {stage:"lay_on", note:"crack it on top for the last few minutes so it steams into the rice, or stir it through the hot rice at the end"};
  if(id==="lap_cheong") return {stage:"base_in", note:"slice it in from the start \u2014 the fat renders into the rice"};
  if(id==="char_siu") return {stage:"lay_on", note:"already cooked \u2014 lay it on to warm through for the last few minutes"};
  if(id==="dried_shrimp") return {stage:"base_in", note:"in from the start \u2014 it perfumes the whole pot"};
  if(FISH.includes(id)) return {stage:"lay_on", note:"lay the fillet on the rice for the last 10 minutes \u2014 it steams through gently"};
  if(["prawn","squid","clams","oyster"].includes(id)) return {stage:"lay_on", note:"scatter on top for the last 6\u20138 minutes, just until opaque"};
  if(id==="beef_slices") return {stage:"lay_on", note:"thin slices laid on for the last few minutes"};
  if(p.has("collagen_rich") || i.cut_role==="braise") return {stage:"no_along", alt:"a slow braise", note:"needs 45+ minutes of braising \u2014 far longer than the rice takes"};
  if(["beef","beef_steak","beef_chuck","pork_loin","pork_shoulder","mutton"].includes(id)) return {stage:"no_along", alt:"a hot sear", note:"wants dry, high heat \u2014 not gentle steam"};
  if(/^chicken/.test(id)) return {stage:"base_in", note:"marinate it and cook it on the rice from the start"};
  if(id==="tofu") return {stage:"base_in", note:"firm tofu holds up cooked in the rice"};
  if(i.category==="vegetables"){
    if(["peas","beansprouts","spinach","bok_choy","chye_sim","kangkong","kailan","watercress","lettuce"].includes(id))
      return {stage:"fold_end", note:"fold through at the very end \u2014 residual heat is enough, and it stays bright"};
    return {stage:"base_in", note:"cooks in the same time and heat \u2014 stir it in with the rice"};
  }
  return {stage:"base_in", note:"cooks along with the rice"};
}

/* ---- BUILD A RICE BOWL ---- */
function buildRice(ingIds, R, dishes, AFF, opts){
  const dir=(opts&&opts.direction)||null;
  const real=[...new Set(ingIds.filter(id=>{
    const i=R.byId[id]||{};
    if(i.id==="water") return false;
    return measureTypeOf(i)!=="assumed" || CHARACTER_SEASONINGS.has(id);
  }))];
  const nm=id=>((R.byId[id]||{}).name)||id;
  const has=id=>ingIds.includes(id);

  // mode: the direction decides, else the ingredients, else "over" (rice you already have)
  let mode = (dir&&dir.mode) || (opts&&opts.mode) || null;
  if(!mode){
    const inSignal = has("lap_cheong")||has("dried_shrimp")||has("yam")||has("sweet_potato");
    mode = inSignal ? "in_rice" : "over_rice";
  }
  const modeInfo=RICE_MODES[mode];

  const subjId=(opts&&opts.subject) || real.find(id=>RICE_TOPPING_PROTEINS.has(id)) || real[0];
  const subjName=subjId?nm(subjId):"the topping";

  const prep=[];
  const steps=[];   // {label, detail, mins, handsoff}
  let handsOff=0;
  let separate=[];  // add-ins that can't cook in the rice — a different heat/time/appliance

  if(mode==="in_rice"){
    // stage every add-in by whether (and when) it can share the rice's pot, heat and time.
    // Only real SOLIDS are staged — sauces and seasonings live in the marinade, not the pot.
    const others=real.filter(id=>{
      if(RICE_BASE_IDS.has(id)) return false;
      if(id==="shiitake_dried") return true;                 // dried, but a genuine cook-in solid
      if(CHARACTER_SEASONINGS.has(id)) return false;         // dark soy, oyster, dashi... = seasoning
      return ["proteins","vegetables","starches"].includes((R.byId[id]||{}).category);
    });
    const along=others.map(id=>({id, name:nm(id), ...riceAlong(id,R)}));
    const baseIn =along.filter(a=>a.stage==="base_in");
    const layOn  =along.filter(a=>a.stage==="lay_on");
    const foldEnd=along.filter(a=>a.stage==="fold_end");
    separate     =along.filter(a=>a.stage==="no_along");
    const names=arr=>arr.map(a=>a.name).join(", ").replace(/, ([^,]*)$/," and $1");

    // prep — only the add-ins that need a knife or a soak
    if(baseIn.some(a=>/^chicken/.test(a.id))) prep.push({name:"Chicken", prep:"marinate in soy, a little dark soy for colour, and oil", warn:null});
    if(has("shiitake_dried")) prep.push({name:"Dried shiitake", prep:"soak until soft, then slice", warn:null});
    if(has("dried_shrimp")) prep.push({name:"Dried shrimp", prep:"soak, then chop", warn:null});
    ["yam","sweet_potato","potato","carrot","pumpkin","daikon"].forEach(v=>{ if(has(v)) prep.push({name:nm(v), prep:"peel and cut into small, even cubes so it cooks in rice time", warn:null}); });
    if(has("corn")) prep.push({name:"Corn", prep:"strip the kernels off the cob", warn:null});
    if(has("lap_cheong")) prep.push({name:"Lap cheong", prep:"slice on the diagonal", warn:null});
    if(layOn.some(a=>/fish|salmon|cod|snapper|seabass|threadfin|pomfret|mackerel|tuna|sardine|grouper/.test(a.id)))
      prep.push({name:"Fish", prep:"pat dry and season lightly", warn:null});

    steps.push({label:"The rice", detail:"Rinse the rice and add the water \u2014 a touch less than usual, since the add-ins give off moisture. Use stock in place of water for more flavour.", mins:0, handsoff:false});
    if(baseIn.length)
      steps.push({label:"In from the start", detail:"Stir "+names(baseIn)+" through the raw rice \u2014 they share the pot, the heat and the 15 minutes.", mins:0, handsoff:false});
    steps.push({label:"Cook together", detail:"Bring to a boil, then cover and cook on low for 15 minutes"+(layOn.length?", laying "+names(layOn)+" on top for the last 10 minutes":"")+".", mins:15, handsoff:true});
    steps.push({label:"The crust, resting", detail:"Off the heat, leave it covered and undisturbed for 10 minutes \u2014 this sets the golden crust at the bottom. Don't lift the lid.", mins:10, handsoff:true});
    if(foldEnd.length)
      steps.push({label:"Fold in to finish", detail:"Fold "+names(foldEnd)+" through the hot rice \u2014 the residual heat cooks them through and keeps them bright. Scatter scallion.", mins:1, handsoff:false});
    else
      steps.push({label:"Finish", detail:"Toss everything through and scatter scallion.", mins:1, handsoff:false});
    handsOff=25;
  } else {
    const style=riceStyleOf(dir, ingIds);
    const S=RICE_STYLE[style];
    steps.push({label:"The rice", detail: style==="hainanese"
        ? "The rice cooks in the chicken's fat and stock, in its own pot."
        : "Cook plain rice in a separate pot \u2014 or use rice you already have; leftover rice is ideal for a bowl.", mins:0, handsoff:true});
    prep.push({name:subjName, prep: style==="roast"?"slice thickly": style==="braise"?"cut into pieces":"cut into bite-size pieces", warn:null});
    if(style==="braise"||style==="donburi"){ if(has("egg")) prep.push({name:"Eggs", prep: style==="braise"?"hard-boil and peel":"beat loosely", warn:null}); }
    steps.push({label:S.label, detail:"about "+S.mins+" minutes, mostly hands-off \u2014 the method's in the sauce steps below", mins:S.mins, handsoff:true});
    steps.push({label:"Assemble", detail:"Ladle the topping and plenty of its sauce over the hot rice, so the grain soaks it up.", mins:1, handsoff:false});
    handsOff=S.mins;
  }

  // the sauce/seasoning method for the chosen direction (mirrors steam and stir-fry)
  const sauceSteps = (dir&&dir.steps) ? dir.steps
    : [{t:"Season", d: mode==="over_rice"
         ? "cook the topping in a savoury sauce until it has gravy to spoon over the rice"
         : "marinate the topping in soy and a little dark soy, and cook the rice in stock for flavour"}];

  const prepMins=Math.max(4, 3+prep.length*2);
  const total=prepMins+handsOff+1;

  const moisture=riceMoisture(ingIds, mode);
  const texture=riceTexture(ingIds);

  let suggest={yours:[],buy:[]};
  if(AFF){
    const base=real.filter(id=>RICE_TOPPING_PROTEINS.has(id));
    const key=base.length?base:[subjId].filter(Boolean);
    if(key.length) suggest=potSuggestions(key,"rice_bowl",R,AFF,{have:real});
  }

  return {
    mode, modeInfo, subject:subjId, subjectName:subjName,
    prep, prepMins, steps, total, handsOn:total-handsOff, handsOff,
    direction:dir, moisture, texture, suggest, sauceSteps,
    separate: separate.map(a=>({name:a.name, alt:a.alt, note:a.note})),
    warnings:[moisture.warn, texture.note].filter(Boolean),
    reminds: dishes ? dishes.filter(d=>contextOf(d)==="rice_bowl" &&
      (d.grocery_items||[]).some(g=>!RICE_BASE_IDS.has(g.id) && real.includes(g.id)))
      .slice(0,2).map(d=>({dish:d.name})) : []
  };
}

/* ============================================================
   WHICH BOWL? \u2014 surface the fork. When the ingredients suit both, offer both, so the
   choice between "cook it in" and "ladle it over" is the user's to make.
   ============================================================ */
function riceCandidates(ingIds, R, dishes, AFF){
  const real=[...new Set(ingIds.filter(id=>{
    const i=R.byId[id]||{};
    if(i.id==="water") return false;
    return measureTypeOf(i)!=="assumed" || CHARACTER_SEASONINGS.has(id);
  }))];
  const nm=id=>((R.byId[id]||{}).name)||id;
  const has=id=>ingIds.includes(id);
  const proteins=real.filter(id=>RICE_TOPPING_PROTEINS.has(id));
  const out=[];
  const add=(key,label,mode,subject,note)=>{
    out.push({key,label,mode,subject,note,
      contents:real, leftOut:[]});
  };

  // strong claypot / cook-in signals
  if(has("lap_cheong")||(proteins.some(p=>/^chicken/.test(p))&&has("dark_soy_sauce")))
    add("claypot","Claypot chicken rice","in_rice", proteins.find(p=>/^chicken/.test(p))||"lap_cheong","cooked in the rice \u2014 chicken and sausage render down, crust at the bottom");
  if(has("yam")||has("sweet_potato")||has("dried_shrimp"))
    add("yam","Yam rice","in_rice", has("yam")?"yam":(has("sweet_potato")?"sweet_potato":"dried_shrimp"),"cooked in the rice \u2014 yam and dried shrimp fried through the grain (Teochew)");

  // over-rice styles
  if(has("japanese_curry_roux")||has("curry_powder"))
    add("curry","Curry rice","over_rice", proteins[0]||"potato","rice separate \u2014 a thick curry ladled over");
  if(has("pork_belly")||has("five_spice")||has("star_anise"))
    add("braise","Braised pork over rice","over_rice","pork_belly","rice separate \u2014 pork belly braised soft in dark soy, sauce over");
  if(has("char_siu"))
    add("roast","Char siu over rice","over_rice","char_siu","rice separate \u2014 sliced roast meat, a glossy sauce, a green");
  if(has("chicken_whole"))
    add("hainanese","Hainanese chicken rice","over_rice","chicken_whole","poached chicken, rice cooked in its stock, sauces on the side");
  if(has("egg")&&(has("dashi")||has("mirin"))){
    const p=proteins.find(x=>/^chicken/.test(x))||proteins.find(x=>/^beef/.test(x))||proteins[0];
    add("donburi",(p?nm(p)+" ":"")+"& egg donburi","over_rice", p||"egg","rice separate \u2014 simmered in dashi-soy, bound with a soft egg");
  }

  // fish leads a rice-cooker "[fish] rice" — the fillet laid on top, steamed as the rice cooks
  const FISH_IDS=["fish","salmon","cod","snapper","seabass","threadfin","pomfret","mackerel","tuna","sardine","grouper"];
  const fishes=proteins.filter(p=>FISH_IDS.includes(p));
  let styledSubjects=new Set(out.map(o=>o.subject));
  fishes.filter(f=>!styledSubjects.has(f)).slice(0,1).forEach(f=>{
    add("fish_"+f, nm(f)+" rice","in_rice", f,"cooked in the rice \u2014 the fillet laid on top and steamed through as the grain cooks");
  });

  // a plain solid meat with no strong style: SURFACE THE FORK — but only offer "in the rice"
  // if it can actually cook there. A steak or a tough cut can't; it gets the over-rice path.
  styledSubjects=new Set(out.map(o=>o.subject));
  const meats=proteins.filter(p=>!styledSubjects.has(p) && !fishes.includes(p) &&
    !["dried_shrimp","lap_cheong","egg","prawn","squid","clams","oyster"].includes(p));
  meats.slice(0,1).forEach(p=>{
    if(riceAlong(p,R).stage!=="no_along")
      add("in_"+p, nm(p)+" claypot rice","in_rice", p,"cooked in the rice \u2014 marinate it, cook it on the grain, form a crust");
    add("over_"+p, nm(p)+" over rice","over_rice", p,"rice separate \u2014 cook it in a sauce, or sear it, and serve over");
  });

  // COOK-ALONG: rice + whatever shares its pot, heat and time (corn, egg, mushroom, veg).
  // Offered when nothing above already leads an in-rice bowl.
  if(!out.some(o=>o.mode==="in_rice")){
    const along=real.filter(id=>!RICE_BASE_IDS.has(id))
      .map(id=>({id, cat:(R.byId[id]||{}).category, ...riceAlong(id,R)}))
      .filter(a=>a.stage!=="no_along");
    const veg=along.filter(a=>a.cat==="vegetables").map(a=>a.id);
    const hasEgg=has("egg");
    if(veg.length || hasEgg){
      let label;
      if(hasEgg && veg.includes("corn")) label="Corn & egg rice";
      else if(veg.includes("corn")) label="Corn rice";
      else if(veg.includes("tomato")) label=hasEgg?"Tomato & egg rice":"Tomato rice";
      else if(veg.some(v=>["mushroom","enoki"].includes(v))) label="Mushroom rice";
      else if(hasEgg && !veg.length) label="Egg rice";
      else if(veg.length) label="Vegetable rice";
      else label="Rice-cooker rice";
      add("along", label, "in_rice", hasEgg?"egg":(veg[0]||null),
        "cooked in the rice \u2014 everything that shares the pot, the heat and the time goes in together");
    }
  }

  if(!out.length){
    add("herb","Herb rice","in_rice",null,"rice cooked with aromatics and herbs, in stock instead of water \u2014 a fragrant pilaf");
  }
  return out;
}
