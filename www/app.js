/* Enhanced Training Studio (formerly Injection Tracker) — vanilla JS, no build step. Runs in a browser and inside Capacitor (Android). */
(function(){
'use strict';

/* ================= Platform ================= */
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const P = (Cap && Cap.Plugins) || {};
const plugin = name => (isNative && P[name]) ? P[name] : null;

async function haptic(kind){
  const H = plugin('Haptics'); if(!H) return;
  try{ kind==='success' ? await H.notification({type:'SUCCESS'}) : await H.impact({style:'LIGHT'}); }catch(e){}
}

/* ================= Constants ================= */
const DAY = 86400000;
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOW_ORDER = [1,2,3,4,5,6,0]; // Monday first
const BARRELS = ['0.3 mL','0.5 mL','1 mL','3 mL','5 mL'];
const SITES = {
  IM:   ['Glute L','Glute R','Ventroglute L','Ventroglute R','Delt L','Delt R','Quad L','Quad R'],
  SubQ: ['Abdomen L','Abdomen R','Love handle L','Love handle R','Thigh L','Thigh R']
};
const LAB_PRESETS = [
  ['Total testosterone','nmol/L'],['Free testosterone','pmol/L'],['Oestradiol (E2)','pmol/L'],
  ['Haematocrit','%'],['Haemoglobin','g/L'],['SHBG','nmol/L'],['PSA','µg/L'],
  ['LH','IU/L'],['FSH','IU/L'],['Prolactin','mIU/L'],['ALT','U/L'],['HDL','mmol/L'],['LDL','mmol/L']
];
const STORE_KEY = 'inj-data-v2';

/* ================= State ================= */
let db = { compounds:[], logs:[], labs:[], health:{days:{}}, exercises:[], templates:[], workouts:[], activeWorkout:null, settings:{} };
const DEFAULT_SETTINGS = { reminders:false, morning:'08:00', night:'21:00', lowStockDoses:3, autoBackup:true, lastBackupAt:null, lastBackupFile:null, lastBackupError:null, lockEnabled:false, lockAfter:0, privateNotifs:true, secureScreen:false };
const ui = {
  tab:'today', mode:'inj', lastTab:{inj:'today', train:'workout', health:'hoverview'}, hMetric:null, hRange:30, histFilter:'all', calMonth:null, calSel:null, draft:null, tplEdit:null,
  chartCompound:null, chartWeeks:4
};

/* ================= Helpers ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const dayStart = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const diffDays = (a,b) => Math.round((dayStart(a)-dayStart(b))/DAY);
const ymd = d => { const x=new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; };
const parseYmd = s => { const [y,m,d] = String(s).split('-').map(Number); return new Date(y, (m||1)-1, d||1); };
// One formatter each, reused: toLocale*String builds a new formatter per call, which is slow on long lists.
const _fD = new Intl.DateTimeFormat(undefined,{weekday:'short', day:'numeric', month:'short', year:'numeric'});
const _fS = new Intl.DateTimeFormat(undefined,{day:'numeric', month:'short'});
const _fT = new Intl.DateTimeFormat(undefined,{hour:'numeric', minute:'2-digit'});
const _fM = new Intl.DateTimeFormat(undefined,{month:'long', year:'numeric'});
const fmtDate = d => _fD.format(new Date(d));
const fmtShort = d => _fS.format(new Date(d));
const fmtTime = d => _fT.format(new Date(d));
const fmtMonth = d => _fM.format(new Date(d));
const round = (n,p=2) => Math.round(n*10**p)/10**p;
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : NaN; };
const toLocalInput = d => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16);
const hm = s => { const [h,m] = String(s||'08:00').split(':').map(Number); return [h||0, m||0]; };

function fmtAmt(mg, unit){
  if(mg==null || !isFinite(mg)) return '';
  if(unit==='mcg') return `${round(mg*1000,1)} mcg`;
  return `${round(mg,2)} mg`;
}
/* estimates: whole numbers once they're big enough, so they don't look more exact than they are */
function fmtEst(mg, unit){ if(mg==null) return ''; const v = unit==='mcg' ? mg*1000 : mg; const r = v>=10 ? Math.round(v) : round(v,1); return `${r} ${unit==='mcg'?'mcg':'mg'}`; }
function toMg(val, unit){ return unit==='mcg' ? val/1000 : val; }
function fromMg(mg, unit){ return unit==='mcg' ? mg*1000 : mg; }
function drawText(volMl, c){
  if(!(volMl>0)) return '';
  let s = `<b>${round(volMl,2)} mL</b>`;
  if(volMl <= 1) s += ` · <b>${round(volMl*100,1)} units</b> on U-100`;
  if(c && c.barrel) s += ` · ${esc(c.barrel)} syringe`;
  return s;
}

/* ================= Data hygiene =================
   Everything loaded from storage or a backup goes through cleanData() first, so a crafted backup can't smuggle
   markup into number fields, break ids, pollute prototypes or crash the app with nulls. */
const NUM_KEYS = new Set(['strength','dosePerInj','dose','volumeMl','powderMg','waterMl','halfLife','every','sizeMl','remainingMl',
  'w','r','tr','reps','restSec','distanceM','elapsedSec','movingSec','elevGainM','avg','max','min','lowStockDoses','lockAfter','inc',
  'durMin','heightCm','weightKg','bodyFat','activity','hrMax','kcal','steps','lat','lon','alt','acc','dosesLeft','seg','pausedMs']);
const ID_KEYS = new Set(['id','compoundId','exId','wid','templateId','chartCompound']);
function cleanData(v, key, depth=0){
  if(depth > 14) return undefined;
  if(Array.isArray(v)){ const out = []; for(const x of v.slice(0, 500000)){ const c = cleanData(x, key, depth+1); if(c !== undefined) out.push(c); } return out; }
  if(v && typeof v === 'object'){
    const o = {};
    for(const k of Object.keys(v)){
      if(k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const c = cleanData(v[k], k, depth+1); if(c !== undefined) o[k] = c;
    }
    return o;
  }
  if(typeof v === 'string'){
    if(NUM_KEYS.has(key)){ if(v === '') return ''; const n = Number(v); return isFinite(n) ? n : null; }
    if(ID_KEYS.has(key)) return v.replace(/[^\w.:-]/g, '').slice(0, 80);
    return v.length > 20000 ? v.slice(0, 20000) : v;
  }
  if(typeof v === 'number') return isFinite(v) ? v : null;
  if(typeof v === 'boolean' || v === null) return v;
  return undefined;
}
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const validDate = x => typeof x === 'string' && !isNaN(Date.parse(x));
/* the shape checks that stop half-valid entries from crashing screens later */
function cleanCollections(d){
  const objs = a => Array.isArray(a) ? a.filter(isObj) : [];
  d.compounds = objs(d.compounds).filter(c=>c.id && typeof c.name==='string');
  d.logs = objs(d.logs).filter(l=>l.id && validDate(l.date));
  d.labs = objs(d.labs).filter(l=>l.id);
  d.exercises = objs(d.exercises).filter(e=>e.id && typeof e.name==='string');
  d.templates = objs(d.templates).filter(t=>t.id).map(t=>({...t, name: String(t.name||'Template'), items: objs(t.items).filter(i=>i.exId).map(i=>({...i, sets: Math.min(20, Math.max(1, Math.round(+i.sets) || 3))}))}));
  d.workouts = objs(d.workouts).filter(w=>w.id && validDate(w.start)).map(w=>({...w, items: objs(w.items).map(it=>({...it, sets: objs(it.sets)}))}));
  d.activities = objs(d.activities).filter(a=>a.id && validDate(a.start) && ACT_KINDS.includes(a.kind));
  if(d.activeWorkout && !(isObj(d.activeWorkout) && Array.isArray(d.activeWorkout.items) && validDate(d.activeWorkout.start))) d.activeWorkout = null;
  if(d.activeWorkout) d.activeWorkout.items = objs(d.activeWorkout.items).map(it=>({...it, sets: objs(it.sets)}));
  if(d.activeActivity && !(isObj(d.activeActivity) && ACT_KINDS.includes(d.activeActivity.kind) && validDate(d.activeActivity.start))) d.activeActivity = null;
  if(!isObj(d.health) || !isObj(d.health.days)) d.health = {days:{}};
  if(!isObj(d.settings)) d.settings = {};
  return d;
}
const ACT_KINDS = ['run','treadmill','walk','hike'];

/* ================= Storage ================= */
async function rawGet(key){
  const Pref = plugin('Preferences');
  if(Pref){ try{ const r = await Pref.get({key}); if(r && r.value) return r.value; }catch(e){} }
  try{ return localStorage.getItem(key); }catch(e){ return null; }
}
async function rawSet(key, val){
  const Pref = plugin('Preferences');
  let ok = false;
  if(Pref){ try{ await Pref.set({key, value:val}); ok = true; }catch(e){} }
  try{ localStorage.setItem(key, val); ok = true; }catch(e){}
  if(!ok && key===STORE_KEY && !storageWarned){ storageWarned = true; setTimeout(()=>toast('Couldn\u2019t save: this phone\u2019s storage for the app is full. Export a backup now.'), 0); }
}

let saveTimer = null, modeSaveT = null, storageWarned = false;
let _loadMap = null;    // day -> training load; cleared by save() and render()
let _setsCache = null;   // training sets index; cleared by save(), rebuilt when the workout list changes
function save(){
  _setsCache = null; _tlCache.clear(); _loadMap = null; _logIdx = null; _labTestsCache = null;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{ rawSet(STORE_KEY, JSON.stringify(db)); scheduleReminders(); scheduleAutoBackup(); }, 120);
}
/* write without triggering reminders/backup again (used by the backup itself) */
function persistQuiet(){ rawSet(STORE_KEY, JSON.stringify(db)); }

async function load(){
  let raw = await rawGet(STORE_KEY);
  let data = null;
  try{ data = raw ? JSON.parse(raw) : null; }catch(e){ data = null; try{ await rawSet(STORE_KEY + '-unreadable-' + Date.now(), raw); }catch(x){} }  // keep a copy rather than overwrite it
  if(!isObj(data)) data = {};
  data = cleanCollections(cleanData(data));
  db.compounds = Array.isArray(data.compounds) ? data.compounds : [];
  db.logs = Array.isArray(data.logs) ? data.logs : [];
  db.labs = Array.isArray(data.labs) ? data.labs : [];
  db.health = data.health && typeof data.health.days==='object' ? data.health : {days:{}};
  db.exercises = Array.isArray(data.exercises) ? data.exercises : [];
  db.templates = Array.isArray(data.templates) ? data.templates : [];
  db.workouts = Array.isArray(data.workouts) ? data.workouts : [];
  db.activities = Array.isArray(data.activities) ? data.activities : [];
  db.activeActivity = data.activeActivity && data.activeActivity.kind ? data.activeActivity : null;
  db.activeWorkout = data.activeWorkout && Array.isArray(data.activeWorkout.items) ? data.activeWorkout : null;
  db.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  migrate();
}

/* Bring every compound/log to the current shape. Safe to run repeatedly. */
function migrate(){
  const now = Date.now();
  db.compounds.forEach((c, i)=>{
    if(c.needle !== undefined){ if(c.barrel===undefined) c.barrel = c.needle; delete c.needle; }
    // schedule
    if(Array.isArray(c.schedule)){ // oldest shape: [{day, time}]
      if(c.schedule[0] && c.schedule[0].time) c.time = c.schedule[0].time;
      c.days = c.schedule.map(s=>s.day); delete c.schedule;
    }
    if(!c.schedule){
      let days = [];
      if(Array.isArray(c.days)) days = c.days;
      c.schedule = { type:'weekly', days:[...new Set(days.map(Number))].filter(d=>d>=0&&d<=6).sort() };
    }
    if(Array.isArray(c.times)) { c.time = c.times[0]; }
    if(c.time==='bedtime') c.time='night';
    if(c.time!=='night') c.time = 'morning';
    // dose per injection (older versions stored a weekly total)
    if(c.dosePerInj===undefined){
      const per = perWeek(c);
      c.dosePerInj = (c.weeklyDose && per) ? c.weeklyDose/per : null;
    }
    delete c.days; delete c.times; delete c.weeklyDose; delete c.frequencyDays;
    c.unit = c.unit==='mcg' ? 'mcg' : 'mg';
    c.form = c.form==='powder' ? 'powder' : 'oil';
    c.route = c.route==='SubQ' ? 'SubQ' : 'IM';
    if(!c.createdAt){
      const first = db.logs.filter(l=>l.compoundId===c.id).map(l=>+new Date(l.date)).sort((a,b)=>a-b)[0];
      c.createdAt = new Date(Math.min(first || now, now)).toISOString();
    }
    if(c.halfLife!==undefined && !(c.halfLife>0)) c.halfLife = null;
    if(!Array.isArray(c.pauses)) c.pauses = [];
    if(!Array.isArray(c.doseHistory)) c.doseHistory = c.dosePerInj>0 ? [{from: ymd(c.createdAt), dose: c.dosePerInj}] : [];
  });
  db.logs.forEach(l=>{
    const c = db.compounds.find(c=>c.id===l.compoundId);
    if(c){
      if(!l.compoundName) l.compoundName = c.name;
      if(l.strength==null) l.strength = c.strength;
      if(l.unit==null) l.unit = c.unit;
    }
    if(l.volumeMl==null && l.strength) l.volumeMl = l.dose / l.strength;
  });
}

/* ================= Schedule engine ================= */
/* Pauses: [{from:'YYYY-MM-DD', to:'YYYY-MM-DD'|null}] — no doses from `from` up to (not including) `to`. */
function isPausedOn(c, d){ const k = ymd(d); return (c.pauses||[]).some(p=>k>=p.from && (!p.to || k<p.to)); }
function currentPause(c){ const k = ymd(new Date()); return (c.pauses||[]).find(p=>k>=p.from && (!p.to || k<p.to)) || null; }
function upcomingPause(c){ const k = ymd(new Date()); return (c.pauses||[]).filter(p=>p.from>k).sort((a,b)=>a.from<b.from?-1:1)[0] || null; }
/* Cycles. c.cycle = {start:'YYYY-MM-DD', days:N, unit:'weeks'|'days'} — doses only from start up to (not including)
   start+days. c.periods = earlier windows [{start|null, end|null, anchor?}] kept so past cycles (and the ongoing
   time before a first cycle) still count in history. c.ongoingFrom = when an ongoing run started after a cycle.
   No cycle and no periods = no limits (the normal ongoing schedule). */
const cycleEndOf = cy => ymd(addDays(parseYmd(cy.start), cy.days));
const cycleEnd = c => c.cycle ? cycleEndOf(c.cycle) : null;
function activeWindows(c){
  const w = (c.periods||[]).slice();
  if(c.cycle) w.push({start:c.cycle.start, end:cycleEnd(c), anchor:c.cycle.start});
  else if(w.length || c.ongoingFrom) w.push({start:c.ongoingFrom || null, end:null, anchor:c.ongoingFrom || null});
  return w;
}
function inCycle(c, d){
  const w = activeWindows(c); if(!w.length) return true;
  const k = ymd(d); return w.some(p=>(!p.start || k>=p.start) && (!p.end || k<p.end));
}
/* where the current cycle is today: {state:'before'|'active'|'done', week, weeks, day, days, start, end, lastDay} */
function cycleState(c, now=new Date()){
  if(!c.cycle) return null;
  const k = ymd(now), end = cycleEnd(c), start = c.cycle.start;
  const day = diffDays(now, parseYmd(start));
  return { state: k<start ? 'before' : k>=end ? 'done' : 'active', start, end, lastDay: ymd(addDays(parseYmd(end), -1)),
    day: day+1, days: c.cycle.days, week: Math.floor(day/7)+1, weeks: Math.ceil(c.cycle.days/7), unit: c.cycle.unit || 'weeks' };
}
function cycleDoses(c, cy){ const o = occurrences(c, parseYmd(cy.start), addDays(parseYmd(cycleEndOf(cy)), -1)); return o; }
function cycleLengthText(cy){ return cy.unit==='days' || cy.days%7 ? `${cy.days} ${cy.days===1?'day':'days'}` : `${cy.days/7} ${cy.days===7?'week':'weeks'}`; }
function cycleNote(c){
  const cy = cycleState(c); if(!cy) return '';
  if(cy.state==='before') return ` · Cycle starts ${esc(fmtShort(parseYmd(cy.start)))}`;
  if(cy.state==='done') return ` · Cycle ended ${esc(fmtShort(parseYmd(cy.lastDay)))}`;
  const left = diffDays(parseYmd(cy.lastDay), new Date());     // days until the cycle's last day
  return ` · ${cy.unit==='days' || cy.days%7 ? `Day ${cy.day} of ${cy.days}` : `Week ${cy.week} of ${cy.weeks}`}${left<=7 ? ` · ${left<=0 ? 'last day' : left===1 ? 'ends tomorrow' : `ends in ${left}d`}` : ''}`;
}
/* Dose history: [{from:'YYYY-MM-DD', dose:mg}] — the planned dose per injection from that date on. */
function doseOn(c, d){
  const h = (c.doseHistory||[]).slice().sort((a,b)=>a.from<b.from?-1:1);
  if(!h.length) return c.dosePerInj || null;
  const k = ymd(d);
  let cur = h[0].dose;
  for(const e of h) if(e.from<=k) cur = e.dose;
  return cur;
}
function nextDoseChange(c){ const k = ymd(new Date()); return (c.doseHistory||[]).filter(e=>e.from>k).sort((a,b)=>a.from<b.from?-1:1)[0] || null; }
function syncDoses(){ db.compounds.forEach(c=>{ if(c.doseHistory && c.doseHistory.length) c.dosePerInj = doseOn(c, new Date()); }); }

function perWeek(c){
  const s = c.schedule;
  if(!s) return 0;
  if(s.type==='interval') return s.every>0 ? 7/s.every : 0;
  return (s.days||[]).length;
}
function hasSchedule(c){ return perWeek(c) > 0; }

/* Scheduled dose days for compound c between from and to (inclusive), as midnight Dates. */
function occurrences(c, from, to){
  const out = [], s = c.schedule, a = dayStart(from), b = dayStart(to);
  if(!s || b < a) return out;
  if(s.type==='interval'){
    if(!(s.every>0) || !s.start) return out;
    // each cycle counts its doses from its own first day; outside cycles the schedule's first dose is the anchor
    const wins = activeWindows(c);
    const segs = wins.length ? wins.map(p=>({anchor:p.anchor || s.start, from:p.start ? parseYmd(p.start) : null, to:p.end ? addDays(parseYmd(p.end), -1) : null}))
      : [{anchor:s.start, from:null, to:null}];
    const seen = new Set();
    segs.forEach(g=>{
      const start = parseYmd(g.anchor);
      const lo = g.from && g.from > a ? g.from : a, hi = g.to && g.to < b ? g.to : b;
      if(hi < lo) return;
      let k = Math.max(0, Math.ceil((diffDays(lo, start) - 1e-9) / s.every));
      for(let guard=0; guard<2000; guard++, k++){
        const d = dayStart(addDays(start, Math.floor(k*s.every + 1e-9)));   // dayStart: where DST starts at midnight, days begin at 01:00
        if(d > hi) break;
        if(d >= lo && !seen.has(+d)){ seen.add(+d); out.push(d); }
      }
    });
    out.sort((x,y)=>x-y);
    return out.filter(d=>!isPausedOn(c, d));
  }
  const days = s.days || [];
  if(!days.length) return out;
  for(let d = new Date(a); d <= b; d = dayStart(addDays(d,1))) if(days.includes(d.getDay())) out.push(dayStart(d));
  return out.filter(d=>!isPausedOn(c, d) && inCycle(c, d));
}
function nextOccurrence(c, after){
  const o = occurrences(c, addDays(after,1), addDays(after, 60));
  return o[0] || null;
}

/* Match logs to scheduled days. Each log covers one scheduled dose, and can be up to a day early.
   Returns [{day, status:'taken'|'skipped'|'missed'|'due'|'planned', log}] for the requested range. */
const _tlCache = new Map();   // cleared on every render() and save(): timeline() is called many times per screen
function timeline(c, from, to){
  const key = c.id + '|' + (+from) + '|' + (+to);
  const hit = _tlCache.get(key);
  if(hit && hit.c === c) return hit.res;
  const res = timelineCalc(c, from, to);
  _tlCache.set(key, {c, res});
  return res;
}
function timelineCalc(c, from, to){
  const today = dayStart(new Date());
  // scan from when the compound was added, or from the last schedule change (the past isn't re-judged by a new schedule)
  const created = new Date(Math.max(+dayStart(c.createdAt || today), c.scheduleSince ? +parseYmd(c.scheduleSince) : 0));
  const scanFrom = new Date(Math.max(+created, +addDays(from, -10)));
  const occ = occurrences(c, scanFrom, to);
  const early = +addDays(scanFrom, -1);
  const logs = (logsByCompound().get(c.id) || []).map(e=>({l:e.l, day:dayStart(e.t)})).filter(x=>+x.day >= early).sort((x,y)=>x.day-y.day);
  const used = new Set();
  const res = [];
  occ.forEach((d,i)=>{
    const next = occ[i+1] || addDays(d, 60);
    const winStart = addDays(d,-1);
    let match = null;
    for(const x of logs){
      if(used.has(x.l.id)) continue;
      if(x.day >= winStart && x.day < next && x.day <= today){ match = x; break; }
      if(x.day >= next) break;
    }
    let status;
    if(match){ used.add(match.l.id); status = match.l.skipped ? 'skipped' : 'taken'; }
    else if(d < today) status = 'missed';
    else if(+d === +today) status = 'due';
    else status = 'planned';
    if(d >= dayStart(from)) res.push({day:d, status, log: match ? match.l : null});
  });
  return res;
}

function statusFor(c){
  const today = dayStart(new Date());
  if(!hasSchedule(c)) return {label:'No schedule', cls:'tag-muted', due:false};
  const pz = currentPause(c);
  if(pz) return {label: pz.to ? `Paused until ${fmtShort(parseYmd(pz.to))}` : 'Paused', cls:'tag-muted', due:false, paused:true};
  const cy = cycleState(c);
  const tl = timeline(c, addDays(today,-60), today);
  const todayItem = tl.find(t=>+t.day===+today);
  // missed doses since the last one taken (skipping one on purpose doesn't hide the others)
  let missed = 0; const missedDays = [];
  for(let i=tl.length-1;i>=0;i--){
    const t = tl[i];
    if(t.status==='taken') break;
    if(t.status==='missed'){ missed++; missedDays.push(ymd(t.day)); }
  }
  if(cy && cy.state==='done'){
    // doses missed at the end of a cycle stay visible for a few days, then the cycle just shows as finished
    if(missed && diffDays(today, parseYmd(cy.end)) < 3) return {label:`${missed} missed · cycle ended`, cls:'tag-late', due:true, missed, missedDays};
    return {label:`Cycle finished ${fmtShort(parseYmd(cy.lastDay))}`, cls:'tag-muted', due:false, finished:true};
  }
  const next = nextOccurrence(c, today);
  const nextIn = next ? diffDays(next, today) : null;
  const lastOfCycle = cy && cy.state==='active' && !next;
  if(todayItem && todayItem.status==='due'){
    return {label: missed ? `Due today · ${missed} missed` : lastOfCycle ? 'Due today · last of cycle' : `Due today · ${c.time==='night'?'night':'morning'}`, cls: missed?'tag-late':'tag-due', due:true, dueToday:true, missed, missedDays};
  }
  if(missed) return {label:`${missed} missed`, cls:'tag-late', due:true, missed, missedDays};
  const nextTxt = nextIn!=null ? `next in ${nextIn}d` : lastOfCycle ? 'cycle complete' : 'none planned';
  if(todayItem && todayItem.status==='taken') return {label:`Done · ${nextTxt}`, cls:'tag-ok', due:false};
  if(todayItem && todayItem.status==='skipped') return {label:`Skipped · ${nextTxt}`, cls:'tag-muted', due:false};
  if(nextIn==null && lastOfCycle) return {label:`No more doses · ends ${fmtShort(parseYmd(cy.lastDay))}`, cls:'tag-muted', due:false};
  if(nextIn==null && cy && cy.state==='before') return {label:`Cycle starts ${fmtShort(parseYmd(cy.start))}`, cls:'tag-muted', due:false};
  if(nextIn==null) return {label:'Nothing planned', cls:'tag-muted', due:false};
  return {label: nextIn===1 ? 'Due tomorrow' : `Due in ${nextIn}d`, cls:'tag-ok', due:false};
}

function scheduleLabel(c){
  const s = c.schedule;
  if(!hasSchedule(c)) return 'No schedule';
  const t = c.time==='night' ? 'night' : 'morning';
  if(s.type==='interval'){
    const e = s.every;
    const name = e===1 ? 'Every day' : e===2 ? 'Every other day' : `Every ${e} days`;
    return `${name} · ${t}`;
  }
  const days = s.days.slice().sort((a,b)=>DOW_ORDER.indexOf(a)-DOW_ORDER.indexOf(b));
  if(days.length===7) return `Every day · ${t}`;
  return `${days.map(d=>DOW[d]).join(', ')} · ${t}`;
}

/* ================= Stock & sites ================= */
function plannedVol(c){ return (c.dosePerInj>0 && c.strength>0) ? c.dosePerInj / c.strength : null; }
function stockInfo(c){
  if(!c.vial || !(c.vial.sizeMl>0)) return null;
  const rem = Math.max(0, c.vial.remainingMl ?? c.vial.sizeMl);
  const pv = plannedVol(c);
  const dosesLeft = pv ? Math.floor(rem/pv + 1e-9) : null;
  const pct = Math.min(1, rem / c.vial.sizeMl);
  const low = (dosesLeft!==null && dosesLeft <= (db.settings.lowStockDoses||3)) || pct < 0.1;
  return {rem, pct, dosesLeft, low};
}
/* when: the dose's date. Doses from before the current vial was opened belong to an earlier vial and don't change it. */
function adjustStock(compoundId, deltaMl, when){
  const c = db.compounds.find(c=>c.id===compoundId);
  if(!c || !c.vial || !(c.vial.sizeMl>0) || !isFinite(deltaMl)) return;
  if(when && c.vial.openedAt && new Date(when) < new Date(c.vial.openedAt)) return;
  const rem = (c.vial.remainingMl ?? c.vial.sizeMl) + deltaMl;
  c.vial.remainingMl = Math.max(0, Math.min(c.vial.sizeMl, round(rem, 3)));
}
function siteHistory(route){
  const last = {};
  SITES[route].forEach(s=>last[s]=null);
  db.logs.forEach(l=>{ if(l.site && l.site in last){ const t=+new Date(l.date); if(!last[l.site] || t>last[l.site]) last[l.site]=t; } });
  return last;
}
/* The sites a compound rotates through: the ones you picked, else the ones you've actually used
   (so it never pushes delts or quads on someone who only uses glutes), else all of them. */
function sitesFor(c){
  const route = c && c.route==='SubQ' ? 'SubQ' : 'IM';
  const all = SITES[route];
  if(c && Array.isArray(c.sites) && c.sites.filter(s=>all.includes(s)).length) return all.filter(s=>c.sites.includes(s));
  const used = new Set(db.logs.filter(l=>l.site && all.includes(l.site)).map(l=>l.site));
  return used.size >= 2 ? all.filter(s=>used.has(s)) : all;
}
function suggestSite(route, c){
  const last = siteHistory(route);
  const pool = c ? sitesFor(c) : SITES[route];
  // least recently used within your rotation; never-used first, in list order
  return pool.slice().sort((a,b)=>(last[a]||0)-(last[b]||0))[0];
}

/* ================= Edition & sections =================
   Two editions are built from this file. Code between the premium markers (training, labs, health) is left out
   of the free edition entirely by scripts/make-edition.mjs; code between the free markers is left out of the premium one.
   In the premium edition those sections also need an active licence. */
const REST_NOTIF_ID = 1900000001;
const WEEKLY_NOTIF_ID = 1900000301;
const INJ_TABS = [['today','Today'],['calendar','Calendar'],['history','History'],['labs','Labs'],['setup','Setup']];


const EDITION = 'free';
function premiumOn(){ return false; }

function tabsFor(m){
  if(m==='train') return [['tpromo','Training']];
  if(m==='health') return [['hpromo','Health']];
  return INJ_TABS;
}
const FIRST_TAB = { inj:'today', get train(){ return premiumOn() ? 'workout' : 'tpromo'; }, get health(){ return premiumOn() ? 'hoverview' : 'hpromo'; } };
const PROMO = {
  labs: {title:'Blood tests', lead:'Keep every blood test next to your protocol.', points:['Import the PDF report from your pathology lab, or add results by hand','See each marker over time, with anything outside the lab range flagged','Blood tests shown on your estimated levels chart, with the time since your last dose','Blood tests in the doctor report']},
  train: {title:'Training', lead:'Log your lifting and cardio in the same app as your protocol.', points:['Workouts from your own templates, with a rest timer that works with the phone locked','Personal bests, estimated one-rep max and progression suggestions','GPS runs, walks and hikes with maps, splits and elevation, plus treadmill runs','Import your history from the Strong app']},
  health: {title:'Health', lead:'Your watch data, recovery and body numbers alongside everything else.', points:['Sleep, resting heart rate, HRV, steps and more from Health Connect','A daily readiness score and a weekly report','Live heart rate from a Bluetooth band during workouts','BMI, calories and macro targets from your profile']},
};
function renderPromo(kind){
  const p = PROMO[kind];
  return `<div class="card promo"><div class="alert-code">${premiumOn() ? '' : 'WITH A LICENCE'}</div>
    <h3 style="margin:6px 0 6px">${esc(p.title)}</h3><p class="small" style="margin:0 0 10px">${esc(p.lead)}</p>
    <ul class="promo-list">${p.points.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>${premiumCta()}</div>
    <p class="small muted" style="margin:10px 2px">Injections, reminders, levels, the doctor report and backups are free. A licence adds training, blood tests and health.</p>`;
}

function premiumCta(){
  const link = siteLink('/pricing/');
  return link ? `<a class="btn btn-block" href="${esc(link)}" target="_blank" rel="noopener" style="margin-top:12px">See what a licence includes</a>` : '<p class="small muted" style="margin:12px 0 0">Get a licence from the Enhanced Training Studio website.</p>';
}


/* leaving the app: write anything still waiting, so nothing typed is lost if Android closes it */
let wkSaveT = null;
let reloading = false;
function flushPending(){
  if(reloading) return;
  if(wkSaveT){ clearTimeout(wkSaveT); wkSaveT = null; persistQuiet(); }
  if(modeSaveT){ clearTimeout(modeSaveT); modeSaveT = null; persistQuiet(); }
}
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) flushPending(); });
window.addEventListener('pagehide', flushPending);

