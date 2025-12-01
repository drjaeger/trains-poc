// Train POC frontend
// Fetch graph, list stations, open websocket, and estimate time-to-pass

// This frontend relies on websocket messages for station and schedule data.
// Connect directly to the upstream websocket.
const WS_URL = 'wss://trainmap.pv.lv/ws';

const el = {
  stationSelect: document.getElementById('stationSelect'),
  status: document.getElementById('status'),
  predictions: document.getElementById('predictions'),
  stationsUpdated: document.getElementById('stationsUpdated')
};

// Lightweight logger: keep a small in-memory buffer and log to console only.
const debugBuffer = [];
function log(...args){
  try{
    const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    debugBuffer.push({ t: Date.now(), msg: text });
    if (debugBuffer.length > 100) debugBuffer.shift();
    console.log(...args);
  } catch (e) { console.log('log err', e); }
}
// Expose buffer for manual inspection: `window._debugBuffer`
window._debugBuffer = debugBuffer;

// Haversine distance (meters)
function haversine([lat1,lon1],[lat2,lon2]){
  const R = 6371000;
  const toRad = d => d*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

// Bearing from a->b (degrees)
function bearing([lat1,lon1],[lat2,lon2]){
  const toRad = d => d*Math.PI/180;
  const toDeg = r => r*180/Math.PI;
  const y = Math.sin(toRad(lon2-lon1))*Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
  return (toDeg(Math.atan2(y,x))+360)%360;
}

function angleDiff(a,b){
  let d = Math.abs(a-b)%360;
  if(d>180) d = 360-d;
  return d;
}

let stations = []; // {id,name,lat,lon}
let selectedStation = null;
let trains = new Map(); // id -> {prev:{lat,lon,t}, curr:{lat,lon,t}, speed}
let schedules = new Map(); // trainId -> {trainId, stops: [{pvID,id,title,departure,coords}]}
let countdownTimer = null;
let nextUp = [];
let pendingStations = null;

// Restore stations from localStorage (if present) so the UI isn't empty before WS arrives
function restoreStationsFromStorage(){
  try{
    const raw = localStorage.getItem('stations');
    if(raw){
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed) && parsed.length){
        stations = parsed;
        // populate selector
        el.stationSelect.innerHTML = stations.map(s=>`<option value="${s.id}">${s.name}</option>`).join('\n');
        try{ const stored = localStorage.getItem('selectedStationId'); if(stored){ const found = stations.find(x=>String(x.id)===String(stored)); if(found) selectedStation = found; } }catch(e){}
        if(!selectedStation && stations.length) selectedStation = stations[0];
        if(selectedStation) el.stationSelect.value = String(selectedStation.id);
        try{ el.stationsUpdated.textContent = new Date().toLocaleString(); }catch(e){}
      }
    }
  }catch(e){ /* ignore */ }
  el.stationSelect.addEventListener('change', ()=>{
    const id = el.stationSelect.value;
    selectedStation = stations.find(s=>String(s.id)===String(id));
    try{ localStorage.setItem('selectedStationId', String(selectedStation.id)); }catch(e){}
    renderPredictions();
  });
  // apply pending stations update when user finishes interacting with the select
  el.stationSelect.addEventListener('blur', ()=>{
    if(pendingStations){
      stations = pendingStations;
      pendingStations = null;
      try{ localStorage.setItem('stations', JSON.stringify(stations)); }catch(e){}
      // refresh selector preserving selection
      try{
        el.stationSelect.innerHTML = stations.map(s=>`<option value="${s.id}">${s.name}</option>`).join('\n');
        try{ const stored = localStorage.getItem('selectedStationId'); if(stored){ const found = stations.find(x=>String(x.id)===String(stored)); if(found) selectedStation = found; } }catch(e){}
        if(!selectedStation && stations.length) selectedStation = stations[0];
        if(selectedStation) el.stationSelect.value = String(selectedStation.id);
      }catch(e){}
      try{ el.stationsUpdated.textContent = new Date().toLocaleString(); }catch(e){}
      renderPredictions();
    }
  });
}

function connectWS(){
  el.status.textContent = 'Connecting websocket...';
  const ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    el.status.textContent = 'WS open';
    log('ws open');
  });

  ws.addEventListener('message', ev => {
    let msg = ev.data;
    try { msg = JSON.parse(ev.data); } catch (e) { /* not JSON - ignore */ }
    handleWSMessage(msg);
  });

  ws.addEventListener('close', () => {
    el.status.textContent = 'WS closed — retrying in 5s';
    setTimeout(connectWS, 5000);
  });

  ws.addEventListener('error', e => log('ws error', e));
}

