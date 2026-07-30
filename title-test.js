// RENDER-LEVEL TITLE TEST
// Drives the real render functions with a DOM stub, captures the op-name headline, and asserts
// the title reflects the ACTIVE selection (sauce/style/dir) — not a stale default. Catches the
// "Ginger scallion · Dark soy", "Mala scallion fish", and "always mee goreng" class of bug.
const fs=require('fs');
const html=fs.readFileSync('flow.html','utf8');
const js=html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

// ---- capture op-name text from any innerHTML assignment ----
global.captured={};
function extractOpName(h){
  const m=(h||'').match(/op-name">([^<]*)</);
  return m?m[1]:null;
}
global.requestAnimationFrame=function(){};
function mkNode(boxId){
  const node={
    tagName:'div', style:{}, _cls:'', _box:boxId,
    set className(v){this._cls=v}, get className(){return this._cls},
    classList:{add(){},remove(){},contains(){return false}},
    children:[],
    appendChild(c){ this.children.push(c);
      // when a child with an op-name is appended to the recipes box, capture it
      if(c && c._h){ const t=extractOpName(c._h); if(t) global.captured[boxId]=t; }
      return c; },
    set innerHTML(v){ this._h=v; const t=extractOpName(v); if(t && this._box) global.captured[this._box]=t; },
    get innerHTML(){return this._h||''},
    setAttribute(){}, getAttribute(){return null}, dataset:{},
    addEventListener(){}, removeEventListener(){}, onclick:null, textContent:'',
    querySelector(){return null}, querySelectorAll(){return []},
    closest(){return null}, remove(){}, focus(){}, getBoundingClientRect(){return {left:0,top:0,width:0,height:0};}
  };
  return node;
}
let curBox='recipes';
const boxes={};
global.document={
  createElement:(t)=>mkNode(curBox),
  getElementById:(id)=>{ if(!boxes[id]) boxes[id]=mkNode(id); return boxes[id]; },
  addEventListener(){}, body:{appendChild(){}}, querySelector:()=>null, querySelectorAll:()=>[]
};
global.window={innerWidth:1200,innerHeight:800,addEventListener(){},removeEventListener(){}};
global.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
global.fetch=()=>({then:()=>({then:()=>({catch:()=>{}})})});
global.navigator={};global.Image=function(){return{};};

const ing=fs.readFileSync('ingredients.json','utf8');
const dish=fs.readFileSync('dishes.json','utf8');

const inner=`
REF=buildReference(JSON.parse(ing));
DISHES=JSON.parse(dish).dishes; var misses=[]; DISHES.forEach(d=>{try{hydrateVariant(d,REF,misses);}catch(e){}});
if(typeof AFF==='undefined'){ try{ AFF=buildAffinity?buildAffinity(DISHES,REF):null; }catch(e){ AFF=null; } }

var results=[];
function grab(boxId){ global.captured[boxId]=null; return ()=>global.captured[boxId]; }
function setBasket(ids){ FLOW.active=new Set(ids); }
function run(label, fn, expectSubstr){
  captured['recipes']=null;
  try{ fn(); }catch(e){ results.push({label, ok:false, got:'(threw: '+e.message+')', want:expectSubstr}); return; }
  var got=captured['recipes']||'(no title captured)';
  var ok = got.toLowerCase().indexOf(expectSubstr.toLowerCase())>=0;
  results.push({label, ok, got, want:expectSubstr});
}

// ---- STIR-FRY: pick an explicit sauce, title must name THAT sauce ----
setBasket(['fish_slices','scallion']); FLOW.wokPick=null; FLOW.wokDir='mala';
run('stirfry fish + explicit MALA', ()=>renderStirFry(), 'mala');
setBasket(['chicken_thigh','bell_pepper']); FLOW.wokPick=null; FLOW.wokDir='dark_soy';
run('stirfry chicken + explicit DARK SOY', ()=>renderStirFry(), 'dark soy');
// and the two-word sauce that produced "Mala scallion fish"
setBasket(['fish_slices','ginger','scallion']); FLOW.wokPick=null; FLOW.wokDir='mala';
run('stirfry fish + MALA over ginger-scallion (concat bug)', ()=>renderStirFry(), 'mala');
// negative guard: title should NOT contain 'scallion' when mala is picked
(function(){ var g=captured['recipes']||''; results.push({label:'  ^ and NOT "scallion" in that title', ok: g.toLowerCase().indexOf('scallion')<0, got:g, want:'(no scallion)'}); })();

// ---- RICE: explicit style must show in title ----
setBasket(['rice','chicken_thigh']); FLOW.ricePick=null; FLOW.riceDir='congee';
run('rice chicken + explicit CONGEE', ()=>renderRice(), 'congee');

// ---- NOODLE: explicit style must show in title ----
setBasket(['yellow_noodle','prawn']); FLOW.noodlePick=null; FLOW.noodleDir='laksa';
run('noodle + explicit LAKSA', ()=>renderNoodle(), 'laksa');
setBasket(['yellow_noodle','prawn']); FLOW.noodlePick=null; FLOW.noodleDir='clear_soup';
run('noodle + explicit CLEAR SOUP', ()=>renderNoodle(), 'clear');

// ---- ONEPOT: broth seasoning must show in title ----
setBasket(['chicken_thigh']); FLOW.potBase=null; FLOW.potMode='soup'; FLOW.potPath='jp_curry';
run('onepot chicken + curry via seasoning path', ()=>renderOnePot(), 'curry');
// also test BKT path
setBasket(['pork_ribs']); FLOW.potBase=null; FLOW.potMode='soup'; FLOW.potPath='bkt_teochew';
run('onepot pork ribs + BKT via seasoning path', ()=>renderOnePot(), 'bak kut teh');
FLOW.potPath=null;

// ---- report ----
var pass=results.filter(r=>r.ok).length, tot=results.length;
results.forEach(r=>{
  console.log((r.ok?'  PASS':'  FAIL')+'  '+r.label);
  if(!r.ok) console.log('        wanted ~"'+r.want+'"  got: "'+r.got+'"');
});
console.log('');
console.log(pass+'/'+tot+' title checks pass');
if(pass<tot) process.exitCode=1;
`;
(0,eval)(js+'\n;var ing='+JSON.stringify(ing)+';var dish='+JSON.stringify(dish)+';\n'+inner);