/* All notification settings live in one card in App settings; each Setup screen links to it with a one-line summary. */
function notifLinkHtml(){
  const s = db.settings;
  const bits = [s.reminders ? `Dose reminders ${fmtTimeStr(s.morning)} and ${fmtTimeStr(s.night)}` : 'Dose reminders off', ].filter(Boolean);
  return `<div class="list-item tap-row" data-action="app-settings" data-notif-link>
    <div class="list-main"><div class="list-title">Notifications</div><div class="list-sub">${esc(bits.join(' · '))}</div></div>
    <svg class="chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></div>`;
}
function fmtTimeStr(hm){ const [h,m] = String(hm||'').split(':').map(Number); if(!(h>=0 && h<24 && m>=0 && m<60)) return String(hm||''); const d = new Date(); d.setHours(h,m,0,0); return fmtTime(d); }
function notifCardHtml(){
  const s = db.settings;
  return `<div class="section-label">Notifications</div><div class="card" id="notifCard">
    <div class="switch-row"><div><div class="list-title">Dose reminders</div><div class="list-sub">${isNative ? 'Notification on each scheduled day' : 'Available in the Android app'}</div></div>
      <label class="switch"><input type="checkbox" id="setRem" ${s.reminders?'checked':''} ${isNative?'':'disabled'} aria-label="Dose reminders"><span></span></label></div>
    <div class="row2" style="margin-top:10px">
      <div class="field"><label for="setMorning">Morning time</label><input type="time" id="setMorning" value="${esc(s.morning)}"></div>
      <div class="field"><label for="setNight">Night time</label><input type="time" id="setNight" value="${esc(s.night)}"></div>
    </div>
    <div class="switch-row" style="border-top:1px solid var(--hair)"><div><div class="list-title">Private reminders</div><div class="list-sub">Say "Reminder" without compound names or doses</div></div>
      <label class="switch"><input type="checkbox" id="setPrivNotif" ${s.privateNotifs?'checked':''} aria-label="Private reminders"><span></span></label></div>

    ${isNative?`<button class="btn btn-outline btn-block" data-action="rem-test" style="margin-top:8px">Send a test notification</button>`:''}
  </div>`;
}