function handleWSMessage(msg){
  log('ws', msg);

  // If this is an "active-stops" message, populate stations from it
  try {
    const isActiveStops = msg && (msg.type === 'active-stops' || msg.event === 'active-stops' || msg['active-stops']);
    if (!isActiveStops) { /* not active-stops */ }
    else {
      const arr = msg.data || msg.stops || msg['active-stops'] || msg;
      if (!Array.isArray(arr)) return;
      const map = new Map();
      for (const s of arr) {
        const id = s.id ?? s.pvID ?? s.gps_id ?? s._id ?? s.i ?? s.stopIndex ?? s.routes_id;
        const name = s.title ?? s.name ?? s.adress ?? s.address ?? s.title;
        const lat = Number((s.coords && s.coords[0]) ?? (s.animatedCoord && s.animatedCoord[0]));
        const lon = Number((s.coords && s.coords[1]) ?? (s.animatedCoord && s.animatedCoord[1]));
        if (!id || Number.isNaN(lat) || Number.isNaN(lon)) continue;
        const key = String(id);
        if (!map.has(key)) map.set(key, { id: key, name: name ?? key, lat, lon });
      }

      // preserve the user's actual dropdown value if present
      const prevSelectValue = el.stationSelect && el.stationSelect.value ? String(el.stationSelect.value) : null;
      const prevSelectedId = selectedStation ? String(selectedStation.id) : null;
      stations = Array.from(map.values());
      try { localStorage.setItem('stations', JSON.stringify(stations)); } catch (e) { /* ignore */ }

      // If the user is interacting with the select, defer the DOM update until blur
      if (document.activeElement === el.stationSelect) {
        pendingStations = stations;
        el.status.textContent = 'Stations update pending — dropdown open';
        return;
      }

      // Update the DOM options
      el.stationSelect.innerHTML = stations.length
        ? stations.map(x => `<option value="${x.id}">${x.name}</option>`).join('\n')
        : '<option>(no stations)</option>';

      // Restore selection: priority = prevSelectValue, prevSelectedId, localStorage, name match, fallback first
      let restored = false;
      if (prevSelectValue) {
        const opt = Array.from(el.stationSelect.options).find(o => o.value === String(prevSelectValue));
        if (opt) { el.stationSelect.value = String(prevSelectValue); selectedStation = stations.find(s => String(s.id) === String(prevSelectValue)); restored = true; }
      }
      if (!restored && prevSelectedId) {
        const opt = Array.from(el.stationSelect.options).find(o => o.value === String(prevSelectedId));
        if (opt) { el.stationSelect.value = String(prevSelectedId); selectedStation = stations.find(s => String(s.id) === String(prevSelectedId)); restored = true; }
      }
      if (!restored) {
        try {
          const stored = localStorage.getItem('selectedStationId');
          if (stored) {
            const opt2 = Array.from(el.stationSelect.options).find(o => o.value === String(stored));
            if (opt2) { el.stationSelect.value = String(stored); selectedStation = stations.find(s => String(s.id) === String(stored)); restored = true; }
          }
        } catch (e) { /* ignore */ }
      }
      if (!restored) {
        try {
          const currentName = selectedStation && selectedStation.name ? selectedStation.name : null;
          if (currentName) {
            const opt3 = Array.from(el.stationSelect.options).find(o => o.text === currentName || o.text === String(currentName));
            if (opt3) { el.stationSelect.value = opt3.value; selectedStation = stations.find(s => String(s.id) === String(opt3.value)); restored = true; }
          }
        } catch (e) { /* ignore */ }
      }
      if (!restored && stations.length && !selectedStation) { selectedStation = stations[0]; el.stationSelect.value = String(selectedStation.id); }

      el.status.textContent = 'Stations updated from WS (active-stops)';
      try { el.stationsUpdated.textContent = new Date().toLocaleString(); } catch (e) { /* ignore */ }
      renderPredictions();
      return;
    }
  } catch (e) {
    log('active-stops handling error', e);
  }

  // If this is a `back-end` message containing schedules, update schedules store
  try{
    const isBack = msg && (msg.type === 'back-end' || msg.event === 'back-end');
    if(isBack){
      const arr = msg.data || msg.trains || msg.returnValue || [];
      if(Array.isArray(arr)){
        for(const item of arr){
          // back-end structure often contains returnValue.stopObjArray
          const trainId = item.returnValue?.train ?? item.train ?? item.trainId ?? item.id ?? item.tid;
          const stopArray = item.returnValue?.stopObjArray || item.stopObjArray || item.stops || item.data || [];
          if(!trainId || !Array.isArray(stopArray)) continue;
          const stops = stopArray.map(s => ({
            pvID: s.pvID ?? String(s.pvID ?? s.id ?? s.gps_id ?? s.routes_id ?? ''),
            id: s.id ?? s._id ?? s.pvID ?? '',
            title: s.title ?? s.name ?? '',
            departure: s.departure ?? s.arrival ?? null,
            coords: (s.coords && Array.isArray(s.coords)) ? [Number(s.coords[0]), Number(s.coords[1])] : (s.animatedCoord && Array.isArray(s.animatedCoord)) ? [Number(s.animatedCoord[0]), Number(s.animatedCoord[1])] : null
          })).filter(x=>x.title && x.departure);
          schedules.set(String(trainId), { trainId: String(trainId), stops });
        }
        log('schedules updated', schedules.size);
        renderPredictions();
      }
      // and continue — may also include position updates in same message
    }
  }catch(e){ log('back-end handling error', e); }

  // Try a few shapes: array of trains, object with trains, or single train
  let updates = [];
  if(Array.isArray(msg)) updates = msg;
  else if(msg.trains) updates = msg.trains;
  else if(msg.train) updates = [msg.train];
  else if(msg.type && msg.type === 'position' && msg.data) updates = [msg.data];
  else if(msg.id && (msg.lat || msg.latitude || msg.y)) updates = [msg];

  if(!updates.length) return;

  const now = Date.now()
  for(const u of updates){
    const id = u.id ?? u.trainId ?? u.tid ?? u.name ?? u.uid;
    const lat = Number(u.lat ?? u.latitude ?? u.y ?? u[1]);
    const lon = Number(u.lon ?? u.longitude ?? u.x ?? u[0]);
    const t = (u.ts || u.timestamp || u.time || Date.now()/1000) * ((u.ts||u.timestamp||u.time) ? 1e3 : 1); // normalize to ms
    if(!id || Number.isNaN(lat) || Number.isNaN(lon)) continue;
    const prevEntry = trains.get(id);
    if(prevEntry && prevEntry.curr){
      prevEntry.prev = prevEntry.curr;
    }
    const curr = {lat,lon,t: t || now};
    const entry = prevEntry || {};
    entry.curr = curr;
    // compute speed
    if(entry.prev){
      const dt = (entry.curr.t - entry.prev.t)/1000;
      if(dt>0){
        const d = haversine([entry.prev.lat,entry.prev.lon],[entry.curr.lat,entry.curr.lon]);
        entry.speed = d/dt; // m/s
        entry.heading = bearing([entry.prev.lat,entry.prev.lon],[entry.curr.lat,entry.curr.lon]);
      }
    }
    trains.set(id, entry);
  }
  renderPredictions();
}