/* ================= Rendering ================= */
const TAB_META = {
  today:   {title:'Today'},
  calendar:{title:'Calendar'},
  history: {title:'History'},
  labs:    {title:'Labs'},
  setup:   {title:'Setup'},
  workout: {title:'Workout'},
  thistory:{title:'History'},
  records: {title:'Records'},
  templates:{title:'Templates'},
  hoverview:{title:'Health'},
  htrends:{title:'Trends'},
  hweek:{title:'Weekly'},
  hbody:{title:'Body'},
  tpromo:{title:'Training'},
  hpromo:{title:'Health'},
  app:{title:'App settings'}
};
/* bottom tabs for the current section */
function renderTabbar(){
  const tabs = tabsFor(ui.mode);
  const bar = $('#tabbar');
  const sig = ui.mode + tabs.map(t=>t[0]).join();
  if(bar.dataset.sig !== sig){
    bar.innerHTML = tabs.map(([k,l])=>`<button class="tab-btn" data-tab="${esc(k)}"><span>${l}</span></button>`).join('');
    bar.dataset.sig = sig;
    bar.style.gridTemplateColumns = `repeat(${tabs.length}, minmax(0,1fr))`;
  }
  document.querySelectorAll('.tab-btn').forEach(b=>{
    const on = b.dataset.tab===ui.tab || (ui.tab==='app' && b.dataset.tab==='setup');
    b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  document.querySelectorAll('.mode-btn').forEach(b=>{ const on = b.dataset.mode===ui.mode; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
}
function setMode(m){
  if(ui.mode===m) return;
  ui.lastTab[ui.mode] = ui.tab;
  ui.mode = m; ui.tab = ui.lastTab[m] || FIRST_TAB[m] || 'today';
  db.settings.mode = m; clearTimeout(modeSaveT); modeSaveT = setTimeout(()=>{ modeSaveT = null; persistQuiet(); }, 1500);
  
  render();
   $('#main').scrollTop = 0;
}
const PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';

function render(){
  _tlCache.clear(); _loadMap = null; _logIdx = null; _labTestsCache = null;
  syncDoses();
  if(!FIRST_TAB[ui.mode]) ui.mode = 'inj';
  if(ui.tab!=='app' && !tabsFor(ui.mode).some(t=>t[0]===ui.tab)) ui.tab = FIRST_TAB[ui.mode];
  renderTabbar();
  $('#pageTitle').textContent = TAB_META[ui.tab].title;
  const sub = $('#pageSub'), meta = $('#pageMeta'), top = $('#topAction');
  meta.textContent = ''; meta.style.color = '';
  top.hidden = true; top.innerHTML = PLUS; top.dataset.action = '';
  let html = '';
  if(ui.tab==='tpromo' || ui.tab==='hpromo' || (ui.tab==='labs' && !premiumOn())){
    const kind = ui.tab==='labs' ? 'labs' : ui.tab==='tpromo' ? 'train' : 'health';
    sub.textContent = ui.tab==='labs' ? 'Blood tests' : kind==='train' ? 'Workouts · cardio' : 'Watch data · recovery';
    html = renderPromo(kind);
  } else if(ui.tab==='today'){
    sub.textContent = fmtDate(new Date()).replace(/,/g,'');
    const sts = db.compounds.map(statusFor);
    const due = sts.filter(x=>x.dueToday).length, missed = sts.reduce((n,x)=>n+(x.missed||0),0);
    $('#pageTitle').textContent = !db.compounds.length ? 'Get started' : due ? `${due} due today` : missed ? `${missed} missed` : 'All clear';
    if(missed && due){ meta.textContent = `${missed} missed`; meta.style.color = 'var(--signal)'; }
    else { const n = db.compounds.filter(c=>{ const cy = cycleState(c); return !cy || cy.state!=='done'; }).length; meta.textContent = n ? `${n} active` : ''; meta.style.color = ''; }
    html = renderToday();
    if(db.compounds.length){ top.hidden=false; top.dataset.action='log'; top.innerHTML = PLUS + '<span>Log</span>'; top.setAttribute('aria-label','Log injection'); }
  } else if(ui.tab==='calendar'){
    sub.textContent = 'Taken · missed · planned';
    html = renderCalendar();
  } else if(ui.tab==='history'){
    sub.textContent = 'Injection log'; meta.textContent = `${String(db.logs.length).padStart(3,'0')} entries`;
    html = renderHistory();
    if(db.compounds.length){ top.hidden=false; top.dataset.action='log'; top.innerHTML = PLUS + '<span>Log</span>'; top.setAttribute('aria-label','Log injection'); }
  } else if(ui.tab==='app'){
    sub.textContent = 'Notifications · lock · backup';
    html = renderAppSettings();
  } else {
    sub.textContent = ui.mode==='train' ? 'Training · exercises · import' : ui.mode==='health' ? 'Heart rate · Health Connect' : 'Compounds · vial stock';
    html = (renderSetup()) + appSettingsLink();
  }
  
  $('#main').innerHTML = html;
  
  fitTabLabels();
  if(ui.tab==='today') drawLevels();
}

/* Tab labels shrink together until the longest fits its cell (large system text sizes). */
let _fitSig = '';
function fitTabLabels(force){
  const spans = [...document.querySelectorAll('.tab-btn span')];
  if(!spans.length) return;
  // only re-measure when the tab set, window width or text size changed (measuring forces a layout)
  const sig = ($('#tabbar').dataset.sig||'') + '|' + innerWidth;
  if(!force && sig === _fitSig) return;
  _fitSig = sig;
  spans.forEach(s=>{ s.style.fontSize = ''; s.style.letterSpacing = ''; });
  let size = parseFloat(getComputedStyle(spans[0]).fontSize) || 11;
  const tooWide = ()=>spans.some(s=>s.scrollWidth > s.parentElement.clientWidth - 10);
  for(let i=0; i<12 && tooWide(); i++){
    size *= 0.92;
    spans.forEach(s=>{ s.style.fontSize = size+'px'; s.style.letterSpacing = '0.02em'; });
  }
}
window.addEventListener('resize', ()=>fitTabLabels(true));
/* labels change width once the bundled fonts finish loading */
if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>fitTabLabels(true));
setTimeout(()=>fitTabLabels(true), 600);

/* ---------- Today ---------- */
/* Syringe scale matched to the syringe in use: U-100 barrels (≤1 mL) read in units, larger ones in mL. */
function scaleFor(c, volMl){
  const b = c && c.barrel ? parseFloat(c.barrel) : NaN;
  let capMl = isFinite(b) && b>0 ? b : (volMl<=0.3 ? 0.3 : volMl<=0.5 ? 0.5 : volMl<=1 ? 1 : Math.ceil(volMl));
  if(volMl > capMl) capMl = volMl<=1 ? 1 : Math.ceil(volMl);
  const units = capMl <= 1;
  return {capMl, units, max: units ? Math.round(capMl*100) : capMl};
}
function syringeSvg(c, volMl, alert){
  const sc = scaleFor(c, volMl), W = 320, val = sc.units ? volMl*100 : volMl;
  const fill = Math.max(0, Math.min(1, val / sc.max)) * W;
  const minor = sc.units ? (sc.max<=50 ? 1 : 2) : (sc.max<=3 ? 0.1 : 0.2);
  const major = sc.units ? (sc.max<=50 ? 5 : 10) : (sc.max<=3 ? 0.5 : 1);
  let ticks = '';
  const n = Math.round(sc.max / minor);
  for(let i=0;i<=n;i++){
    const v = i*minor, x = (v/sc.max*W).toFixed(1);
    const isMajor = Math.abs(v/major - Math.round(v/major)) < 1e-6;
    ticks += `<line class="tick" x1="${x}" y1="30" x2="${x}" y2="${isMajor?42:35}"></line>`;
  }
  const labels = [0, sc.max/2, sc.max].map((v,i)=>`<text x="${(v/sc.max*W).toFixed(1)}" y="56" text-anchor="${['start','middle','end'][i]}">${sc.units ? Math.round(v) : round(v,2)}${i===2 ? (sc.units?' U':' mL') : ''}</text>`).join('');
  const readout = sc.units ? `${round(val,1)} units` : `${round(val,2)} mL`;
  return `<svg class="scale ${alert?"scale-alert":""}" viewBox="0 -2 ${W} 62" role="img" aria-label="Syringe: draw to ${readout} on a ${sc.units ? sc.max+'-unit' : sc.capMl+' mL'} scale">
    <rect class="barrel" x="0" y="4" width="${W}" height="22"></rect>
    <rect class="fill" x="1" y="5" width="${Math.max(0,fill-1).toFixed(1)}" height="20"></rect>
    <line class="plunger" x1="${fill.toFixed(1)}" y1="-1" x2="${fill.toFixed(1)}" y2="31"></line>
    ${ticks}${labels}</svg>`;
}
function renderToday(){
  if(!db.compounds.length){
    return `<div class="card"><div class="empty">No compounds yet.<br><br>
      <button class="btn" data-action="compound-add">Add a compound</button></div></div>`;
  }
  let html = '';
  const bAge = db.settings.lastBackupAt ? diffDays(new Date(), db.settings.lastBackupAt) : null;
  if(db.logs.length && (bAge===null || bAge >= 7 || (isNative && db.settings.lastBackupError))){
    const why = isNative && db.settings.lastBackupError ? 'The automatic backup could not be saved.' : bAge===null ? 'Your data has never been backed up.' : `Last backup was ${bAge} days ago.`;
    html += `<div class="alert"><span class="alert-code">BACKUP NEEDED</span><div>${why} Everything is stored only on this phone.</div>
      <button class="btn btn-outline" data-action="${isNative?'backup-now':'export'}">Back up now</button></div>`;
  }
  db.compounds.forEach(c=>{
    const s = stockInfo(c);
    if(s && s.low){
      html += `<div class="alert"><span class="alert-code">VIAL LOW · ${esc(c.name.toUpperCase())}</span>
        <div>${round(s.rem,2)} mL left${s.dosesLeft!==null?`, about <b>${s.dosesLeft} ${s.dosesLeft===1?'dose':'doses'}</b>`:''}.</div>
        <button class="btn btn-outline" data-action="vial-new" data-id="${esc(c.id)}">Start new vial</button></div>`;
    }
  });
  const withStatus = db.compounds.map(c=>({c, st:statusFor(c)}));
  const due = withStatus.filter(x=>x.st.due), rest = withStatus.filter(x=>!x.st.due && !x.st.finished), done = withStatus.filter(x=>x.st.finished);
  const full = ({c, st})=>{
    const pv = plannedVol(c), stock = stockInfo(c), site = suggestSite(c.route, c);
    const unitsTxt = pv && pv<=1 ? `${round(pv*100,1)} u` : (pv ? `${round(pv,2)} mL` : '—');
    return `<div class="dose">
      <div class="dose-head">
        <div><div class="dose-name">${esc(c.name)}</div><div class="dose-sched">${esc(scheduleLabel(c))}${doseChangeNote(c)}${cycleNote(c)}</div></div>
        <span class="tag ${st.cls}">${esc(st.label)}</span>
      </div>
      ${st.missedDays && st.missedDays.length ? (()=>{ const d = st.missedDays[0]; const more = st.missedDays.length-1;
        return `<div class="missed-row"><div><span class="alert-code">MISSED</span> ${esc(fmtDate(parseYmd(d)))}${more?` <span class="muted">+${more} earlier</span>`:''}</div>
          <div class="foot-btns">${more ? `<button class="btn btn-outline" data-action="skip-all" data-id="${esc(c.id)}">Skip all ${more+1}</button>` : `<button class="btn btn-outline" data-action="skip" data-id="${esc(c.id)}" data-day="${esc(d)}">Skip it</button>`}<button class="btn btn-outline" data-action="log" data-id="${esc(c.id)}" data-day="${esc(d)}">Log late</button></div></div>`; })() : ''}
      ${pv ? syringeSvg(c, pv, !!st.missed) : `<div class="small muted">Set a planned dose (Setup) to see the draw on the syringe.</div>`}
      <div class="readout">
        <div><span>Dose</span><span>${c.dosePerInj ? fmtAmt(c.dosePerInj, c.unit) : '—'}</span></div>
        <div><span>Draw</span><span>${unitsTxt}</span></div>
        <div><span>Site</span><span>${esc(site)}</span></div>
      </div>
      <div class="dose-foot">
        <span class="vial-line ${stock&&stock.low?'low':''}">${stock ? `Vial ${round(stock.rem,2)} / ${c.vial.sizeMl} mL${stock.dosesLeft!==null?` · ≈${stock.dosesLeft} doses`:''}` : (pv ? `${round(pv,2)} mL${c.barrel?' · '+esc(c.barrel)+' syringe':''}` : '')}</span>
        <div class="foot-btns"><button class="btn btn-outline" data-action="skip" data-id="${esc(c.id)}">Skip</button><button class="btn" data-action="log" data-id="${esc(c.id)}">Log dose</button></div>
      </div>
    </div>`;
  };
  const compact = ({c, st})=>{
    const pv = plannedVol(c);
    return `<div class="dose compact-wrap">
      <div class="dose compact">
        <div class="grow"><div class="dose-name">${esc(c.name)}</div>
          <div class="dose-sched">${c.dosePerInj?fmtAmt(c.dosePerInj,c.unit)+' · ':''}${pv&&pv<=1?round(pv*100,1)+' u · ':''}${esc(scheduleLabel(c))}${doseChangeNote(c)}${cycleNote(c)}</div>
          <div style="margin-top:8px"><span class="tag ${st.cls}">${esc(st.label)}</span></div></div>
        <button class="btn btn-outline" data-action="log" data-id="${esc(c.id)}">Log</button>
      </div>
      ${pv && !st.paused ? `<div class="scale-slim">${syringeSvg(c, pv, false)}</div>` : ''}
    </div>`;
  };
  if(due.length) html += `<div class="section-label">Due now</div>${due.map(full).join('')}`;
  if(rest.length) html += `<div class="section-label">${due.length?'Coming up':'Schedule'}</div>${rest.map(compact).join('')}`;
  if(done.length) html += `<div class="section-label">Finished cycles</div><div class="card">${done.map(({c})=>{ const cy = cycleState(c);
      return `<div class="list-item"><div class="list-main"><div class="list-title">${esc(c.name)}</div>
        <div class="list-sub">${esc(cycleLengthText(c.cycle))} · ${esc(fmtShort(parseYmd(cy.start)))} – ${esc(fmtShort(parseYmd(cy.lastDay)))}</div></div>
        <button class="btn btn-outline" data-action="cycle-next" data-id="${esc(c.id)}">New cycle</button></div>`; }).join('')}</div>`;

  const hl = db.compounds.filter(c=>c.halfLife>0);
  html += `<div class="section-label">Estimated levels</div>`;
  if(!hl.length){
    html += `<div class="card"><div class="empty small">Add a compound's half-life to see roughly how much is active over time.${db.compounds.length ? `<br><br><button class="btn btn-outline" data-action="compound-edit" data-id="${esc(db.compounds[0].id)}">Add half-life to ${esc(db.compounds[0].name)}</button>` : ''}</div></div>`;
  } else {
    if(!hl.find(c=>c.id===ui.chartCompound)) ui.chartCompound = hl[0].id;
    const cur = hl.find(c=>c.id===ui.chartCompound);
    html += `<div class="card">
      <div class="card-head">
        ${hl.length>1 ? `<div class="chips" style="margin:0">${hl.map(c=>`<button class="chip ${c.id===ui.chartCompound?'active':''}" data-action="chart-compound" data-id="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</div>` : `<span class="dose-sched" style="margin:0">${esc(cur.name)} · t½ ${cur.halfLife} d</span>`}
        <div class="seg" role="group" aria-label="Range">${[[4,'4W'],[12,'12W'],[52,'1Y']].map(([w,l])=>`<button class="${ui.chartWeeks===w?'active':''}" data-action="chart-weeks" data-w="${esc(w)}">${l}</button>`).join('')}</div>
      </div>
      <div class="chart-wrap" id="chartWrap"><canvas id="levels" role="img" aria-label="Estimated active amount over time"></canvas><div class="chart-tip" id="chartTip" hidden></div></div>
      <div class="chart-note" id="chartNote"></div>
    </div>`;
  }
  return html;
}

function doseChangeNote(c){
  const n = nextDoseChange(c);
  return n ? ` · ${esc(fmtAmt(n.dose, c.unit))} from ${esc(fmtShort(parseYmd(n.from)))}` : '';
}
/* Record a dose as skipped on purpose (covers that scheduled dose; no volume used). */
function skipDose(cid, dayKey){
  const c = db.compounds.find(c=>c.id===cid); if(!c) return;
  const today = ymd(new Date());
  const when = dayKey && dayKey!==today ? (()=>{ const d = parseYmd(dayKey); d.setHours(12,0,0,0); return d; })() : new Date();
  const log = {id:uid(), compoundId:c.id, compoundName:c.name, skipped:true, dose:0, unit:c.unit, volumeMl:0, date:when.toISOString(), site:null, notes:''};
  db.logs.push(log); save(); render(); haptic();
  toast(`${c.name} marked skipped`, {label:'Undo', fn:()=>{ db.logs = db.logs.filter(l=>l.id!==log.id); save(); render(); toast('Undone'); }});
}

/* Mark every missed dose of a compound as skipped on purpose, with one undo. */
function skipAllMissed(cid){
  const c = db.compounds.find(c=>c.id===cid); if(!c) return;
  const st = statusFor(c); const days = st.missedDays || []; if(!days.length) return;
  const made = days.map(k=>{ const d = parseYmd(k); d.setHours(12,0,0,0);
    return {id:uid(), compoundId:c.id, compoundName:c.name, skipped:true, dose:0, unit:c.unit, volumeMl:0, date:d.toISOString(), site:null, notes:''}; });
  db.logs.push(...made); save(); render(); haptic();
  const ids = new Set(made.map(l=>l.id));
  toast(`${made.length} missed ${made.length===1?'dose':'doses'} of ${c.name} marked skipped`, {label:'Undo', fn:()=>{ db.logs = db.logs.filter(l=>!ids.has(l.id)); save(); render(); toast('Undone'); }});
}

/* ---------- Levels chart ---------- */
let chartState = null;
function levelSeries(c, weeks){
  const now = Date.now();
  const start = now - weeks*7*DAY, end = now + 14*DAY;
  const k = Math.LN2 / (c.halfLife*DAY);
  const past = db.logs.filter(l=>l.compoundId===c.id && !l.skipped && l.dose>0).map(l=>({t:+new Date(l.date), mg:l.dose}));
  const firstT = past.length ? Math.min(...past.map(d=>d.t)) : now;
  // projected doses from the schedule, using the planned dose in effect on each day
  const proj = [];
  if(hasSchedule(c)){
    const [h,m] = hm(c.time==='night' ? db.settings.night : db.settings.morning);
    timeline(c, dayStart(now), new Date(end)).forEach(t=>{
      if(t.status==='taken' || t.status==='skipped') return;
      const mg = doseOn(c, t.day); if(!(mg>0)) return;
      const at = new Date(t.day); at.setHours(h,m,0,0);
      proj.push({t: Math.max(+at, now), mg});
    });
  }
  const N = 280, pts = [];
  for(let i=0;i<=N;i++){
    const t = start + (end-start)*i/N;
    let v = 0;
    for(const d of past) if(d.t<=t) v += d.mg*Math.exp(-k*(t-d.t));
    if(t>now) for(const d of proj) if(d.t<=t) v += d.mg*Math.exp(-k*(t-d.t));
    pts.push({t, v: t < firstT ? null : v});   // no estimate before the first logged dose
  }
  let nowV = 0; for(const d of past) if(d.t<=now) nowV += d.mg*Math.exp(-k*(now-d.t));
  const estAt = t => t < firstT ? null : past.reduce((v,d)=> d.t<=t ? v + d.mg*Math.exp(-k*(t-d.t)) : v, 0);
  return {pts, start, end, now, nowV, firstT, estAt};
}
function niceMax(v){
  if(v<=0) return 1;
  const p = 10**Math.floor(Math.log10(v)), n = v/p;
  return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p;
}
/* Paint the levels chart onto any canvas (the live chart, or an off-screen one for the PDF report). */
function paintLevels(cv, c, weeks, W, H, dpr, col, MONO){
  cv.width = W*dpr; cv.height = H*dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle = col('--card'); g.fillRect(0,0,W,H);
  const S = levelSeries(c, weeks);
  const unit = c.unit;
  const maxV = niceMax(Math.max(1e-9, ...S.pts.filter(p=>p.v!=null).map(p=>p.v))*1.1);
  const pad = {l:44, r:10, t:26, b:24};
  const x = t => pad.l + (t-S.start)/(S.end-S.start)*(W-pad.l-pad.r);
  const y = v => H - pad.b - v/maxV*(H-pad.t-pad.b);
  g.font = `10px ${MONO}`;
  // grid + y labels
  g.strokeStyle = col('--grid'); g.fillStyle = col('--muted'); g.lineWidth = 1;
  g.textAlign='right'; g.textBaseline='middle';
  for(let i=0;i<=4;i++){
    const v = maxV*i/4, yy = Math.round(y(v))+0.5;
    g.beginPath(); g.moveTo(pad.l, yy); g.lineTo(W-pad.r, yy); g.stroke();
    g.fillText(fmtAmt(v, unit).replace(/ (mg|mcg)$/, ''), pad.l-6, yy);
  }
  g.textAlign='right'; g.textBaseline='alphabetic'; g.fillText(unit, pad.l-6, 12); g.textBaseline='middle';
  // x labels weekly
  g.textAlign='center'; g.textBaseline='alphabetic';
  if(weeks >= 40){
    const d0 = new Date(S.start); let m = new Date(d0.getFullYear(), d0.getMonth()+1, 1);
    for(; +m <= S.end; m = new Date(m.getFullYear(), m.getMonth()+2, 1)){
      const xx = x(+m); if(xx < pad.l+14 || xx > W-pad.r-14) continue;
      g.fillText(m.toLocaleDateString(undefined,{month:'short'}).toUpperCase(), xx, H-6);
    }
  } else {
    const step = weeks>8 ? 14 : 7;
    for(let t = +dayStart(S.start); t <= S.end; t += step*DAY){
      const xx = x(t); if(xx < pad.l+14 || xx > W-pad.r-14) continue;
      g.fillText(fmtShort(t), xx, H-6);
    }
  }
  // now line
  const nx = Math.round(x(S.now))+0.5;
  g.strokeStyle = col('--muted'); g.setLineDash([2,3]);
  g.beginPath(); g.moveTo(nx, pad.t); g.lineTo(nx, H-pad.b); g.stroke(); g.setLineDash([]);
  // area + line (past solid, future dashed)
  const accent = col('--text'), signal = col('--signal');
  const pastPts = S.pts.filter(p=>p.t<=S.now && p.v!=null), futPts = S.pts.filter(p=>p.t>=S.now && p.v!=null);
  if(pastPts.length>1){
    g.beginPath(); g.moveTo(x(pastPts[0].t), y(0));
    pastPts.forEach(p=>g.lineTo(x(p.t), y(p.v)));
    g.lineTo(x(pastPts[pastPts.length-1].t), y(0)); g.closePath();
    g.fillStyle = accent; g.globalAlpha = 0.07; g.fill(); g.globalAlpha = 1;
  }
  g.lineWidth = 1.6; g.strokeStyle = accent; g.lineJoin='miter';
  const line = (pts, dash)=>{ if(pts.length<2) return; g.setLineDash(dash); g.beginPath(); pts.forEach((p,i)=> i?g.lineTo(x(p.t),y(p.v)):g.moveTo(x(p.t),y(p.v))); g.stroke(); g.setLineDash([]); };
  line(pastPts, []); line(futPts, [5,4]);
  // now marker + direct label
  const ny = y(S.nowV);
  g.fillStyle = col('--card'); g.fillRect(nx-6, ny-6, 12, 12);
  g.fillStyle = signal; g.fillRect(nx-4, ny-4, 8, 8);
  g.fillStyle = col('--text'); g.font = `600 11px ${MONO}`;
  const label = `NOW ≈ ${fmtEst(S.nowV, unit).toUpperCase()}`;
  const tw = g.measureText(label).width;
  // label sits in the top band, beside the "now" line
  const lx = nx + 6 + tw <= W - pad.r ? nx + 6 : nx - 6 - tw;
  g.textAlign='left'; g.textBaseline='alphabetic'; g.fillText(label, lx, 13);
  // blood tests on the timeline
  const tests = labTests().filter(tst=>+tst.at >= S.start && +tst.at <= S.now);
  g.font = `600 9px ${MONO}`; g.textAlign = 'center';
  const marks = tests.map(tst=>{
    const v = S.estAt(+tst.at), mx = x(+tst.at), my = v==null ? H - pad.b : y(v);
    g.fillStyle = col('--card'); g.fillRect(mx-5, my-5, 10, 10);
    g.strokeStyle = signal; g.lineWidth = 2; g.strokeRect(mx-4, my-4, 8, 8);
    g.fillStyle = signal; g.fillText('LAB', mx, Math.max(pad.t+8, my-9));
    return {tst, v, mx, my};
  });
  return {S, x, y, pad, W, H, unit, marks, c};
}
function drawLevels(){
  const cv = $('#levels'); if(!cv) return;
  const c = db.compounds.find(c=>c.id===ui.chartCompound); if(!c) return;
  const css = getComputedStyle(document.documentElement);
  const col = n => css.getPropertyValue(n).trim();
  const MONO = css.getPropertyValue('--mono') || 'monospace';
  chartState = paintLevels(cv, c, ui.chartWeeks, cv.clientWidth, cv.clientHeight, window.devicePixelRatio || 1, col, MONO);
  const {marks, unit} = chartState;
  const doses = db.logs.filter(l=>l.compoundId===c.id && !l.skipped).length;
  let note = `Estimate from your ${doses} logged ${doses===1?'dose':'doses'} and a ${c.halfLife}-day half-life. Dashed line = planned doses. It shows amount remaining, not a blood level.`;
  const lines = marks.map(({tst, v})=>`<div class="lab-note"><b>Blood test ${esc(fmtShort(tst.at))}</b> · ${esc(labTimingText(tst.at, c) || 'no dose logged before it')}${v!=null?` · est. ${esc(fmtEst(v, unit))} active`:''}${tst.key?` · ${esc(tst.key.marker)} ${esc(labValueText(tst.key))} ${esc(tst.key.unit||'')}${tst.key.flag?` (${esc(tst.key.flag)})`:''}`:''}</div>`);
  const hidden = !marks.length && labTests().some(t=>t.at < chartState.S.start) && ui.chartWeeks < 52;
  $('#chartNote').innerHTML = esc(note) + lines.join('') + (hidden ? `<div style="margin-top:8px"><button class="btn btn-outline" data-action="chart-weeks" data-w="52">Show blood tests (1 year)</button></div>` : '');
}
function chartHover(ev){
  if(!chartState) return;
  const cv = $('#levels'), tip = $('#chartTip');
  const r = cv.getBoundingClientRect();
  const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
  const {S, x, y, pad, W} = chartState;
  if(px < pad.l || px > W-pad.r){ tip.hidden = true; return; }
  const mk = (chartState.marks||[]).find(m=>Math.abs(m.mx - px) < 12);
  if(mk){
    const k = mk.tst.key;
    tip.hidden = false;
    tip.innerHTML = `Blood test ${fmtShort(mk.tst.at)}<br>${k?`<b>${esc(k.marker)} ${esc(labValueText(k))} ${esc(k.unit||'')}</b>${k.flag?' '+esc(k.flag):''}<br>`:''}${esc(labTimingText(mk.tst.at, chartState.c) || '')}`;
    tip.style.left = Math.min(Math.max(mk.mx, 70), W-70)+'px'; tip.style.top = (mk.my-12)+'px';
    return;
  }
  const t = S.start + (px-pad.l)/(W-pad.l-pad.r)*(S.end-S.start);
  let best = null; for(const p of S.pts) if(p.v!=null && (!best || Math.abs(p.t-t) < Math.abs(best.t-t))) best = p;
  if(!best){ tip.hidden = true; return; }
  tip.hidden = false;
  tip.innerHTML = `${fmtShort(best.t)}${best.t>S.now?' (planned)':''}<br><i style="background:var(--signal)"></i><b>${fmtEst(best.v, chartState.unit)}</b>`;
  tip.style.left = Math.min(Math.max(x(best.t), 60), W-60)+'px';
  tip.style.top = (y(best.v)-10)+'px';
}

/* ---------- Calendar ---------- */
function calendarItems(from, to){
  // map ymd -> [{c, status, log}]
  const map = {};
  const push = (d, item)=>{ const k=ymd(d); (map[k] = map[k]||[]).push(item); };
  const matched = new Set();
  db.compounds.forEach(c=>{
    timeline(c, from, to).forEach(t=>{
      if(t.log){ matched.add(t.log.id); push(t.log.date, {c, status:t.status, log:t.log, day:t.day}); }
      else push(t.day, {c, status:t.status, day:t.day});
    });
  });
  db.logs.forEach(l=>{
    if(matched.has(l.id)) return;
    const d = new Date(l.date);
    if(d>=from && d<=addDays(to,1)) push(d, {c:db.compounds.find(c=>c.id===l.compoundId), status:l.skipped?'skipped':'taken', log:l, day:dayStart(d)});
  });
  return map;
}
function renderCalendar(){
  const today = dayStart(new Date());
  if(!ui.calMonth) ui.calMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  if(!ui.calSel) ui.calSel = ymd(today);
  const m0 = ui.calMonth;
  const first = new Date(m0);
  const lead = (first.getDay()+6)%7; // Monday first
  const gridStart = addDays(first, -lead);
  const gridEnd = addDays(gridStart, 41);
  const items = calendarItems(gridStart, gridEnd);
  let cells = DOW_ORDER.map(d=>`<div class="cal-dow">${DOW[d].slice(0,1)}</div>`).join('');
  for(let i=0;i<42;i++){
    const d = addDays(gridStart,i), k = ymd(d);
    const list = items[k] || [];
    const dots = list.slice(0,6).map(it=>`<i class="dot-${it.status}"></i>`).join('');
    const cls = [d.getMonth()!==m0.getMonth()?'out':'', +d===+today?'today':'', k===ui.calSel?'sel':''].join(' ');
    const aria = `${fmtDate(d)}: ${list.length ? list.map(it=>`${it.c?it.c.name:'Removed'} ${it.status}`).join(', ') : 'nothing scheduled'}`;
    cells += `<button class="cal-day ${cls}" data-action="cal-sel" data-d="${esc(k)}" aria-label="${esc(aria)}"><span class="d">${d.getDate()}</span><span class="cal-dots">${dots}</span></button>`;
  }
  const monthName = fmtMonth(m0);
  let html = `<div class="card">
    <div class="cal-head">
      <button class="icon-btn" data-action="cal-prev" aria-label="Previous month"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <h3>${esc(monthName)}</h3>
      <button class="icon-btn" data-action="cal-next" aria-label="Next month"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-key"><span><i class="dot-taken"></i>Taken</span><span><i class="dot-missed"></i>Missed</span><span><i class="dot-due"></i>Due</span><span><i class="dot-planned"></i>Planned</span><span><i class="dot-skipped"></i>Skipped</span></div>
  </div>`;
  // selected day detail
  const sel = parseYmd(ui.calSel);
  const list = calendarItems(sel, sel)[ui.calSel] || [];
  html += `<div class="section-label">${esc(fmtDate(sel))}</div><div class="card">`;
  if(!list.length) html += `<div class="empty small">Nothing scheduled or logged.</div>`;
  list.forEach(it=>{
    const name = it.c ? it.c.name : (it.log && it.log.compoundName) || 'Removed compound';
    if(it.status==='skipped'){
      html += `<div class="list-item tap-row" data-action="log-edit" data-id="${esc(it.log.id)}">
        <div class="list-main"><div class="list-title">${esc(name)}</div><div class="list-sub">Skipped on purpose</div></div>
        <span class="tag tag-muted">Skipped</span></div>`;
    } else if(it.status==='taken'){
      const l = it.log;
      html += `<div class="list-item tap-row" data-action="log-edit" data-id="${esc(l.id)}">
        <div class="list-main"><div class="list-title">${esc(name)}</div>
        <div class="list-sub">${fmtTime(l.date)}${l.site?' · '+esc(l.site):''}</div></div>
        <div class="list-right"><span class="tag tag-ok">Taken</span><div class="small muted" style="margin-top:4px">${fmtAmt(l.dose, l.unit)}</div></div></div>`;
    } else {
      const pill = it.status==='missed' ? '<span class="tag tag-late">Missed</span>' : it.status==='due' ? '<span class="tag tag-due">Due</span>' : '<span class="tag tag-muted">Planned</span>';
      const canLog = it.c && it.day <= today;
      html += `<div class="list-item"><div class="list-main"><div class="list-title">${esc(name)}</div>
        <div class="list-sub">${esc(it.c?scheduleLabel(it.c):'')}</div></div>
        ${pill}${canLog?` <button class="btn btn-tonal" data-action="log" data-id="${esc(it.c.id)}" data-day="${ymd(it.day)}">Log</button>`:''}${canLog && it.status!=='planned'?` <button class="btn btn-outline" data-action="skip" data-id="${esc(it.c.id)}" data-day="${ymd(it.day)}">Skip</button>`:''}</div>`;
    }
  });
  html += `</div>`;
  return html;
}

/* ---------- History ---------- */
function renderHistory(){
  const ids = new Set(db.compounds.map(c=>c.id));
  if(ui.histFilter!=='all' && ui.histFilter!=='removed' && !ids.has(ui.histFilter)) ui.histFilter='all';
  const hasRemoved = db.logs.some(l=>!ids.has(l.compoundId));
  let html = `<div class="chips">
    <button class="chip ${ui.histFilter==='all'?'active':''}" data-action="hist-filter" data-f="all">All</button>
    ${db.compounds.map(c=>`<button class="chip ${ui.histFilter===c.id?'active':''}" data-action="hist-filter" data-f="${esc(c.id)}">${esc(c.name)}</button>`).join('')}
    ${hasRemoved?`<button class="chip ${ui.histFilter==='removed'?'active':''}" data-action="hist-filter" data-f="removed">Removed</button>`:''}
  </div>`;
  const list = db.logs.filter(l=> ui.histFilter==='all' || (ui.histFilter==='removed' ? !ids.has(l.compoundId) : l.compoundId===ui.histFilter))
    .slice().sort((a,b)=>+new Date(b.date) - +new Date(a.date));
  if(!list.length) return html + `<div class="card"><div class="empty">No injections logged yet.</div></div>` + reportBtnHtml();
  const byId = {}; db.compounds.forEach(c=>{ byId[c.id] = c; });
  const limit = ui.ihLimit || 60;
  let lastDay = null, open = false;
  list.slice(0, limit).forEach(l=>{
    const c = byId[l.compoundId];
    const day = fmtDate(l.date);
    if(day!==lastDay){ if(open) html += '</div>'; html += `<div class="day-label">${esc(day)}</div><div class="card">`; open = true; lastDay = day; }
    const vol = l.volumeMl ?? (l.strength ? l.dose/l.strength : null);
    html += `<div class="list-item tap-row" data-action="log-edit" data-id="${esc(l.id)}">
      <div class="list-main"><div class="list-title">${esc(c ? c.name : (l.compoundName || 'Removed compound'))}</div>
        <div class="list-sub mono">${fmtTime(l.date)}${vol?` · ${round(vol,2)} mL${vol<=1?` (${round(vol*100,1)} u)`:''}`:''}${l.site?' · '+esc(l.site):''}</div>
        ${l.notes?`<div class="list-note">${esc(l.notes)}</div>`:''}
      </div>
      <div class="list-right">${l.skipped ? '<span class="tag tag-muted">Skipped</span>' : `<div class="big">${fmtAmt(l.dose, l.unit || (c&&c.unit))}</div>`}</div>
    </div>`;
  });
  if(open) html += '</div>';
  if(list.length > limit) html += `<button class="btn btn-outline btn-block" data-action="ih-more">Show older injections (${list.length - limit} more)</button>`;
  return html + reportBtnHtml();
}
/* The doctor report lives under History in both editions */
function reportBtnHtml(){
  if(!db.compounds.length) return '';
  return `<div class="section-label">Doctor report</div><div class="card"><p class="small muted" style="margin:0 0 10px">A PDF of your regimen, adherence, estimated levels${premiumOn() ? ', blood tests' : ''} and injection log, to share with your doctor.</p>
    <button class="btn btn-block" data-action="report">Create doctor report</button></div>`;
}

/* ---------- Labs ---------- */
/* One entry per blood test (date + time), with a representative result for labels. */
let _labTestsCache = null;
function labTests(){ return _labTestsCache || (_labTestsCache = labTestsCalc()); }
function labTestsCalc(){
  const by = {};
  db.labs.forEach(r=>{ const k = `${r.date} ${r.time||'12:00'}`; (by[k] = by[k] || []).push(r); });
  const pref = ['Total testosterone','Free testosterone','Oestradiol (E2)','Haematocrit'];
  return Object.entries(by).map(([k, rows])=>{
    const [d, tm] = k.split(' '); const at = parseYmd(d); const [h,m] = hm(tm); at.setHours(h,m,0,0);
    const key = pref.map(p=>rows.find(r=>r.marker===p)).find(Boolean) || rows.find(r=>r.flag) || rows[0];
    return {date:d, at, rows, key};
  }).sort((a,b)=>a.at-b.at);
}
/* "2.1 d after Test Cyp" — time since the last logged dose before a blood test. */
/* Logs grouped by compound, oldest first (rebuilt after every change) */
let _logIdx = null;
function logsByCompound(){
  if(_logIdx) return _logIdx;
  const m = new Map();
  for(const l of db.logs){ let a = m.get(l.compoundId); if(!a) m.set(l.compoundId, a = []); a.push({l, t:+new Date(l.date)}); }
  for(const a of m.values()) a.sort((x,y)=>x.t - y.t);
  return _logIdx = m;
}
function labTimingText(at, onlyCompound){
  const lim = +at;
  const list = (onlyCompound ? [onlyCompound] : db.compounds).map(c=>{
    const a = logsByCompound().get(c.id) || [];
    let lo = 0, hi = a.length - 1, idx = -1;          // last log at or before `at`
    while(lo <= hi){ const mid = (lo+hi) >> 1; if(a[mid].t <= lim){ idx = mid; lo = mid+1; } else hi = mid-1; }
    while(idx >= 0 && a[idx].l.skipped) idx--;
    return idx >= 0 ? {c, hrs:(lim - a[idx].t)/36e5} : null;
  }).filter(x=>x && x.hrs < 24*45);
  if(!list.length) return '';
  return list.map(({c, hrs})=>`${hrs < 48 ? Math.round(hrs)+' h' : round(hrs/24,1)+' d'} after ${c.name}`).join(', ');
}
function labGroups(){
  const g = {};
  db.labs.forEach(r=>{ (g[r.marker] = g[r.marker] || []).push(r); });
  Object.values(g).forEach(a=>a.sort((x,y)=>parseYmd(x.date)-parseYmd(y.date)));
  return g;
}
function sparkSvg(vals){
  if(vals.length<2) return '';
  const W=84, H=30, p=4, mn=Math.min(...vals), mx=Math.max(...vals), span = (mx-mn)||1;
  const pts = vals.map((v,i)=>[p+i*(W-2*p)/(vals.length-1), H-p-(v-mn)/span*(H-2*p)]);
  const last = pts[pts.length-1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round" points="${pts.map(q=>q.map(n=>n.toFixed(1)).join(',')).join(' ')}"/><rect x="${last[0]-3}" y="${last[1]-3}" width="6" height="6" fill="var(--signal)"/></svg>`;
}
function labValueText(r){ return `${r.qual||''}${round(r.value, 3)}`; }
function labFlagTag(r){ return r && r.flag ? `<span class="tag tag-late" title="${r.flag==='H'?'Above':'Below'} the lab's reference range">${esc(r.flag)}</span>` : ''; }

/* ---------- Setup ---------- */
function renderSetup(){
  const s = db.settings;
  let html = `<div class="section-label">Compounds</div><div class="card">`;
  if(!db.compounds.length) html += `<div class="empty small">No compounds added.</div>`;
  db.compounds.forEach(c=>{
    const stock = stockInfo(c);
    html += `<div class="list-item tap-row" data-action="compound-edit" data-id="${esc(c.id)}">
      <div class="list-main"><div class="list-title">${esc(c.name)}</div>
      <div class="list-sub">${round(c.strength,3)} mg/mL${c.form==='powder'?' (reconstituted)':''} · ${c.route} · ${esc(scheduleLabel(c))}</div>
      <div class="list-sub">${currentPause(c)?'<b>Paused</b> · ':''}${c.dosePerInj?fmtAmt(c.dosePerInj,c.unit)+' per injection':'No planned dose'}${doseChangeNote(c)}${cycleNote(c)}${stock?` · ${round(stock.rem,2)}/${c.vial.sizeMl} mL in vial`:''}${c.halfLife?` · t½ ${c.halfLife}d`:''}</div></div>
      <svg class="chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
    </div>`;
  });
  html += `</div><button class="btn btn-block" data-action="compound-add">Add compound</button>`;

  html += `<div class="section-label">Vial stock</div><div class="card">
    <div class="field" style="margin:0"><label for="setLow">Warn when doses left in a vial is at or below</label>
    <input type="number" id="setLow" min="0" max="20" step="1" inputmode="numeric" value="${esc(s.lowStockDoses)}"></div>
  </div>`;

  html += `<p class="small muted" style="text-align:center; margin:18px 8px 4px">Planning tool only. Doses, draw volumes and level estimates come from what you enter. Check them against your prescription.</p>`;
  return html;
}

function appSettingsLink(){
  return `<div class="section-label">App</div><div class="card" style="padding:0 14px">${notifLinkHtml()}<div class="list-item tap-row" data-action="app-settings">
    <div class="list-main"><div class="list-title">App settings</div><div class="list-sub">Google · app lock · backups</div></div>
    <svg class="chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></div></div>`;
}
/* Version and edition come from build-info.js, which the build script writes. The free edition is an older version published on GitHub. */
const BUILD = Object.assign({ version: 'dev', edition: 'premium', siteUrl: '' }, window.ETS_BUILD || {});
function siteLink(path){ const u = String(BUILD.siteUrl||''); return /^https:\/\/[\w.-]+\.[a-z]{2,}$/i.test(u) && !/example\.com$/i.test(u) ? u + path : ''; }
function aboutCardHtml(){
  const free = EDITION === 'free', link = siteLink('/pricing/');
  return `<div class="section-label">About</div><div class="card">
    <div class="kv" style="border:none; padding-top:0"><span>Version</span><span>${esc(BUILD.version)}${free ? ' \u00b7 free edition' : ''}</span></div>
    ${free ? `<p class="small muted" style="margin:6px 0 0">The free edition covers injections, reminders, levels and backups. Training, blood tests and health come with a licence${link ? `: <a href="${esc(link)}" target="_blank" rel="noopener">${esc(link.replace(/^https:\/\//,''))}</a>` : ''}.</p>` : ''}
  </div>`;
}
function renderAppSettings(){
  const s = db.settings;
  let html = `<button type="button" class="chip-btn" data-action="app-back" style="margin-bottom:4px">\u2039 Back to setup</button>` + notifCardHtml() + renderGoogleCard();
  html += `<div class="section-label">Privacy</div><div class="card">
    <div class="switch-row"><div><div class="list-title">App lock</div><div class="list-sub">${isNative && lockPlugin() ? 'Unlock with your fingerprint, face or screen lock' : 'Available in the Android app'}</div></div>
      <label class="switch"><input type="checkbox" id="setLock" ${s.lockEnabled?'checked':''} ${isNative && lockPlugin()?'':'disabled'} aria-label="App lock"><span></span></label></div>
    ${s.lockEnabled ? `<div class="field" style="margin:8px 0 4px"><label for="setLockAfter">Lock again after leaving the app</label>
      <select id="setLockAfter">${[[0,'Immediately'],[1,'After 1 minute'],[5,'After 5 minutes'],[15,'After 15 minutes']].map(([v,l])=>`<option value="${v}" ${(s.lockAfter||0)===v?'selected':''}>${l}</option>`).join('')}</select></div>
` : ''}
    <div class="switch-row" style="border-top:1px solid var(--hair); margin-top:6px"><div><div class="list-title">Block screenshots</div><div class="list-sub">${isNative && lockPlugin() ? (s.lockEnabled ? 'Always on while App lock is on. Also hides the app in the recent-apps view' : 'Also hides the app in the recent-apps view') : 'Available in the Android app'}</div></div>
      <label class="switch"><input type="checkbox" id="setSecure" ${s.secureScreen||s.lockEnabled?'checked':''} ${isNative && lockPlugin() && !s.lockEnabled?'':'disabled'} aria-label="Block screenshots"><span></span></label></div>

  </div>`;

  const lb = s.lastBackupAt ? `${fmtDate(s.lastBackupAt)} ${fmtTime(s.lastBackupAt)}` : 'Never';
  html += `<div class="section-label">Backup</div><div class="card">
    ${isNative ? `<div class="switch-row"><div><div class="list-title">Daily automatic backup</div><div class="list-sub">Saved to Documents/ETS on this phone. The last 14 days are kept.</div></div>
      <label class="switch"><input type="checkbox" id="setAutoBackup" ${s.autoBackup?'checked':''} aria-label="Daily automatic backup"><span></span></label></div>` :
      `<p class="small muted" style="margin:0 0 12px">Your data is stored only in this browser. Export a backup regularly.</p>`}
    <div class="kv"><span>Last backup</span><span>${esc(lb)}</span></div>
    ${s.lastBackupFile ? `<div class="kv"><span>File</span><span>${esc(s.lastBackupFile)}</span></div>` : ''}
    ${isNative && s.lastBackupError ? `<div class="form-err" style="margin:6px 0 0">Backup failed: ${esc(s.lastBackupError)}</div>` : ''}
    <div class="btn-row" style="margin-top:12px">${isNative?`<button class="btn" data-action="backup-now">Back up now</button>`:''}<button class="btn ${isNative?'btn-outline':''}" data-action="export">${isNative?'Share backup':'Export backup'}</button><button class="btn btn-outline" data-action="import">Restore</button></div>
    <div class="switch-row" style="border-top:1px solid var(--hair); margin-top:12px"><div><div class="list-title">Backup password</div><div class="list-sub">${s.backupCrypto ? 'On. Backups are encrypted and need the password to restore.' : 'Off. Anyone who gets a backup file can read it.'}</div></div>
      <button class="btn btn-outline" data-action="backup-pass" style="flex:none">${s.backupCrypto ? 'Change' : 'Set up'}</button></div>
    ${gdCfg().email ? '' : `<p class="small muted" style="margin:10px 0 0">For a copy off the phone, sign in with Google above, or use Share backup.</p>`}
    <p class="small muted" style="margin:12px 0 0">Stored: ${[[db.compounds.length,'compound'],[db.logs.length,'injection'],[db.labs.length,'lab result'],[(db.workouts||[]).length,'workout'],[(db.activities||[]).length,'run/walk/hike','runs/walks/hikes'],[Object.keys((db.health&&db.health.days)||{}).length,'day of watch data','days of watch data']].filter(([n],i)=>i<2 || n).map(([n,a,b])=>`${n} ${n===1?a:(b||a+'s')}`).join(' \u00b7 ')}</p>
  </div>
`;
  
  html += aboutCardHtml();
  return html;
}

/* ================= Sheets ================= */
let sheetOpen = false;
function openSheet(html){
  $('#sheetRoot').innerHTML = `<div class="sheet-bg" id="sheetBg"><div class="sheet" role="dialog" aria-modal="true"><button type="button" class="sheet-close" id="sheetClose" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>${html}</div></div>`;
  sheetOpen = true;
  $('#sheetBg').addEventListener('click', e=>{ if(e.target.id==='sheetBg') closeSheet(); });
  $('#sheetClose').addEventListener('click', closeSheet);
  const sh = $('#sheetRoot .sheet');
  // keep the field being typed in clear of the keyboard and the sticky Save bar; clear stale errors as the user fixes things
  sh.addEventListener('focusin', e=>{ if(e.target.matches('input,select,textarea')) setTimeout(()=>{ if(document.activeElement===e.target) e.target.scrollIntoView({block:'center', behavior:'smooth'}); }, 350); });
  sh.addEventListener('input', ()=>{ sh.querySelectorAll('.form-err').forEach(x=>{ if(x.textContent && !x.closest('#bkErr, #impErr')) x.textContent = ''; }); });
}
function closeSheet(){ $('#sheetRoot').innerHTML=''; sheetOpen = false; }
function toast(msg, action){
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="toast-btn">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if(action) t.querySelector('.toast-btn').addEventListener('click', ()=>{ t.hidden = true; action.fn(); });
  clearTimeout(toast._t); toast._t = setTimeout(()=>{ t.hidden = true; }, action ? 7000 : 2600);
}
function armButton(btn, label, fn){
  if(btn.dataset.armed){ fn(); return; }
  const orig = btn.innerHTML; btn.dataset.armed = '1'; btn.textContent = label;
  setTimeout(()=>{ if(btn.isConnected){ delete btn.dataset.armed; btn.innerHTML = orig; } }, 3000);
}
const segHtml = (id, opts, val) => `<div class="opt-grid" id="${id}">${opts.map(([v,l])=>`<button type="button" class="opt ${v===val?'active':''}" data-v="${esc(v)}">${l}</button>`).join('')}</div>`;
function bindSeg(id, onChange){
  const root = document.getElementById(id);
  root.addEventListener('click', e=>{
    const b = e.target.closest('.opt'); if(!b) return;
    root.querySelectorAll('.opt').forEach(o=>o.classList.toggle('active', o===b));
    onChange(b.dataset.v);
  });
}
const segVal = id => { const a = document.querySelector(`#${id} .opt.active`); return a ? a.dataset.v : null; };

/* ---------- Compound sheet ---------- */
function openCompoundSheet(id){
  const ex = id ? db.compounds.find(c=>c.id===id) : null;
  const c = ex ? JSON.parse(JSON.stringify(ex)) : {
    name:'', form:'oil', strength:null, unit:'mg', route:'IM', dosePerInj:null,
    schedule:{type:'weekly', days:[]}, time:'morning', barrel:'', vial:null, halfLife:null
  };
  const sch = c.schedule || {type:'weekly', days:[]};
  const custom = c.barrel && !BARRELS.includes(c.barrel);
  const doseDisp = c.dosePerInj ? round(fromMg(c.dosePerInj, c.unit), 3) : '';
  openSheet(`
    <h2>${ex?'Edit compound':'Add compound'}</h2>
    <div class="field"><label for="cName">Name</label><input id="cName" autocomplete="off" placeholder="e.g. Testosterone cypionate" value="${esc(c.name)}"></div>
    <div class="field"><span class="field-label">Vial type</span>${segHtml('cForm',[['oil','Oil / liquid'],['powder','Powder (mix with water)']], c.form)}</div>
    <div id="oilBox" ${c.form==='oil'?'':'hidden'}>
      <div class="field"><label for="cStrength">Strength (mg/mL)</label><input id="cStrength" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 200" value="${c.form==='oil' && c.strength ? esc(c.strength) : ''}"></div>
    </div>
    <div id="powderBox" ${c.form==='powder'?'':'hidden'}>
      <div class="row2">
        <div class="field"><label for="cPowder">Powder in vial (mg)</label><input id="cPowder" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 5" value="${esc(c.powderMg||'')}"></div>
        <div class="field"><label for="cWater">Water added (mL)</label><input id="cWater" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 2" value="${esc(c.waterMl||'')}"></div>
      </div>
    </div>
    <div class="calc" id="cRecon"></div>
    <div class="field"><span class="field-label">Dose unit</span>${segHtml('cUnit',[['mg','mg'],['mcg','mcg']], c.unit)}</div>
    <div class="row2">
      <div class="field"><label for="cDose">Per injection (<span class="uLbl">${esc(c.unit)}</span>)</label><input id="cDose" type="number" inputmode="decimal" min="0" step="any" value="${esc(doseDisp)}"></div>
      <div class="field"><label for="cWeek">Per week (<span class="uLbl">${esc(c.unit)}</span>)</label><input id="cWeek" type="number" inputmode="decimal" min="0" step="any"></div>
    </div>
    ${ex ? `<div class="field"><label for="cDoseFrom">Dose change applies from</label><input id="cDoseFrom" type="date" value="${ymd(new Date())}">
      <div class="hint">Only used if you change the dose. Pick a future date to plan a change; the current dose stays until then.</div></div>
    <details class="more"><summary>Dose history</summary><div id="doseHist"></div></details>
    <details class="more" ${currentPause(ex)||upcomingPause(ex)?'open':''}><summary>Pause</summary><div id="pauseBox"></div></details>` : ''}
    <div class="field"><span class="field-label">Schedule</span>${segHtml('cSchType',[['weekly','Days of the week'],['interval','Every X days']], sch.type)}</div>
    <div id="weeklyBox" ${sch.type==='weekly'?'':'hidden'}>
      <div class="field"><div class="opt-grid" id="cDays">${DOW_ORDER.map(d=>`<button type="button" class="opt ${(sch.days||[]).includes(d)?'active':''}" data-d="${esc(d)}" aria-pressed="${(sch.days||[]).includes(d)}">${DOW[d]}</button>`).join('')}</div></div>
    </div>
    <div id="intervalBox" ${sch.type==='interval'?'':'hidden'}>
      <div class="field"><div class="opt-grid" id="cEveryQuick">${[[1,'Daily'],[2,'EOD'],[3,'E3D'],[3.5,'E3.5D'],[5,'E5D'],[7,'Weekly'],[10,'E10D'],[14,'E14D']].map(([v,l])=>`<button type="button" class="opt ${sch.every===v?'active':''}" data-v="${esc(v)}">${l}</button>`).join('')}</div></div>
      <div class="row2">
        <div class="field"><label for="cEvery">Every (days)</label><input id="cEvery" type="number" inputmode="decimal" min="0.5" step="0.5" value="${esc(sch.every||'')}"></div>
        <div class="field"><label for="cStart">First dose on</label><input id="cStart" type="date" value="${esc(sch.start || ymd(new Date()))}"></div>
      </div>
    </div>
    <div class="field"><span class="field-label">How long</span>${segHtml('cCycle',[['ongoing','Ongoing'],['cycle','Set a cycle']], c.cycle?'cycle':'ongoing')}</div>
    <div id="cycleBox" ${c.cycle?'':'hidden'}>
      ${ex && cycleState(ex) && cycleState(ex).state==='done' ? `<div class="calc" style="margin-bottom:12px">The last cycle finished on ${esc(fmtDate(parseYmd(cycleState(ex).lastDay)))}. <button type="button" class="btn btn-outline" style="margin-top:8px; width:100%" data-action="cycle-next" data-id="${esc(ex.id)}">Start the next cycle</button></div>` : ''}
      <div class="field"><div class="opt-grid" id="cCycQuick">${[4,6,8,10,12,16].map(w=>`<button type="button" class="opt" data-w="${w}">${w} weeks</button>`).join('')}</div></div>
      <div class="row2">
        <div class="field"><label for="cCycLen">Length</label><input id="cCycLen" type="number" inputmode="numeric" min="1" step="1" placeholder="e.g. 6" value="${c.cycle ? esc(c.cycle.unit==='days' ? c.cycle.days : c.cycle.days/7) : ''}"></div>
        <div class="field"><span class="field-label">In</span>${segHtml('cCycUnit',[['weeks','Weeks'],['days','Days']], c.cycle && c.cycle.unit==='days' ? 'days' : 'weeks')}</div>
      </div>
      <div class="field" id="cCycStartF" ${sch.type==='interval'?'hidden':''}><label for="cCycStart">Cycle starts</label><input id="cCycStart" type="date" value="${esc(c.cycle ? c.cycle.start : ymd(new Date()))}"></div>
      <div class="calc" id="cCycPrev"></div>
      <div class="hint" style="margin:-4px 0 12px">After the last day there are no more reminders or missed doses. You can start the next cycle from the Today screen.</div>
    </div>
    <div class="field"><span class="field-label">Time of day</span>${segHtml('cTime',[['morning','Morning'],['night','Night']], c.time)}</div>
    <div class="field"><span class="field-label">Injection type</span>${segHtml('cRoute',[['IM','Intramuscular (IM)'],['SubQ','Subcutaneous (SubQ)']], c.route)}</div>
    <div class="field"><span class="field-label">My injection sites</span>
      <div class="opt-grid" id="cSites"></div>
      <div class="hint">Pick the sites you rotate through. Leave them all off and the app rotates through the sites you've used.</div></div>
    <div class="field"><label for="cBarrel">Syringe size</label>
      <select id="cBarrel"><option value="">Not set</option>${BARRELS.map(b=>`<option ${c.barrel===b?'selected':''}>${b}</option>`).join('')}<option value="__custom" ${custom?'selected':''}>Other…</option></select>
      <input id="cBarrelCustom" style="margin-top:8px" placeholder="e.g. 2 mL" ${custom?'':'hidden'} value="${custom?esc(c.barrel):''}">
    </div>
    <details class="more" ${c.vial?'open':''}><summary>Vial stock</summary>
      <div class="row2">
        <div class="field"><label for="cVial">Vial size (mL)</label><input id="cVial" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 10" value="${esc(c.vial&&c.vial.sizeMl||'')}"></div>
        <div class="field"><label for="cRemain">Left now (mL)</label><input id="cRemain" type="number" inputmode="decimal" min="0" step="any" value="${c.vial&&c.vial.remainingMl!=null?round(c.vial.remainingMl,3):''}"></div>
      </div>
      <div class="hint" style="margin:-6px 0 12px">Each logged injection subtracts its volume. For powder vials the size is the water you added.</div>
    </details>
    <details class="more" ${c.halfLife?'open':''}><summary>Half-life (for the levels chart)</summary>
      <div class="field"><label for="cHalf">Half-life (days)</label><input id="cHalf" type="number" inputmode="decimal" min="0" step="any" placeholder="From your prescriber or product info" value="${esc(c.halfLife||'')}"></div>
    </details>
    <div class="sheet-actions"><button class="btn btn-block" id="cSave">${ex?'Save changes':'Add compound'}</button><div class="form-err" id="cErr" role="alert" style="margin-top:6px; min-height:0"></div></div>
    ${ex?`<button class="btn btn-danger btn-block" style="margin-top:10px" id="cDel">Remove compound</button>`:''}
    
  `);

  const f = id => document.getElementById(id);
  let days = new Set(sch.days||[]);
  let unit = c.unit;
  const strength = ()=>{
    if(segVal('cForm')==='powder'){ const p=num(f('cPowder').value), w=num(f('cWater').value); return p>0&&w>0 ? p/w : NaN; }
    return num(f('cStrength').value);
  };
  const injPerWeek = ()=>{
    if(segVal('cSchType')==='interval'){ const e=num(f('cEvery').value); return e>0 ? 7/e : 0; }
    return days.size;
  };
  const syncWeek = ()=>{ const d=num(f('cDose').value), n=injPerWeek(); f('cWeek').value = (d>0&&n>0) ? round(d*n,3) : ''; };
  const syncDose = ()=>{ const w=num(f('cWeek').value), n=injPerWeek(); if(w>0&&n>0) f('cDose').value = round(w/n,3); };
  const recon = ()=>{
    const s = strength(), box = f('cRecon');
    if(!(s>0)){ box.innerHTML=''; return; }
    const d = num(f('cDose').value);
    let h = `Concentration <b>${round(s,3)} mg/mL</b>${unit==='mcg'?` = <b>${round(s*1000,1)} mcg/mL</b>`:''} · 10 units = ${fmtAmt(s*0.1, unit)}`;
    if(d>0){ const v = toMg(d,unit)/s; h += `<br>Each dose: draw ${drawText(v, null)}`; }
    box.innerHTML = h;
  };
  bindSeg('cForm', v=>{ f('oilBox').hidden = v!=='oil'; f('powderBox').hidden = v!=='powder'; recon(); });
  bindSeg('cUnit', v=>{
    const d = num(f('cDose').value);
    if(d>0 && v!==unit) f('cDose').value = round(v==='mcg' ? d*1000 : d/1000, 4);
    unit = v; document.querySelectorAll('.uLbl').forEach(x=>x.textContent=v); syncWeek(); recon();
  });
  bindSeg('cSchType', v=>{ f('weeklyBox').hidden = v!=='weekly'; f('intervalBox').hidden = v!=='interval'; syncWeek(); });
  bindSeg('cTime', ()=>{});
  let mySites = new Set(Array.isArray(c.sites) ? c.sites : []);
  const renderMySites = ()=>{
    const route = segVal('cRoute') || 'IM';
    f('cSites').innerHTML = SITES[route].map(s=>`<button type="button" class="opt ${mySites.has(s)?'active':''}" data-site="${esc(s)}" aria-pressed="${mySites.has(s)}">${esc(s)}</button>`).join('');
  };
  f('cSites').addEventListener('click', e=>{
    const b = e.target.closest('.opt'); if(!b) return;
    const s = b.dataset.site; mySites.has(s) ? mySites.delete(s) : mySites.add(s); renderMySites();
  });
  bindSeg('cRoute', ()=>{ mySites = new Set(); renderMySites(); });
  renderMySites();
  f('cDays').addEventListener('click', e=>{
    const b = e.target.closest('.opt'); if(!b) return;
    const d = +b.dataset.d; days.has(d) ? days.delete(d) : days.add(d);
    b.classList.toggle('active', days.has(d)); b.setAttribute('aria-pressed', days.has(d)); syncWeek();
  });
  f('cEveryQuick').addEventListener('click', e=>{
    const b = e.target.closest('.opt'); if(!b) return;
    f('cEvery').value = b.dataset.v;
    f('cEveryQuick').querySelectorAll('.opt').forEach(o=>o.classList.toggle('active', o===b)); syncWeek();
  });
  f('cEvery').addEventListener('input', ()=>{ f('cEveryQuick').querySelectorAll('.opt').forEach(o=>o.classList.toggle('active', +o.dataset.v===num(f('cEvery').value))); syncWeek(); });
  ['cStrength','cPowder','cWater'].forEach(i=>f(i).addEventListener('input', recon));
  f('cDose').addEventListener('input', ()=>{ syncWeek(); recon(); });
  f('cWeek').addEventListener('input', ()=>{ syncDose(); recon(); });
  f('cWater').addEventListener('input', ()=>{ if(!f('cVial').value || f('cVial').dataset.auto){ f('cVial').value = f('cWater').value; f('cVial').dataset.auto='1'; } });
  f('cBarrel').addEventListener('change', ()=>{ f('cBarrelCustom').hidden = f('cBarrel').value!=='__custom'; });
  // cycle length
  const formSchedule = ()=> segVal('cSchType')==='interval'
    ? {type:'interval', every:num(f('cEvery').value), start:f('cStart').value}
    : {type:'weekly', days:[...days]};
  const formCycle = ()=>{
    if(segVal('cCycle')!=='cycle') return null;
    const n = Math.round(num(f('cCycLen').value)); if(!(n>=1)) return {bad:'len'};
    const unitC = segVal('cCycUnit') || 'weeks';
    const len = unitC==='weeks' ? n*7 : n;
    const sc = formSchedule();
    const start = sc.type==='interval' ? sc.start : f('cCycStart').value;
    if(!start) return {bad:'start'};
    return {start, days:len, unit:unitC};
  };
  const cycPreview = ()=>{
    const box = f('cCycPrev'); if(!box) return;
    const cy = formCycle();
    if(!cy){ box.innerHTML = ''; return; }
    if(cy.bad){ box.innerHTML = cy.bad==='len' ? 'Enter how long the cycle lasts.' : 'Pick the date the cycle starts.'; return; }
    if(cy.days > 730){ box.innerHTML = 'That\u2019s longer than two years. Use Ongoing instead.'; return; }
    const tmp = {schedule: formSchedule(), cycle: cy, pauses: []};
    const doses = hasSchedule(tmp) ? cycleDoses(tmp, cy) : [];
    const last = ymd(addDays(parseYmd(cycleEndOf(cy)), -1));
    box.innerHTML = `<b>${esc(cycleLengthText(cy))}</b>: ${esc(fmtDate(parseYmd(cy.start)))} to ${esc(fmtDate(parseYmd(last)))}` +
      (hasSchedule(tmp) ? `<br>${doses.length} ${doses.length===1?'dose':'doses'}${doses.length ? ` · last dose ${esc(fmtDate(doses[doses.length-1]))}` : ''}` : '<br>Pick the schedule above to see the doses.');
  };
  const startLabel = ()=>{ const lb = document.querySelector('label[for="cStart"]'); if(lb) lb.textContent = segVal('cCycle')==='cycle' ? 'Cycle starts (first dose)' : 'First dose on'; };
  bindSeg('cCycle', v=>{
    f('cycleBox').hidden = v!=='cycle';
    if(v==='cycle' && !f('cCycLen').value){ f('cCycLen').value = 6; syncCycQuick(); }
    // turning a cycle on for an existing compound: start it today rather than on the original first-dose date
    if(v==='cycle' && ex && !ex.cycle){ f('cStart').value = ymd(new Date()); f('cCycStart').value = ymd(new Date()); }
    if(v==='ongoing' && ex && !ex.cycle && ex.schedule && ex.schedule.start) f('cStart').value = ex.schedule.start;
    if(v==='ongoing' && ex && ex.cycle && cycleState(ex).state==='done') f('cStart').value = ymd(new Date());
    startLabel(); cycPreview();
  });
  startLabel();
  bindSeg('cCycUnit', ()=>{ syncCycQuick(); cycPreview(); });
  const syncCycQuick = ()=>{ const n = num(f('cCycLen').value), wk = segVal('cCycUnit')==='weeks'; f('cCycQuick').querySelectorAll('.opt').forEach(o=>o.classList.toggle('active', wk && +o.dataset.w===n)); };
  f('cCycQuick').addEventListener('click', e=>{
    const b = e.target.closest('.opt'); if(!b) return;
    f('cCycLen').value = b.dataset.w;
    document.querySelectorAll('#cCycUnit .opt').forEach(o=>o.classList.toggle('active', o.dataset.v==='weeks'));
    syncCycQuick(); cycPreview();
  });
  ['cCycLen','cCycStart','cEvery','cStart'].forEach(i=>f(i).addEventListener('input', ()=>{ syncCycQuick(); cycPreview(); }));
  f('cSchType').addEventListener('click', ()=>setTimeout(()=>{ f('cCycStartF').hidden = segVal('cSchType')==='interval'; cycPreview(); }));
  f('cDays').addEventListener('click', ()=>setTimeout(cycPreview));
  f('cEveryQuick').addEventListener('click', ()=>setTimeout(cycPreview));
  syncCycQuick(); cycPreview();
  syncWeek(); recon();

  // dose history (edited locally, applied on save)
  let hist = ex ? (ex.doseHistory||[]).map(e=>({...e})) : [];
  const renderHist = ()=>{
    const box = f('doseHist'); if(!box) return;
    const rows = hist.slice().sort((a,b)=>a.from<b.from?1:-1);
    const today = ymd(new Date());
    box.innerHTML = rows.length ? rows.map(e=>`<div class="kv"><span>From ${esc(fmtDate(parseYmd(e.from)))}${e.from>today?' (planned)':''}</span>
        <span>${esc(fmtAmt(e.dose, unit))} ${hist.length>1?`<button type="button" class="btn btn-danger" style="min-height:30px; padding:0 8px; margin-left:6px" data-hdel="${esc(e.from)}">✕</button>`:''}</span></div>`).join('')
      : '<div class="small muted" style="padding-bottom:10px">No planned dose yet.</div>';
    box.querySelectorAll('[data-hdel]').forEach(b=>b.addEventListener('click', ()=>{ hist = hist.filter(e=>e.from!==b.dataset.hdel); renderHist(); }));
  };
  renderHist();
  // pause controls act immediately
  const renderPause = ()=>{
    const box = f('pauseBox'); if(!box) return;
    const cur = currentPause(ex), up = upcomingPause(ex);
    if(cur || up){
      const p = cur || up;
      box.innerHTML = `<p class="small" style="margin:0 0 10px">${cur?'Paused':'Pause planned'} from ${esc(fmtDate(parseYmd(p.from)))}${p.to?` until ${esc(fmtDate(parseYmd(p.to)))}`:''}. No reminders or missed doses while paused.</p>
        <button type="button" class="btn btn-block" id="pauseEnd">${cur?'Resume today':'Cancel planned pause'}</button><div style="height:10px"></div>`;
      f('pauseEnd').addEventListener('click', ()=>{
        const today = ymd(new Date());
        if(cur && cur.from < today) cur.to = today; else ex.pauses = ex.pauses.filter(x=>x!==p);
        save(); closeSheet(); render(); toast(cur ? `${ex.name} resumed` : 'Planned pause cancelled');
      });
    } else {
      box.innerHTML = `<div class="row2">
          <div class="field"><label for="pFrom">Pause from</label><input id="pFrom" type="date" value="${ymd(new Date())}"></div>
          <div class="field"><label for="pTo">Resume on (optional)</label><input id="pTo" type="date"></div></div>
        <button type="button" class="btn btn-outline btn-block" id="pauseGo">Pause ${esc(ex.name)}</button><div class="form-err" id="pErr"></div>`;
      f('pauseGo').addEventListener('click', ()=>{
        const from = f('pFrom').value, to = f('pTo').value || null;
        if(!from) return f('pErr').textContent = 'Pick the date the pause starts.';
        if(to && to <= from) return f('pErr').textContent = 'The resume date must be after the start.';
        ex.pauses = (ex.pauses||[]).concat([{from, to}]);
        save(); closeSheet(); render(); toast(`${ex.name} paused${to?` until ${fmtShort(parseYmd(to))}`:''}`);
      });
    }
  };
  if(ex) renderPause();

  if(ex) f('cDel').addEventListener('click', e=>armButton(e.currentTarget, 'Tap again to remove', ()=>{
    db.compounds = db.compounds.filter(x=>x.id!==ex.id); save(); closeSheet(); render(); toast('Compound removed. Its history is kept.');
  }));

  f('cSave').addEventListener('click', ()=>{
    const err = f('cErr'); err.textContent = '';
    const name = f('cName').value.trim();
    const form = segVal('cForm');
    const s = strength();
    if(!name){ f('cName').focus(); return err.textContent = 'Enter a name.'; }
    if(!(s>0)) return err.textContent = form==='powder' ? 'Enter the powder amount and the water added.' : 'Enter the strength in mg/mL.';
    const type = segVal('cSchType');
    let schedule;
    if(type==='interval'){
      const every = num(f('cEvery').value);
      if(!(every>=0.5)) return err.textContent = 'Enter how many days between doses (0.5 or more).';
      if(!f('cStart').value) return err.textContent = 'Pick the date of the first dose.';
      schedule = {type, every, start:f('cStart').value};
    } else {
      schedule = {type:'weekly', days:[...days].sort()};
    }
    const cycle = formCycle();
    if(cycle && cycle.bad) return err.textContent = cycle.bad==='len' ? 'Enter how long the cycle lasts, or choose Ongoing.' : 'Pick the date the cycle starts.';
    if(cycle && cycle.days > 730) return err.textContent = 'A cycle can be up to two years. Use Ongoing for longer.';
    if(cycle && (schedule.type==='interval' || schedule.days.length) && !cycleDoses({schedule, cycle, pauses:[]}, cycle).length) return err.textContent = 'No doses fall inside this cycle. Check the start date and length.';
    const doseIn = num(f('cDose').value);
    let barrel = f('cBarrel').value; if(barrel==='__custom') barrel = f('cBarrelCustom').value.trim();
    const vialSize = num(f('cVial').value), remain = num(f('cRemain').value);
    const half = num(f('cHalf').value);
    const prevSched = ex ? JSON.stringify(ex.schedule) : null;
    const prevStart = ex && ex.schedule ? ex.schedule.start : null;
    const out = ex || {id:uid(), createdAt:new Date().toISOString(), pauses:[]};
    if(ex) out._oldCycle = ex.cycle ? {...ex.cycle} : null;
    let newDose = doseIn>0 ? toMg(doseIn, unit) : null;
    if(newDose){
      const fromK = ex ? (f('cDoseFrom').value || ymd(new Date())) : ymd(new Date());
      const prev = hist.length ? doseOn({doseHistory:hist}, parseYmd(fromK)) : null;
      // the field shows 3 decimals, so an untouched field must not count as a new dose (e.g. 83.3333 → 83.333)
      if(prev!=null && round(fromMg(prev, unit),3) === round(doseIn,3)) newDose = prev;
      else if(prev==null || Math.abs(prev - newDose) > 1e-9){
        hist = hist.filter(e=>e.from!==fromK).concat([{from:fromK, dose:newDose}]).sort((a,b)=>a.from<b.from?-1:1);
      }
    }
    Object.assign(out, {
      name, form, strength: round(s,6), unit, route: segVal('cRoute'), time: segVal('cTime'),
      dosePerInj: newDose, schedule, barrel,
      powderMg: form==='powder' ? num(f('cPowder').value) : null,
      waterMl: form==='powder' ? num(f('cWater').value) : null,
      vial: vialSize>0 ? {sizeMl:vialSize, remainingMl: remain>=0 && isFinite(remain) ? Math.min(remain, vialSize) : vialSize} : null,
      halfLife: half>0 ? half : null,
      sites: [...mySites].filter(x=>SITES[segVal('cRoute')].includes(x)),
      doseHistory: hist
    });
    out.dosePerInj = hist.length ? doseOn(out, new Date()) : newDose;
    applyCycle(out, ex, cycle, prevStart);
    if(ex){
      if(prevSched !== JSON.stringify(schedule)) out.scheduleSince = ymd(new Date());
      db.logs.forEach(l=>{ if(l.compoundId===ex.id) l.compoundName = name; });
    } else db.compounds.push(out);
    save(); closeSheet(); render(); haptic(); toast(ex ? 'Changes saved' : `${name} added`);
  });
}

/* Keep past cycles in history when the cycle setting changes (see activeWindows). */
function applyCycle(out, ex, cycle, prevStart){
  const today = ymd(new Date());
  const old = ex ? (out._oldCycle || null) : null;
  delete out._oldCycle;
  out.periods = out.periods || [];
  if(!ex){ out.cycle = cycle; out.ongoingFrom = null; return; }
  const oldDone = old && today >= cycleEndOf(old);
  if(cycle && !old){
    // ongoing → cycle: keep the ongoing time before the cycle as history
    const since = out.ongoingFrom || null;
    if(ymd(out.createdAt || today) < cycle.start) out.periods.push({start:since, end:cycle.start, anchor: since || prevStart || undefined});
    out.ongoingFrom = null;
  } else if(cycle && old){
    if(oldDone && cycle.start >= cycleEndOf(old)) out.periods.push({start:old.start, end:cycleEndOf(old), anchor:old.start});   // a new cycle after a finished one
  } else if(!cycle && old){
    if(oldDone){
      // the break since the last cycle is never judged: carry on from today (or a later first dose)
      out.periods.push({start:old.start, end:cycleEndOf(old), anchor:old.start});
      const st = out.schedule.type==='interval' && out.schedule.start > today ? out.schedule.start : today;
      out.ongoingFrom = st; if(out.schedule.type==='interval') out.schedule.start = st;
    }
    else out.ongoingFrom = old.start;           // keep going from the start of the current cycle
  }
  out.cycle = cycle;
  out.periods = out.periods.filter(p=>!p.start || !p.end || p.start < p.end);
}
function openNextCycleSheet(id){
  const c = db.compounds.find(x=>x.id===id); if(!c || !c.cycle) return;
  const old = c.cycle, oldEnd = cycleEndOf(old);
  const today = ymd(new Date());
  const def = today < oldEnd ? oldEnd : today;
  const n = old.unit==='days' ? old.days : old.days/7;
  openSheet(`<h2>New cycle</h2>
    <p class="muted" style="margin-top:-8px">${esc(c.name)} · last cycle ${esc(cycleLengthText(old))}, ${esc(fmtShort(parseYmd(old.start)))} – ${esc(fmtShort(addDays(parseYmd(oldEnd),-1)))}</p>
    <div class="field"><label for="ncStart">${c.schedule && c.schedule.type==='interval' ? 'First dose on' : 'Cycle starts'}</label><input id="ncStart" type="date" min="${esc(oldEnd)}" value="${esc(def)}"></div>
    <div class="row2">
      <div class="field"><label for="ncLen">Length</label><input id="ncLen" type="number" inputmode="numeric" min="1" step="1" value="${esc(n)}"></div>
      <div class="field"><span class="field-label">In</span>${segHtml('ncUnit',[['weeks','Weeks'],['days','Days']], old.unit==='days'?'days':'weeks')}</div>
    </div>
    <div class="calc" id="ncPrev"></div>
    <div class="sheet-actions"><button class="btn btn-block" id="ncGo">Start cycle</button><div class="form-err" id="ncErr" role="alert"></div></div>`);
  const f = x=>document.getElementById(x);
  const read = ()=>{ const len = Math.round(num(f('ncLen').value)); const u = segVal('ncUnit'); return {start:f('ncStart').value, days: u==='weeks' ? len*7 : len, unit:u, len}; };
  const tmpC = cy => ({...c, schedule: c.schedule.type==='interval' ? {...c.schedule, start:cy.start} : c.schedule, cycle:cy, periods:[], ongoingFrom:null});
  const prev = ()=>{
    const cy = read(), box = f('ncPrev');
    if(!(cy.len>=1) || !cy.start){ box.innerHTML = 'Pick a start date and length.'; return; }
    const doses = cycleDoses(tmpC(cy), cy);
    box.innerHTML = `<b>${esc(cycleLengthText(cy))}</b>: ${esc(fmtDate(parseYmd(cy.start)))} to ${esc(fmtDate(addDays(parseYmd(cycleEndOf(cy)),-1)))}<br>${doses.length} ${doses.length===1?'dose':'doses'}${doses.length?` · last dose ${esc(fmtDate(doses[doses.length-1]))}`:''}`;
  };
  bindSeg('ncUnit', prev); ['ncStart','ncLen'].forEach(x=>f(x).addEventListener('input', prev)); prev();
  f('ncGo').addEventListener('click', ()=>{
    const cy = read(), e = f('ncErr');
    if(!cy.start) return e.textContent = 'Pick the start date.';
    if(cy.start < oldEnd) return e.textContent = `The new cycle can't start before the last one ended (${fmtDate(parseYmd(oldEnd))}).`;
    if(!(cy.len>=1)) return e.textContent = 'Enter how long the cycle lasts.';
    if(cy.days > 730) return e.textContent = 'A cycle can be up to two years.';
    if(!cycleDoses(tmpC(cy), cy).length) return e.textContent = 'No doses fall inside this cycle. Check the schedule.';
    c.periods = (c.periods||[]).concat([{start:old.start, end:oldEnd, anchor:old.start}]);
    c.cycle = {start:cy.start, days:cy.days, unit:cy.unit};
    if(c.schedule.type==='interval') c.schedule.start = cy.start;
    save(); closeSheet(); render(); haptic(); toast(`${c.name}: new cycle from ${fmtShort(parseYmd(cy.start))}`);
  });
}

/* ---------- Log sheet (new or edit) ---------- */
function openLogSheet(opts={}){
  if(!db.compounds.length && !opts.logId){ ui.mode='inj'; ui.tab='setup'; render(); return openCompoundSheet(); }
  const ex = opts.logId ? db.logs.find(l=>l.id===opts.logId) : null;
  if(ex && ex.skipped){
    openSheet(`<h2>Skipped dose</h2>
      <p class="muted" style="margin-top:-8px">${esc(ex.compoundName||'')} · ${esc(fmtDate(ex.date))}</p>
      <p class="small">Marked as skipped on purpose, so it doesn't count as missed.</p>
      <button class="btn btn-danger btn-block" id="unskip">Remove skip</button>`);
    $('#unskip').addEventListener('click', e=>armButton(e.currentTarget, 'Tap again to remove', ()=>{
      db.logs = db.logs.filter(l=>l.id!==ex.id); save(); closeSheet(); render(); toast('Skip removed');
    }));
    return;
  }
  let cid = ex ? ex.compoundId : (opts.compoundId || (db.compounds.find(c=>statusFor(c).due) || db.compounds[0] || {}).id);
  const getC = () => db.compounds.find(c=>c.id===cid);
  let c = getC();
  let when;
  if(ex) when = new Date(ex.date);
  else if(opts.day){
    when = parseYmd(opts.day);
    const [h,m] = hm(c && c.time==='night' ? db.settings.night : db.settings.morning);
    if(ymd(when)===ymd(new Date())) when = new Date(); else when.setHours(h,m,0,0);
  } else when = new Date();
  const compOpts = db.compounds.map(x=>`<option value="${esc(x.id)}" ${x.id===cid?'selected':''}>${esc(x.name)}</option>`).join('')
    + (ex && !c ? `<option value="${esc(ex.compoundId)}" selected>${esc(ex.compoundName||'Removed compound')}</option>` : '');
  openSheet(`
    <h2>${ex?'Edit dose':'Log dose'}</h2>
    <div class="field"><label for="lComp">Compound</label><select id="lComp">${compOpts}</select></div>
    <div class="row2">
      <div class="field"><label for="lDose">Dose (<span id="lUnit">${(c&&c.unit)||(ex&&ex.unit)||'mg'}</span>)</label><input id="lDose" type="number" inputmode="decimal" min="0" step="any"></div>
      <div class="field"><label for="lDate">Date &amp; time</label><input id="lDate" type="datetime-local" value="${toLocalInput(when)}"></div>
    </div>
    <div class="calc" id="lCalc"></div>
    <div class="field"><span class="field-label">Injection site</span><div class="site-grid" id="lSites"></div></div>
    <div class="field"><label for="lNotes">Notes</label><textarea id="lNotes" placeholder="Side effects, how you feel, site pain…">${esc(ex?ex.notes||'':'')}</textarea></div>
    <div class="sheet-actions"><button class="btn btn-block" id="lSave">${ex?'Save changes':'Save dose'}</button><div class="form-err" id="lErr" role="alert" style="margin-top:6px; min-height:0"></div></div>
    ${ex?`<button class="btn btn-danger btn-block" style="margin-top:10px" id="lDel">Delete entry</button>`:''}
    
  `);
  const f = id => document.getElementById(id);
  let site = ex ? ex.site || null : null;
  const unitOf = () => (c && c.unit) || (ex && ex.unit) || 'mg';
  const renderSites = ()=>{
    const route = c ? c.route : (ex && SITES.SubQ.includes(ex.site) ? 'SubQ' : 'IM');
    const last = siteHistory(route);
    const sug = suggestSite(route, c);
    if(!ex && (!site || !SITES[route].includes(site))) site = sug;
    const mine = c ? sitesFor(c) : SITES[route];
    const order = mine.concat(SITES[route].filter(s=>!mine.includes(s)));
    f('lSites').innerHTML = order.map(s=>{
      const ago = last[s] ? `${diffDays(new Date(), last[s])}d ago` : 'Not used yet';
      return `<button type="button" class="opt ${s===site?'active':''} ${s===sug?'suggest':''} ${mine.includes(s)?'':'other-site'}" data-s="${esc(s)}">${esc(s)}<span class="sub">${s===sug?'Suggested · ':''}${ago}</span></button>`;
    }).join('');
  };
  const prefill = ()=>{
    if(ex){ f('lDose').value = round(fromMg(ex.dose, unitOf()), 3); return; }
    const last = db.logs.filter(l=>l.compoundId===cid && !l.skipped).sort((a,b)=>new Date(b.date)-new Date(a.date))[0];
    const planned = c ? doseOn(c, when) : null;
    const mg = planned>0 ? planned : (last ? last.dose : null);
    f('lDose').value = mg ? round(fromMg(mg, unitOf()), 3) : '';
  };
  const calc = ()=>{
    const d = num(f('lDose').value), strength = c ? c.strength : (ex && ex.strength);
    let h = '';
    if(d>0 && strength>0){
      const v = toMg(d, unitOf())/strength;
      h = `Draw ${drawText(v, c)}<div class="calc-scale">${syringeSvg(c, v, false)}</div>`;
      const st = c && stockInfo(c);
      if(st){
        const prevVol = ex && ex.compoundId===cid ? (ex.volumeMl||0) : 0;
        const after = st.rem + prevVol - v;
        h += `Vial after this: <b>${round(Math.max(0,after),2)} mL</b>${after<0?' (more than is left — start a new vial first)':''}`;
      }
    }
    f('lCalc').innerHTML = h;
  };
  f('lSites').addEventListener('click', e=>{
    const b = e.target.closest('.opt'); if(!b) return;
    site = b.dataset.s; f('lSites').querySelectorAll('.opt').forEach(o=>o.classList.toggle('active', o===b));
  });
  f('lComp').addEventListener('change', ()=>{ cid = f('lComp').value; c = getC(); f('lUnit').textContent = unitOf(); if(!ex) site=null; renderSites(); prefill(); calc(); });
  f('lDose').addEventListener('input', calc);
  renderSites(); prefill(); calc();

  if(ex) f('lDel').addEventListener('click', e=>armButton(e.currentTarget, 'Tap again to delete', ()=>{
    adjustStock(ex.compoundId, ex.volumeMl||0, ex.date);
    db.logs = db.logs.filter(l=>l.id!==ex.id); save(); closeSheet(); render(); toast('Entry deleted');
  }));

  f('lSave').addEventListener('click', ()=>{
    const err = f('lErr'); err.textContent = '';
    const d = num(f('lDose').value);
    const dt = new Date(f('lDate').value);
    if(!cid) return err.textContent = 'Choose a compound.';
    if(!(d>0)) return err.textContent = `Enter a dose above 0 ${unitOf()}.`;
    if(isNaN(dt.getTime())) return err.textContent = 'Pick a date and time.';
    if(dt - Date.now() > 36e5) return err.textContent = 'That time is in the future. Log doses after you take them.';
    const unit = unitOf();
    const mg = toMg(d, unit);
    const strength = c ? c.strength : ex.strength;
    const vol = strength>0 ? mg/strength : null;
    const notes = f('lNotes').value.trim();
    if(ex){
      adjustStock(ex.compoundId, ex.volumeMl||0, ex.date); // undo old
      Object.assign(ex, {compoundId:cid, compoundName: c?c.name:ex.compoundName, strength, unit, dose:mg, volumeMl:vol, date:dt.toISOString(), site, notes});
      adjustStock(cid, -(vol||0), ex.date);
    } else {
      db.logs.push({id:uid(), compoundId:cid, compoundName:c.name, strength, unit, dose:mg, volumeMl:vol, date:dt.toISOString(), site, notes});
      adjustStock(cid, -(vol||0), dt);
    }
    save(); closeSheet(); render(); haptic('success');
    toast(ex ? 'Entry updated' : `Logged ${fmtAmt(mg, unit)} ${c?c.name:''}${site?' · '+site:''}`);
  });
}

/* ---------- Vial ---------- */
function newVial(id){
  const c = db.compounds.find(c=>c.id===id); if(!c || !c.vial) return;
  openSheet(`<h2>Start a new vial</h2>
    <p class="muted" style="margin-top:-6px">${esc(c.name)}</p>
    <div class="field"><label for="vSize">Vial size (mL)</label><input id="vSize" type="number" inputmode="decimal" min="0" step="any" value="${esc(c.vial.sizeMl)}"></div>
    ${c.form==='powder'?`<div class="row2"><div class="field"><label for="vPowder">Powder (mg)</label><input id="vPowder" type="number" inputmode="decimal" step="any" value="${esc(c.powderMg||'')}"></div><div class="field"><label for="vWater">Water added (mL)</label><input id="vWater" type="number" inputmode="decimal" step="any" value="${esc(c.waterMl||'')}"></div></div>`:''}
    <button class="btn btn-block" id="vSave">Start new vial</button><div class="form-err" id="vErr" role="alert"></div>`);
  $('#vSave').addEventListener('click', ()=>{
    let size = num($('#vSize').value);
    if(c.form==='powder'){
      const p = num($('#vPowder').value), w = num($('#vWater').value);
      if(!(p>0 && w>0)) return $('#vErr').textContent = 'Enter the powder amount and water added.';
      c.powderMg = p; c.waterMl = w; c.strength = round(p/w, 6); size = w;
    }
    if(!(size>0)) return $('#vErr').textContent = 'Enter the vial size in mL.';
    c.vial = {sizeMl:size, remainingMl:size, openedAt:new Date().toISOString()};
    save(); closeSheet(); render(); haptic(); toast('New vial started');
  });
}


/* ================= Backup ================= */
function backupJson(){
  return JSON.stringify({app:'injection-tracker', version:2, exportedAt:new Date().toISOString(), ...db});
}
/* ---------- Backup password (optional) ----------
   With a backup password set, every backup (daily file, Google Drive, Share) is encrypted with AES-256-GCM using a key
   made from the password (PBKDF2-SHA256). The key itself stays on this phone so automatic backups keep working; the
   password is needed to restore on another phone. Backups made without a password still restore as before. */
const BK_KEY_STORE = 'ets-backup-key';
const BK_ITER = 310000;
let _bkKey = null;
const b64enc = buf => { const a = new Uint8Array(buf); let s = ''; for(let i=0;i<a.length;i+=0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i+0x8000)); return btoa(s); };
const b64dec = s => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
async function deriveBackupKey(pass, salt, iter){
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', hash:'SHA-256', salt:b64dec(salt), iterations:iter}, base, {name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
}
async function backupKey(){
  if(_bkKey) return _bkKey;
  const raw = await rawGet(BK_KEY_STORE); if(!raw) return null;
  try{ _bkKey = await crypto.subtle.importKey('raw', b64dec(raw), {name:'AES-GCM'}, true, ['encrypt','decrypt']); }catch(e){ _bkKey = null; }
  return _bkKey;
}
/* the text that goes into any backup file */
async function backupPayload(){
  const json = backupJson(), bc = db.settings.backupCrypto;
  if(!bc) return json;
  const key = await backupKey();
  if(!key) throw new Error('The backup password key is missing on this phone. Set the backup password again in App settings.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, new TextEncoder().encode(json));
  return JSON.stringify({app:'ets-encrypted', v:1, kdf:'PBKDF2-SHA256', iter:bc.iter, salt:bc.salt, iv:b64enc(iv), data:b64enc(ct)});
}
function isEncryptedBackup(text){ try{ const o = JSON.parse(String(text).trim()); return isObj(o) && o.app==='ets-encrypted' ? o : null; }catch(e){ return null; } }
async function decryptBackup(o, pass){
  const key = await deriveBackupKey(pass, o.salt, +o.iter || BK_ITER);
  try{ const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv:b64dec(o.iv)}, key, b64dec(o.data)); return new TextDecoder().decode(pt); }
  catch(e){ throw new Error('That password doesn\u2019t open this backup.'); }
}
/* Turn backup text into parsed data, asking for the password in `box` if the backup is encrypted. */
function readBackupText(text, box){
  const enc = isEncryptedBackup(text);
  if(!enc) return Promise.resolve(parseBackup(text));
  return new Promise((resolve, reject)=>{
    box.innerHTML = `<div class="field" style="margin:0 0 8px"><label for="bkPass">This backup is password protected</label><input id="bkPass" type="password" autocomplete="current-password"></div>
      <button type="button" class="btn btn-outline btn-block" id="bkOpen">Open backup</button><div class="form-err" id="bkErr" role="alert"></div>`;
    const go = async ()=>{
      const b = document.getElementById('bkOpen'); b.disabled = true; document.getElementById('bkErr').textContent = '';
      try{ const pass = document.getElementById('bkPass').value; const plain = await decryptBackup(enc, pass); const parsed = parseBackup(plain);
        parsed._crypto = {pass, salt:enc.salt, iter:+enc.iter || BK_ITER}; resolve(parsed); }
      catch(e){ document.getElementById('bkErr').textContent = e.message; b.disabled = false; }
    };
    document.getElementById('bkOpen').addEventListener('click', go);
    document.getElementById('bkPass').addEventListener('keydown', e=>{ if(e.key==='Enter') go(); });
    document.getElementById('bkPass').focus();
  });
}
function openBackupPassword(){
  const on = !!db.settings.backupCrypto;
  openSheet(`<h2>Backup password</h2>
    <p class="small muted" style="margin-top:-6px">Encrypts every backup: the daily file, Google Drive and shared copies. Without the password nobody can read them, including anyone who finds the file.</p>
    <p class="small"><b>If you forget the password, encrypted backups can't be opened.</b> Keep it in a password manager.</p>
    <div class="field"><label for="bp1">${on ? 'New password' : 'Password'}</label><input id="bp1" type="password" autocomplete="new-password"></div>
    <div class="field"><label for="bp2">Type it again</label><input id="bp2" type="password" autocomplete="new-password"></div>
    <button class="btn btn-block" id="bpSave">${on ? 'Change password' : 'Turn on'}</button>
    ${on ? `<button class="btn btn-outline btn-block" id="bpOff" style="margin-top:10px">Turn off (new backups won't be encrypted)</button>` : ''}
    <div class="form-err" id="bpErr" role="alert"></div>`);
  $('#bpSave').addEventListener('click', async e=>{
    const a = $('#bp1').value, b = $('#bp2').value;
    if(a.length < 8) return $('#bpErr').textContent = 'Use at least 8 characters.';
    if(a !== b) return $('#bpErr').textContent = 'The two passwords don\u2019t match.';
    e.currentTarget.disabled = true;
    const salt = b64enc(crypto.getRandomValues(new Uint8Array(16)));
    const key = await deriveBackupKey(a, salt, BK_ITER);
    await rawSet(BK_KEY_STORE, b64enc(await crypto.subtle.exportKey('raw', key)));
    _bkKey = key; db.settings.backupCrypto = {salt, iter:BK_ITER};
    save(); closeSheet(); render(); toast('Backups are now encrypted'); if(isNative) backupNow();
  });
  if(on) $('#bpOff').addEventListener('click', e=>armButton(e.currentTarget, 'Tap again to turn off', async ()=>{
    db.settings.backupCrypto = null; _bkKey = null; await rawSet(BK_KEY_STORE, '');
    save(); closeSheet(); render(); toast('Backup password turned off');
  }));
}
async function exportBackup(){
  let json;
  try{ json = await backupPayload(); }catch(e){ return toast(e.message); }
  const name = `ets-backup-${ymd(new Date())}.json`;
  const FS = plugin('Filesystem'), Share = plugin('Share');
  if(FS && Share){
    try{
      const r = await FS.writeFile({path:name, data:json, directory:'CACHE', encoding:'utf8'});
      suppressLockOnce();
      await Share.share({title:'Enhanced Training Studio backup', text:'Enhanced Training Studio backup', files:[r.uri], dialogTitle:'Save or send backup'});
      return;
    }catch(e){ if(String(e && e.message).match(/cancel/i)) return; }
  }
  // Browser: copy to clipboard and show the text
  openSheet(`<h2>Export backup</h2>
    <p class="small muted" style="margin-top:-6px">Copy this text and keep it somewhere safe (a note, an email to yourself). To restore, paste it into Restore backup.</p>
    <textarea id="expText" readonly style="min-height:180px; font-family:monospace; font-size:0.75rem">${esc(json)}</textarea>
    <button class="btn btn-block" id="expCopy" style="margin-top:10px">Copy backup</button>`);
  $('#expCopy').addEventListener('click', async ()=>{
    try{ await navigator.clipboard.writeText(json); db.settings.lastBackupAt = new Date().toISOString(); db.settings.lastBackupFile = 'Copied backup text'; persistQuiet(); toast('Backup copied'); }
    catch(e){ const t=$('#expText'); t.focus(); t.select(); toast('Select all and copy'); }
  });
}
/* Backup text -> the data it holds (throws if it isn't one of ours). */
function parseBackup(text){
  const raw = JSON.parse(String(text).replace(/^\ufeff/, '').trim());
  if(!isObj(raw)) throw new Error('not a backup');
  if(!raw.compounds && raw['inj-compounds']) raw.compounds = raw['inj-compounds'];
  if(!raw.logs && raw['inj-logs']) raw.logs = raw['inj-logs'];
  if(!Array.isArray(raw.compounds)) throw new Error('not a backup');
  const d = cleanCollections(cleanData(raw));
  const compounds = d.compounds || d['inj-compounds'];
  if(!Array.isArray(compounds)) throw new Error('not a backup');
  const logs = d.logs || d['inj-logs'];
  return {compounds, logs: Array.isArray(logs)?logs:[], activeWorkout: d.activeWorkout && Array.isArray(d.activeWorkout.items) ? d.activeWorkout : null,
    labs: Array.isArray(d.labs)?d.labs:[], health: isObj(raw.health) && isObj(raw.health.days) ? d.health : null,
    exercises: Array.isArray(d.exercises)?d.exercises:[], templates: Array.isArray(d.templates)?d.templates:[], workouts: Array.isArray(d.workouts)?d.workouts:[],
    activities: Array.isArray(d.activities)?d.activities:[], settings: d.settings||{}, exportedAt: validDate(d.exportedAt) ? d.exportedAt : null};
}
function backupSummary(p){
  return `Found <b>${p.compounds.length}</b> compounds, <b>${p.logs.length}</b> injections, <b>${p.labs.length}</b> lab results, <b>${p.workouts.length}</b> workouts, <b>${p.activities.length}</b> runs/walks/hikes${p.exportedAt?` · saved ${esc(fmtDate(p.exportedAt))} ${esc(fmtTime(p.exportedAt))}`:''}.`;
}
/* A copy of everything taken just before a restore or import, so it can be undone. */
const SNAP_KEY = 'inj-data-v2-before-change';
async function takeSnapshot(what){ try{ await rawSet(SNAP_KEY, JSON.stringify({what, at:new Date().toISOString(), data:db})); }catch(e){} }
async function snapshotInfo(){ try{ const r = await rawGet(SNAP_KEY); if(!r) return null; const o = JSON.parse(r); return o && o.data ? o : null; }catch(e){ return null; } }
async function undoSnapshot(){
  const o = await snapshotInfo(); if(!o) return toast('Nothing to undo.');
  clearTimeout(saveTimer); clearTimeout(wkSaveT); clearTimeout(modeSaveT); wkSaveT = modeSaveT = null; reloading = true;
  await rawSet(STORE_KEY, JSON.stringify(o.data)); await rawSet(SNAP_KEY, '');
  location.reload();
}
/* Replace everything with a parsed backup. Settings that belong to this phone (lock, reminders, band, Google account…) stay. */
function applyBackup(parsed){
  takeSnapshot('restore');
  db.compounds = parsed.compounds; db.logs = parsed.logs; db.labs = parsed.labs; db.health = parsed.health || {days:{}};
  db.exercises = parsed.exercises; db.templates = parsed.templates; db.workouts = parsed.workouts; db.activities = parsed.activities;
  
  db.activeActivity = null; db.activeWorkout = parsed.activeWorkout; ui.draft = null; ui.tplEdit = null; ui.mode = 'inj';
  const local = {};
  ['lockEnabled','lockAfter','autoBackup','lastBackupAt','lastBackupFile','lastBackupError','reminders','secureScreen','health','hr','gdrive','backupCrypto'].forEach(k=>{ if(k in db.settings) local[k] = db.settings[k]; });
  db.settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings, local);
  // keep encrypting after restoring an encrypted backup on a new phone (same password); otherwise don't claim
  // encryption this phone has no key for
  if(parsed._crypto && !local.backupCrypto){
    const {pass, salt, iter} = parsed._crypto;
    db.settings.backupCrypto = {salt, iter};
    deriveBackupKey(pass, salt, iter).then(async k=>{ _bkKey = k; await rawSet(BK_KEY_STORE, b64enc(await crypto.subtle.exportKey('raw', k))); }).catch(()=>{});
  } else if(!local.backupCrypto) db.settings.backupCrypto = null;
  if(!parsed.health && db.settings.health){ db.settings.health.lastSync = null; db.settings.health.syncedTypes = []; }
  migrate(); save(); closeSheet(); ui.tab='today'; render(); toast('Backup restored', {label:'Undo', fn:undoSnapshot});
}
function openImport(){
  openSheet(`<h2>Restore backup</h2>
    <p class="small muted" style="margin-top:-6px">Restoring replaces everything currently in the app.</p>
    <div class="field"><label for="impFile">Backup file</label><input id="impFile" type="file" accept="application/json,.json,text/plain"></div>
    <div class="field"><label for="impText">Or paste backup text</label><textarea id="impText" style="font-family:monospace; font-size:0.75rem"></textarea></div>
    <div class="calc" id="impInfo"></div>
    <button class="btn btn-block" id="impGo" disabled>Replace my data with this backup</button>
    <div class="form-err" id="impErr" role="alert"></div><div id="impUndo"></div>`);
  snapshotInfo().then(o=>{ const b = $('#impUndo'); if(!o || !b) return;
    b.innerHTML = `<button type="button" class="btn btn-outline btn-block" style="margin-top:14px" id="impUndoBtn">Undo the last ${esc(o.what)} (${esc(fmtShort(o.at))} ${esc(fmtTime(o.at))})</button>`;
    $('#impUndoBtn').addEventListener('click', e=>armButton(e.currentTarget, 'Tap again to go back', undoSnapshot)); });
  let parsed = null, seq = 0;
  const check = async text => {
    const mine = ++seq;
    parsed = null; $('#impGo').disabled = true; $('#impErr').textContent=''; $('#impInfo').innerHTML='';
    if(!text.trim()) return;
    try{
      const p = await readBackupText(text, $('#impInfo'));
      if(mine !== seq || !$('#impInfo')) return;
      parsed = p; $('#impInfo').innerHTML = backupSummary(parsed); $('#impGo').disabled = false;
    }
    catch(e){ if(mine === seq && $('#impErr')) $('#impErr').textContent = 'That is not an Enhanced Training Studio backup. Check you copied all of it.'; }
  };
  $('#impText').addEventListener('input', e=>check(e.target.value));
  $('#impFile').addEventListener('change', e=>{
    const file = e.target.files[0]; if(!file) return;
    const r = new FileReader(); r.onload = ()=>{ $('#impText').value = r.result; check(String(r.result)); }; r.readAsText(file);
  });
  $('#impGo').addEventListener('click', e=>armButton(e.currentTarget, 'Tap again to replace all data', ()=>applyBackup(parsed)));
}

/* ================= Google account: backups in Google Drive =================
   Backups go to the app's private folder in your Drive (hidden in the Drive app; only this app reads it). */
function gdPlugin(){ return plugin('GoogleDrive'); }
function gdCfg(){ return db.settings.gdrive || (db.settings.gdrive = {email:null, name:null, auto:true, lastAt:null, lastError:null}); }
const gd = { busy:false };
async function gdSignIn(){
  const G = gdPlugin(); if(!G) return toast('Google sign-in works in the Android app.');
  if(gd.signing) return; gd.signing = true;
  suppressLockOnce();
  try{
    const r = await G.signIn();
    const c = gdCfg(); c.email = r.email || c.email || 'Google account'; c.name = r.name || ''; c.lastError = null; c.needsSignIn = false; save(); render();
    toast(`Signed in as ${c.email}`);
    gdBackup(false, true);
  }catch(e){ if(e && e.code!=='cancelled') toast(e && e.message || 'Google sign-in failed'); }
  finally{ gd.signing = false; }
}
async function gdSignOut(){
  const G = gdPlugin(), c = gdCfg();
  if(G) try{ await G.signOut({email:c.email}); }catch(e){}
  c.email = null; c.name = null; c.lastAt = null; c.lastError = null; c.needsSignIn = false; save(); render(); toast('Signed out of Google');
}
/* manual: show toasts. Otherwise only runs when auto is on and the last Drive backup is over 20 hours old. */
async function gdBackup(manual, force){
  const G = gdPlugin(), c = gdCfg();
  if(!G || !c.email || gd.busy) return false;
  if(!manual && !force && (c.auto===false || (c.lastAt && Date.now() - new Date(c.lastAt) < 20*3600e3))) return false;
  gd.busy = true; if(manual) render();
  try{
    const stamp = new Date(); const name = `ets-backup-${ymd(stamp)}-${String(stamp.getHours()).padStart(2,'0')}${String(stamp.getMinutes()).padStart(2,'0')}.json`;
    if(manual) suppressLockOnce();
    await G.upload({name, data: await backupPayload(), keep: 10, interactive: !!manual});
    c.lastAt = stamp.toISOString(); db.settings.lastBackupAt = c.lastAt; if(!isNative || !db.settings.autoBackup) db.settings.lastBackupFile = "Google Drive"; c.lastError = null; c.needsSignIn = false; persistQuiet();
    if(manual) toast('Backed up to Google Drive');
    return true;
  }catch(e){
    c.lastError = (e && e.message) || 'Backup failed'; if(e && e.code==='consent') c.needsSignIn = true; persistQuiet();
    if(manual) toast(c.lastError);
    return false;
  }finally{ gd.busy = false; if(ui.tab==='app' && !sheetOpen) render(); }
}
async function gdOpenRestore(){
  const G = gdPlugin(); if(!G) return;
  openSheet(`<h2>Restore from Google Drive</h2>
    <p class="small muted" style="margin-top:-6px">Pick a backup. Restoring replaces everything currently in the app.</p>
    <div class="card" style="padding:0 14px" id="gdList"><div class="empty small">Loading backups…</div></div>
    <div class="calc" id="gdInfo"></div><div class="form-err" id="gdErr" role="alert"></div>`);
  try{
    suppressLockOnce();
    const r = await G.list({interactive:true});
    const files = r.files || [];
    const box = $('#gdList'); if(!box) return;
    box.innerHTML = files.length ? files.map(f=>`<button type="button" class="list-item tap-row" data-gdfile="${esc(f.id)}" style="width:100%; text-align:left; background:none; border-left:0; border-right:0; border-top:0">
        <div class="list-main"><div class="list-title">${esc(fmtDate(f.modifiedTime))} ${esc(fmtTime(f.modifiedTime))}</div><div class="list-sub">${f.size ? Math.round(f.size/1024).toLocaleString()+' KB' : ''}</div></div>
        <svg class="chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></button>`).join('')
      : `<div class="empty small">No backups in Google Drive yet.</div>`;
    let pick = 0;
    box.querySelectorAll('[data-gdfile]').forEach(b=>b.addEventListener('click', async ()=>{
      const mine = ++pick;
      box.querySelectorAll('[data-gdfile]').forEach(x=>x.classList.toggle('picked', x===b));
      $('#gdErr').textContent = ''; $('#gdInfo').textContent = 'Downloading…';
      try{
        const d = await G.download({id:b.dataset.gdfile});
        if(mine !== pick) return;                      // a newer choice is loading
        const parsed = await readBackupText(d.data, $('#gdInfo'));
        if(mine !== pick) return;
        $('#gdInfo').innerHTML = backupSummary(parsed) + `<button class="btn btn-block" id="gdGo" style="margin-top:10px">Replace my data with this backup</button>`;
        $('#gdGo').addEventListener('click', e=>armButton(e.currentTarget, 'Tap again to replace all data', ()=>applyBackup(parsed)));
      }catch(e){ if(mine !== pick) return; $('#gdInfo').textContent = ''; $('#gdErr').textContent = (e && e.message) || 'Couldn\u2019t read that backup.'; }
    }));
  }catch(e){ const box = $('#gdList'); if(box) box.innerHTML = ''; const er = $('#gdErr'); if(er) er.textContent = (e && e.message) || 'Couldn’t reach Google Drive.'; }
}
function renderGoogleCard(){
  const G = gdPlugin(), c = gdCfg();
  let html = `<div class="section-label">Google account</div><div class="card">`;
  if(!G) return html + `<p class="small muted" style="margin:0">Sign in with Google to back everything up to your Google Drive. Available in the Android app.</p></div>`;
  if(!c.email) return html + `<p class="small" style="margin:0 0 12px">Sign in to back up everything (injections, training, labs, health, settings) to a private folder in your Google Drive, and restore it on a new phone.</p>
    <button class="btn btn-block" data-action="gd-signin">Sign in with Google</button></div>`;
  html += `<div class="kv"><span>Signed in</span><span>${esc(c.email)}</span></div>
    <div class="kv"><span>Last Drive backup</span><span>${c.lastAt ? esc(fmtDate(c.lastAt)+' '+fmtTime(c.lastAt)) : 'Not yet'}</span></div>
    ${c.needsSignIn ? `<div class="form-err" style="margin:6px 0 0">Google needs you to sign in again.</div><button class="btn btn-block" data-action="gd-signin" style="margin-top:8px">Sign in again</button>`
      : c.lastError ? `<div class="form-err" style="margin:6px 0 0">${esc(c.lastError)}</div>` : ''}
    <div class="switch-row" style="border-top:1px solid var(--hair); margin-top:8px"><div><div class="list-title">Daily backup to Google Drive</div><div class="list-sub">Once a day when the app is open. The 10 newest are kept.</div></div>
      <label class="switch"><input type="checkbox" id="setGdAuto" ${c.auto!==false?'checked':''} aria-label="Daily backup to Google Drive"><span></span></label></div>
    <div class="btn-row" style="margin-top:10px"><button class="btn" data-action="gd-backup" ${gd.busy?'disabled':''}>${gd.busy?'Backing up…':'Back up now'}</button><button class="btn btn-outline" data-action="gd-restore">Restore</button></div>
    <button class="btn btn-outline btn-block" data-action="gd-signout" style="margin-top:10px">Sign out</button></div>`;
  return html;
}

/* ================= App lock (Android) =================
   Uses the phone's own fingerprint / face / screen lock through the AppLock native plugin. */
const lock = { locked:false, authing:false, pausedAt:null, lastAuth:0, suppressUntil:0, pending:[] };
function lockPlugin(){ return plugin('AppLock'); }
function lockOn(){ return !!(isNative && db.settings.lockEnabled && lockPlugin()); }
function showLock(){
  if(lock.locked) return;
  lock.locked = true;
  $('#lockScreen').hidden = false;
  $('#app').setAttribute('aria-hidden','true');
}
function hideLock(){
  lock.locked = false;
  $('#lockScreen').hidden = true;
  $('#app').removeAttribute('aria-hidden');
  lock.pending.splice(0).forEach(fn=>{ try{ fn(); }catch(e){} });
}
/* One biometric attempt at a time. Leaving the app mid-prompt can leave the native call hanging
   (no success or error ever arrives), so every attempt has an id and a stale one is cancelled and replaced. */
async function unlock(force){
  const L = lockPlugin();
  if(!L){ hideLock(); return; }
  if(lock.authing && !force) return;
  if(lock.authing && L.cancel) L.cancel().catch(()=>{});
  const id = lock.attempt = (lock.attempt||0) + 1;
  lock.authing = true; lock.authStart = Date.now(); $('#lockMsg').textContent = '';
  try{
    await L.authenticate({title:'Unlock Enhanced Training Studio', subtitle:'Use your fingerprint, face or screen lock'});
    hideLock();                                   // a success always counts, even from an older attempt
  }catch(e){
    if(id !== lock.attempt) return;               // superseded attempt: ignore its error
    const code = String(e && e.code || ''), msg = String(e && e.message || '');
    // 10 = cancelled by user, 13 = negative button, 5 = cancelled by system
    $('#lockMsg').textContent = ['5','10','13'].includes(code) || /cancel/i.test(msg) ? '' : (msg || 'Couldn’t unlock. Try again.');
  }finally{
    if(id === lock.attempt){ lock.authing = false; lock.lastAuth = Date.now(); }
  }
}
/* Opening the file picker, share sheet or Android settings leaves the app briefly — don't lock for that. */
function suppressLockOnce(){ lock.suppressUntil = Date.now() + 90000; }
const ACTIVITY_LOCK_MS = 15*60000;   // during a run: lock only after 15 minutes away, not on every glance
function onAppPause(){
  flushPending();
  lock.pausedAt = Date.now();
  if(db.activeActivity) return;
  if(lockOn() && !lock.authing && (db.settings.lockAfter||0)===0 && Date.now() > lock.suppressUntil) showLock();
}
function onAppResume(){
  if(!lockOn()) return;
  if(db.activeActivity && !lock.locked){
    if(lock.pausedAt && Date.now() - lock.pausedAt >= ACTIVITY_LOCK_MS && !lock.authing && Date.now() > lock.suppressUntil){ showLock(); unlock(); }
    return;
  }
  if(lock.locked){
    // Back on the lock screen: ask again. The PIN/pattern screen itself pauses and resumes the app,
    // so give a running attempt a moment to report before treating it as abandoned.
    clearTimeout(lock.resumeT);
    lock.resumeT = setTimeout(()=>{
      if(!lock.locked) return;
      if(!lock.authing) unlock();
      else unlock(true);
    }, lock.authing ? 1200 : 250);
    return;
  }
  if(lock.authing || Date.now() - lock.lastAuth < 2000) return;
  if(Date.now() <= lock.suppressUntil){ lock.suppressUntil = 0; return; }
  const away = lock.pausedAt ? Date.now() - lock.pausedAt : Infinity;
  if(away >= (db.settings.lockAfter||0)*60000){ showLock(); unlock(); }
}
async function setLockEnabled(on){
  const L = lockPlugin();
  if(!L){ db.settings.lockEnabled = false; render(); return; }
  if(on){
    let ok = false;
    try{
      const a = await L.isAvailable();
      if(!a.available){
        render();
        return toast(a.reason==='none_enrolled' || a.reason==='unavailable'
          ? 'Set up a screen lock or fingerprint in Android Settings first.'
          : 'This phone can’t use fingerprint or screen-lock unlocking.');
      }
      lock.authing = true;
      await L.authenticate({title:'Turn on app lock', subtitle:'Confirm it’s you'});
      ok = true;
    }catch(e){ /* cancelled */ }
    finally{ lock.authing = false; lock.lastAuth = Date.now(); }
    if(!ok){ render(); return; }
    db.settings.lockEnabled = true;
    save(); applySecureScreen(); render(); toast('App lock on');
  } else {
    let ok = false;
    try{ lock.authing = true; await L.authenticate({title:'Turn off app lock', subtitle:'Confirm it’s you'}); ok = true; }
    catch(e){} finally{ lock.authing = false; lock.lastAuth = Date.now(); }
    if(!ok){ render(); return; }
    db.settings.lockEnabled = false;
    save(); applySecureScreen(); render(); toast('App lock off');
  }
}

/* ================= Doctor report (PDF) ================= */
function loadScript(src){
  return new Promise((res, rej)=>{
    if(document.querySelector(`script[data-src="${esc(src)}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.dataset.src = src;
    s.onload = ()=>res(); s.onerror = ()=>rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
async function loadJsPdf(){
  if(!(window.jspdf && window.jspdf.jsPDF)) await loadScript('vendor/jspdf.umd.min.js');
  if(!window.jspdf.jsPDF.API.autoTable) await loadScript('vendor/jspdf.plugin.autotable.min.js');
  return window.jspdf.jsPDF;
}
function openReportSheet(){
  const s = db.settings;
  const periods = [[3,'3 months'],[6,'6 months'],[12,'12 months'],[0,'Everything']];
  const pm = s.reportMonths==null ? 6 : s.reportMonths;
  openSheet(`<h2>Doctor report</h2>
    <p class="small muted" style="margin-top:-8px">A PDF summary of your regimen, doses, blood tests and estimated levels. It's made on this phone; you choose where to send it.</p>
    <div class="field"><span class="field-label">Period</span>${segHtml('rPeriod', periods.map(([v,l])=>[String(v), l]), String(pm))}</div>
    <div class="field"><label for="rName">Name on report (optional)</label><input id="rName" autocomplete="name" value="${esc(s.reportName||'')}" placeholder="Your name"></div>
    <div class="field"><span class="field-label">Include</span>
      <label class="switch-row"><span>Estimated levels charts</span><span class="switch"><input type="checkbox" id="rCharts" ${s.reportCharts!==false?'checked':''}><span></span></span></label>
      <label class="switch-row"><span>Full injection log</span><span class="switch"><input type="checkbox" id="rLog" ${s.reportLog!==false?'checked':''}><span></span></span></label>
      <label class="switch-row"><span>Notes on injections</span><span class="switch"><input type="checkbox" id="rNotes" ${s.reportNotes?'checked':''}><span></span></span></label>
      ${''}
    </div>
    <div class="sheet-actions"><button class="btn btn-block" id="rGo">Create PDF</button><div class="form-err" id="rErr" role="alert" style="margin-top:6px; min-height:0"></div></div>
    `);
  bindSeg('rPeriod', ()=>{});
  $('#rGo').addEventListener('click', async ()=>{
    const btn = $('#rGo'), err = $('#rErr'); err.textContent = '';
    const opts = { months: +segVal('rPeriod'), name: $('#rName').value.trim(), charts: $('#rCharts').checked, log: $('#rLog').checked, notes: $('#rNotes').checked, health: !!($('#rHealth') && $('#rHealth').checked) };
    Object.assign(db.settings, {reportMonths:opts.months, reportName:opts.name, reportCharts:opts.charts, reportLog:opts.log, reportNotes:opts.notes, reportHealth:opts.health});
    save();
    btn.disabled = true; btn.textContent = 'Creating…';
    try{
      const jsPDF = await loadJsPdf();
      const doc = buildReport(jsPDF, opts);
      await deliverPdf(doc, `ets-doctor-report-${ymd(new Date())}.pdf`);
      closeSheet();
    }catch(e){
      err.textContent = 'Couldn’t create the report: ' + (e && e.message || e);
    }finally{
      if(btn.isConnected){ btn.disabled = false; btn.textContent = 'Create PDF'; }
    }
  });
}
async function deliverPdf(doc, name){
  const FS = plugin('Filesystem'), Share = plugin('Share');
  if(FS && Share){
    const b64 = doc.output('datauristring').split(',')[1];
    const r = await FS.writeFile({path:name, data:b64, directory:'CACHE'});
    suppressLockOnce();
    try{ await Share.share({title:'Injection report', files:[r.uri], dialogTitle:'Send or save report'}); }
    catch(e){ if(!/cancel/i.test(String(e && e.message))) throw e; }
    return;
  }
  // browser: open the PDF in a new tab (downloads may be blocked)
  const url = URL.createObjectURL(doc.output('blob'));
  const w = window.open(url, '_blank');
  if(!w) doc.save(name);
}

/* Report content. Pure: reads db, draws into a jsPDF document. */
function reportData(months){
  const now = new Date();
  const end = now;
  let start;
  if(months>0){ start = new Date(now); start.setMonth(start.getMonth()-months); start = dayStart(start); }
  else {
    const ts = [...db.logs.map(l=>+new Date(l.date)), ...db.labs.map(r=>+parseYmd(r.date)), ...db.compounds.map(c=>+new Date(c.createdAt||now))];
    start = dayStart(ts.length ? Math.min(...ts) : now);
  }
  const inRange = d => { const t = new Date(d); return t >= start && t <= end; };
  const logs = db.logs.filter(l=>inRange(l.date)).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const labs = db.labs.filter(r=>inRange(parseYmd(r.date)));
  const adherence = db.compounds.filter(hasSchedule).map(c=>{
    const tl = timeline(c, start, dayStart(now)).filter(t=>t.day <= dayStart(now));
    const n = st => tl.filter(t=>t.status===st).length;
    const taken = n('taken'), skipped = n('skipped'), missed = n('missed'), due = n('due');
    const sched = taken + skipped + missed;
    const ds = logs.filter(l=>l.compoundId===c.id && !l.skipped).map(l=>+new Date(l.date));
    const gaps = ds.slice(1).map((t,i)=>(t-ds[i])/DAY);
    return {c, sched, taken, skipped, missed, due, pct: sched ? Math.round(taken/sched*100) : null,
            avgGap: gaps.length ? round(gaps.reduce((a,b)=>a+b,0)/gaps.length, 1) : null, count: ds.length};
  });
  return {start, end, logs, labs, adherence};
}
function buildReport(jsPDF, opts){
  const D = reportData(opts.months);
  const doc = new jsPDF({unit:'mm', format:'a4'});
  const W = 210, M = 16, CW = W - 2*M;
  const INK = [26,28,30], MUTED = [98,102,106], SIG = [200,64,27], HAIR = [207,205,196], PAPER = [242,241,236];
  const at = (o)=> doc.autoTable(o);
  let y = M;
  const fmtD = d => new Date(d).toLocaleDateString(undefined, {day:'numeric', month:'short', year:'numeric'});
  const ensure = h => { if(y + h > 297 - 18){ doc.addPage(); y = M; } };
  const heading = (t)=>{
    ensure(14);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    doc.text(t.toUpperCase(), M, y+4, {charSpace:0.6});
    doc.setDrawColor(...HAIR); doc.setLineWidth(0.3); doc.line(M, y+6, M+CW, y+6);
    y += 10;
  };
  const para = (t, size=9, color=INK)=>{
    doc.setFont('helvetica','normal'); doc.setFontSize(size); doc.setTextColor(...color);
    const lines = doc.splitTextToSize(t, CW);
    ensure(lines.length*size*0.42 + 2);
    doc.text(lines, M, y+3.2); y += lines.length*size*0.42 + 2.5;
  };
  const tableBase = {
    margin:{left:M, right:M, bottom:18}, theme:'plain',
    styles:{font:'helvetica', fontSize:8.2, textColor:INK, cellPadding:{top:1.6,bottom:1.6,left:2,right:2}, lineColor:HAIR, lineWidth:{bottom:0.2}},
    headStyles:{fontStyle:'bold', textColor:MUTED, fontSize:7.2, lineColor:INK, lineWidth:{bottom:0.4}},
  };

  // ---- title block
  doc.setFillColor(...PAPER); doc.rect(0,0,W,40,'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.setTextColor(...INK);
  doc.text(D.labs.length ? 'Injection & blood test report' : 'Injection report', M, 20);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(...MUTED);
  const who = opts.name ? `${opts.name}  ·  ` : '';
  doc.text(`${who}Period ${fmtD(D.start)} – ${fmtD(D.end)}  ·  Generated ${fmtD(new Date())}`, M, 28);
  doc.setDrawColor(...INK); doc.setLineWidth(0.6); doc.line(M, 34, W-M, 34);
  y = 44;

  // ---- summary
  heading('Summary');
  const taken = D.logs.filter(l=>!l.skipped).length;
  const allSched = D.adherence.reduce((a,x)=>a+x.sched,0), allTaken = D.adherence.reduce((a,x)=>a+x.taken,0);
  const tests = labTests().filter(t=>t.at >= D.start && t.at <= D.end);
  const lastTest = tests[tests.length-1];
  const summary = [
    ['Compounds', (()=>{ const fin = c=>{ const cy = cycleState(c); return cy && cy.state==='done'; };
      const nAct = db.compounds.filter(c=>!currentPause(c) && !fin(c)).length, nP = db.compounds.filter(c=>currentPause(c) && !fin(c)).length, nF = db.compounds.filter(fin).length;
      return `${nAct} active${nP ? `, ${nP} paused` : ''}${nF ? `, ${nF} finished cycle${nF===1?'':'s'}` : ''}`; })()],
    ['Injections logged', String(taken)],
    ['Doses taken as scheduled', allSched ? `${Math.round(allTaken/allSched*100)}% (${allTaken} of ${allSched})` : '—'],
    ['Blood tests', tests.length ? `${tests.length} in period${lastTest ? `, latest ${fmtD(lastTest.at)}${labTimingText(lastTest.at) ? ' (' + labTimingText(lastTest.at) + ')' : ''}` : ''}` : 'None in period'],
  ];
  at({...tableBase, startY:y, body:summary, columnStyles:{0:{textColor:MUTED, cellWidth:52}}, styles:{...tableBase.styles, fontSize:9}});
  y = doc.lastAutoTable.finalY + 6;

  // ---- current regimen
  heading('Current regimen');
  const reg = db.compounds.map(c=>{
    const notes = [];
    const cyr = cycleState(c); if(cyr) notes.push(`${cyr.state==='done' ? 'Cycle finished' : cyr.state==='before' ? 'Cycle planned' : 'Cycle'}: ${cycleLengthText(c.cycle)}, ${fmtD(parseYmd(cyr.start))} to ${fmtD(parseYmd(cyr.lastDay))}`);
    const pz = currentPause(c); if(pz) notes.push(`Paused since ${fmtD(parseYmd(pz.from))}${pz.to?` until ${fmtD(parseYmd(pz.to))}`:''}`);
    const nx = nextDoseChange(c); if(nx) notes.push(`${fmtAmt(nx.dose,c.unit)} from ${fmtD(parseYmd(nx.from))}`);
    if(c.halfLife) notes.push(`Half-life ${c.halfLife} d (entered)`);
    const strength = c.form==='powder' && c.powderMg ? `${c.powderMg} mg + ${c.waterMl} mL water (${round(c.strength,3)} mg/mL)` : `${round(c.strength,3)} mg/mL`;
    const pv = plannedVol(c);
    return [c.name, strength, c.dosePerInj ? `${fmtAmt(c.dosePerInj,c.unit)}${pv?`\n${round(pv,2)} mL${pv<=1?` / ${round(pv*100,1)} U`:''}`:''}` : '—',
            scheduleLabel(c), c.route, notes.join('\n')];
  });
  at({...tableBase, startY:y, head:[['Compound','Strength','Dose / injection','Schedule','Route','Notes']], body:reg.length?reg:[['No compounds','','','','','']],
      columnStyles:{0:{fontStyle:'bold', cellWidth:28}, 1:{cellWidth:32}, 2:{cellWidth:27}, 4:{cellWidth:13}}});
  y = doc.lastAutoTable.finalY + 6;

  // dose changes and pauses in period
  const changes = [];
  db.compounds.forEach(c=>{
    (c.doseHistory||[]).slice().sort((a,b)=>a.from<b.from?-1:1).forEach((e,i,arr)=>{
      if(i===0) return;
      const d = parseYmd(e.from); if(d < D.start) return;
      changes.push([fmtD(d), c.name, `Dose ${fmtAmt(arr[i-1].dose,c.unit)} to ${fmtAmt(e.dose,c.unit)}${d>new Date()?' (planned)':''}`]);
    });
    (c.pauses||[]).forEach(p=>{
      const d = parseYmd(p.from); if(p.to && parseYmd(p.to) < D.start) return;
      changes.push([fmtD(d), c.name, `Paused${p.to?` until ${fmtD(parseYmd(p.to))}`:''}`]);
    });
  });
  if(changes.length){
    heading('Dose changes and pauses');
    at({...tableBase, startY:y, head:[['Date','Compound','Change']], body:changes.sort((a,b)=>new Date(a[0])-new Date(b[0])), columnStyles:{0:{cellWidth:28}, 1:{cellWidth:36}}});
    y = doc.lastAutoTable.finalY + 6;
  }

  // ---- adherence
  if(D.adherence.length){
    heading('Adherence');
    at({...tableBase, startY:y, head:[['Compound','Scheduled','Taken','Skipped','Missed','Taken %','Avg days between doses']],
      body:D.adherence.map(a=>[a.c.name, a.sched, a.taken, a.skipped, a.missed, a.pct==null?'—':a.pct+'%', a.avgGap==null?'—':a.avgGap]),
      columnStyles:{0:{fontStyle:'bold'}, 1:{halign:'right'}, 2:{halign:'right'}, 3:{halign:'right'}, 4:{halign:'right'}, 5:{halign:'right'}, 6:{halign:'right'}},
      didParseCell: h=>{ if(h.section==='body' && h.column.index===4 && +h.cell.raw>0) h.cell.styles.textColor = SIG; }});
    y = doc.lastAutoTable.finalY + 2;
    para('Scheduled doses are counted from the schedule entered in the app. A dose logged up to a day early counts for that scheduled day.', 7.5, MUTED);
    y += 3;
  }

  // ---- levels charts
  if(opts.charts){
    const hl = db.compounds.filter(c=>c.halfLife>0 && db.logs.some(l=>l.compoundId===c.id && !l.skipped));
    if(hl.length){
      ensure(10 + CW*300/900 + 18);   // keep the heading with the first chart
      heading('Estimated levels');
      const weeks = Math.min(52, Math.max(4, Math.ceil((D.end - D.start)/(7*DAY))));
      const light = {'--card':'#FFFFFF','--grid':'#E3E1DA','--muted':'#62666A','--text':'#1A1C1E','--signal':'#C8401B'};
      hl.forEach(c=>{
        const cv = document.createElement('canvas');
        const cs = paintLevels(cv, c, weeks, 900, 300, 2, n=>light[n]||'#000', 'Helvetica, Arial, sans-serif');
        const img = cv.toDataURL('image/png');
        const h = CW * 300/900;
        ensure(h + 16);
        doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...INK);
        doc.text(`${c.name}  ·  half-life ${c.halfLife} d`, M, y+3); y += 5;
        doc.addImage(img, 'PNG', M, y, CW, h); y += h + 2;
        cs.marks.forEach(mk=>{
          const k = mk.tst.key;
          para(`Blood test ${fmtD(mk.tst.at)}: ${labTimingText(mk.tst.at, c) || 'no dose logged before it'}${mk.v!=null?`, est. ${fmtEst(mk.v, c.unit)} active`:''}${k?`, ${k.marker} ${labValueText(k)} ${k.unit||''}${k.flag?' ('+k.flag+')':''}`:''}.`, 7.8, INK);
        });
        y += 3;
      });
      para('Estimated amount remaining from logged doses and the half-life entered in the app; not a measured blood level. Dashed line = planned doses. Squares = blood tests.', 7.5, MUTED);
      y += 3;
    }
  }

  // ---- blood tests
  if(D.labs.length){
    heading('Blood tests');
    const dates = [...new Set(D.labs.map(r=>r.date))].sort().reverse().slice(0, 5);
    const order = ['Total testosterone','Free testosterone','SHBG','Oestradiol (E2)','LH','FSH','Prolactin','PSA','Haematocrit','Haemoglobin'];
    const markers = [...new Set(D.labs.filter(r=>dates.includes(r.date)).map(r=>r.marker))].sort((a,b)=>{
      const ia = order.indexOf(a), ib = order.indexOf(b); return (ia<0?99:ia)-(ib<0?99:ib) || a.localeCompare(b);
    });
    const cellOf = (m, d)=>{ const r = D.labs.find(x=>x.marker===m && x.date===d); return r ? `${labValueText(r)}${r.flag?' '+r.flag:''}` : ''; };
    const rangeOf = m => { const r = D.labs.filter(x=>x.marker===m && x.refText).sort((a,b)=>a.date<b.date?1:-1)[0]; return r ? r.refText : ''; };
    const unitOf = m => { const r = D.labs.find(x=>x.marker===m && x.unit); return r ? r.unit : ''; };
    const timingRow = ['Time since last dose', '', '', ...dates.map(d=>{ const t = labTests().find(x=>x.date===d); return t ? (labTimingText(t.at).replace(/ after .*/,'') || '—') : ''; })];
    const body = [timingRow, ...markers.map(m=>[m, unitOf(m), rangeOf(m), ...dates.map(d=>cellOf(m,d))])];
    at({...tableBase, startY:y, head:[['Test','Unit','Range', ...dates.map(d=>fmtD(parseYmd(d)))]], body,
      columnStyles:{0:{fontStyle:'bold', cellWidth:38}, 1:{textColor:MUTED, cellWidth:18}, 2:{textColor:MUTED, cellWidth:22}},
      didParseCell: h=>{
        if(h.section!=='body') return;
        if(h.row.index===0){ h.cell.styles.textColor = MUTED; h.cell.styles.fontStyle = 'italic'; }
        if(h.column.index>=3){ h.cell.styles.halign = 'right'; if(/ [HL]$/.test(String(h.cell.raw))){ h.cell.styles.textColor = SIG; h.cell.styles.fontStyle = 'bold'; } }
        if(h.column.index>=1 && h.column.index<3) h.cell.styles.fontSize = 7.4;
      }});
    y = doc.lastAutoTable.finalY + 2;
    para('H / L = above / below the reference range printed on the lab report. "Time since last dose" is from the injection log.', 7.5, MUTED);
    y += 3;
  }

  

  // ---- injection sites
  const sites = {};
  D.logs.filter(l=>!l.skipped && l.site).forEach(l=>{ sites[l.site] = (sites[l.site]||0) + 1; });
  if(Object.keys(sites).length){
    heading('Injection sites');
    const rows = Object.entries(sites).sort((a,b)=>b[1]-a[1]).map(([s,n])=>[s, n]);
    at({...tableBase, startY:y, head:[['Site','Injections']], body:rows, tableWidth:80, columnStyles:{1:{halign:'right'}}});
    y = doc.lastAutoTable.finalY + 6;
  }

  // ---- injection log
  if(opts.log && D.logs.length){
    heading('Injection log');
    const head = ['Date','Time','Compound','Dose','Volume','Site'].concat(opts.notes ? ['Notes'] : []);
    const body = D.logs.slice().reverse().map(l=>{
      const vol = l.volumeMl ?? (l.strength ? l.dose/l.strength : null);
      const row = [fmtD(l.date), new Date(l.date).toLocaleTimeString('en-AU',{hour:'numeric', minute:'2-digit'}), l.compoundName || '',
        l.skipped ? 'Skipped' : fmtAmt(l.dose, l.unit), l.skipped || vol==null ? '' : `${round(vol,2)} mL`, l.site || ''];
      if(opts.notes) row.push(l.notes || '');
      return row;
    });
    at({...tableBase, startY:y, head:[head], body, columnStyles:{0:{cellWidth:24}, 1:{cellWidth:16}, 3:{cellWidth:20}, 4:{cellWidth:17}},
      didParseCell: h=>{ if(h.section==='body' && h.cell.raw==='Skipped') h.cell.styles.textColor = MUTED; }});
    y = doc.lastAutoTable.finalY + 6;
  }

  // ---- footer on every page
  const pages = doc.getNumberOfPages();
  for(let i=1;i<=pages;i++){
    doc.setPage(i);
    doc.setDrawColor(...HAIR); doc.setLineWidth(0.3); doc.line(M, 297-12, W-M, 297-12);
    doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
    doc.text('Enhanced Training Studio · all data entered by the patient · estimates are not measured blood levels', M, 297-8);
    doc.text(`Page ${i} of ${pages}`, W-M, 297-8, {align:'right'});
  }
  return doc;
}


/* ================= Automatic backup (Android) =================
   One file per day in Documents/ETS, rewritten after every change that day. Last 14 kept.
   Files in Documents survive uninstalling the app. */
const BACKUP_DIR = 'ETS';
let backupTimer = null;
function scheduleAutoBackup(){ clearTimeout(backupTimer); backupTimer = setTimeout(()=>autoBackup(false), 20000); }
async function autoBackup(force){
  const FS = plugin('Filesystem'); if(!FS) return false;
  if(!force && !db.settings.autoBackup) return false;
  if(!db.compounds.length && !db.logs.length && !db.labs.length && !(db.workouts||[]).length && !(db.activities||[]).length && !Object.keys((db.health&&db.health.days)||{}).length) return false;
  const name = `ets-backup-${ymd(new Date())}.json`;
  let data;
  const write = () => FS.writeFile({path:`${BACKUP_DIR}/${name}`, data, directory:'DOCUMENTS', encoding:'utf8', recursive:true});
  try{
    data = await backupPayload();
    try{ await write(); }
    catch(e){
      // older Android versions need storage permission for Documents
      const p = FS.requestPermissions ? await FS.requestPermissions() : null;
      if(p && p.publicStorage==='granted') await write(); else throw e;
    }
    db.settings.lastBackupAt = new Date().toISOString();
    db.settings.lastBackupFile = `Documents/${BACKUP_DIR}/${name}`;
    db.settings.lastBackupError = null;
    try{
      const r = await FS.readdir({path:BACKUP_DIR, directory:'DOCUMENTS'});
      const files = (r.files||[]).map(f=>typeof f==='string'?f:f.name).filter(n=>/^ets-backup-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
      for(const f of files.slice(0, -14)) { try{ await FS.deleteFile({path:`${BACKUP_DIR}/${f}`, directory:'DOCUMENTS'}); }catch(e){} }
    }catch(e){}
    persistQuiet();
    return true;
  }catch(e){
    db.settings.lastBackupError = String((e && e.message) || e).slice(0,140);
    persistQuiet();
    return false;
  }
}
async function backupNow(){
  const ok = await autoBackup(true);
  if(['setup','today','app'].includes(ui.tab)) render();
  toast(ok ? `Backed up to ${db.settings.lastBackupFile}` : 'Backup failed. Use Share backup instead.');
}

/* ================= Reminders (Android) ================= */
let remTimer = null;
function scheduleReminders(){ clearTimeout(remTimer); remTimer = setTimeout(doScheduleReminders, 400); }
let lastRemSig = null;
/* What the reminders depend on. save() runs on every edit (a whole workout's worth of typing),
   so the native cancel + reschedule only happens when one of these actually changed. */
function reminderSig(){
  const s = db.settings, since = ymd(addDays(new Date(), -70));
  return JSON.stringify([ymd(new Date()), s.reminders, s.morning, s.night, s.privateNotifs, db.compounds,
    db.logs.filter(l=>ymd(l.date) >= since).map(l=>[l.compoundId, l.date, !!l.skipped])]);
}
async function doScheduleReminders(force){
  const LN = plugin('LocalNotifications'); if(!LN) return;
  const sig = reminderSig();
  if(!force && sig === lastRemSig) return;
  lastRemSig = sig;
  try{
    const pending = await LN.getPending();
    const pend = (pending && pending.notifications) || [];
    // daily reminders are rebuilt each time; a snoozed reminder is kept unless its doses are already logged
    const drop = pend.filter(n=>{
      if(n.id === REST_NOTIF_ID || n.id === WEEKLY_NOTIF_ID) return false;   // rest timer / weekly report: leave alone
      if(n.id < SNOOZE_BASE) return true;
      const ids = (n.extra && n.extra.ids) || [];
      return !ids.some(id=>{ const c = db.compounds.find(c=>c.id===id); return c && statusFor(c).due; });
    });
    if(drop.length) await LN.cancel({notifications: drop.map(n=>({id:n.id}))});
    if(!db.settings.reminders) return;
    const now = new Date(), today = dayStart(now), until = addDays(today, 60);
    const groups = {};
    db.compounds.forEach(c=>{
      if(!hasSchedule(c)) return;
      timeline(c, today, until).forEach(t=>{
        if(t.status==='taken' || t.status==='skipped') return;
        const [h,m] = hm(c.time==='night' ? db.settings.night : db.settings.morning);
        const at = new Date(t.day); at.setHours(h,m,0,0);
        if(at <= now) return;
        const key = `${ymd(t.day)}|${c.time}`;
        const g = (groups[key] = groups[key] || {at, items:[], ids:[]});
        const dd = doseOn(c, t.day);
        g.items.push(`${c.name}${dd?' '+fmtAmt(dd,c.unit):''}`); g.ids.push(c.id);
      });
    });
    const notifications = Object.entries(groups).map(([key, g])=>{
      const [d, time] = key.split('|');
      return {
        id: (Number(d.replace(/-/g,''))*10 + (time==='night'?1:0)) % 2147483647,
        title: db.settings.privateNotifs ? 'Reminder' : (g.items.length>1 ? `${g.items.length} injections due` : 'Injection due'),
        body: db.settings.privateNotifs ? 'You have something scheduled. Tap to open.' : g.items.join(' · '),
        schedule: {at: g.at, allowWhileIdle: true},
        channelId: 'doses', smallIcon: 'ic_stat_injection',
        actionTypeId: 'DOSE', extra: {ids: g.ids, day: d}
      };
    });
    if(notifications.length) await LN.schedule({notifications});
  }catch(e){ lastRemSig = null; console.warn('reminders', e); }
}
const SNOOZE_BASE = 2000000000;
/* Log the planned dose for each compound in a reminder, at the suggested site. */
function quickLog(ids){
  const done = [], needInput = [];
  const now = new Date();
  ids.forEach(id=>{
    const c = db.compounds.find(c=>c.id===id); if(!c) return;
    const st = statusFor(c);
    if(!st.due) return;                        // already logged since the reminder
    const dose = doseOn(c, now) || c.dosePerInj;      // today's planned dose, even if a change started overnight
    if(!(dose>0) || !(c.strength>0)){ needInput.push(c); return; }
    const site = suggestSite(c.route, c), vol = dose / c.strength;
    const log = {id:uid(), compoundId:c.id, compoundName:c.name, strength:c.strength, unit:c.unit, dose, volumeMl:vol, date:now.toISOString(), site, notes:''};
    db.logs.push(log); adjustStock(c.id, -vol); done.push(log);
  });
  if(done.length) save();
  return {done, needInput};
}
function undoLogs(logs){
  logs.forEach(l=>{ adjustStock(l.compoundId, l.volumeMl||0, l.date); });
  const ids = new Set(logs.map(l=>l.id));
  db.logs = db.logs.filter(l=>!ids.has(l.id)); save(); render(); toast('Undone');
}
async function handleNotificationAction(a){
  if(lock.locked){ lock.pending.push(()=>handleNotificationAction(a)); return; }
  const LN = plugin('LocalNotifications');
  const n = (a && a.notification) || {}, extra = n.extra || {}, ids = extra.ids || [];
  closeSheet();
  if(n.id === REST_NOTIF_ID || n.channelId === 'rest'){ ui.mode = 'train'; ui.tab = 'workout'; render(); return; }
  if(n.id === WEEKLY_NOTIF_ID || extra.route === 'weekly'){ ui.mode = 'health'; ui.tab = 'hweek'; ui.weekOff = 0; render(); return; }
  ui.mode = 'inj'; ui.tab = 'today';
  if(a.actionId==='log'){
    const {done, needInput} = quickLog(ids);
    render();
    if(done.length){
      haptic('success');
      toast(`Logged ${done.map(l=>`${l.compoundName} ${fmtAmt(l.dose,l.unit)} · ${l.site}`).join(', ')}`, {label:'Undo', fn:()=>undoLogs(done)});
    } else if(!needInput.length) toast('Already logged');
    if(needInput.length) openLogSheet({compoundId: needInput[0].id});
  } else if(a.actionId==='snooze' && LN){
    try{
      await LN.schedule({notifications:[{
        id: SNOOZE_BASE + Math.floor(Math.random()*1e8), title: n.title || 'Injection due', body: n.body || '',
        schedule: {at: new Date(Date.now() + 3600e3), allowWhileIdle: true},
        channelId: 'doses', smallIcon: 'ic_stat_injection', actionTypeId: 'DOSE', extra
      }]});
      render(); toast('Snoozed. Reminder again in 1 hour.');
    }catch(e){ render(); toast('Could not snooze.'); }
  } else {
    render();
  }
}
async function enableReminders(on){
  const LN = plugin('LocalNotifications');
  if(!LN){ db.settings.reminders = false; return render(); }
  if(on){
    try{
      let p = await LN.checkPermissions();
      if(p.display!=='granted') p = await LN.requestPermissions();
      if(p.display!=='granted'){ db.settings.reminders=false; save(); render(); return toast('Notifications are turned off for this app in Android settings.'); }
      if(LN.checkExactNotificationSetting){
        const ex = await LN.checkExactNotificationSetting();
        if(ex && ex.exact_alarm && ex.exact_alarm!=='granted' && LN.changeExactNotificationSetting){
          toast('Allow "Alarms & reminders" so reminders arrive on time.');
          suppressLockOnce();
          await LN.changeExactNotificationSetting();
        }
      }
    }catch(e){}
  }
  db.settings.reminders = on; save(); render();
  toast(on ? 'Reminders on' : 'Reminders off');
}
async function testNotification(){
  const LN = plugin('LocalNotifications'); if(!LN) return;
  try{
    let p = await LN.checkPermissions(); if(p.display!=='granted') p = await LN.requestPermissions();
    if(p.display!=='granted') return toast('Notifications are turned off for this app in Android settings.');
    await LN.schedule({notifications:[{id:1, title:'Enhanced Training Studio', body:'Reminders are working.', schedule:{at:new Date(Date.now()+3000)}, channelId:'doses', smallIcon:'ic_stat_injection', actionTypeId:'DOSE', extra:{ids:[], day:ymd(new Date())}}]});
    toast('Test notification in 3 seconds');
  }catch(e){ toast('Could not send a notification.'); }
}

/* ================= Events ================= */
document.addEventListener('click', e=>{
  const rangeBtn = e.target.closest('#hRange .opt');
  if(rangeBtn){ ui.hRange = +rangeBtn.dataset.v; render(); return; }
  const tabBtn = e.target.closest('.tab-btn');
  if(tabBtn){ ui.tab = tabBtn.dataset.tab; render(); $('#main').scrollTop = 0; return; }
  const modeBtn = e.target.closest('.mode-btn');
  if(modeBtn){ setMode(modeBtn.dataset.mode); return; }
  const a = e.target.closest('[data-action]'); if(!a || !a.dataset.action) return;
  const id = a.dataset.id;
  
  switch(a.dataset.action){
    case 'log': openLogSheet({compoundId:id, day:a.dataset.day}); break;
    case 'log-edit': openLogSheet({logId:id}); break;
    case 'skip': if(a.dataset.day) skipDose(id, a.dataset.day); else armButton(a, 'Confirm skip', ()=>skipDose(id)); break;
    case 'compound-add': openCompoundSheet(); break;
    case 'backup-pass': openBackupPassword(); break;
    case 'skip-all': skipAllMissed(id); break;
    case 'cycle-next': closeSheet(); openNextCycleSheet(id); break;
    case 'compound-edit': openCompoundSheet(id); break;
    case 'vial-new': newVial(id); break;
    case 'chart-compound': ui.chartCompound = id; render(); break;
    case 'chart-weeks': ui.chartWeeks = +a.dataset.w; render(); break;
    
    case 'cal-prev': ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth()-1, 1); render(); break;
    case 'cal-next': ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth()+1, 1); render(); break;
    case 'cal-sel': ui.calSel = a.dataset.d; { const d=parseYmd(ui.calSel); if(d.getMonth()!==ui.calMonth.getMonth()) ui.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); } render(); break;
    case 'hist-filter': ui.histFilter = a.dataset.f; render(); break;
    
    
    
    case 'export': exportBackup(); break;
    case 'import': openImport(); break;
    case 'rem-test': testNotification(); break;
    case 'backup-now': backupNow(); break;
    case 'report': openReportSheet(); break;
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    case 'gd-signin': gdSignIn(); break;
    case 'gd-signout': armButton(a, 'Tap again to sign out', gdSignOut); break;
    case 'gd-backup': gdBackup(true); break;
    case 'gd-restore': gdOpenRestore(); break;
    
    
    
    
    case 'app-back': ui.tab = 'setup'; render(); break;
    case 'app-settings': ui.tab = 'app'; render(); $('#main').scrollTop = 0; break;
    
    
    
    case 'unlock': unlock(lock.authing && Date.now() - lock.authStart > 1500); break;
  }
});
document.addEventListener('input', e=>{
  
});
document.addEventListener('change', e=>{
  const t = e.target;
  if(t.id==='setRem') enableReminders(t.checked);
  else if(t.id==='setMorning' && t.value){ db.settings.morning = t.value; save(); }
  else if(t.id==='setNight' && t.value){ db.settings.night = t.value; save(); }
  else if(t.id==='setLock'){ setLockEnabled(t.checked); }
  else if(t.id==='setLockAfter'){ db.settings.lockAfter = +t.value; save(); }
  
  else if(t.id==='setRestNotify'){ db.settings.restNotify = t.checked; save(); }
  else if(t.id==='setSecure'){ db.settings.secureScreen = t.checked; save(); applySecureScreen(); toast(t.checked ? 'Screenshots blocked' : 'Screenshots allowed'); }
  else if(t.id==='setPrivNotif'){ db.settings.privateNotifs = t.checked; save(); toast(t.checked ? 'Reminders will not show names or doses' : 'Reminders show names and doses'); }
  else if(t.id==='setAutoBackup'){ db.settings.autoBackup = t.checked; save(); if(t.checked) backupNow(); }
  else if(t.id==='setWeekly'){ db.settings.weeklyReport = t.checked; save();  toast(t.checked ? 'Weekly report notification on' : 'Weekly report notification off'); }
  
  else if(t.id==='setGdAuto'){ gdCfg().auto = t.checked; save(); if(t.checked) gdBackup(false); }
  
  
  
  else if(t.id==='setLow'){ const n = parseInt(t.value,10); if(n>=0){ db.settings.lowStockDoses = n; save(); } }
});
document.addEventListener('click', e=>{ if(e.target && e.target.matches && e.target.matches('input[type=file]')) suppressLockOnce(); }, true);
/* Tapping a set or template number selects what's there, so typing replaces it. The tap's own
   mouseup would drop the selection again, so it's re-applied after the tap settles. */
const QUICK_EDIT = '.set-in, .tpl-in';
document.addEventListener('focusin', e=>{
  const el = e.target;
  if(el && el.matches && el.matches(QUICK_EDIT)){
    const sel = ()=>{ if(document.activeElement===el){ try{ el.select(); }catch(x){} } };
    sel(); el._qsel = Date.now(); setTimeout(sel, 0); setTimeout(sel, 120);
  }
});
document.addEventListener('mouseup', e=>{
  const el = e.target;
  if(el && el.matches && el.matches(QUICK_EDIT) && el._qsel && Date.now() - el._qsel < 600){ e.preventDefault(); el._qsel = 0; }
}, true);
document.addEventListener('focusin', e=>{
  const el = e.target;
  if(el && el.matches && el.matches('input:not([type=checkbox]):not([type=file]), textarea, select')){
    setTimeout(()=>{ try{ el.scrollIntoView({block:'center', behavior:'smooth'}); }catch(x){} }, 350);
  }
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && sheetOpen) closeSheet(); });
['pointermove','pointerdown'].forEach(ev=>document.addEventListener(ev, e=>{ if(e.target && e.target.id==='levels') chartHover(e); }));
document.addEventListener('pointerleave', e=>{ if(e.target && e.target.id==='levels') { const t=$('#chartTip'); if(t) t.hidden=true; } }, true);
let resizeT; window.addEventListener('resize', ()=>{ clearTimeout(resizeT); resizeT = setTimeout(drawLevels, 120); });
if(window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', ()=>{ drawLevels(); styleStatusBar(); });

/* ================= Native integration ================= */
async function styleStatusBar(){
  const SB = plugin('StatusBar'); if(!SB) return;
  const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  try{
    await SB.setStyle({style: dark ? 'DARK' : 'LIGHT'});
    await SB.setBackgroundColor({color: dark ? '#111315' : '#F2F1EC'});
  }catch(e){}
}
function initNative(){
  if(!isNative) return;
  const App = plugin('App'), LN = plugin('LocalNotifications');
  styleStatusBar();
  if(App){
    App.addListener('backButton', ()=>{
      if(lock.locked) return App.minimizeApp ? App.minimizeApp() : App.exitApp();
      if(sheetOpen) return closeSheet();
      if(ui.tplEdit){ ui.tplEdit = null; return render(); }
      if(ui.tab==='app'){ ui.tab = 'setup'; return render(); }
      const first = FIRST_TAB[ui.mode] || 'today';
      if(ui.tab!==first){ ui.tab = first; return render(); }
      App.minimizeApp ? App.minimizeApp() : App.exitApp();
    });
    // day may have changed while in the background
    App.addListener('pause', onAppPause);
    App.addListener('resume', ()=>{ onAppResume(); if(!sheetOpen) render(); scheduleReminders(); scheduleAutoBackup();  setTimeout(()=>gdBackup(false), 3000); });
  }
  if(LN){
    
    LN.createChannel && LN.createChannel({id:'doses', name:'Dose reminders', description:'Reminders on scheduled injection days', importance:4, visibility:0, vibration:true}).catch(()=>{});
    LN.registerActionTypes && LN.registerActionTypes({types:[{id:'DOSE', actions:[
      {id:'log', title:'Log now', foreground:true},
      {id:'snooze', title:'Snooze 1 h', foreground:true}
    ]}]}).catch(()=>{});
    LN.addListener('localNotificationActionPerformed', handleNotificationAction);
  }
}

/* A new day while the app stays open: refresh what's due and the reminders. */
let lastDayKey = ymd(new Date());
setInterval(()=>{
  const k = ymd(new Date());
  if(k !== lastDayKey){ lastDayKey = k; if(!sheetOpen) render(); scheduleReminders(); }
}, 60000);

/* ================= Boot ================= */
/* Screenshots and the recent-apps preview are blocked when asked for, and always while the app lock is on
   (otherwise the preview would show the data the lock is hiding). */
function applySecureScreen(){
  const L = isNative ? plugin('AppLock') : null;
  if(L) L.setSecure({enabled: !!(db.settings.secureScreen || db.settings.lockEnabled)}).catch(()=>{});
}
/* Shared backups and reports are written to the cache for the share sheet; clear old ones on start. */
async function cleanShareCache(){
  const FS = isNative ? plugin('Filesystem') : null; if(!FS) return;
  try{
    const r = await FS.readdir({path:'', directory:'CACHE'});
    for(const f of (r.files||[])){
      const n = typeof f==='string' ? f : f.name;
      if(/\.(json|pdf)$/i.test(n) && /backup|report|ets-|injection-tracker/i.test(n)) { try{ await FS.deleteFile({path:n, directory:'CACHE'}); }catch(e){} }
    }
  }catch(e){}
}
load().then(async ()=>{
  
  applySecureScreen();
  setTimeout(cleanShareCache, 5000);
  if(lockOn()){
    showLock();
    setTimeout(unlock, 250);
  }
  syncDoses();
  if(db.settings.mode==='train' || db.settings.mode==='health'){ ui.mode = db.settings.mode; ui.tab = FIRST_TAB[ui.mode]; }
  
  render();
  initNative();
  
  scheduleReminders();
  scheduleAutoBackup();
  
  setTimeout(()=>gdBackup(false), 6000);
  
  rawSet(STORE_KEY, JSON.stringify(db)); // persist any migration
});

// expose for debugging in dev tools
window.__injtrack = { get db(){ return db; }, cycleState, addDays, ymd, gdBackup, timeline, statusFor, occurrences, handleNotificationAction, quickLog, buildReport, loadJsPdf, reportData,
   };
})();