function renderPredictions(){
  if(!selectedStation){ el.predictions.textContent = '(no station)'; updateCountdown(); return; }
  const now = Date.now();
  // Find upcoming stops from schedules for this station
  const candidates = [];
  const stationId = String(selectedStation.id);
  function parseDateString(s){
    if(!s) return null;
    const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if(m){
      const [,Y,Mo,D,H,Mi,Ss] = m;
      const year = Number(Y), month = Number(Mo)-1, day = Number(D), hour = Number(H), minute = Number(Mi), second = Ss ? Number(Ss) : 0;
      const dt = new Date(year, month, day, hour, minute, second).getTime();
      if(!Number.isNaN(dt)) return dt;
    }
    const p = Date.parse(s);
    return Number.isNaN(p) ? null : p;
  }
  for(const sched of schedules.values()){
    for(const st of sched.stops){
      // match by pvID or id or title
      if(String(st.pvID) === stationId || String(st.id) === stationId || (selectedStation.name && st.title && st.title === selectedStation.name)){
        if(!st.departure) continue;
        const ts = parseDateString(st.departure);
        if(!ts) continue;
        const dt = Math.round((ts - now)/1000);
        // only future arrivals
        if(dt <= 0) continue;
        candidates.push({train: sched.trainId, title: st.title, departure: ts, dt});
      }
    }
  }
  // sort by nearest time
  candidates.sort((a,b)=>a.departure - b.departure);
  nextUp = candidates.slice(0,3);
  if(!nextUp.length){ el.predictions.textContent = '(no upcoming trains)'; updateCountdown(); return; }
  // render list
  el.predictions.innerHTML = nextUp.map(n=>{
    const d = new Date(n.departure);
    const inSec = Math.max(0, Math.round((n.departure - now)/1000));
    return `<div class="train"><strong>${n.train}</strong>: ${formatETA(inSec)} — ${d.toLocaleString()}</div>`;
  }).join('\n');
  updateCountdown();
}

function formatETA(sec){
  if(sec<60) return `${sec}s`;
  const m = Math.floor(sec/60); const s = sec%60; return `${m}m ${s}s`;
}

(function(){
  restoreStationsFromStorage();
  connectWS();
})();

function updateCountdown(){
  const elc = document.getElementById('countdown');
  if(!elc) return;
  if(!nextUp || !nextUp.length){ elc.textContent = '–'; return; }
  if(countdownTimer) clearInterval(countdownTimer);
  const tick = ()=>{
    const now = Date.now();
    const next = nextUp[0];
    const sec = Math.max(0, Math.round((next.departure - now)/1000));
    elc.textContent = formatETA(sec);
    if(sec<=0){
      // refresh predictions when arrival passes
      renderPredictions();
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}




