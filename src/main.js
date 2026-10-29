import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
function readStoredJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.error(`Unable to read ${key} from local storage`, error);
    return fallback;
  }
}
function readStoredObject(key, fallback) {
  const value = readStoredJson(key, fallback);
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...fallback, ...value } : { ...fallback };
}
function readStoredReports() {
  const value = readStoredJson('ta-reports', []);
  return Array.isArray(value) ? value.filter(report => report && typeof report === 'object' && typeof report.id === 'string') : [];
}
function readTimingFeedback() {
  const value = readStoredObject('ta-checkpoint-feedback', { offsetMinutes: 0, responses: {} });
  const offset = Number(value.offsetMinutes);
  return {
    ...value,
    offsetMinutes: Number.isFinite(offset) ? Math.max(-15, Math.min(15, offset)) : 0,
    responses: value.responses && typeof value.responses === 'object' && !Array.isArray(value.responses) ? value.responses : {}
  };
}
const store = {
  page: 'route', mapCenter: null, activeAlert: null, severityFilter: 'all',
  pilotProfile: readStoredJson('ta-demo-pilot-profile', null),
  pilotSession: readStoredJson('ta-demo-session', null),
  authMode: readStoredJson('ta-demo-pilot-profile', null) ? 'login' : 'signup',
  authPending: null,
  flight: readStoredJson('ta-active-flight', null),
  factors: new Set(['Location', 'Altitude', 'Weather Pattern', 'Season']),
  layers: readStoredObject('ta-layers', { weather: true, routeExperiences: true, weatherProxy: true, jet: true }),
  notificationEnabled: typeof Notification !== 'undefined' && Notification.permission === 'granted',
  settings: readStoredObject('ta-settings', { '30 minute advisory': true, '10 minute warning': true, '5 minute immediate': true, 'UTC time display': true, 'Share anonymized reports': true }),
  timingFeedback: readTimingFeedback(),
  reports: readStoredReports(),
  weatherProxyTarget: null,
  completedWeatherTargetIds: new Set(),
  weatherProxyLoaded: false,
  weatherProxyError: false,
  alertRegionReached: false,
  cases: [
    { id:'c1', severity:'Moderate to Severe', level:'high', date:'2023-07-14 12:30 UTC', place:'Arabian Sea', coord:'12.5°N, 68.1°E', lat:12.5, lon:68.1, aircraft:'Boeing 787', quote:'Moderate to severe chop, sudden onset. Lasted about 10–15 minutes. Associated with convective activity.', tags:['Convective Clouds','Wind Shear'] },
    { id:'c2', severity:'Moderate', level:'moderate', date:'2022-11-03 09:10 UTC', place:'Arabian Sea', coord:'13.2°N, 66.8°E', lat:13.2, lon:66.8, aircraft:'Airbus A350', quote:'Moderate turbulence, continuous light to moderate chop. No significant deviation required.', tags:['Jet Stream','Upper Level Winds'] },
    { id:'c3', severity:'Moderate', level:'moderate', date:'2021-08-22 14:45 UTC', place:'Near ALPOR', coord:'14.1°N, 65.3°E', lat:14.1, lon:65.3, aircraft:'Boeing 777', quote:'Moderate turbulence for around 8 minutes. Likely due to convective build-up in the area.', tags:['Convective Activity','Humidity'] },
    { id:'c4', severity:'Light', level:'low', date:'2020-05-18 16:20 UTC', place:'Laccadive Sea', coord:'11.8°N, 72.4°E', lat:11.8, lon:72.4, aircraft:'Boeing 787', quote:'Light chop above cloud tops. Smooth conditions returned after a small altitude change.', tags:['Clear Air Turbulence'] },
  ],
  get allCases(){ return [...this.reports, ...this.cases]; }
};
const pageIds = ['route', 'insights', 'report', 'settings'];
const requestedPage = window.location.pathname.replace(/^\/+|\/+$/g, '');
if (pageIds.includes(requestedPage)) store.page = requestedPage;
let routeMap = null;
let aircraftMarker = null;
let positionReadout = null;
let flownRoute = null;
let checkpointMapMarkers = [];
let routeTimingMapMarkers = [];
let pirepRegionModelPromise = null;
let weatherProxyModelPromise = null;
let insightsWeatherProxyPromise = null;
let alertTargetMarker = null;
let weatherProxyLayerRef = null;
const airports = {
  DOH: { name: 'Doha, Qatar', lat: 25.273, lon: 51.608 },
  COK: { name: 'Kochi, India', lat: 10.152, lon: 76.401 },
  DXB: { name: 'Dubai, UAE', lat: 25.253, lon: 55.366 },
  AUH: { name: 'Abu Dhabi, UAE', lat: 24.433, lon: 54.651 },
  BOM: { name: 'Mumbai, India', lat: 19.089, lon: 72.868 },
  DEL: { name: 'Delhi, India', lat: 28.556, lon: 77.100 },
  BLR: { name: 'Bengaluru, India', lat: 13.199, lon: 77.706 },
  MAA: { name: 'Chennai, India', lat: 12.994, lon: 80.170 },
  SIN: { name: 'Singapore', lat: 1.364, lon: 103.992 },
  HKG: { name: 'Hong Kong', lat: 22.308, lon: 113.918 },
  ICN: { name: 'Seoul, South Korea', lat: 37.460, lon: 126.441 },
  NRT: { name: 'Tokyo, Japan', lat: 35.772, lon: 140.392 },
  PEK: { name: 'Beijing, China', lat: 40.080, lon: 116.584 },
  PVG: { name: 'Shanghai, China', lat: 31.144, lon: 121.808 }
};
const defaultFlight = {
  callsign: 'QTR532',
  aircraft: 'Boeing 787-9 Dreamliner',
  origin: 'DOH',
  destination: 'COK',
  altitude: 350,
  cruiseSpeedKmh: 890
};
const aircraftStart = { lat: airports.DOH.lat, lon: airports.DOH.lon, timestamp: Date.now() };
const destination = { lat: airports.COK.lat, lon: airports.COK.lon };
let flightSpeedKmh = defaultFlight.cruiseSpeedKmh;
if (activeFlightIsValid(store.flight)) {
  const savedFlight = store.flight;
  store.flight = { ...defaultFlight, ...savedFlight };
  applyFlightConfig(store.flight, false);
}
const demoOtp = '123456';
const ranks = ['First Officer', 'Senior First Officer', 'Captain', 'Training Captain'];
const weatherProxyCacheKey = 'ta-weather-proxy-cache-v2';
const weatherProxyCacheDuration = 30 * 60 * 1000;
const weatherProxyCellSize = 3;
const weatherProxyAreas = [
  { south: 12, north: 30, west: 42, east: 66 },
  { south: 6, north: 36, west: 66, east: 99 },
  { south: 18, north: 54, west: 75, east: 135 },
  { south: 27, north: 51, west: 123, east: 150 },
  { south: 25, north: 49, west: -125, east: -65, cellSize: 4 }
];
const checkpointDefinitions = [
  { id: 'checkpoint-30', leadMinutes: 30, name: 'Assess weather conditions', action: 'Assess wind, atmosphere, and groundspeed before the predicted region.' },
  { id: 'checkpoint-10', leadMinutes: 10, name: 'Prepare for turbulence', action: 'Prepare for the forecast turbulence region and review the current conditions.' },
  { id: 'checkpoint-5', leadMinutes: 5, name: 'Heightened turbulence caution', action: 'Use heightened caution as the aircraft approaches the selected region.' }
];
const checkpoints = checkpointDefinitions.map(checkpoint => {
  return { ...checkpoint, triggered: false, acknowledged: false };
});
const routeTimingCheckpoints = [0.25, 0.5, 0.75].map((fraction, index) => ({
  id: `route-timing-${index + 1}`,
  fraction,
  name: `Route timing checkpoint ${index + 1}`,
  triggered: false,
  acknowledged: false
}));
const icons = {route:'⌁', insights:'◉', report:'▤', settings:'⚙', plane:'✈', pin:'⌖', clock:'◷'};
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}
function pilotIsAuthenticated() {
  return Boolean(store.pilotSession?.authenticated && store.pilotProfile?.phone &&
    store.pilotSession.phone === store.pilotProfile.phone);
}
function activeFlightIsValid(flight) {
  return Boolean(
    flight && typeof flight.callsign === 'string' && flight.callsign.trim() &&
    typeof flight.aircraft === 'string' && flight.aircraft.trim() &&
    airports[flight.origin] && airports[flight.destination] && flight.origin !== flight.destination &&
    Number.isFinite(Number(flight.altitude)) && Number(flight.altitude) >= 100 && Number(flight.altitude) <= 450 &&
    Number.isFinite(Number(flight.cruiseSpeedKmh)) && Number(flight.cruiseSpeedKmh) >= 300 && Number(flight.cruiseSpeedKmh) <= 1100
  );
}
function applyFlightConfig(flight, resetPosition = true) {
  store.flight = {
    ...flight,
    callsign: flight.callsign.trim().toUpperCase(),
    altitude: Number(flight.altitude),
    cruiseSpeedKmh: Number(flight.cruiseSpeedKmh)
  };
  const origin = airports[store.flight.origin];
  const arrival = airports[store.flight.destination];
  Object.assign(aircraftStart, { lat: origin.lat, lon: origin.lon });
  Object.assign(destination, { lat: arrival.lat, lon: arrival.lon });
  flightSpeedKmh = store.flight.cruiseSpeedKmh;
  if (resetPosition) {
    aircraftStart.timestamp = Date.now();
    store.flightPosition = flightPositionAt();
    store.previousFlightPosition = store.flightPosition;
  }
}
function airportOptions(selected) {
  return Object.entries(airports).map(([code, airport]) =>
    `<option value="${code}" ${code === selected ? 'selected' : ''}>${code} · ${escapeHtml(airport.name)}</option>`
  ).join('');
}
function brandMark() {
  return '<div class="brand"><div class="brand-icon">✈</div><div><div class="brand-name">Turbulence<span>Alert</span></div><div class="brand-sub">EXPERIENCE-BASED TURBULENCE RECOGNITION</div></div></div>';
}
function accessPage() {
  const pending = store.authPending;
  const signup = store.authMode === 'signup';
  return `<main class="access-card">
    ${brandMark()}
    <div class="eyebrow">PILOT ACCESS · PROTOTYPE</div>
    <h1>${pending ? 'Verify your phone' : 'Your flight-deck workspace'}</h1>
    <p class="access-intro">${pending ? `Enter the demo code sent to ${escapeHtml(pending.phone)}.` : 'Sign in or create a pilot profile to set up an active flight and open the EFB tools.'}</p>
    <div class="prototype-notice"><strong>Prototype verification only</strong><span>No SMS is sent and this local demo is not real authentication. Demo OTP: <b>${demoOtp}</b></span></div>
    ${pending ? `<form id="otp-form" class="access-form"><label>6-digit demo OTP<input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="Enter ${demoOtp}" required autofocus></label><p class="form-error" id="auth-error" role="alert"></p><button class="primary-button" type="submit">Verify &amp; continue</button><button class="text-button" type="button" data-action="otp-back">Change phone number</button></form>` : `
    <div class="access-tabs"><button type="button" data-auth-mode="login" class="${!signup?'selected':''}">Log in</button><button type="button" data-auth-mode="signup" class="${signup?'selected':''}">Create pilot account</button></div>
    <form id="auth-form" class="access-form">
      ${signup ? `<label>Full name<input name="fullName" autocomplete="name" maxlength="80" placeholder="e.g. Aisha Rahman" required></label>
      <div class="access-fields"><label>Pilot rank<select name="rank" required>${ranks.map(rank=>`<option>${rank}</option>`).join('')}</select></label><label>Airline<input name="airline" maxlength="80" placeholder="e.g. Qatar Airways" required></label></div>
      <label>Country base<input name="country" maxlength="60" autocomplete="country-name" placeholder="e.g. Qatar" required></label>` : ''}
      <label>Phone number<input name="phone" type="tel" autocomplete="tel" inputmode="tel" minlength="7" maxlength="20" placeholder="+974 5555 1234" required></label>
      <p class="form-error" id="auth-error" role="alert"></p>
      <button class="primary-button" type="submit">Send demo OTP</button>
    </form>
    <p class="access-footnote">Flight setup and all app sections remain locked until you verify and configure a flight.</p>`}
  </main>`;
}
function flightSetupPage() {
  const flight = activeFlightIsValid(store.flight) ? store.flight : defaultFlight;
  const profile = store.pilotProfile;
  return `<main class="setup-card">
    <div class="setup-head">${brandMark()}<button class="text-button" type="button" data-action="sign-out">Sign out</button></div>
    <div class="eyebrow">REQUIRED BEFORE FLIGHT TOOLS</div><h1>Set up your active flight</h1>
    <p class="access-intro">Confirm the aircraft and planned route. This information drives the live map, telemetry, region timing, alerts, checkpoints, and report defaults.</p>
    <div class="pilot-summary"><span class="live-dot"></span><strong>${escapeHtml(profile?.fullName || 'Pilot')}</strong><span>${escapeHtml(profile?.rank || 'Pilot')} · ${escapeHtml(profile?.airline || 'Airline not set')} · ${escapeHtml(profile?.country || 'Base not set')}</span></div>
    <form id="flight-setup-form" class="flight-setup-form">
      <div class="setup-section-title"><span>01</span><div><strong>Flight identification</strong><small>Call sign and aircraft configuration</small></div></div>
      <div class="setup-fields"><label>Flight call sign<input name="callsign" maxlength="12" value="${escapeHtml(flight.callsign)}" placeholder="e.g. QTR532" required></label>
      <label>Aircraft model<select name="aircraft" required>${['Boeing 787-9 Dreamliner','Airbus A350-900','Boeing 777-300ER','Airbus A321neo','Other / enter in notes'].map(model=>`<option ${flight.aircraft===model?'selected':''}>${model}</option>`).join('')}</select></label></div>
      <div class="setup-section-title"><span>02</span><div><strong>Planned route</strong><small>Choose departure and destination airports</small></div></div>
      <div class="setup-fields"><label>Departure airport<select name="origin" required>${airportOptions(flight.origin)}</select></label><label>Destination airport<select name="destination" required>${airportOptions(flight.destination)}</select></label></div>
      <div class="setup-section-title"><span>03</span><div><strong>Cruise profile</strong><small>Used for aircraft movement and alert lead-time estimates</small></div></div>
      <div class="setup-fields three"><label>Cruise altitude<div class="setup-input-unit"><span>FL</span><input name="altitude" type="number" min="100" max="450" step="10" value="${escapeHtml(flight.altitude)}" required></div></label>
      <label>Planned cruise speed<div class="setup-input-unit"><input name="cruiseSpeedKmh" type="number" min="300" max="1100" step="1" value="${escapeHtml(flight.cruiseSpeedKmh)}" required><span>KM/H</span></div></label>
      <div class="setup-estimate"><span>PROFILE CHECK</span><strong>Map &amp; alerts use these values</strong><small>Speed is groundspeed proxy for this prototype.</small></div></div>
      <p class="form-error" id="flight-setup-error" role="alert"></p>
      <button class="primary-button" type="submit">Confirm flight &amp; open EFB</button>
      <p class="access-footnote">Prototype telemetry is simulated. Review approved operational sources and company procedures; this app is not certified for flight operations.</p>
    </form>
  </main>`;
}
function fmtClock(){const utc=store.settings['UTC time display']!==false;return new Intl.DateTimeFormat('en-GB',{...(utc?{timeZone:'UTC'}:{}),hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date())+(utc?' UTC':' LT')}
function header(){return `<header class="topbar"><div class="brand"><div class="brand-icon">✈</div><div><div class="brand-name">Turbulence<span>Alert</span></div><div class="brand-sub">EXPERIENCE-BASED TURBULENCE RECOGNITION</div></div></div><div class="top-status"><span class="live-dot"></span> LIVE TELEMETRY <span class="divider"></span><span id="clock">${fmtClock()}</span><span class="divider"></span><span class="battery">▰ 100%</span></div></header><nav class="nav">${[['route','Route'],['insights','Insights'],['report','Report']].map(([id,label])=>`<button class="nav-item ${store.page===id?'active':''}" data-page="${id}"><span>${icons[id]}</span>${label}${id==='insights'&&store.reports.length?`<i class="count">${store.reports.length}</i>`:''}</button>`).join('')}<div class="nav-spacer"></div><button class="nav-item settings" data-page="settings"><span>⚙</span>Settings</button></nav>`}
function planeMap(){return `<section class="map-card"><div class="map-head"><div><div class="eyebrow">LIVE FLIGHT TRACKING <span class="map-live">● LIVE</span></div><h2>Route &amp; turbulence risk</h2></div><button class="layer-button" data-action="layers">☷ <span>Map layers</span> <span class="chevron">⌄</span></button></div><div class="map-wrap"><svg class="map-svg" viewBox="0 0 900 430" role="img" aria-label="Flight route map from Doha to Kochi with turbulence areas"><defs><linearGradient id="sea" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#122d40"/><stop offset=".55" stop-color="#0c2637"/><stop offset="1" stop-color="#102e3a"/></linearGradient><radialGradient id="hot"><stop stop-color="#ff4d31" stop-opacity=".86"/><stop offset=".4" stop-color="#ff9e23" stop-opacity=".68"/><stop offset=".7" stop-color="#ffd83d" stop-opacity=".35"/><stop offset="1" stop-color="#39d89c" stop-opacity="0"/></radialGradient><filter id="blur"><feGaussianBlur stdDeviation="12"/></filter></defs><rect width="900" height="430" fill="url(#sea)"/><g class="gridlines"><path d="M0 86H900M0 172H900M0 258H900M0 344H900M150 0V430M300 0V430M450 0V430M600 0V430M750 0V430"/></g><path class="land" d="M0 0H363L341 42 319 63 310 99 292 119 277 140 260 155 232 165 211 177 197 197 187 217 177 229 145 229 127 241 107 236 94 224 82 209 62 191 50 173 33 162 0 159Z"/><path class="land" d="M900 430H645L652 407 665 387 676 360 689 340 697 317 715 299 729 280 742 256 751 232 769 217 780 196 794 177 805 153 823 129 835 102 850 78 865 58 881 31 900 20Z"/><path class="coast" d="M363 0 341 42 319 63 310 99 292 119 277 140 260 155 232 165 211 177 197 197 187 217 177 229 145 229 127 241 107 236 94 224 82 209"/><path class="coast" d="M645 430 652 407 665 387 676 360 689 340 697 317 715 299 729 280 742 256 751 232 769 217 780 196 794 177 805 153 823 129 835 102"/><g class="terrain"><path d="M25 20 70 11 101 39 92 71 47 84 18 64zM130 33l63-18 45 35-27 43-62 8-26-32zM222 12l58 9 33 33-44 37-58-29zM730 326l51-14 43 28-20 45-54 9-31-30zM778 267l53-24 40 28-16 40-57 12-30-29z"/></g><g id="weather-layer" class="weather-layer"><ellipse cx="425" cy="160" rx="124" ry="75" fill="url(#hot)" filter="url(#blur)"/><ellipse cx="599" cy="252" rx="114" ry="84" fill="url(#hot)" filter="url(#blur)"/><ellipse cx="745" cy="130" rx="95" ry="60" fill="url(#hot)" filter="url(#blur)"/><path class="isobar" d="M357 165q64-74 143-21t-17 77q-85 24-126-56m203 87q67-76 136-30t-6 93q-79 21-130-26"/></g><g id="jet-layer" class="jet-layer"><path d="M185 95C340 25 530 43 715 88"/><text x="475" y="53">JET STREAM  ·  90 KT</text></g><g class="route-line"><path d="M160 146 C355 170 564 244 751 305"/><path d="M160 146 C355 170 564 244 751 305" class="route-glow"/></g><g class="airport"><circle cx="160" cy="146" r="7"/><text x="111" y="133">DOH</text></g><g class="airport"><circle cx="751" cy="305" r="7"/><text x="764" y="322">COK</text></g><g class="waypoint"><circle cx="532" cy="235" r="5"/><text x="540" y="229">ALPOR</text></g><g class="aircraft-marker" id="aircraft-marker" transform="translate(432 221) rotate(20)"><circle r="22"/><text y="8">✈</text></g><g class="pirep-layer"><g class="pirep" transform="translate(410 137)"><circle r="11"/><text y="4">!</text></g><g class="pirep" transform="translate(627 266)"><circle r="11"/><text y="4">!</text></g><g class="pirep" transform="translate(303 193)"><circle r="11"/><text y="4">!</text></g></g><g class="map-labels"><text x="370" y="324">ARABIAN SEA</text><text x="42" y="122">QATAR</text><text x="748" y="376">KERALA</text><text x="285" y="255">12° N</text><text x="524" y="175">14° N</text></g><g class="map-marker-layer" id="encounter-marker"></g></svg><div class="map-controls"><button data-action="zoom-in" aria-label="Zoom in">＋</button><button data-action="zoom-out" aria-label="Zoom out">−</button><button data-action="recenter" title="Center aircraft">⌖</button><button data-action="playback" title="Playback">▶</button></div><div class="map-tools"><button data-layer="weather" class="on">◉ Weather</button><button data-layer="jet" class="on">⌁ Jetstream</button><button data-layer="pirep" class="on">⚑ PIREPs</button></div><div class="map-zoom-label">${store.mapCenter?`CASE ${store.mapCenter}`:'FLIGHT PLAN'} <span>·</span> 06:42:18Z</div><div class="risk-legend"><span class="legend-title">TURBULENCE RISK</span><span><i class="dot high"></i>High</span><span><i class="dot mod"></i>Moderate</span><span><i class="dot low"></i>Low</span></div><div class="map-scale">200 NM <span></span></div><div class="playback-bar"><span>−30m</span><input type="range" min="0" max="30" value="0" aria-label="Weather playback time"><span>NOW</span></div></div><div class="map-footer"><span>Basemap: Tactical dark</span><span>Weather data · 06:42 UTC</span><span>Position: 12.4°N 67.8°E</span></div></section>`}
function alerts() {
  const target = store.weatherProxyTarget;
  const level = target ? (target.signal === 3 ? 'high' : 'moderate') : 'low';
  const levelText = target ? (target.signal === 3 ? 'HIGHER MODEL SIGNAL' : 'ELEVATED MODEL SIGNAL') : 'NO ELEVATED REGION';
  const regionName = target ? formatCoordinate(target.latitude, target.longitude) : (
    store.weatherProxyLoaded ? 'No elevated proxy region selected' : 'Finding priority region'
  );
  const regionDetail = target
    ? `${target.signal === 3 ? 'Red · higher-signal' : 'Yellow · elevated'} GFS region · ${target.shear} m/s/km shear proxy · ${target.crossTrackKm.toFixed(0)} km from route`
    : store.weatherProxyLoaded
      ? 'No elevated GFS proxy cell meets the route and signal thresholds right now. This does not confirm smooth air; route timing checkpoints remain active.'
      : 'Selecting the highest-signal eligible GFS region ahead of the aircraft.';
  return `<section class="alerts-section"><div class="section-heading"><div><div class="eyebrow">ONE SELECTED REGION · STAGED PREPARATION</div><h2>Alert sequence <span class="muted">30 · 10 · 5</span></h2></div><button class="text-button" data-page="insights">All reports <span>↗</span></button></div><div class="alerts-list">${checkpoints.map((checkpoint,index)=>`<article class="alert-card ${level}" data-alert-stage="${checkpoint.id}"><div class="alert-count ${level}"><strong>${checkpoint.leadMinutes}</strong><small>MIN</small></div><div class="alert-main"><div class="alert-top"><span class="risk-pill ${level}"><i></i>${levelText}</span><span class="alert-alt" data-alert-stage-time="${checkpoint.id}">WAITING</span></div><h3>${checkpoint.name}</h3><p>${checkpoint.action}</p><small class="alert-region" data-alert-region="${checkpoint.id}">${regionName}</small><small class="alert-description" data-alert-detail="${checkpoint.id}">${regionDetail}</small></div><button class="outline-button" data-action="details" data-index="${index}" ${target ? '' : 'disabled'}>View details <span>→</span></button></article>`).join('')}</div><div class="why-banner"><div class="why-icon">✳</div><div><strong>Higher-signal regions take priority</strong><p>The 30/10/5 sequence prioritizes red/high-signal eligible GFS regions over yellow/elevated regions ahead; nearest route entry is selected within a signal level. Yellow regions are considered when no eligible red region remains. This experimental proxy is not a calibrated probability or operational turbulence forecast.</p></div><span class="confidence">GFS PROXY</span></div></section>`;
}
function routeTimingCheckpointMarkup() {
  return routeTimingCheckpoints.map(checkpoint => `<article class="route-timing-card" data-route-checkpoint="${checkpoint.id}">
    <span class="route-timing-index">CP ${String(Math.round(checkpoint.fraction * 100)).padStart(2, '0')}</span>
    <div class="route-timing-info"><strong>${checkpoint.name}</strong><span data-route-checkpoint-coord="${checkpoint.id}">Calculated route position</span></div>
    <div class="route-timing-eta"><strong data-route-checkpoint-eta="${checkpoint.id}">--:-- UTC</strong><span data-route-checkpoint-countdown="${checkpoint.id}">Calculating time</span></div>
    <span class="route-timing-state" data-route-checkpoint-state="${checkpoint.id}">PENDING</span>
  </article>`).join('');
}
function routePage(){
  const flight = store.flight;
  const origin = airports[flight.origin];
  const arrival = airports[flight.destination];
  const position = flightPositionAt();
  const remainingKm = distanceKm(position, arrival);
  const remainingMinutes = Math.round(remainingKm / flight.cruiseSpeedKmh * 60);
  const eta = formatUtcTime(Date.now() + remainingMinutes * 60_000);
  return `<div class="page-content"><section class="flight-card"><div class="flight-ident"><div class="eyebrow">ACTIVE FLIGHT <span class="flight-id"> · ${escapeHtml(store.pilotProfile?.airline || 'COMMERCIAL')}</span></div><div class="flight-name">${escapeHtml(flight.callsign)}<i class="status-pill"><i></i> EN ROUTE</i></div><div class="aircraft-type">${escapeHtml(flight.aircraft)} <span>·</span> ${escapeHtml(flight.origin)} → ${escapeHtml(flight.destination)}</div></div><div class="route-legs"><div class="airport-box"><strong>${flight.origin}</strong><small>${escapeHtml(origin.name)}</small><small>DEPARTURE</small></div><div class="route-track"><div class="route-track-label">CRUISE · ${flight.cruiseSpeedKmh} KM/H</div><div class="track-line"><i></i><span>✈</span><i></i></div><div class="route-track-label">${remainingKm.toFixed(0)} KM REMAINING · ETA ${eta}</div></div><div class="airport-box right"><strong>${flight.destination}</strong><small>${escapeHtml(arrival.name)}</small><small>EST. ARRIVAL ${eta}</small></div></div><div class="telemetry"><div class="telemetry-item"><span>CRUISE ALTITUDE</span><strong>FL${flight.altitude}</strong><small><i class="stable-dot"></i> PILOT SET</small></div><div class="telemetry-item"><span>GROUND SPEED</span><strong id="speed">${flight.cruiseSpeedKmh} <small>km/h</small></strong><small class="speed-delta">LIVE SIMULATION</small></div><div class="telemetry-item"><span>AIRCRAFT MODEL</span><strong class="telemetry-model">${escapeHtml(flight.aircraft)}</strong><small>FLIGHT CONFIGURATION</small></div></div></section><div class="overview-grid">${planeMap()}<aside class="alerts-aside">${alerts()}</aside></div></div>`;
}
function insightCard(c){return `<article class="experience-card"><div class="case-level ${c.level}"><span class="sev-icon">${c.level==='high'?'▲':c.level==='moderate'?'◆':'●'}</span><span>${c.severity}</span></div><div class="case-meta"><span>◷ &nbsp;${c.date}</span><span>⌖ &nbsp;${c.place}</span><span>${c.coord}</span><span>✈ &nbsp;${c.aircraft}</span></div><blockquote>“${c.quote}”</blockquote><div class="case-bottom"><div class="tag-list">${c.tags.map(t=>`<span class="tag">${t}</span>`).join('')}</div><button class="outline-button small" data-action="map-case" data-case="${c.id}">⌖ &nbsp;View on map</button></div></article>`}
function reportPage(){return `<div class="page-content inner-page"><div class="page-title-row"><div><div class="eyebrow">CONTRIBUTE TO FLIGHT SAFETY</div><h1>Share your experience</h1><p>Your experience helps build a safer sky for everyone.</p></div><div class="verified-tag">◈ &nbsp; SECURE PIREP CHANNEL</div></div><div class="report-layout"><section class="form-panel"><div class="form-tabs"><button class="selected">✎ &nbsp; New report</button><button data-action="previous-reports">◷ &nbsp; Previous reports <span>${store.reports.length}</span></button></div><form id="report-form"><div class="form-section"><div class="form-section-head"><span class="step-num">01</span><div><strong>Flight details</strong><p>Encounter context and aircraft information</p></div></div><div class="form-grid three"><label>Date &amp; time <span class="required">*</span><input name="date" type="datetime-local" required value="${new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}"></label><label>Route (From → To)<input name="route" value="DOH → COK" required></label><label>Aircraft type<select name="aircraft"><option>Boeing 787</option><option>Airbus A350</option><option>Boeing 777</option></select></label></div></div><div class="form-section"><div class="form-section-head"><span class="step-num">02</span><div><strong>Encounter conditions</strong><p>Position, altitude, and turbulence intensity</p></div></div><div class="location-select"><label class="radio-option"><input type="radio" name="location-mode" value="current" checked><span><b>Use current aircraft location</b><small>12.4°N, 67.8°E · Live GPS</small></span></label><label class="radio-option"><input type="radio" name="location-mode" value="manual"><span><b>Enter manually</b><small>Specify encounter coordinates</small></span></label></div><div class="form-grid four location-fields"><label>Latitude<input name="latitude" value="12.4°N" disabled></label><label>Longitude<input name="longitude" value="67.8°E" disabled></label><label>Altitude (FL)<div class="input-unit"><span>FL</span><input name="altitude" type="number" min="0" max="600" value="350" required></div></label><label>Duration (min)<div class="input-unit"><input name="duration" type="number" min="1" max="180" value="10" required><span>MIN</span></div></label></div><div class="form-grid two"><label>Turbulence intensity<div class="intensity-options">${['Light','Moderate','Severe','Extreme'].map((t,i)=>`<button type="button" class="intensity ${i===1?'selected':''}" data-intensity="${t}"><i class="intensity-dot ${['low','mod','high','extreme'][i]}"></i>${t}</button>`).join('')}</div><input type="hidden" name="intensity" value="Moderate"></label><label>Weather conditions <span class="optional">OPTIONAL</span><div class="weather-checks">${['Convective Clouds','Jet Stream','Wind Shear','Mountain Wave','Clear Air Turbulence'].map((w,i)=>`<label><input type="checkbox" name="weather" value="${w}" ${i===0?'checked':''}> ${w}</label>`).join('')}</div></label></div></div><div class="form-section last"><div class="form-section-head"><span class="step-num">03</span><div><strong>Pilot debrief</strong><p>Describe what you experienced</p></div><span class="optional">OPTIONAL</span></div><label class="debrief-label"><textarea name="description" maxlength="600" placeholder="Describe the turbulence onset, duration, aircraft response, and any weather observations…"></textarea><span class="char-count"><b id="char-count">0</b> / 600</span></label></div><div class="form-actions"><span>◈ &nbsp; Report is stored securely and queued for verification.</span><button class="primary-button" type="submit"><span class="submit-label">↑ &nbsp; Submit experience</span><span class="submit-spinner"></span></button></div></form></section><aside class="pipeline-panel"><div class="eyebrow">COMMUNITY SAFETY LOOP</div><h2>How it works</h2><p class="panel-sub">Every report improves shared awareness.</p><div class="pipeline">${[['01','Submit','Pilots share first-hand turbulence experiences.','↥'],['02','Store','Reports are securely added to the experience database.','▤'],['03','Review','Submissions are reviewed and prepared for learning.','⬡'],['04','Improve','Verified patterns sharpen future route alerts.','↗']].map(([n,title,desc,icon])=>`<button class="pipeline-step" data-action="pipeline" data-step="${n}"><span class="pipeline-icon">${icon}</span><span class="pipeline-num">${n}</span><strong>${title}</strong><small>${desc}</small><span class="pipeline-more">ⓘ &nbsp; Learn more</span></button>`).join('')}</div><div class="pipeline-foot"><span class="live-dot"></span> OFFLINE HEURISTIC ENGINE <span>·</span> NO BLACK-BOX ML</div></aside></div></div>`}
function settingsPage(){return `<div class="page-content inner-page"><div class="page-title-row"><div><div class="eyebrow">FLIGHT DECK PREFERENCES</div><h1>Settings</h1><p>Configure your EFB display and alert preferences.</p></div></div><section class="settings-card"><h2>Alert thresholds</h2><p>Receive alerts based on predicted encounter time.</p>${[['30 minute advisory','Moderate or higher'],['10 minute warning','Moderate or higher'],['5 minute immediate','All intensities']].map(([a,b])=>`<div class="setting-row"><div><strong>${a}</strong><small>${b}</small></div><label class="switch"><input type="checkbox" checked><span></span></label></div>`).join('')}<h2 class="settings-subtitle">Data &amp; display</h2><div class="setting-row"><div><strong>UTC time display</strong><small>All flight times shown in UTC</small></div><label class="switch"><input type="checkbox" checked><span></span></label></div><div class="setting-row"><div><strong>Share anonymized reports</strong><small>Contribute to the experience database</small></div><label class="switch"><input type="checkbox" checked><span></span></label></div></section></div>`}
function render(){
  if (!pilotIsAuthenticated()) {
    $('#app').innerHTML = `<div class="access-shell">${accessPage()}</div>`;
    wireAccessScreens();
    return;
  }
  if (!activeFlightIsValid(store.flight) || store.page === 'flight-setup') {
    $('#app').innerHTML = `<div class="access-shell">${flightSetupPage()}</div>`;
    wireFlightSetup();
    return;
  }
  const content=store.page==='route'?routePage():store.page==='insights'?insightsPage():store.page==='report'?reportPage():settingsPage();
  $('#app').innerHTML=`<div class="app-shell">${header()}<main>${content}</main><footer><span>TA <b>·</b> EXPERIENCE BASED TURBULENCE ALERTING</span><span>HEURISTIC MATCHING ENGINE <b>·</b> V 2.4.1</span><span>DATA AS OF 06:42:18 UTC</span></footer></div>`;
  wire();
}
function wireAccessScreens() {
  $$('[data-auth-mode]').forEach(button => button.onclick = () => {
    store.authMode = button.dataset.authMode;
    store.authPending = null;
    render();
  });
  $('[data-action="otp-back"]')?.addEventListener('click', () => {
    store.authPending = null;
    render();
  });
  $('#auth-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const phone = String(values.get('phone') || '').replace(/\D/g, '');
    const error = $('#auth-error');
    if (phone.length < 7 || phone.length > 15) {
      if (error) error.textContent = 'Enter a valid phone number, including its country code.';
      return;
    }
    if (store.authMode === 'login') {
      const savedProfile = readStoredJson(`ta-demo-pilot-profile-${phone}`, null);
      if (!savedProfile) {
        if (error) error.textContent = 'No local demo profile was found for this number. Create a pilot account first.';
        return;
      }
      store.authPending = { phone, profile: savedProfile };
    } else {
      store.authPending = {
        phone,
        profile: {
          phone,
          fullName: String(values.get('fullName') || '').trim(),
          rank: String(values.get('rank') || ''),
          airline: String(values.get('airline') || '').trim(),
          country: String(values.get('country') || '').trim()
        }
      };
    }
    render();
  });
  $('#otp-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const error = $('#auth-error');
    if (new FormData(form).get('otp') !== demoOtp) {
      if (error) error.textContent = 'Incorrect demo code. Use the six-digit code shown above.';
      return;
    }
    const profile = store.authPending?.profile;
    if (!profile) {
      if (error) error.textContent = 'The pilot profile is missing. Return and try again.';
      return;
    }
    try {
      localStorage.setItem(`ta-demo-pilot-profile-${profile.phone}`, JSON.stringify(profile));
      localStorage.setItem('ta-demo-pilot-profile', JSON.stringify(profile));
      localStorage.setItem('ta-demo-session', JSON.stringify({ authenticated: true, phone: profile.phone }));
    } catch (storageError) {
      console.error('Unable to persist prototype pilot profile', storageError);
      if (error) error.textContent = 'Browser storage is unavailable. Enable local storage to continue.';
      return;
    }
    store.pilotProfile = profile;
    store.pilotSession = { authenticated: true, phone: profile.phone };
    store.authPending = null;
    store.page = activeFlightIsValid(store.flight) ? 'route' : 'flight-setup';
    history.replaceState({ page: store.page }, '', `/${store.page}`);
    render();
  });
}
function wireFlightSetup() {
  $('[data-action="sign-out"]')?.addEventListener('click', signOutPilot);
  $('#flight-setup-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const flight = {
      callsign: String(values.get('callsign') || '').trim(),
      aircraft: String(values.get('aircraft') || ''),
      origin: String(values.get('origin') || ''),
      destination: String(values.get('destination') || ''),
      altitude: Number(values.get('altitude')),
      cruiseSpeedKmh: Number(values.get('cruiseSpeedKmh'))
    };
    const error = $('#flight-setup-error');
    if (flight.origin === flight.destination) {
      if (error) error.textContent = 'Departure and destination must be different airports.';
      return;
    }
    if (!activeFlightIsValid(flight)) {
      if (error) error.textContent = 'Check the call sign, flight levels, cruise speed, and airport selections.';
      return;
    }
    applyFlightConfig(flight);
    try {
      localStorage.setItem('ta-active-flight', JSON.stringify(store.flight));
    } catch (storageError) {
      console.error('Unable to save active flight configuration', storageError);
      if (error) error.textContent = 'The flight is configured for this session, but browser storage is unavailable.';
      return;
    }
    checkpoints.forEach(checkpoint => {
      checkpoint.triggered = false;
      checkpoint.acknowledged = false;
      checkpoint.missed = false;
    });
    routeTimingCheckpoints.forEach(checkpoint => {
      checkpoint.triggered = false;
      checkpoint.acknowledged = false;
      delete checkpoint.triggeredAt;
    });
    store.alertRegionReached = false;
    store.weatherProxyTarget = null;
    store.completedWeatherTargetIds = new Set();
    store.weatherProxyLoaded = false;
    store.weatherProxyError = false;
    store.page = 'route';
    history.pushState({ page: 'route' }, '', '/route');
    render();
  });
}
function signOutPilot() {
  try {
    localStorage.removeItem('ta-demo-session');
  } catch (error) {
    console.error('Unable to clear prototype pilot session', error);
    toast('Could not sign out', 'Browser storage is unavailable.');
    return;
  }
  store.pilotSession = null;
  store.authPending = null;
  store.authMode = 'login';
  render();
}
function toast(title,body=''){const old=$('.toast');old?.remove();const n=document.createElement('div');n.className='toast';n.innerHTML=`<span class="toast-icon">✓</span><span><b>${title}</b>${body?`<small>${body}</small>`:''}</span>`;document.body.append(n);setTimeout(()=>n.classList.add('show'),10);setTimeout(()=>{n.classList.remove('show');setTimeout(()=>n.remove(),350)},3200)}
function setPage(page){store.page=page;render();window.scrollTo({top:0,behavior:'smooth'})}
function wire(){ $$('[data-page]').forEach(b=>b.onclick=()=>setPage(b.dataset.page));
 $$('.factor-chip').forEach(b=>b.onclick=()=>{const f=b.dataset.factor;store.factors.has(f)?store.factors.delete(f):store.factors.add(f);render()});
 $$('[data-layer]').forEach(b=>b.onclick=()=>{const k=b.dataset.layer;store.layers[k]=!store.layers[k];b.classList.toggle('on',store.layers[k]);const id=k==='weather'?'weather-layer':k==='jet'?'jet-layer':'pirep-layer';const e=$('#'+id);if(e)e.style.opacity=store.layers[k]?'1':'0'});
 $$('[data-action="layers"]').forEach(b=>b.onclick=()=>toast('Map layers','Use the map layer controls to toggle weather, jetstream, and PIREP overlays.'));
 $$('[data-action="zoom-in"],[data-action="zoom-out"]').forEach(b=>b.onclick=()=>{const svg=$('.map-svg');let z=Number(svg.dataset.zoom||1);z=Math.min(1.5,Math.max(.8,z+(b.dataset.action==='zoom-in'?.1:-.1)));svg.dataset.zoom=z;svg.style.transform=`scale(${z})`;toast(`Map zoom ${Math.round(z*100)}%`)});
 $('[data-action="recenter"]')?.addEventListener('click',()=>{store.mapCenter=null;toast('Centered on aircraft','12.4°N, 67.8°E · FL350')});
 $('[data-action="playback"]')?.addEventListener('click',e=>{const input=$('.playback-bar input');input.value=input.value==='0'?'15':'0';e.currentTarget.textContent=input.value==='0'?'▶':'Ⅱ';toast(input.value==='0'?'Live weather restored':'Weather playback','Historical conditions along the route')});
 $$('.playback-bar input').forEach(i=>i.oninput=()=>{$('.map-zoom-label').innerHTML=`−${i.value} MIN <span>·</span> WEATHER PLAYBACK`});
 $$('[data-action="details"]').forEach(b=>b.onclick=()=>{setPage('insights');setTimeout(()=>{$('.experience-list')?.scrollIntoView({behavior:'smooth',block:'center'});toast(`Alert ${['30 min','10 min','5 min'][b.dataset.index]} details`,'Related historical PIREPs are highlighted.')},100)});
 $$('[data-action="map-case"]').forEach(b=>b.onclick=()=>{const c=store.allCases.find(x=>x.id===b.dataset.case);store.mapCenter=b.dataset.case;setPage('route');setTimeout(()=>{if(c){const x=Math.max(160,Math.min(760,160+((c.lon-50)/30)*600)),y=Math.max(90,Math.min(345,345-((c.lat-8)/18)*255));$('#encounter-marker').innerHTML=`<g transform="translate(${x} ${y})"><circle r="24" fill="#47d7ec" fill-opacity=".18" stroke="#47d7ec"/><circle r="7" fill="#47d7ec"/><text x="18" y="-14" fill="#d8faff" font-size="11">HISTORICAL ENCOUNTER</text></g>`}toast('Map centered on report',`${c?.coord||'Encounter position'} · Historical encounter highlighted.`)},80)});
 $('[data-action="filter"]')?.addEventListener('click',()=>toast('Experience filters','Showing reports for this flight corridor.'));
 $$('[data-action="pipeline"]').forEach(b=>b.onclick=()=>toast(`${b.querySelector('strong').textContent} · Step ${b.dataset.step}`,b.querySelector('small').textContent));
 $('[data-action="previous-reports"]')?.addEventListener('click',()=>{if(!store.reports.length){toast('No submitted reports','Your reports will appear here after submission.');return}setPage('insights')});
 $$('input[name="location-mode"]').forEach(r=>r.onchange=()=>{const manual=r.value==='manual'&&r.checked;const lat=$('input[name="latitude"]'),lon=$('input[name="longitude"]');lat.disabled=lon.disabled=!manual;if(manual){lat.value='';lon.value='';lat.placeholder='e.g. 12.4°N';lon.placeholder='e.g. 67.8°E'}else{lat.value='12.4°N';lon.value='67.8°E'}});
 $$('.intensity').forEach(b=>b.onclick=()=>{$$('.intensity').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('input[name="intensity"]').value=b.dataset.intensity});
 const desc=$('textarea[name="description"]');if(desc)desc.oninput=()=>$('#char-count').textContent=desc.value.length;
 $('#report-form')?.addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;if(!form.reportValidity())return;const btn=$('.primary-button');btn.classList.add('loading');btn.disabled=true;await new Promise(r=>setTimeout(r,850));const fd=new FormData(form),intensity=fd.get('intensity'), level=intensity==='Severe'||intensity==='Extreme'?'high':intensity==='Moderate'?'moderate':'low', date=new Date(fd.get('date')+'Z');const c={id:'r'+Date.now(),severity:intensity,level,date:date.toISOString().slice(0,16).replace('T',' ')+' UTC',place:'Reported encounter',coord:`${fd.get('latitude')}, ${fd.get('longitude')}`,lat:parseFloat(fd.get('latitude'))||12.4,lon:parseFloat(fd.get('longitude'))||67.8,aircraft:fd.get('aircraft'),quote:fd.get('description')||`${intensity} turbulence encounter at FL${fd.get('altitude')}, duration ${fd.get('duration')} minutes.`,tags:fd.getAll('weather')};store.reports.unshift(c);localStorage.setItem('ta-reports',JSON.stringify(store.reports));btn.classList.remove('loading');btn.disabled=false;render();toast('Experience record submitted','Queued for verification · Insights updated');});
}
const originalPlaneMap = planeMap;
planeMap = function () {
  let html = originalPlaneMap();
  for (const [layer, id] of Object.entries({ weather: 'weather-layer', jet: 'jet-layer', pirep: 'pirep-layer' })) {
    html = html.replace(`id="${id}"`, `id="${id}" style="opacity:${store.layers[layer] ? 1 : 0}"`);
    html = html.replace(`data-layer="${layer}" class="on"`, `data-layer="${layer}" class="${store.layers[layer] ? 'on' : ''}"`);
  }
  html = html.replace('class="map-svg"', `class="map-svg" style="transform:scale(${store.mapZoom || 1})"`);
  const encounter = store.allCases.find(item => item.id === store.mapCenter);
  if (encounter) {
    const x = Math.max(160, Math.min(760, 160 + ((encounter.lon - 50) / 30) * 600));
    const y = Math.max(90, Math.min(345, 345 - ((encounter.lat - 8) / 18) * 255));
    const zoom = Math.max(1, store.mapZoom || 1.18);
    html = html.replace('viewBox="0 0 900 430"', `viewBox="${x - 450 / zoom} ${y - 215 / zoom} ${900 / zoom} ${430 / zoom}"`);
    html = html.replace('</svg>', `<g class="encounter-highlight" transform="translate(${x} ${y})"><circle r="24"/><circle r="7"/><text x="18" y="-14">HISTORICAL ENCOUNTER</text></g></svg>`);
  }
  return html;
};

function casesForCurrentFilter() {
  const matches = historicalMatchSummary();
  let cases = store.factors.has('Location') ? matches.routeMatches : matches.matches;
  if (store.activeAlert !== null) {
    const target = store.weatherProxyTarget;
    cases = target
      ? cases.filter(item => Number.isFinite(item.report.lat) && Number.isFinite(item.report.lon) && distanceKm(item.report, target) <= 300)
      : [];
  }
  if (store.severityFilter !== 'all') {
    cases = cases.filter(item => item.report.level === store.severityFilter);
  }
  return cases.map(item => ({ ...item.report, insightMatch: item }));
}
function insightsPage() {
  const summary = historicalMatchSummary();
  let reports = casesForCurrentFilter();
  const forecastCells = store.weatherProxyModel?.cells
    ? routeWeatherCells(store.weatherProxyModel.cells)
    : [];
  const routeForecastCells = forecastCells
    .filter(cell =>
      cell.signal >= 2 &&
      cell.rawFraction >= 0 && cell.rawFraction <= 1 &&
      cell.crossTrackKm <= 500
    )
    .sort((left, right) => left.alongRouteKm - right.alongRouteKm);
  const forecastCellCards = routeForecastCells.map(cell => {
    const level = cell.signal === 3 ? 'high' : 'moderate';
    const state = cell.id === store.weatherProxyTarget?.id
      ? 'ACTIVE · 30/10/5 SEQUENCE'
      : cell.completed ? 'REACHED · CHECKED IN'
        : cell.passed ? 'BEHIND AIRCRAFT · NOT ACTIONABLE'
          : cell.eligible ? 'QUEUED · ACTIVE REGION TAKES PRIORITY'
            : 'NEAR ROUTE · OUTSIDE ALERT CORRIDOR';
    return `<article class="forecast-region-card ${level}${cell.id === store.weatherProxyTarget?.id ? ' active' : ''}">
      <span class="forecast-region-signal">${cell.signal === 3 ? '▲' : '◆'}</span>
      <div class="forecast-region-main"><strong>${cell.signal === 3 ? 'HIGHER' : 'ELEVATED'} GFS SIGNAL · ${formatCoordinate(cell.latitude, cell.longitude)}</strong>
        <small>${Math.round(cell.alongRouteKm)} km from departure · ${Math.round(cell.crossTrackKm)} km cross-track · shear ${cell.shear} m/s/km</small>
        <small>CAPE ${cell.cape} J/kg · precipitation ${cell.precipitation} mm/h · valid ${escapeHtml(cell.time || 'time unavailable')} UTC</small>
      </div>
      <span class="forecast-region-state">${state}</span>
    </article>`;
  }).join('');
  const forecastRegionsMarkup = store.weatherProxyModel
    ? routeForecastCells.length
      ? forecastCellCards
      : '<div class="empty-state">No elevated or higher GFS proxy cells are within 500 km of the planned route segment. Lower-signal, distant off-route, or already-passed map cells do not receive staged alerts.</div>'
    : `<div class="empty-state">${store.weatherProxyError ? 'GFS weather proxy could not be loaded.' : 'Loading the GFS weather proxy for the configured route…'} Forecast cells are not historical pilot reports.</div>`;
  const ranked = reports.map(report => summary.matchesById.get(report.id)).filter(Boolean);
  const best = ranked[0] || null;
  const hasBestScore = Number.isFinite(best?.score);
  const scoreText = hasBestScore ? `${best.score}<small>/100</small>` : '—';
  const criteria = [...store.factors];
  const criteriaText = criteria.length
    ? `Heuristic 0–100 mean of selected factors with recorded data: route proximity, altitude difference, weather-tag overlap, and month proximity. Missing fields are excluded, not treated as matches. Not a turbulence probability.`
    : 'No matching factors selected. Select at least one factor to calculate a match score.';
  const activeFilters = store.activeAlert !== null
    ? `<div class="active-filter-banner"><span>REPORTS NEAR SELECTED ALERT REGION · WITHIN 300 KM</span><button type="button" data-action="clear-alert">Clear alert filter</button></div>`
    : '';
  const reportCards = reports.map(insightCard).join('') ||
    `<div class="empty-state">${store.activeAlert !== null && !store.weatherProxyTarget
      ? 'No selected weather-proxy target is available, so reports cannot be matched to an alert region.'
      : store.factors.has('Location') && !summary.routeReports.length
        ? `No loaded pilot reports fall within 300 km of ${escapeHtml(store.flight.origin)} → ${escapeHtml(store.flight.destination)}. The uploaded dataset-wide model has no individual route reports to show here.`
        : 'No reports match the selected factors and severity filter. Try changing the factors or severity.'}</div>`;
  const filteredMatch = reports.length
    ? `${reports.length} loaded report${reports.length === 1 ? '' : 's'} ${store.factors.has('Location') ? 'within 300 km of the planned route' : 'in the loaded feed'}${store.activeAlert !== null ? ' and within 300 km of the selected alert target' : ''}.`
    : store.factors.has('Location')
      ? `No loaded report records within 300 km of ${escapeHtml(store.flight.origin)} → ${escapeHtml(store.flight.destination)}.`
      : 'No report records meet the current filters.';
  const altitudeValues = summary.routeReports.map(report => Number(report.altitudeFL)).filter(Number.isFinite);
  const historicalAltitude = altitudeValues.length
    ? `FL${Math.min(...altitudeValues)}–${Math.max(...altitudeValues)} (${altitudeValues.length} report${altitudeValues.length === 1 ? '' : 's'})`
    : 'Not recorded in matching reports';
  const weatherTags = [...summary.routeReports.reduce((counts, report) => {
    (Array.isArray(report.tags) ? report.tags : []).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1));
    return counts;
  }, new Map())].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const historicalWeather = weatherTags.length
    ? weatherTags.map(([tag, count]) => `${escapeHtml(tag)} (${count})`).join(', ')
    : 'No weather tags in matching reports';
  const target = store.weatherProxyTarget;
  const currentWeather = target
    ? `${target.signal === 3 ? 'Higher' : 'Elevated'} GFS proxy selected · shear ${target.shear} m/s/km · CAPE ${target.cape} J/kg · valid ${escapeHtml(target.time || 'time unavailable')} UTC`
    : store.weatherProxyError ? 'GFS proxy unavailable'
      : store.weatherProxyModel
        ? `${routeForecastCells.length} elevated/higher cells near route · no active alert target`
        : store.weatherProxyLoaded ? 'No elevated GFS proxy target selected' : 'Loading GFS proxy';
  const routeModels = [...new Set(summary.routeReports.map(report => report.aircraft).filter(Boolean))];
  const historicalAircraft = routeModels.length ? routeModels.map(escapeHtml).join(', ') : 'No route report records';
  const severityCounts = summary.routeReports.reduce((counts, report) => {
    const label = report.severity || report.level || 'Unspecified';
    counts.set(label, (counts.get(label) || 0) + 1);
    return counts;
  }, new Map());
  const severitySummary = severityCounts.size
    ? [...severityCounts].sort((a, b) => b[1] - a[1]).map(([label, count]) => `${escapeHtml(label)} (${count})`).join(', ')
    : 'No route report records';
  const bestHeading = best
    ? `${hasBestScore ? escapeHtml(best.report.severity || best.report.level) + ' match' : 'Report located · score unavailable'} · ${escapeHtml(best.report.aircraft || 'Aircraft not recorded')}`
    : 'Historical match unavailable';
  return `<div class="page-content inner-page">
    <div class="page-title-row"><div><div class="eyebrow">EXPERIENCE-BASED RECOGNITION</div><h1>Turbulence insights</h1><p>Historical pilot reports compared with the configured flight. This is a report-matching aid, not a turbulence forecast.</p></div><button class="outline-button" data-page="route">← &nbsp; Back to route</button></div>
    ${activeFilters}
    <section class="match-banner">
      <div class="match-score"><strong>${scoreText}</strong><span>${hasBestScore ? 'BEST REPORT MATCH' : 'NO MATCH SCORE'}</span></div>
      <div class="match-explainer"><strong>${bestHeading}</strong>
        <p>${best ? `${best.report.date || 'Date not recorded'} · ${formatCoordinate(best.report.lat, best.report.lon)} · based on ${best.availableFactors.length} of ${criteria.length} selected criteria.` : escapeHtml(filteredMatch)}</p>
        <p class="insight-criteria-note">${escapeHtml(criteriaText)}</p>
      </div>
      <div class="match-factors"><span class="eyebrow">MATCHING CRITERIA <span class="muted">· Toggle to score on available data</span></span><div class="chip-row">${['Location','Altitude','Weather Pattern','Season'].map(f=>`<button class="factor-chip ${store.factors.has(f)?'selected':''}" data-factor="${f}" aria-pressed="${store.factors.has(f)}">${store.factors.has(f)?'✓':'+'} &nbsp;${f}</button>`).join('')}</div></div>
    </section>
    <section class="insight-weather-regions">
      <div class="section-heading compact"><div><div class="eyebrow">CURRENT ROUTE WEATHER · GFS PROXY</div><h2>Elevated regions and alert assignment</h2></div><span class="forecast-model-warning">MODEL SIGNAL · NOT PIREPs OR A CERTIFIED FORECAST</span></div>
      <p class="insight-coverage-note">The red/amber cells on the Route map are forecast-proxy grid cells, not historical pilot reports. Among eligible regions ahead, the staged 30/10/5 alerts prioritize red/higher-signal cells over amber/elevated cells; the nearest route entry is selected within each signal level. Amber regions become alert targets when no eligible red region remains. The proxy signal is not a confirmed turbulence severity or certified forecast.</p>
      <div class="forecast-region-list">${forecastRegionsMarkup}</div>
    </section>
    <div class="insight-grid">
      <section><div class="section-heading compact"><div><div class="eyebrow">LOADED PILOT REPORTS · ROUTE-RELEVANT FIRST</div><h2>Historical experiences <span class="muted">${reports.length}</span></h2></div><button class="filter-button" data-action="filter">⚑ &nbsp; ${store.severityFilter === 'all' ? 'All severities' : `${escapeHtml(store.severityFilter)} risk`} · Change</button></div>
        <p class="insight-coverage-note">${escapeHtml(filteredMatch)} Case feed: ${summary.totalReports} bundled or locally submitted reports; the 300k dataset is shown as aggregated map regions and does not provide individual case cards here.</p>
        <div class="experience-list">${reportCards}</div></section>
      <aside class="weather-panel"><div class="eyebrow">AVAILABLE EVIDENCE · NOT LIVE AIRCRAFT SENSORS</div><h2>Flight and report comparison</h2><p class="panel-sub">Missing report fields are shown as unavailable, not estimated.</p>
        <table><thead><tr><th>Parameter</th><th>Current flight</th><th>Route reports</th></tr></thead><tbody>
          <tr><td>Altitude</td><td>FL${store.flight.altitude}</td><td>${historicalAltitude}</td></tr>
          <tr><td>Weather pattern</td><td>${currentWeather}</td><td>${historicalWeather}</td></tr>
          <tr><td>Aircraft</td><td>${escapeHtml(store.flight.aircraft)}</td><td>${historicalAircraft}</td></tr>
          <tr><td>Reported intensity</td><td>Not measured by this app</td><td>${severitySummary}</td></tr>
        </tbody></table>
        <div class="analysis-note"><span>ⓘ</span><p>Historical values summarize only ${summary.routeReports.length} loaded reports in the 300 km corridor. The global PIREP training model is a separate aggregate and contains no individual reports for this comparison.</p></div>
      </aside>
    </div>
  </div>`;
}

insightCard = function (item) {
  const safe = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const reportDetails = [item.route, item.altitudeFL ? `FL${item.altitudeFL}` : '', item.durationMinutes ? `${item.durationMinutes} min` : ''].filter(Boolean).map(safe).map(value => `<span>${value}</span>`).join('');
  const match = item.insightMatch;
  const matchBadge = match ? `<span class="insight-match-badge">${match.score === null ? 'NO SCORE' : `${match.score}/100 MATCH`}</span>` : '';
  const matchDetails = match
    ? `<div class="insight-match-details">${match.availableFactors.length ? match.availableFactors.map(factor => `${safe(factor)} ${match.factorScores[factor]}/100`).join(' · ') : 'No selected criteria available for this report'}${Number.isFinite(match.crossTrackKm) ? ` · ${Math.round(match.crossTrackKm)} km from route` : ''}</div>`
    : '';
  return `<article class="experience-card"><div class="case-level ${safe(item.level)}"><span class="sev-icon">${item.level === 'high' ? '▲' : item.level === 'moderate' ? '◆' : '●'}</span><span>${safe(item.severity)}</span>${matchBadge}</div><div class="case-meta"><span>◷ &nbsp;${safe(item.date)}</span><span>⌖ &nbsp;${safe(item.place)}</span><span>${safe(item.coord)}</span><span>✈ &nbsp;${safe(item.aircraft)}</span>${reportDetails}</div>${matchDetails}<blockquote>“${safe(item.quote)}”</blockquote><div class="case-bottom"><div class="tag-list">${(Array.isArray(item.tags) ? item.tags : []).map(tag => `<span class="tag">${safe(tag)}</span>`).join('')}</div><button class="outline-button small" data-action="map-case" data-case="${safe(item.id)}">⌖ &nbsp;View on map</button></div></article>`;
};

const originalWire = wire;
const originalSetPage = setPage;
setPage = function (page) {
  if (!pageIds.includes(page)) return;
  history.pushState({ page }, '', `/${page}`);
  originalSetPage(page);
};
window.addEventListener('popstate', () => {
  const page = window.location.pathname.replace(/^\/+|\/+$/g, '');
  store.page = pageIds.includes(page) ? page : 'route';
  render();
});
wire = function () {
  originalWire();
  $$('[data-page="insights"]').forEach(button => button.onclick = () => {
    store.activeAlert = null;
    store.severityFilter = 'all';
    setPage('insights');
  });
  const severityButton = $('[data-action="filter"]');
  if (severityButton) severityButton.textContent = `⚑  ${store.severityFilter === 'all' ? 'All severities' : `${store.severityFilter} risk`} · Change`;
  const routeInput = $('input[name="route"]');
  if (routeInput) {
    const routeSelect = document.createElement('select');
    routeSelect.name = 'route';
    routeSelect.required = true;
    [['DOH → COK', 'Doha (DOH) → Kochi (COK)'], ['DOH → MAA', 'Doha (DOH) → Chennai (MAA)']].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      routeSelect.append(option);
    });
    routeInput.replaceWith(routeSelect);
  }
  const dateInput = $('input[name="date"]');
  if (dateInput) dateInput.value = new Date().toISOString().slice(0, 16);
  $$('[data-action="details"]').forEach(button => {
    button.onclick = () => {
      store.activeAlert = Number(button.dataset.index);
      store.severityFilter = 'all';
      setPage('insights');
      setTimeout(() => {
        $('.experience-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast('Related PIREPs loaded', 'Historical reports are filtered to this alert.');
      }, 100);
    };
  });
  $$('[data-action="clear-alert"]').forEach(button => button.onclick = () => {
    store.activeAlert = null;
    store.severityFilter = 'all';
    render();
  });
  $('[data-action="filter"]')?.addEventListener('click', event => {
    const filters = ['all', 'high', 'moderate', 'low'];
    store.severityFilter = filters[(filters.indexOf(store.severityFilter) + 1) % filters.length];
    event.currentTarget.innerHTML = `⚑ &nbsp; ${store.severityFilter === 'all' ? 'All severities' : `${store.severityFilter} risk`} · Change`;
    render();
  });
  $$('[data-action="map-case"]').forEach(button => {
    button.onclick = () => {
      store.mapCenter = button.dataset.case;
      store.mapZoom = 1.18;
      setPage('route');
      toast('Map centered on report', `${store.allCases.find(item => item.id === store.mapCenter)?.coord || 'Encounter position'} · Historical encounter highlighted.`);
    };
  });
  $$('[data-layer]').forEach(button => {
    button.onclick = () => {
      const layer = button.dataset.layer;
      store.layers[layer] = !store.layers[layer];
      button.classList.toggle('on', store.layers[layer]);
      const id = { weather: 'weather-layer', jet: 'jet-layer', pirep: 'pirep-layer' }[layer];
      const group = $(`#${id}`);
      if (group) group.style.opacity = store.layers[layer] ? '1' : '0';
      try {
        localStorage.setItem('ta-layers', JSON.stringify(store.layers));
      } catch (error) {
        console.error('Unable to save map layer preferences', error);
        toast('Preference not saved', 'Map layer changes apply for this session only.');
      }
      if (['30 minute advisory', '10 minute warning', '5 minute immediate'].includes(name)) {
        const index = ['30 minute advisory', '10 minute warning', '5 minute immediate'].indexOf(name);
        const card = $$('.alert-card')[index];
        if (card) card.hidden = !input.checked;
      }
    };
    if (['30 minute advisory', '10 minute warning', '5 minute immediate'].includes(name)) {
      const index = ['30 minute advisory', '10 minute warning', '5 minute immediate'].indexOf(name);
      const card = $$('.alert-card')[index];
      if (card) card.hidden = !input.checked;
    }
  });
  $$('[data-action="filter"]').forEach(button => button.onclick = () => {
    const filters = ['all', 'high', 'moderate', 'low'];
    store.severityFilter = filters[(filters.indexOf(store.severityFilter) + 1) % filters.length];
    render();
  });
  $$('.weather-panel tbody tr').forEach(row => {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const toggle = () => {
      row.classList.toggle('selected');
      toast('Comparison highlighted', `${$('td', row)?.textContent.trim() || 'Weather parameter'} · current vs. historical`);
    };
    row.onclick = toggle;
    row.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    };
  });
  const layersButton = $('[data-action="layers"]');
  if (layersButton) layersButton.onclick = event => {
    const controls = $('.map-tools');
    if (!controls) return;
    controls.hidden = !controls.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!controls.hidden));
  };
  $$('[data-action="zoom-in"],[data-action="zoom-out"]').forEach(button => {
    button.onclick = () => {
      const change = button.dataset.action === 'zoom-in' ? 0.1 : -0.1;
      store.mapZoom = Math.min(1.6, Math.max(0.8, (store.mapZoom || 1) + change));
      const svg = $('.map-svg');
      if (svg) svg.style.transform = `scale(${store.mapZoom})`;
      toast(`Map zoom ${Math.round(store.mapZoom * 100)}%`);
    };
  });
  $('[data-action="recenter"]')?.addEventListener('click', () => {
    store.mapCenter = null;
    store.mapZoom = 1;
    const svg = $('.map-svg');
    if (svg) svg.style.transform = 'scale(1)';
    $('.encounter-highlight')?.remove();
    const label = $('.map-zoom-label');
    if (label) label.innerHTML = 'FLIGHT PLAN <span>·</span> 06:42:18Z';
    toast('Centered on aircraft', '12.4°N, 67.8°E · FL350');
  });
  $('[data-action="playback"]')?.addEventListener('click', event => {
    store.playbackActive = !store.playbackActive;
    event.currentTarget.textContent = store.playbackActive ? 'Ⅱ' : '▶';
    toast(store.playbackActive ? 'Weather playback' : 'Live weather restored', store.playbackActive ? 'Historical conditions along the route' : 'Returning to current conditions');
  });
  $('.playback-bar input')?.addEventListener('input', event => {
    store.playbackMinutes = Number(event.currentTarget.value);
    const label = $('.map-zoom-label');
    if (label) label.innerHTML = store.playbackMinutes ? `−${store.playbackMinutes} MIN <span>·</span> WEATHER PLAYBACK` : 'FLIGHT PLAN <span>·</span> LIVE WEATHER';
  });
  $$('.setting-row').forEach(row => {
    const name = $('strong', row)?.textContent.trim();
    const input = $('input[type="checkbox"]', row);
    if (!name || !input) return;
    input.checked = store.settings[name] !== false;
    input.onchange = () => {
      store.settings[name] = input.checked;
      try {
        localStorage.setItem('ta-settings', JSON.stringify(store.settings));
      } catch (error) {
        console.error('Unable to save settings', error);
        toast('Preference not saved', 'This setting applies for this session only.');
      }
    };
  });
  const form = $('#report-form');
  if (form) form.addEventListener('submit', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!form.reportValidity()) return;
    const latitudeValue = $('input[name="latitude"]', form).value.trim();
    const longitudeValue = $('input[name="longitude"]', form).value.trim();
    const parseCoordinate = (value, axis) => {
      const match = value.match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?$/i);
      if (!match) return NaN;
      let number = Number(match[1]);
      const direction = match[2]?.toUpperCase();
      if (direction && ((axis === 'lat' && !['N', 'S'].includes(direction)) || (axis === 'lon' && !['E', 'W'].includes(direction)))) return NaN;
      if (direction) number = ['S', 'W'].includes(direction) ? -Math.abs(number) : Math.abs(number);
      return number;
    };
    const lat = parseCoordinate(latitudeValue, 'lat');
    const lon = parseCoordinate(longitudeValue, 'lon');
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      toast('Check encounter coordinates', 'Enter a valid latitude and longitude before submitting.');
      return;
    }
    const button = $('.primary-button', form);
    button.disabled = true;
    button.classList.add('loading');
    await new Promise(resolve => setTimeout(resolve, 850));
    const data = new FormData(form);
    const intensity = data.get('intensity');
    const date = new Date(`${data.get('date')}Z`);
    const level = intensity === 'Severe' || intensity === 'Extreme' ? 'high' : intensity === 'Moderate' ? 'moderate' : 'low';
    const report = {
      id: `r${Date.now()}`, severity: intensity, level,
      date: `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      place: 'Reported encounter', coord: `${latitudeValue}, ${longitudeValue}`, lat, lon,
      route: data.get('route'), altitudeFL: Number(data.get('altitude')), durationMinutes: Number(data.get('duration')),
      aircraft: data.get('aircraft'),
      quote: data.get('description').trim() || `${intensity} turbulence encounter at FL${data.get('altitude')}, duration ${data.get('duration')} minutes.`,
      tags: data.getAll('weather')
    };
    store.reports.unshift(report);
    let persisted = true;
    try {
      localStorage.setItem('ta-reports', JSON.stringify(store.reports));
    } catch (error) {
      console.error('Unable to persist submitted experience', error);
      persisted = false;
    }
    button.classList.remove('loading');
    render();
    toast(persisted ? 'Experience record submitted' : 'Saved for this session', persisted ? 'Queued for verification · Insights updated' : 'Browser storage is unavailable; this report may not persist after closing.');
  }, true);
};

planeMap = function () {
  const notificationText = store.notificationEnabled ? '◉ iPad alerts on' : '◉ Enable alerts';
  return `<section class="map-card"><div class="map-head"><div><div class="eyebrow">LIVE MAP · SIMULATED FLIGHT TRACKING <span class="map-live">● TRACKING</span></div><h2>Route &amp; turbulence risk</h2></div><div class="map-actions"><button class="layer-button" data-action="notifications">${notificationText}</button><button class="layer-button" data-action="layers" aria-expanded="true">☷ <span>Map layers</span> <span class="chevron">⌄</span></button></div></div><div class="map-wrap"><div id="live-map" role="application" aria-label="Interactive live flight map from Doha to Kochi"></div><div class="map-controls"><button data-action="zoom-in" aria-label="Zoom in">＋</button><button data-action="zoom-out" aria-label="Zoom out">−</button><button data-action="recenter" aria-label="Follow aircraft" title="Follow aircraft position" aria-pressed="${Boolean(store.followAircraft)}">⌖</button></div><div class="map-tools" aria-label="Map overlays"><button data-layer="weather" class="${store.layers.weather ? 'on' : ''}" aria-pressed="${store.layers.weather}">◉ Forecast risk</button><button data-layer="jet" class="${store.layers.jet ? 'on' : ''}" aria-pressed="${store.layers.jet}">⌁ Jetstream</button><button data-layer="pirep" class="${store.layers.pirep ? 'on' : ''}" aria-pressed="${store.layers.pirep}">⚑ PIREPs</button></div><div class="risk-legend"><span class="legend-title">FORECAST RISK</span><span><i class="dot high"></i>High</span><span><i class="dot mod"></i>Moderate</span><span><i class="dot low"></i>Low</span></div><div class="map-source" role="status">Loading OpenStreetMap tiles…</div></div><div class="map-footer"><span>Map tiles © OpenStreetMap contributors</span><span>Aircraft telemetry simulated · Forecast overlays illustrative</span><span id="map-position">12.40°N 67.80°E</span></div><section class="checkpoint-panel" aria-label="Upcoming route checkpoints"><div class="checkpoint-heading"><div><span class="eyebrow">PREDICTED ALONG ROUTE</span><h3>Upcoming checkpoints</h3></div><span class="checkpoint-accuracy" id="timing-accuracy">TIMING OFFSET <b>0 min</b></span></div><div class="checkpoint-list">${checkpoints.map(checkpoint => `<article class="checkpoint-card ${checkpoint.level}" data-checkpoint="${checkpoint.id}"><span class="checkpoint-marker" aria-hidden="true"></span><div class="checkpoint-info"><strong>${checkpoint.name}</strong><span data-checkpoint-coord="${checkpoint.id}">${checkpoint.leadMinutes}-min alert · ${checkpoint.severity} risk · ${formatCoordinate(checkpoint.lat, checkpoint.lon)}</span></div><div class="checkpoint-eta"><strong data-checkpoint-eta="${checkpoint.id}">--:-- UTC</strong><span data-checkpoint-countdown="${checkpoint.id}">Calculating ETA</span></div><span class="checkpoint-state" data-checkpoint-state="${checkpoint.id}">${checkpoint.acknowledged ? 'REPORTED' : 'PENDING'}</span></article>`).join('')}</div><p class="checkpoint-note">Arrival estimates adjust as flight progress and pilot check-ins are recorded. Forecast overlays are illustrative. iPad notifications require permission; background delivery also needs a push service.</p></section></section>`;
};

planeMap = function () {
  const notificationText = store.notificationEnabled ? 'iPad alerts on' : 'Enable alerts';
  return `<section class="map-card">
    <div class="map-head"><div><div class="eyebrow">LIVE MAP · SIMULATED FLIGHT TRACKING <span class="map-live">● TRACKING</span></div><h2>Route &amp; turbulence regions <span class="map-route-direction">${escapeHtml(store.flight.origin)} → ${escapeHtml(store.flight.destination)}</span></h2></div><div class="map-actions"><button class="layer-button" data-action="notifications">${notificationText}</button><button class="layer-button" data-action="layers" aria-expanded="true">Map layers <span class="chevron">⌄</span></button></div></div>
    <div class="map-wrap"><div id="live-map" role="application" aria-label="Interactive flight map from ${escapeHtml(store.flight.origin)} to ${escapeHtml(store.flight.destination)} with historical PIREP regions and regional GFS weather-model signals"></div>
      <div class="map-controls"><button data-action="zoom-in" aria-label="Zoom in">＋</button><button data-action="zoom-out" aria-label="Zoom out">−</button><button data-action="recenter" aria-label="Follow aircraft" title="Follow aircraft position" aria-pressed="${Boolean(store.followAircraft)}">⌖</button></div>
      <div class="map-tools" aria-label="Map overlays"><button data-layer="routeExperiences" class="${store.layers.routeExperiences ? 'on' : ''}" aria-label="Toggle route report regions" title="Route report regions" aria-pressed="${store.layers.routeExperiences}">Route report regions</button><button data-layer="weather" class="${store.layers.weather ? 'on' : ''}" aria-label="Toggle dataset-wide PIREPs" title="Dataset-wide PIREPs" aria-pressed="${store.layers.weather}">Dataset-wide PIREPs</button><button data-layer="weatherProxy" class="${store.layers.weatherProxy ? 'on' : ''}" aria-label="Toggle GFS weather proxy" title="GFS weather proxy" aria-pressed="${store.layers.weatherProxy}">GFS weather proxy</button><button data-layer="jet" class="${store.layers.jet ? 'on' : ''}" aria-label="Toggle jetstream" title="Jetstream" aria-pressed="${store.layers.jet}">Jetstream</button></div>
      <div class="risk-legend"><span class="legend-title">MODEL SIGNAL</span><span><i class="dot high"></i>Higher</span><span><i class="dot mod"></i>Elevated</span><span><i class="dot low"></i>Lower</span></div>
      <div class="map-model-status" id="map-model-status" role="status">Loading historical PIREP region model...</div>
      <div class="map-route-experience-status" id="map-route-experience-status" role="status">Aggregating route pilot reports...</div>
      <div class="map-weather-status" id="map-weather-status" role="status">Loading regional GFS weather proxy...</div>
      <div class="map-source" role="status">Loading OpenStreetMap tiles...</div>
    </div>
    <div class="map-footer"><span>Map tiles © OpenStreetMap</span><span>Weather: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo GFS</a> · CC BY 4.0 · Non-commercial prototype only</span><span id="map-position">12.40°N 67.80°E</span></div>
    <section class="checkpoint-panel" aria-label="Route timing checkpoints and staged turbulence alerts">
      <div class="checkpoint-heading"><div><span class="eyebrow">FLIGHT-PROGRESS TIMING</span><h3>Route timing checkpoints</h3></div><span class="checkpoint-accuracy" id="timing-accuracy">TIMING OFFSET <b>0 min</b></span></div>
      <p class="route-checkpoint-note">Three calculated route milestones, independent of turbulence detections. Check in when prompted to help refine arrival-time estimates.</p>
      <div class="route-timing-list" id="route-timing-list">${routeTimingCheckpointMarkup()}</div>
      <div class="checkpoint-heading alert-sequence-heading"><div><span class="eyebrow">HIGHEST-SIGNAL ELIGIBLE REGION AHEAD</span><h3>Alert sequence · <span id="alert-target-name">selecting region</span></h3></div></div>
      <div class="checkpoint-list">${checkpoints.map(checkpoint => `<article class="checkpoint-card" data-checkpoint="${checkpoint.id}"><span class="checkpoint-marker" aria-hidden="true"></span><div class="checkpoint-info"><strong>${checkpoint.leadMinutes}-minute alert · ${checkpoint.name}</strong><span data-checkpoint-coord="${checkpoint.id}">${checkpoint.action}</span></div><div class="checkpoint-eta"><strong data-checkpoint-eta="${checkpoint.id}">Region ETA --:-- UTC</strong><span data-checkpoint-countdown="${checkpoint.id}">Waiting for regional model</span></div><span class="checkpoint-state" data-checkpoint-state="${checkpoint.id}">WAITING</span></article>`).join('')}</div>
      <p class="checkpoint-note">The 30-, 10-, and 5-minute alerts appear only when an elevated GFS proxy region is selected ahead on the route. No target means no cell currently meets the heuristic thresholds; it does not mean turbulence is absent. GFS signals are not calibrated probabilities, observed PIREPs, or operational turbulence forecasts. Weather data © <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> under CC BY 4.0; this free API is for non-commercial prototypes only. iPad background notifications need a push service.</p>
    </section>
  </section>`;
};

function flightPositionAt(timestamp = Date.now()) {
  const delta = Math.max(0, (timestamp - aircraftStart.timestamp) / 3600000);
  const lat1 = aircraftStart.lat * Math.PI / 180;
  const lon1 = aircraftStart.lon * Math.PI / 180;
  const lat2 = destination.lat * Math.PI / 180;
  const lon2 = destination.lon * Math.PI / 180;
  const haversine = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  const distanceKm = Math.min(flightSpeedKmh * delta, 2 * 6371 * Math.asin(Math.sqrt(haversine)));
  const bearing = Math.atan2(Math.sin(lon2 - lon1) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1));
  const angularDistance = distanceKm / 6371;
  const lat = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing));
  const lon = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1), Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat));
  return { lat: lat * 180 / Math.PI, lon: ((lon * 180 / Math.PI + 540) % 360) - 180, bearing: bearing * 180 / Math.PI };
}

function formatCoordinate(latitude, longitude) {
  return `${Math.abs(latitude).toFixed(2)}°${latitude < 0 ? 'S' : 'N'} ${Math.abs(longitude).toFixed(2)}°${longitude < 0 ? 'W' : 'E'}`;
}

function distanceKm(from, to) {
  const radians = degrees => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.lat - from.lat);
  const longitudeDelta = radians(to.lon - from.lon);
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routeProjection(point) {
  const radians = degrees => degrees * Math.PI / 180;
  const meanLatitude = radians((aircraftStart.lat + destination.lat) / 2);
  const project = coordinate => ({
    x: radians(coordinate.lon) * Math.cos(meanLatitude) * 6371,
    y: radians(coordinate.lat) * 6371
  });
  const start = project(aircraftStart);
  const end = project(destination);
  const candidate = project(point);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const rawFraction = lengthSquared
    ? ((candidate.x - start.x) * dx + (candidate.y - start.y) * dy) / lengthSquared
    : 0;
  const fraction = Math.max(0, Math.min(1, rawFraction));
  const routeLengthKm = Math.sqrt(lengthSquared);
  return {
    fraction,
    rawFraction,
    alongRouteKm: fraction * routeLengthKm,
    crossTrackKm: Math.hypot(candidate.x - (start.x + fraction * dx), candidate.y - (start.y + fraction * dy)),
    routeLengthKm
  };
}

function reportSeverityValue(report) {
  if (report.level === 'high' || /severe|extreme/i.test(report.severity || '')) return 3;
  if (report.level === 'moderate' || /moderate/i.test(report.severity || '')) return 2;
  return 1;
}

function buildRouteExperienceRegions() {
  const routeReports = store.allCases
    .filter(report =>
      Number.isFinite(report.lat) && Number.isFinite(report.lon) &&
      report.lat >= -90 && report.lat <= 90 && report.lon >= -180 && report.lon <= 180
    )
    .map(report => ({
      ...report,
      severityValue: reportSeverityValue(report),
      projection: routeProjection({ lat: report.lat, lon: report.lon })
    }))
    .filter(report =>
      report.projection.rawFraction >= 0 &&
      report.projection.rawFraction <= 1 &&
      report.projection.crossTrackKm <= 300
    );

  const remaining = new Set(routeReports.map((_, index) => index));
  const clusters = [];
  while (remaining.size) {
    const first = remaining.values().next().value;
    remaining.delete(first);
    const members = [routeReports[first]];
    const queue = [first];
    while (queue.length) {
      const currentIndex = queue.shift();
      const current = routeReports[currentIndex];
      for (const candidateIndex of [...remaining]) {
        const candidate = routeReports[candidateIndex];
        if (distanceKm(current, candidate) <= 180) {
          remaining.delete(candidateIndex);
          queue.push(candidateIndex);
          members.push(candidate);
        }
      }
    }

    const count = members.length;
    const meanSeverity = members.reduce((sum, report) => sum + report.severityValue, 0) / count;
    const maxSeverity = Math.max(...members.map(report => report.severityValue));
    const latitude = members.reduce((sum, report) => sum + report.lat, 0) / count;
    const longitude = members.reduce((sum, report) => sum + report.lon, 0) / count;
    const alongRouteKm = members.reduce((sum, report) => sum + report.projection.alongRouteKm, 0) / count;
    const tags = [...new Set(members.flatMap(report => Array.isArray(report.tags) ? report.tags : []))];
    const severityCounts = members.reduce((counts, report) => {
      const severity = report.severityValue === 3 ? 'high' : report.severityValue === 2 ? 'moderate' : 'light';
      counts[severity] += 1;
      return counts;
    }, { light: 0, moderate: 0, high: 0 });
    clusters.push({
      id: `route-experience-${clusters.length + 1}`,
      members,
      count,
      latitude,
      longitude,
      alongRouteKm,
      meanSeverity,
      maxSeverity,
      tags,
      severityCounts
    });
  }

  const maxCount = Math.max(1, ...clusters.map(region => region.count));
  clusters.forEach(region => {
    region.score = Math.round((region.meanSeverity / 3) * 60 + (region.count / maxCount) * 40);
    region.level = region.maxSeverity === 3 ? 'high' : region.maxSeverity === 2 ? 'moderate' : 'low';
  });
  return clusters.sort((left, right) =>
    right.score - left.score || right.count - left.count || left.alongRouteKm - right.alongRouteKm
  );
}

function routePositionAtFraction(fraction) {
  const routeLengthKm = routeProjection(destination).routeLengthKm;
  const timestamp = aircraftStart.timestamp + routeLengthKm * fraction / flightSpeedKmh * 3600000;
  return flightPositionAt(timestamp);
}

function updateRouteTimingUi(position, now) {
  const progress = routeProjection(position).alongRouteKm;
  const previousProgress = routeProjection(store.previousFlightPosition || position).alongRouteKm;
  const routeLengthKm = routeProjection(destination).routeLengthKm;
  routeTimingCheckpoints.forEach((checkpoint, index) => {
    const checkpointKm = routeLengthKm * checkpoint.fraction;
    const remainingKm = Math.max(0, checkpointKm - progress);
    const etaMinutes = Math.max(
      0,
      remainingKm / flightSpeedKmh * 60 + (Number(store.timingFeedback.offsetMinutes) || 0)
    );
    const arrivalTime = now + etaMinutes * 60000;
    const minutes = Math.floor(etaMinutes);
    const seconds = Math.floor((etaMinutes - minutes) * 60);
    const checkpointPosition = routePositionAtFraction(checkpoint.fraction);
    const coordinates = formatCoordinate(checkpointPosition.lat, checkpointPosition.lon);
    const card = $(`[data-route-checkpoint="${checkpoint.id}"]`);
    const coordinate = $(`[data-route-checkpoint-coord="${checkpoint.id}"]`, card || document);
    const eta = $(`[data-route-checkpoint-eta="${checkpoint.id}"]`, card || document);
    const countdown = $(`[data-route-checkpoint-countdown="${checkpoint.id}"]`, card || document);
    const state = $(`[data-route-checkpoint-state="${checkpoint.id}"]`, card || document);
    if (coordinate) coordinate.textContent = `${coordinates} · ${Math.round(checkpointKm)} km from departure`;
    if (eta) eta.textContent = checkpoint.triggered
      ? `REACHED · ${formatUtcTime(checkpoint.triggeredAt)}`
      : `ETA ${formatUtcTime(arrivalTime)}`;
    if (countdown) countdown.textContent = checkpoint.triggered
      ? 'Pilot timing check-in requested'
      : `IN ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} · ${Math.round(remainingKm)} km`;
    if (state) state.textContent = checkpoint.acknowledged
      ? 'REPORTED' : checkpoint.triggered ? 'CHECK IN' : 'PENDING';

    const marker = routeTimingMapMarkers[index];
    if (marker) marker.setLatLng([checkpointPosition.lat, checkpointPosition.lon]);

    if (!checkpoint.triggered && previousProgress < checkpointKm && progress >= checkpointKm) {
      checkpoint.triggered = true;
      checkpoint.triggeredAt = now;
      checkpoint.lat = checkpointPosition.lat;
      checkpoint.lon = checkpointPosition.lon;
      checkpoint.kind = 'route';
      showCheckpointPrompt(checkpoint);
      void notifyCheckpoint(checkpoint);
    }
  });
}

function routeWeatherCells(cells, position = store.flightPosition || flightPositionAt()) {
  const progress = routeProjection(position).alongRouteKm;
  return cells.map(cell => {
    const projection = routeProjection({ lat: cell.latitude, lon: cell.longitude });
    const halfCellKm = cell.cellSize * 111.2 / 2;
    const regionEntryKm = projection.alongRouteKm - halfCellKm;
    const regionExitKm = projection.alongRouteKm + halfCellKm;
    const corridorKm = cell.cellSize * 111.2 * 0.72;
    const onRoute = projection.rawFraction >= 0 && projection.rawFraction <= 1 &&
      projection.crossTrackKm <= corridorKm;
    const passed = regionExitKm < progress - 1;
    const completed = store.completedWeatherTargetIds.has(cell.id ||
      `${cell.latitude.toFixed(3)},${cell.longitude.toFixed(3)}`);
    const eligible = onRoute && !passed && !completed && cell.signal >= 2;
    let reason = 'Eligible for the staged alert sequence';
    if (cell.signal < 2) reason = 'Map signal only; below alert threshold';
    else if (!onRoute) reason = 'Outside the active route corridor';
    else if (completed) reason = 'Already reached and checked in';
    else if (passed) reason = 'Region exit is behind the aircraft';
    return {
      ...cell,
      id: cell.id || `${cell.latitude.toFixed(3)},${cell.longitude.toFixed(3)}`,
      ...projection,
      progressKm: progress,
      halfCellKm,
      regionEntryKm,
      regionExitKm,
      onRoute,
      passed,
      completed,
      eligible,
      reason
    };
  });
}

function chooseAlertTarget(cells) {
  const position = store.flightPosition || flightPositionAt();
  const progress = routeProjection(position).alongRouteKm;
  const candidates = routeWeatherCells(cells, position)
    .filter(cell => cell.eligible && cell.regionExitKm >= progress - 1);

  candidates.sort((left, right) => {
    const priority = right.signal - left.signal;
    if (priority) return priority;
    const distance = left.regionEntryKm - right.regionEntryKm;
    if (distance) return distance;
    const crossTrack = left.crossTrackKm - right.crossTrackKm;
    if (crossTrack) return crossTrack;
    return right.shear - left.shear;
  });
  return candidates[0] || null;
}

function alertRegionEtaMinutes(position = store.flightPosition || flightPositionAt()) {
  const target = store.weatherProxyTarget;
  if (!target) return null;
  const progress = routeProjection(position).alongRouteKm;
  const remainingKm = Math.max(0, target.regionEntryKm - progress);
  return remainingKm / flightSpeedKmh * 60;
}

function formatUtcTime(timestamp) {
  return `${new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(timestamp))}Z`;
}

function updateCheckpointCoordinates() {
  const target = store.weatherProxyTarget;
  const regionEta = alertRegionEtaMinutes();
  checkpoints.forEach(checkpoint => {
    if (!target || regionEta === null || checkpoint.triggered) return;
    const alertInMinutes = Math.max(0, regionEta + (store.timingFeedback.offsetMinutes || 0) - checkpoint.leadMinutes);
    Object.assign(checkpoint, flightPositionAt(Date.now() + alertInMinutes * 60_000));
  });
  checkpointMapMarkers.forEach(({ checkpoint, marker }) => {
    if (Number.isFinite(checkpoint.lat) && Number.isFinite(checkpoint.lon)) marker.setLatLng([checkpoint.lat, checkpoint.lon]);
  });
  if (target && alertTargetMarker && routeMap) {
    alertTargetMarker.setLatLng([target.latitude, target.longitude]);
    if (weatherProxyLayerRef && !weatherProxyLayerRef.hasLayer(alertTargetMarker)) {
      alertTargetMarker.addTo(weatherProxyLayerRef);
    }
  }
}

function popupContent(title, details) {
  const content = document.createElement('div');
  content.className = 'map-popup';
  const heading = document.createElement('strong');
  heading.textContent = title;
  content.append(heading);
  details.forEach(detail => {
    const line = document.createElement('span');
    line.textContent = detail;
    content.append(line);
  });
  return content;
}

async function loadPirepRegionModel() {
  if (!pirepRegionModelPromise) {
    pirepRegionModelPromise = fetch('/pirep-region-model.json')
      .then(response => {
        if (!response.ok) throw new Error(`PIREP model request failed: ${response.status}`);
        return response.json();
      })
      .then(model => {
        if (
          model.version !== 1 ||
          !Array.isArray(model.regions) ||
          !Number.isFinite(model.resolutionDegrees) ||
          !Number.isFinite(model.routeSupportRadiusKm)
        ) {
          throw new Error('PIREP region model has an unsupported format');
        }
        return model;
      });
  }
  return pirepRegionModelPromise;
}

function buildWeatherProxyGrid() {
  const locations = new Map();
  weatherProxyAreas.forEach(area => {
    const cellSize = area.cellSize || weatherProxyCellSize;
    for (let latitude = area.south; latitude <= area.north; latitude += cellSize) {
      for (let longitude = area.west; longitude <= area.east; longitude += cellSize) {
        const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
        if (!locations.has(key)) locations.set(key, { latitude, longitude, cellSize });
      }
    }
  });
  return [...locations.values()];
}

function weatherProxyLevel(hourly, index) {
  const values = [
    hourly.wind_speed_250hPa?.[index],
    hourly.wind_direction_250hPa?.[index],
    hourly.wind_speed_300hPa?.[index],
    hourly.wind_direction_300hPa?.[index],
    hourly.cape?.[index],
    hourly.precipitation?.[index],
    hourly.cloud_cover_mid?.[index]
  ];
  if (!values.every(Number.isFinite)) return null;

  const windVector = (speed, direction) => {
    const radians = direction * Math.PI / 180;
    return { east: -speed * Math.sin(radians), north: -speed * Math.cos(radians) };
  };
  const upperWind = windVector(values[0], values[1]);
  const lowerWind = windVector(values[2], values[3]);
  const vectorShear = Math.hypot(
    upperWind.east - lowerWind.east,
    upperWind.north - lowerWind.north
  );
  const shearMetersPerSecondPerKm = vectorShear / 3.6 / 1.5;
  const shearSignal = shearMetersPerSecondPerKm >= 18 ? 3
    : shearMetersPerSecondPerKm >= 12 ? 2
      : shearMetersPerSecondPerKm >= 7 ? 1 : 0;
  const convectiveSignal = values[4] >= 2000 && values[5] >= 0.5 ? 3
    : values[4] >= 1000 && values[5] >= 0.2 ? 2
      : values[4] >= 600 && values[6] >= 85 ? 1 : 0;
  const signal = Math.max(shearSignal, convectiveSignal);
  if (signal === 0) return null;
  return {
    signal,
    shear: Math.round(shearMetersPerSecondPerKm * 10) / 10,
    cape: Math.round(values[4]),
    precipitation: Math.round(values[5] * 10) / 10,
    midCloud: Math.round(values[6])
  };
}

function refreshWeatherProxyTarget(cells, hasError = false) {
  const target = chooseAlertTarget(cells);
  const previousId = store.weatherProxyTarget?.id || null;
  const targetId = target ? `${target.latitude.toFixed(3)},${target.longitude.toFixed(3)}` : null;
  if (previousId !== targetId) {
    checkpoints.forEach(checkpoint => {
      checkpoint.triggered = false;
      checkpoint.acknowledged = false;
      checkpoint.missed = false;
    });
    store.alertRegionReached = false;
  }
  store.weatherProxyTarget = target ? { ...target, id: targetId } : null;
  store.weatherProxyLoaded = true;
  store.weatherProxyError = hasError;

  const name = $('#alert-target-name');
  if (name) name.textContent = target
    ? formatCoordinate(target.latitude, target.longitude)
    : hasError ? 'weather data unavailable' : 'no elevated region ahead';
  const level = target ? (target.signal === 3 ? 'high' : 'moderate') : 'low';
  const levelText = target ? (target.signal === 3 ? 'HIGHER MODEL SIGNAL' : 'ELEVATED MODEL SIGNAL')
    : hasError ? 'MODEL UNAVAILABLE' : 'NO ELEVATED REGION';
  const regionText = target ? formatCoordinate(target.latitude, target.longitude)
    : hasError ? 'Weather model unavailable' : 'No elevated proxy region selected';
  const detailsText = target
    ? `${target.signal === 3 ? 'Red · higher-signal' : 'Yellow · elevated'} GFS region selected · ${target.shear} m/s/km shear proxy · ${target.crossTrackKm.toFixed(0)} km from route. Higher-signal eligible regions take priority; nearest entry is selected within a signal level.`
    : hasError ? 'Weather data could not be loaded; staged turbulence alerts are unavailable. Route timing checkpoints remain active.'
      : 'No elevated GFS proxy cell meets the route and signal thresholds right now. This does not confirm smooth air; route timing checkpoints remain active.';
  checkpoints.forEach((checkpoint, index) => {
    const card = $(`[data-alert-stage="${checkpoint.id}"]`);
    if (card) {
      card.classList.remove('high', 'moderate', 'low');
      card.classList.add(level);
      const pill = $('.risk-pill', card);
      if (pill) {
        pill.classList.remove('high', 'moderate', 'low');
        pill.classList.add(level);
        const label = $('i', pill);
        pill.textContent = levelText;
        if (label) pill.prepend(label);
      }
      const region = $(`[data-alert-region="${checkpoint.id}"]`, card);
      const details = $(`[data-alert-detail="${checkpoint.id}"]`, card);
      const button = $('[data-action="details"]', card);
      if (region) region.textContent = regionText;
      if (details) details.textContent = detailsText;
      if (button) button.disabled = !target;
    }

    const sequenceCard = $(`[data-checkpoint="${checkpoint.id}"]`);
    if (sequenceCard) {
      sequenceCard.classList.remove('high', 'moderate', 'low');
      sequenceCard.classList.add(level);
      const coordinate = $(`[data-checkpoint-coord="${checkpoint.id}"]`, sequenceCard);
      if (coordinate) coordinate.textContent = target
        ? `${checkpoint.action} · ${formatCoordinate(target.latitude, target.longitude)}`
        : store.weatherProxyError ? 'Weather data unavailable; staged alerts are disabled.'
          : store.weatherProxyLoaded ? 'No elevated region meets the proxy thresholds; route checkpoints remain active.' : checkpoint.action;
      const state = $(`[data-checkpoint-state="${checkpoint.id}"]`, sequenceCard);
      if (state && !checkpoint.triggered) state.textContent = target
        ? 'PENDING' : hasError ? 'UNAVAILABLE' : 'NO TARGET';
    }
    if (checkpointMapMarkers[index]) {
      const marker = checkpointMapMarkers[index].marker;
      marker.setOpacity(target ? 1 : 0);
      const markerElement = marker.getElement();
      markerElement?.classList.toggle('high', target?.signal === 3);
    }
  });

  if (target && routeMap) {
    const targetBounds = [
      [target.latitude - target.cellSize / 2, target.longitude - target.cellSize / 2],
      [target.latitude + target.cellSize / 2, target.longitude + target.cellSize / 2]
    ];
    if (weatherProxyLayerRef) {
      if (store.alertTargetOutline) weatherProxyLayerRef.removeLayer(store.alertTargetOutline);
      store.alertTargetOutline = L.rectangle(targetBounds, {
        color: '#ffffff',
        weight: 3,
        opacity: 1,
        fillOpacity: 0,
        dashArray: '7 5',
        className: `selected-alert-region signal-${target.signal}`
      }).bindPopup(popupContent('SELECTED ALERT REGION · GFS PROXY', [
        `${target.signal === 3 ? 'Red · higher' : 'Yellow · elevated'} heuristic signal · priority selected`,
        `${target.shear} m/s/km upper-level wind shear proxy`,
        'The 30-, 10-, and 5-minute alerts all refer to this region.',
        'Not a calibrated probability or operational turbulence forecast.'
      ])).addTo(weatherProxyLayerRef);
      store.alertTargetOutline.bringToFront();
    }
    if (alertTargetMarker) {
      alertTargetMarker.setLatLng([target.latitude, target.longitude]);
      if (weatherProxyLayerRef && !weatherProxyLayerRef.hasLayer(alertTargetMarker)) {
        alertTargetMarker.addTo(weatherProxyLayerRef);
      }
    }
  } else {
    if (store.alertTargetOutline && weatherProxyLayerRef) weatherProxyLayerRef.removeLayer(store.alertTargetOutline);
    if (alertTargetMarker && weatherProxyLayerRef) weatherProxyLayerRef.removeLayer(alertTargetMarker);
  }

  updateCheckpointCoordinates();
  updateCheckpointUi();
}

async function fetchWeatherProxyBatch(locations) {
  const parameters = new URLSearchParams({
    latitude: locations.map(location => location.latitude).join(','),
    longitude: locations.map(location => location.longitude).join(','),
    hourly: 'wind_speed_250hPa,wind_direction_250hPa,wind_speed_300hPa,wind_direction_300hPa,cape,precipitation,cloud_cover_mid',
    forecast_days: '1',
    timezone: 'UTC'
  });
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/gfs?${parameters}`, {
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`Open-Meteo GFS request failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    const results = Array.isArray(payload) ? payload : [payload];
    if (results.length !== locations.length) {
      throw new Error(`Open-Meteo returned ${results.length} locations for ${locations.length} requested`);
    }
    const desiredHour = new Date();
    desiredHour.setUTCMinutes(0, 0, 0);
    if (new Date().getUTCMinutes() > 0) desiredHour.setUTCHours(desiredHour.getUTCHours() + 1);
    const desiredTime = desiredHour.toISOString().slice(0, 16);

    return results.flatMap((result, index) => {
      const hourly = result?.hourly;
      if (!Array.isArray(hourly?.time)) return [];
      let timeIndex = hourly.time.findIndex(time => time >= desiredTime);
      if (timeIndex < 0) timeIndex = hourly.time.length - 1;
      const risk = weatherProxyLevel(hourly, timeIndex);
      if (!risk || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) return [];
      return [{
        latitude: result.latitude,
        longitude: result.longitude,
        cellSize: locations[index].cellSize,
        time: hourly.time[timeIndex],
        ...risk
      }];
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchWeatherProxyBatchWithRetry(locations) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchWeatherProxyBatch(locations);
    } catch (error) {
      const retryable = error.status === 429 || error.status >= 500;
      if (!retryable || attempt >= 2) throw error;
      await new Promise(resolve => window.setTimeout(resolve, 1200 * (attempt + 1)));
    }
  }
}

async function loadWeatherProxyModel() {
  if (weatherProxyModelPromise) return weatherProxyModelPromise;
  const cached = readStoredJson(weatherProxyCacheKey, null);
  if (
    cached &&
    Number.isFinite(cached.fetchedAt) &&
    Date.now() - cached.fetchedAt < weatherProxyCacheDuration &&
    Array.isArray(cached.cells)
  ) {
    weatherProxyModelPromise = Promise.resolve(cached);
    return weatherProxyModelPromise;
  }

  weatherProxyModelPromise = (async () => {
    const locations = buildWeatherProxyGrid();
    const batches = [];
    for (let index = 0; index < locations.length; index += 50) {
      batches.push(locations.slice(index, index + 50));
    }
    const results = [];
    for (let index = 0; index < batches.length; index += 3) {
      results.push(...await Promise.allSettled(
        batches.slice(index, index + 3).map(fetchWeatherProxyBatchWithRetry)
      ));
    }
    const cells = [];
    let failedBatches = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        cells.push(...result.value);
      } else {
        failedBatches += 1;
        console.error(`Unable to load Open-Meteo GFS batch ${index + 1}`, result.reason);
      }
    });
    if (!cells.length) throw new Error('Open-Meteo GFS returned no usable regional forecasts');

    const model = {
      fetchedAt: Date.now(),
      validTime: cells[0].time,
      requestedLocations: locations.length,
      failedBatches,
      cells
    };
    try {
      localStorage.setItem(weatherProxyCacheKey, JSON.stringify(model));
    } catch (error) {
      console.error('Unable to cache Open-Meteo weather proxy data', error);
    }
    return model;
  })();
  try {
    return await weatherProxyModelPromise;
  } catch (error) {
    weatherProxyModelPromise = null;
    throw error;
  }
}

async function populateWeatherProxyLayer(layer) {
  const status = $('#map-weather-status');
  if (status) {
    status.textContent = `Loading Open-Meteo GFS for ${buildWeatherProxyGrid().length} focus-region locations...`;
  }
  try {
    const model = await loadWeatherProxyModel();
    store.weatherProxyModel = model;
    refreshWeatherProxyTarget(model.cells);
    const signalColors = { 1: '#10b981', 2: '#f59e0b', 3: '#ef4444' };
    model.cells.forEach(cell => {
      const color = signalColors[cell.signal];
      const halfCell = cell.cellSize / 2;
      const bounds = [
        [cell.latitude - halfCell, cell.longitude - halfCell],
        [cell.latitude + halfCell, cell.longitude + halfCell]
      ];
      L.rectangle(bounds, {
        color,
        weight: 1,
        opacity: 0.62,
        fillColor: color,
        fillOpacity: cell.signal === 3 ? 0.28 : cell.signal === 2 ? 0.22 : 0.16,
        className: `gfs-weather-region signal-${cell.signal}`
      }).bindPopup(popupContent('GFS WEATHER-MODEL SIGNAL · NOT A PIREP', [
        `Forecast valid ${cell.time} UTC`,
        `Upper-level vector wind shear proxy: ${cell.shear} m/s/km`,
        `CAPE ${cell.cape} J/kg · precipitation ${cell.precipitation} mm/h · mid-cloud ${cell.midCloud}%`,
        'Coarse-grid heuristic · not an operational turbulence forecast'
      ])).addTo(layer);
    });
    store.alertTargetOutline?.bringToFront();
    if (status) {
      const coverage = `${model.cells.length} elevated-signal cells · ${model.requestedLocations} grid samples · valid ${model.validTime} UTC`;
      status.textContent = model.failedBatches
        ? `PARTIAL GFS DATA · ${coverage} · ${model.failedBatches} batches unavailable`
        : `GFS WEATHER PROXY · ${coverage} · Asia 3° / US 4° grid · NOT OPERATIONAL`;
    }
  } catch (error) {
    console.error('Unable to load global GFS weather proxy', error);
    weatherProxyModelPromise = null;
    refreshWeatherProxyTarget([], true);
    if (status) status.textContent = 'GFS weather proxy unavailable. Check network and retry the layer.';
  }
}

function ensureWeatherProxyForInsights() {
  if (store.weatherProxyModel || store.weatherProxyLoaded || insightsWeatherProxyPromise) return;
  insightsWeatherProxyPromise = (async () => {
    try {
      const model = await loadWeatherProxyModel();
      store.weatherProxyModel = model;
      refreshWeatherProxyTarget(model.cells);
    } catch (error) {
      console.error('Unable to load GFS weather proxy for Insights', error);
      store.weatherProxyLoaded = true;
      store.weatherProxyError = true;
    } finally {
      insightsWeatherProxyPromise = null;
      if (store.page === 'insights') render();
    }
  })();
}

async function populatePirepRegionLayer(regionLayer) {
  const status = $('#map-model-status');
  try {
    const model = await loadPirepRegionModel();
    const colors = { low: '#10b981', moderate: '#f59e0b', high: '#ef4444' };
    model.regions.forEach(region => {
      const [south, west, count, level, intensity, light, moderate, severe] = region;
      const color = colors[level];
      if (
        ![south, west, count, intensity, light, moderate, severe].every(Number.isFinite) ||
        !color
      ) {
        throw new Error('PIREP region model contains an invalid region');
      }
      const regionPath = L.rectangle(
        [
          [south, west],
          [south + model.resolutionDegrees, west + model.resolutionDegrees]
        ],
        {
          color,
          weight: 0.6,
          opacity: 0.38,
          fillColor: color,
          fillOpacity: Math.min(0.52, 0.2 + Math.log2(count) * 0.045),
          className: `pirep-region ${level}`
        }
      );
      regionPath.bindPopup(popupContent(`${level.toUpperCase()} HISTORICAL INTENSITY REGION`, [
        `${count} labeled turbulence reports`,
        `Mean reported intensity: ${intensity.toFixed(2)} / 3`,
        `Light ${light} · Moderate ${moderate} · Severe ${severe}`,
        model.flightLevelBand,
        `Dataset dates: ${model.dateRange[0]} to ${model.dateRange[1]}`
      ]));
      regionPath.addTo(regionLayer);
    });

    if (status) {
      const dateRange = model.dateRange.length
        ? `${model.dateRange[0].slice(0, 7)} to ${model.dateRange[1].slice(0, 7)}`
        : 'unknown dates';
      const globalSummary = `${model.regions.length.toLocaleString()} cells · ${model.flightLevelTrainingReports.toLocaleString()} ${model.flightLevelBand} reports · ${dateRange}`;
      status.textContent = model.routeReportsWithinSupport === 0
        ? `${globalSummary} · No reports within ${model.routeSupportRadiusKm} km; no local regions.`
        : `${globalSummary} · ${model.routeReportsWithinSupport} reports within ${model.routeSupportRadiusKm} km.`;
    }
  } catch (error) {
    console.error('Unable to load PIREP region model', error);
    pirepRegionModelPromise = null;
    if (status) status.textContent = 'PIREP region model unavailable. Rebuild it from the uploaded dataset and reload.';
  }
}

function populateRouteExperienceLayer(layer) {
  layer.clearLayers();
  const regions = buildRouteExperienceRegions();
  const status = $('#map-route-experience-status');
  if (!regions.length) {
    if (status) {
      status.textContent = 'ROUTE REPORTS · No available pilot reports within 300 km of this route.';
    }
    return;
  }

  const colors = { low: '#10b981', moderate: '#f59e0b', high: '#ef4444' };
  regions.forEach(region => {
    const color = colors[region.level];
    const radiusKm = Math.min(115, 48 + Math.max(0, region.count - 1) * 13);
    const marker = L.circle([region.latitude, region.longitude], {
      radius: radiusKm * 1000,
      color,
      weight: region.level === 'high' ? 3 : 2,
      opacity: 0.94,
      fillColor: color,
      fillOpacity: region.level === 'high' ? 0.32 : region.level === 'moderate' ? 0.27 : 0.2,
      className: `route-experience-region ${region.level}`
    });
    const severity = `${region.severityCounts.high} severe · ${region.severityCounts.moderate} moderate · ${region.severityCounts.light} light`;
    const examples = region.members.slice(0, 4).map(report =>
      `${report.date || 'Date not recorded'} · ${report.severity || 'Intensity not recorded'} · ${report.aircraft || 'Aircraft not recorded'}`
    );
    marker.bindPopup(popupContent(`${region.level.toUpperCase()} ROUTE EXPERIENCE CLUSTER`, [
      `Route experience score: ${region.score}/100 · 60% mean reported severity + 40% relative report support`,
      'Comparative historical index only; not a turbulence probability or forecast.',
      `${region.count} pilot report${region.count === 1 ? '' : 's'} clustered within approximately 180 km`,
      `Severity mix: ${severity}`,
      `Cluster center: ${formatCoordinate(region.latitude, region.longitude)}`,
      ...region.tags.map(tag => `Reported condition: ${tag}`),
      ...examples,
      'Highlight is an approximate report cluster, not a measured turbulence boundary.'
    ]));
    marker.addTo(layer);

    const label = L.marker([region.latitude, region.longitude], {
      icon: L.divIcon({
        className: `route-experience-label ${region.level}`,
        html: '<span aria-hidden="true">!</span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      }),
      title: `${region.level.toUpperCase()} route report region · ${region.count} report${region.count === 1 ? '' : 's'} · score ${region.score}/100`,
      interactive: true,
      zIndexOffset: 600
    });
    label.bindTooltip(
      `${region.level.toUpperCase()} · ${region.count} report${region.count === 1 ? '' : 's'} · score ${region.score}/100`,
      { direction: 'top', offset: [0, -8], className: 'map-glass-tooltip' }
    );
    label.on('click', () => marker.openPopup());
    label.addTo(layer);
  });

  const totalReports = regions.reduce((sum, region) => sum + region.count, 0);
  const highest = regions[0];
  if (status) {
    status.textContent = `${totalReports} route report${totalReports === 1 ? '' : 's'} · ${regions.length} clustered region${regions.length === 1 ? '' : 's'} · highest ${highest.level.toUpperCase()} · ${highest.count} case${highest.count === 1 ? '' : 's'} · score ${highest.score}/100`;
  }
}

function initializeFlightMap() {
  const element = $('#live-map');
  if (!element) return;
  [
    ['#map-model-status', 'Historical PIREP dataset status'],
    ['#map-route-experience-status', 'Route report cluster status'],
    ['#map-weather-status', 'GFS weather proxy status']
  ].forEach(([selector, label]) => {
    const status = $(selector);
    if (!status) return;
    status.tabIndex = 0;
    status.setAttribute('aria-label', label);
    status.title = 'Hover or focus to view details';
  });
  routeMap = L.map(element, { zoomControl: false, attributionControl: true, scrollWheelZoom: true });
  const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    subdomains: 'abc',
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
  }).addTo(routeMap);
  tileLayer.on('load', () => {
    const status = $('.map-source');
    if (status) status.textContent = 'LIVE MAP · OPENSTREETMAP';
  });
  tileLayer.on('tileerror', () => {
    const status = $('.map-source');
    if (status) status.textContent = 'Map tiles unavailable · Check network connection';
  });

  const weatherLayer = L.layerGroup();
  const routeExperienceLayer = L.layerGroup();
  const weatherProxyLayer = L.layerGroup();
  const jetstreamLayer = L.layerGroup();
  weatherProxyLayerRef = weatherProxyLayer;
  if (store.layers.weather) weatherLayer.addTo(routeMap);
  if (store.layers.routeExperiences) routeExperienceLayer.addTo(routeMap);
  populateRouteExperienceLayer(routeExperienceLayer);
  if (store.layers.weatherProxy) {
    weatherProxyLayer.addTo(routeMap);
    void populateWeatherProxyLayer(weatherProxyLayer);
  }
  if (store.layers.jet) jetstreamLayer.addTo(routeMap);
  void populatePirepRegionLayer(weatherLayer);
  const routeLayer = L.layerGroup().addTo(routeMap);
  const origin = [aircraftStart.lat, aircraftStart.lon];
  const arrival = [destination.lat, destination.lon];
  const points = [];
  const start = L.latLng(origin);
  const end = L.latLng(arrival);
  const totalDistance = start.distanceTo(end);
  const startBearing = Math.atan2(Math.sin(end.lng * Math.PI / 180 - start.lng * Math.PI / 180) * Math.cos(end.lat * Math.PI / 180), Math.cos(start.lat * Math.PI / 180) * Math.sin(end.lat * Math.PI / 180) - Math.sin(start.lat * Math.PI / 180) * Math.cos(end.lat * Math.PI / 180) * Math.cos((end.lng - start.lng) * Math.PI / 180));
  for (let index = 0; index <= 60; index++) {
    const angularDistance = (totalDistance / 1000 / 6371) * (index / 60);
    const lat1 = start.lat * Math.PI / 180;
    const lon1 = start.lng * Math.PI / 180;
    const lat = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(startBearing));
    const lon = lon1 + Math.atan2(Math.sin(startBearing) * Math.sin(angularDistance) * Math.cos(lat1), Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat));
    points.push([lat * 180 / Math.PI, lon * 180 / Math.PI]);
  }
  L.polyline(points, { color: '#b5c8d3', weight: 3, opacity: 0.62, dashArray: '5 8' }).addTo(routeLayer);
  flownRoute = L.polyline([origin, [aircraftStart.lat, aircraftStart.lon]], { color: '#38d6ef', weight: 4, opacity: 0.95 }).addTo(routeLayer);

  const originAirport = airports[store.flight.origin];
  const destinationAirport = airports[store.flight.destination];
  [
    { code: store.flight.origin, name: originAirport.name, label: 'DEPARTURE', symbol: '●', position: origin },
    { code: store.flight.destination, name: destinationAirport.name, label: 'ARRIVAL', symbol: '◆', position: arrival }
  ].forEach(airport => {
    L.circleMarker(airport.position, { radius: 6, color: '#7de8ff', weight: 2, fillColor: '#eafaff', fillOpacity: 1 })
      .bindPopup(popupContent(airport.code, [airport.name]))
      .addTo(routeLayer);
    L.marker(airport.position, {
      icon: L.divIcon({
        className: `airport-route-symbol ${airport.label.toLowerCase()}`,
        html: `<span aria-hidden="true">${airport.symbol}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      }),
      title: `${airport.label}: ${airport.code} · ${airport.name}`,
      alt: `${airport.label}: ${airport.code} · ${airport.name}`,
      zIndexOffset: 800
    })
      .bindTooltip(`<strong>${airport.label}</strong> · ${airport.code}<br>${escapeHtml(airport.name)}`, {
        direction: 'top',
        offset: [0, -9],
        className: 'map-glass-tooltip'
      })
      .addTo(routeLayer);
  });

  const direction = routePositionAtFraction(0.15);
  L.marker([direction.lat, direction.lon], {
    icon: L.divIcon({
      className: 'route-direction-icon',
      html: `<span aria-label="Route direction from ${store.flight.origin} to ${store.flight.destination}" style="transform:rotate(${(direction.bearing + 360) % 360}deg)">▲</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    }),
    interactive: false,
    zIndexOffset: 450
  }).addTo(routeLayer);

  checkpoints.forEach(checkpoint => {
    const position = flightPositionAt();
    Object.assign(checkpoint, position);
    const badge = L.marker([checkpoint.lat, checkpoint.lon], {
      icon: L.divIcon({
        className: 'checkpoint-map-icon alert-stage-marker',
        html: `<span>${checkpoint.leadMinutes}</span>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      }),
      title: `${checkpoint.leadMinutes}-minute alert checkpoint`,
      zIndexOffset: 300
    }).bindTooltip(`${checkpoint.leadMinutes}-minute alert checkpoint`, {
      direction: 'top',
      offset: [0, -7],
      className: 'map-glass-tooltip'
    }).addTo(routeLayer);
    checkpointMapMarkers.push({ checkpoint, marker: badge });
    badge.setOpacity(0);
  });
  routeTimingMapMarkers = [];
  routeTimingCheckpoints.forEach((checkpoint, index) => {
    const position = routePositionAtFraction(checkpoint.fraction);
    const marker = L.marker([position.lat, position.lon], {
      icon: L.divIcon({
        className: 'route-timing-map-icon',
        html: `<span>${index + 1}</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      }),
      title: `Route checkpoint ${Math.round(checkpoint.fraction * 100)}%`,
      zIndexOffset: 500
    }).bindTooltip(`Route checkpoint · ${Math.round(checkpoint.fraction * 100)}%`, {
      direction: 'top',
      offset: [0, -7],
      className: 'map-glass-tooltip'
    }).addTo(routeLayer);
    routeTimingMapMarkers.push(marker);
  });

  alertTargetMarker = L.marker([destination.lat, destination.lon], {
    icon: L.divIcon({
      className: 'alert-target-map-icon',
      html: '<span aria-hidden="true">⊙</span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    }),
    title: 'Selected turbulence alert region',
    zIndexOffset: 700
  }).bindPopup(popupContent('SELECTED ALERT REGION', [
    'The 30-, 10-, and 5-minute alert stages refer to this one region.',
    'GFS weather proxy; not an operational turbulence forecast.'
  ])).bindTooltip('Selected turbulence alert region', {
    direction: 'top',
    offset: [0, -8],
    className: 'map-glass-tooltip'
  });

  L.polyline([[17.5, 58.2], [18.1, 63.5], [16.4, 68.8], [14.8, 74.4]], {
    color: '#7ac9f5', weight: 3, opacity: 0.85, dashArray: '8 8'
  }).bindPopup(popupContent('Jetstream', ['Forecast axis · approximately 90 kt'])).addTo(jetstreamLayer);

  const icon = L.divIcon({
    className: 'aircraft-div-icon',
    html: '<div class="live-plane-icon">✈</div>',
    iconSize: [42, 42],
    iconAnchor: [21, 21]
  });
  const aircraft = flightPositionAt();
  aircraftMarker = L.marker([aircraft.lat, aircraft.lon], { icon, zIndexOffset: 1000 })
    .bindPopup(popupContent(`${store.flight.callsign} · LIVE POSITION`, [
      `${store.flight.aircraft} · FL${store.flight.altitude}`,
      `${store.flight.cruiseSpeedKmh} km/h planned cruise speed`,
      formatCoordinate(aircraft.lat, aircraft.lon)
    ]))
    .addTo(routeMap);

  const mapCase = store.allCases.find(report => report.id === store.mapCenter);
  if (mapCase) routeMap.setView([mapCase.lat, mapCase.lon], store.mapZoom || 7);
  else if (store.followAircraft) {
    const position = flightPositionAt();
    routeMap.setView([position.lat, position.lon], store.mapView?.zoom || 8);
  }
  else if (store.mapView) routeMap.setView(store.mapView.center, store.mapView.zoom);
  else routeMap.fitBounds(L.latLngBounds([origin, arrival]), { padding: [35, 35], maxZoom: 5 });

  routeMap.on('moveend zoomend', () => {
    store.mapView = { center: routeMap.getCenter(), zoom: routeMap.getZoom() };
  });
  updateFlightMap();
  routeMap.on('dragstart', () => {
    store.followAircraft = false;
    store.mapCenter = null;
    $('[data-action="recenter"]')?.setAttribute('aria-pressed', 'false');
  });
  requestAnimationFrame(() => routeMap?.invalidateSize());

  $$('[data-action="zoom-in"]').forEach(button => button.onclick = () => routeMap?.zoomIn());
  $$('[data-action="zoom-out"]').forEach(button => button.onclick = () => routeMap?.zoomOut());
  const followButton = $('[data-action="recenter"]');
  if (followButton) followButton.onclick = () => {
    store.mapCenter = null;
    store.followAircraft = true;
    const position = flightPositionAt();
    routeMap?.setView([position.lat, position.lon], 8, { animate: true });
    followButton.setAttribute('aria-pressed', 'true');
    toast('Following aircraft', `${formatCoordinate(position.lat, position.lon)} · FL${store.flight.altitude}`);
  };
  const layerGroups = {
    weather: weatherLayer,
    routeExperiences: routeExperienceLayer,
    weatherProxy: weatherProxyLayer,
    jet: jetstreamLayer
  };
  $$('[data-layer]').forEach(button => button.onclick = () => {
    const name = button.dataset.layer;
    store.layers[name] = !store.layers[name];
    if (store.layers[name]) {
      layerGroups[name].addTo(routeMap);
      if (name === 'routeExperiences' && !routeExperienceLayer.getLayers().length) {
        populateRouteExperienceLayer(routeExperienceLayer);
      }
      if (name === 'weatherProxy' && !weatherProxyLayer.getLayers().length) {
        void populateWeatherProxyLayer(weatherProxyLayer);
      }
    }
    else routeMap.removeLayer(layerGroups[name]);
    button.classList.toggle('on', store.layers[name]);
    button.setAttribute('aria-pressed', String(store.layers[name]));
    try {
      localStorage.setItem('ta-layers', JSON.stringify(store.layers));
    } catch (error) {
      console.error('Unable to save map layer preferences', error);
    }
  });
  const layerButton = $('[data-action="layers"]');
  if (layerButton) layerButton.onclick = () => {
    const controls = $('.map-tools');
    controls.hidden = !controls.hidden;
    layerButton.setAttribute('aria-expanded', String(!controls.hidden));
  };
  $('[data-action="notifications"]')?.addEventListener('click', event => {
    void enableCheckpointNotifications(event.currentTarget);
  });
  $$('[data-action="map-case"]').forEach(button => button.onclick = () => {
    store.mapCenter = button.dataset.case;
    store.mapZoom = 7;
    setPage('route');
  });
}

function updateFlightMap() {
  const position = flightPositionAt();
  store.previousFlightPosition = store.flightPosition || position;
  store.flightPosition = position;
  if (!routeMap || !aircraftMarker) return;
  aircraftMarker.setLatLng([position.lat, position.lon]);
  if (store.followAircraft && routeMap.getCenter().distanceTo([position.lat, position.lon]) > 1) {
    routeMap.panTo([position.lat, position.lon], { animate: true, duration: 1 });
  }
  const plane = aircraftMarker.getElement()?.querySelector('.live-plane-icon');
  if (plane) plane.style.setProperty('--heading', `${position.bearing}deg`);
  if (flownRoute) flownRoute.setLatLngs([[aircraftStart.lat, aircraftStart.lon], [position.lat, position.lon]]);
  if (positionReadout) positionReadout.textContent = formatCoordinate(position.lat, position.lon);
}

function segmentDistanceKm(point, start, end) {
  const radians = degrees => degrees * Math.PI / 180;
  const meanLatitude = radians((start.lat + end.lat) / 2);
  const project = coordinate => ({
    x: radians(coordinate.lon) * Math.cos(meanLatitude) * 6371,
    y: radians(coordinate.lat) * 6371
  });
  const p = project(point);
  const a = project(start);
  const b = project(end);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(p.x - (a.x + fraction * dx), p.y - (a.y + fraction * dy));
}

let checkpointPromptQueue = [];
function showCheckpointPrompt(checkpoint) {
  if ($('#checkpoint-prompt')) {
    checkpointPromptQueue.push(checkpoint);
    return;
  }
  const overlay = document.createElement('div');
  overlay.id = 'checkpoint-prompt';
  overlay.className = 'checkpoint-prompt-backdrop';
  overlay.setAttribute('role', 'presentation');
  const dialog = document.createElement('section');
  dialog.className = `checkpoint-prompt ${checkpoint.level || 'moderate'}`;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'checkpoint-prompt-title');
  const heading = document.createElement('div');
  heading.className = 'eyebrow';
  heading.textContent = `${checkpoint.kind === 'route' ? 'ROUTE TIMING CHECKPOINT' : 'PREDICTED REGION CHECK-IN'} · ${store.flight?.callsign || 'FLIGHT'}`;
  const title = document.createElement('h2');
  title.id = 'checkpoint-prompt-title';
  title.textContent = checkpoint.kind === 'route'
    ? `Have you reached ${checkpoint.name}?`
    : 'Have you reached the selected turbulence region?';
  const detail = document.createElement('p');
  detail.textContent = checkpoint.kind === 'route'
    ? `Calculated checkpoint ${formatCoordinate(checkpoint.lat, checkpoint.lon)} · predicted ${formatUtcTime(checkpoint.triggeredAt)}. Report your timing to refine upcoming estimates.`
    : `Calculated region entry: ${formatUtcTime(checkpoint.triggeredAt)} · report whether you are ahead, on time, or behind.`;
  const choices = document.createElement('div');
  choices.className = 'checkpoint-response-options';
  const answers = [
    { label: 'Ahead of schedule', status: 'ahead', delta: -5 },
    { label: 'On time', status: 'on-time', delta: 0 },
    { label: 'Behind schedule', status: 'behind', delta: 5 }
  ];
  answers.forEach(answer => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = answer.label;
    button.addEventListener('click', () => {
      checkpoint.acknowledged = true;
      store.timingFeedback.responses[checkpoint.id] = {
        status: answer.status,
        deltaMinutes: answer.delta,
        reportedAt: new Date().toISOString()
      };
      const previousOffset = Number(store.timingFeedback.offsetMinutes) || 0;
      store.timingFeedback.offsetMinutes = Math.round(previousOffset * 0.5 + answer.delta * 0.5);
      store.timingFeedback.lastReport = checkpoint.id;
      try {
        localStorage.setItem('ta-checkpoint-feedback', JSON.stringify(store.timingFeedback));
      } catch (error) {
        console.error('Unable to save checkpoint timing feedback', error);
        toast('Feedback kept for this session', 'Browser storage is unavailable; timing corrections may not persist.');
      }
      updateCheckpointCoordinates();
      overlay.remove();
      updateCheckpointUi();
      toast('Checkpoint timing updated', `Pilot reported ${answer.status}; upcoming route ETAs adjusted ${store.timingFeedback.offsetMinutes > 0 ? '+' : ''}${store.timingFeedback.offsetMinutes} min.`);
      const next = checkpointPromptQueue.shift();
      if (next) showCheckpointPrompt(next);
    });
    choices.append(button);
  });
  dialog.append(heading, title, detail, choices);
  overlay.append(dialog);
  document.body.append(overlay);
  choices.querySelector('button')?.focus();
}

async function notifyCheckpoint(checkpoint) {
  if (!store.notificationEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  const region = store.weatherProxyTarget
    ? checkpoint.targetCoordinate || formatCoordinate(store.weatherProxyTarget.latitude, store.weatherProxyTarget.longitude)
    : 'selected route region';
  const callsign = store.flight?.callsign || 'FLIGHT';
  const isRouteCheckpoint = checkpoint.kind === 'route';
  const options = {
    body: isRouteCheckpoint
      ? `${checkpoint.name} at ${formatCoordinate(checkpoint.lat, checkpoint.lon)}. Open TurbulenceAlert to report if you are ahead, on time, or behind.`
      : `${checkpoint.late ? 'Catch-up alert; stage is already due. ' : ''}${checkpoint.leadMinutes}-minute alert for ${region}. ${checkpoint.action}`,
    tag: `checkpoint-${checkpoint.id}`,
    renotify: true,
    data: { url: '/route' }
  };
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const title = isRouteCheckpoint
      ? `${callsign} · Route timing check-in`
      : `${callsign} · ${checkpoint.late ? 'Catch-up · ' : ''}${checkpoint.leadMinutes}-minute turbulence alert`;
    if (registration) await registration.showNotification(title, options);
    else new Notification(title, options);
  } catch (error) {
    console.error('Unable to show checkpoint notification', error);
    toast('In-app reminder active', 'This browser could not display an iPad notification.');
  }
}

async function enableCheckpointNotifications(button) {
  if (!('Notification' in window)) {
    toast('Notifications unavailable', 'This browser does not support device notifications.');
    return;
  }
  try {
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission !== 'granted') {
      store.notificationEnabled = false;
      toast('Notifications not enabled', 'Allow notifications in iPad settings and try again.');
      return;
    }
    if (!('serviceWorker' in navigator)) {
      toast('In-app reminders enabled', 'This browser cannot register the iPad notification service worker.');
      store.notificationEnabled = true;
      button.textContent = '◉ iPad alerts on';
      return;
    }
    await navigator.serviceWorker.register('/service-worker.js');
    store.notificationEnabled = true;
    button.textContent = '◉ iPad alerts on';
    toast('iPad checkpoint alerts enabled', 'For supported iPadOS versions, add this EFB to the Home Screen. Closed-app push needs a notification server.');
  } catch (error) {
    console.error('Unable to enable checkpoint notifications', error);
    toast('Could not enable notifications', 'Check this site’s notification and service-worker permissions.');
  }
}

function updateCheckpointUi() {
  const position = store.flightPosition || flightPositionAt();
  const now = Date.now();
  updateRouteTimingUi(position, now);
  const rawEtaMinutes = alertRegionEtaMinutes(position);
  const etaMinutes = rawEtaMinutes === null
    ? null
    : Math.max(0, rawEtaMinutes + (Number(store.timingFeedback.offsetMinutes) || 0));

  if (etaMinutes !== null && store.weatherProxyTarget) {
    const due = checkpoints
      .filter(checkpoint => !checkpoint.triggered && !checkpoint.missed && etaMinutes <= checkpoint.leadMinutes)
      .sort((left, right) => right.leadMinutes - left.leadMinutes);
    const nextDue = due[0];
    if (nextDue) {
      nextDue.triggered = true;
      nextDue.triggeredAt = now;
      nextDue.late = etaMinutes < nextDue.leadMinutes - 1;
      nextDue.lat = position.lat;
      nextDue.lon = position.lon;
      nextDue.targetCoordinate = formatCoordinate(store.weatherProxyTarget.latitude, store.weatherProxyTarget.longitude);
      toast(
        nextDue.late ? `Catch-up · ${nextDue.leadMinutes}-minute alert` : `${nextDue.leadMinutes}-minute turbulence alert`,
        `${nextDue.action} Target region ${nextDue.targetCoordinate}${nextDue.late ? ` · approximately ${Math.max(0, Math.round(etaMinutes))} min away` : ''}.`
      );
      void notifyCheckpoint(nextDue);
    }

    const routeProgress = routeProjection(position).alongRouteKm;
    const alertSequenceComplete = checkpoints.every(checkpoint => checkpoint.triggered || checkpoint.missed);
    if (
      !store.alertRegionReached &&
      alertSequenceComplete &&
      routeProgress >= store.weatherProxyTarget.regionEntryKm
    ) {
      store.alertRegionReached = true;
      const regionCheckin = {
        id: `region-${store.weatherProxyTarget.id}`,
        targetId: store.weatherProxyTarget.id,
        name: 'selected turbulence region',
        level: store.weatherProxyTarget.signal === 3 ? 'high' : 'moderate',
        lat: store.weatherProxyTarget.latitude,
        lon: store.weatherProxyTarget.longitude,
        targetCoordinate: formatCoordinate(store.weatherProxyTarget.latitude, store.weatherProxyTarget.longitude),
        triggeredAt: now
      };
      showCheckpointPrompt(regionCheckin);
      store.completedWeatherTargetIds.add(store.weatherProxyTarget.id);
      const currentTargetId = store.weatherProxyTarget.id;
      if (store.weatherProxyModel?.cells) {
        window.setTimeout(() => {
          if (store.weatherProxyTarget?.id === currentTargetId) {
            refreshWeatherProxyTarget(store.weatherProxyModel.cells);
          }
        }, 0);
      }
      if (store.notificationEnabled && 'Notification' in window && Notification.permission === 'granted') {
        void navigator.serviceWorker?.getRegistration().then(registration => {
          const options = {
            body: `The aircraft has entered the selected region at ${regionCheckin.targetCoordinate}. Open TurbulenceAlert to report whether timing was ahead, on time, or behind.`,
            tag: `region-check-in-${currentTargetId}`,
            data: { url: '/route' }
          };
          const callsign = store.flight?.callsign || 'FLIGHT';
          if (registration) return registration.showNotification(`${callsign} · Region check-in`, options);
          new Notification(`${callsign} · Region check-in`, options);
          return undefined;
        }).catch(error => {
          console.error('Unable to show region check-in notification', error);
          toast('In-app region check-in active', 'This browser could not display an iPad notification.');
        });
      }
    }
  }

  checkpoints.forEach((checkpoint, index) => {
    const stageEtaMinutes = etaMinutes === null ? null : Math.max(0, etaMinutes - checkpoint.leadMinutes);
    const stageAt = stageEtaMinutes === null ? null : now + stageEtaMinutes * 60_000;
    const stageMinutes = stageEtaMinutes === null ? 0 : Math.floor(stageEtaMinutes);
    const stageSeconds = stageEtaMinutes === null ? 0 : Math.floor((stageEtaMinutes - stageMinutes) * 60);
    const regionMinutes = etaMinutes === null ? 0 : Math.floor(etaMinutes);
    const regionSeconds = etaMinutes === null ? 0 : Math.floor((etaMinutes - regionMinutes) * 60);
    const etaElement = $(`[data-checkpoint-eta="${checkpoint.id}"]`);
    const countdownElement = $(`[data-checkpoint-countdown="${checkpoint.id}"]`);
    const stateElement = $(`[data-checkpoint-state="${checkpoint.id}"]`);
    if (etaElement) {
      etaElement.textContent = etaMinutes === null
        ? store.weatherProxyError ? 'MODEL UNAVAILABLE' : store.weatherProxyLoaded ? 'NO TARGET' : 'WAITING FOR MODEL'
        : `REGION ${formatUtcTime(now + etaMinutes * 60_000)}`;
    }
    if (countdownElement) {
      countdownElement.textContent = etaMinutes === null
        ? store.weatherProxyError ? 'Staged alerts unavailable' : store.weatherProxyLoaded ? 'No selected region' : 'Loading regional signals'
        : checkpoint.triggered
          ? `ALERT SENT · REGION IN ${String(regionMinutes).padStart(2, '0')}:${String(regionSeconds).padStart(2, '0')}`
          : checkpoint.missed
            ? 'SKIPPED · MORE URGENT STAGE DUE'
            : `ALERT IN ${String(stageMinutes).padStart(2, '0')}:${String(stageSeconds).padStart(2, '0')}`;
    }
    if (stateElement) stateElement.textContent = checkpoint.acknowledged ? 'REPORTED'
      : checkpoint.triggered ? 'SENT' : checkpoint.missed ? 'SKIPPED'
        : etaMinutes === null ? store.weatherProxyError ? 'UNAVAILABLE' : store.weatherProxyLoaded ? 'NO TARGET' : 'WAITING'
          : 'PENDING';
    const alertCard = $$('.alert-card')[index];
    if (alertCard) {
      const count = $('.alert-count strong', alertCard);
      if (count) count.textContent = String(checkpoint.leadMinutes).padStart(2, '0');
      const stageTime = $(`[data-alert-stage-time="${checkpoint.id}"]`, alertCard);
      if (stageTime) stageTime.textContent = etaMinutes === null
        ? store.weatherProxyError ? 'MODEL UNAVAILABLE' : store.weatherProxyLoaded ? 'NO TARGET' : 'WAITING'
        : checkpoint.triggered ? `SENT · ${formatUtcTime(checkpoint.triggeredAt)}`
          : checkpoint.missed ? 'SKIPPED'
            : `ALERT ETA ${formatUtcTime(stageAt)}`;
      let eta = $('.alert-eta', alertCard);
      if (!eta) {
        eta = document.createElement('span');
        eta.className = 'alert-eta';
        $('.alert-top', alertCard)?.append(eta);
      }
      if (eta) eta.textContent = etaMinutes === null
        ? store.weatherProxyError ? 'Staged alerts unavailable' : store.weatherProxyLoaded ? 'No selected region ahead' : 'Selecting a priority region'
        : checkpoint.triggered
          ? `Region ETA ${String(regionMinutes).padStart(2, '0')}:${String(regionSeconds).padStart(2, '0')}`
          : checkpoint.missed ? 'Superseded by a more urgent stage'
            : `Alert in ${String(stageMinutes).padStart(2, '0')}:${String(stageSeconds).padStart(2, '0')}`;
    }
    if (checkpointMapMarkers[index]) {
      checkpointMapMarkers[index].marker.setOpacity(
        Boolean(store.weatherProxyTarget) && !checkpoint.missed ? 1 : 0
      );
    }
  });
  const offset = Number(store.timingFeedback.offsetMinutes) || 0;
  const accuracy = $('#timing-accuracy b');
  if (accuracy) accuracy.textContent = `${offset > 0 ? '+' : ''}${offset} min`;
}

function formatCoordinateAxis(value, positive, negative) {
  return `${Math.abs(value).toFixed(2)}°${value < 0 ? negative : positive}`;
}

function historicalMatchSummary() {
  const routeReports = [];
  const matches = store.allCases.map(report => {
    const hasLocation = Number.isFinite(report.lat) && Number.isFinite(report.lon) &&
      report.lat >= -90 && report.lat <= 90 && report.lon >= -180 && report.lon <= 180;
    const projection = hasLocation
      ? routeProjection({ lat: report.lat, lon: report.lon })
      : null;
    const onRoute = Boolean(projection &&
      projection.rawFraction >= 0 && projection.rawFraction <= 1 &&
      projection.crossTrackKm <= 300);
    if (onRoute) routeReports.push(report);

    const factorScores = {};
    if (projection && projection.rawFraction >= 0 && projection.rawFraction <= 1) {
      factorScores.Location = Math.max(0, Math.round(100 * (1 - projection.crossTrackKm / 300)));
    }

    const reportAltitude = Number(report.altitudeFL);
    if (Number.isFinite(reportAltitude) && reportAltitude > 0) {
      factorScores.Altitude = Math.max(0, Math.round(100 - Math.abs(reportAltitude - store.flight.altitude) * 2));
    }

    const nearbyWeatherCell = hasLocation && store.weatherProxyModel?.cells
      ? store.weatherProxyModel.cells
        .map(cell => ({ cell, distance: distanceKm(report, { lat: cell.latitude, lon: cell.longitude }) }))
        .filter(candidate => candidate.distance <= 300)
        .sort((left, right) => left.distance - right.distance)[0]?.cell
      : null;
    const currentPatterns = [];
    if (nearbyWeatherCell) {
      if (Number(nearbyWeatherCell.shear) >= 7) currentPatterns.push('shear');
      if (
        (Number(nearbyWeatherCell.cape) >= 600 && Number(nearbyWeatherCell.midCloud) >= 85) ||
        (Number(nearbyWeatherCell.cape) >= 1000 && Number(nearbyWeatherCell.precipitation) >= 0.2)
      ) currentPatterns.push('convection');
    }
    const reportPatterns = [...new Set((Array.isArray(report.tags) ? report.tags : [])
      .map(tag => {
        if (/wind shear|jet stream|upper level wind/i.test(tag)) return 'shear';
        if (/convective|thunderstorm|cloud|precipitation/i.test(tag)) return 'convection';
        return null;
      })
      .filter(Boolean))];
    if (currentPatterns.length && reportPatterns.length) {
      const overlap = currentPatterns.filter(pattern => reportPatterns.includes(pattern)).length;
      const union = new Set([...currentPatterns, ...reportPatterns]).size;
      factorScores['Weather Pattern'] = Math.round(overlap / union * 100);
    }

    const monthMatch = String(report.date || '').match(/^\d{4}-(\d{2})/);
    if (monthMatch) {
      const reportMonth = Number(monthMatch[1]);
      if (reportMonth >= 1 && reportMonth <= 12) {
        const currentMonth = new Date().getUTCMonth() + 1;
        const monthDistance = Math.min(
          Math.abs(currentMonth - reportMonth),
          12 - Math.abs(currentMonth - reportMonth)
        );
        factorScores.Season = Math.round(100 * (1 - monthDistance / 6));
      }
    }

    const selectedFactors = [...store.factors];
    const availableFactors = selectedFactors.filter(factor => Number.isFinite(factorScores[factor]));
    const score = availableFactors.length
      ? Math.round(availableFactors.reduce((total, factor) => total + factorScores[factor], 0) / availableFactors.length)
      : null;
    return {
      report,
      projection,
      onRoute,
      crossTrackKm: projection?.crossTrackKm ?? null,
      factorScores,
      availableFactors,
      score
    };
  });

  const matchesById = new Map(matches.map(match => [match.report.id, match]));
  const ranked = (store.factors.has('Location')
    ? matches.filter(match => match.onRoute)
    : matches.filter(match => match.projection))
    .sort((left, right) =>
      (right.score ?? -1) - (left.score ?? -1) ||
      (left.crossTrackKm ?? Infinity) - (right.crossTrackKm ?? Infinity) ||
      reportSeverityValue(right.report) - reportSeverityValue(left.report)
    );
  const routeMatches = ranked.filter(match => match.onRoute);
  return {
    totalReports: store.allCases.length,
    routeReports,
    matches: ranked,
    routeMatches,
    matchesById
  };
}

const configuredReportPage = reportPage;
reportPage = function () {
  const flight = store.flight;
  const position = flightPositionAt();
  let html = configuredReportPage();
  const route = `${flight.origin} → ${flight.destination}`;
  const aircraftChoices = [
    flight.aircraft,
    'Boeing 787-9 Dreamliner',
    'Airbus A350-900',
    'Boeing 777-300ER',
    'Airbus A321neo'
  ].filter((model, index, models) => models.indexOf(model) === index);
  html = html.replace('value="DOH → COK"', `value="${escapeHtml(route)}"`);
  html = html.replace(
    /<select name="aircraft"><option>Boeing 787<\/option><option>Airbus A350<\/option><option>Boeing 777<\/option><\/select>/,
    `<select name="aircraft">${aircraftChoices.map(model => `<option ${model === flight.aircraft ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')}</select>`
  );
  html = html.replace('12.4°N, 67.8°E · Live GPS', `${formatCoordinate(position.lat, position.lon)} · Simulated position`);
  html = html.replace('value="12.4°N"', `value="${formatCoordinateAxis(position.lat, 'N', 'S')}"`);
  html = html.replace('value="67.8°E"', `value="${formatCoordinateAxis(position.lon, 'E', 'W')}"`);
  html = html.replace('value="350"', `value="${flight.altitude}"`);
  html = html.replace('<h1>Share your experience</h1>', '<h1>Post-flight debrief</h1>');
  html = html.replace('Your experience helps build a safer sky for everyone.', 'After landing, record the turbulence conditions, location, and aircraft response for the shared experience database.');
  return html;
};

const configuredSettingsPage = settingsPage;
settingsPage = function () {
  let html = configuredSettingsPage();
  const profile = store.pilotProfile;
  const flight = store.flight;
  const accountPanel = `<section class="settings-card profile-settings"><h2>Pilot profile</h2><p>${escapeHtml(profile.fullName)} · ${escapeHtml(profile.rank)} · ${escapeHtml(profile.airline)} · ${escapeHtml(profile.country)}</p><div class="profile-actions"><button class="outline-button" type="button" data-action="edit-flight">Edit active flight</button><button class="outline-button" type="button" data-action="sign-out">Sign out</button></div><div class="active-flight-summary"><strong>${escapeHtml(flight.callsign)} · ${escapeHtml(flight.aircraft)}</strong><span>${flight.origin} → ${flight.destination} · FL${flight.altitude} · ${flight.cruiseSpeedKmh} km/h</span></div><p class="prototype-note">Local demo profile only. OTP is not sent to a phone; do not use this prototype as an authentication or flight-safety system.</p></section>`;
  const lastClosing = html.lastIndexOf('</div>');
  return lastClosing < 0 ? html : `${html.slice(0, lastClosing)}${accountPanel}${html.slice(lastClosing)}`;
};

const configuredWire = wire;
wire = function () {
  configuredWire();
  $$('[data-action="sign-out"]').forEach(button => button.onclick = signOutPilot);
  $('[data-action="edit-flight"]')?.addEventListener('click', () => {
    store.page = 'flight-setup';
    render();
  });
  $$('input[name="location-mode"]').forEach(radio => radio.onchange = () => {
    const manual = radio.value === 'manual' && radio.checked;
    const position = flightPositionAt();
    const latitude = $('input[name="latitude"]');
    const longitude = $('input[name="longitude"]');
    latitude.disabled = longitude.disabled = !manual;
    if (manual) {
      latitude.value = '';
      longitude.value = '';
      latitude.placeholder = 'e.g. 12.40°N';
      longitude.placeholder = 'e.g. 67.80°E';
    } else {
      latitude.value = formatCoordinateAxis(position.lat, 'N', 'S');
      longitude.value = formatCoordinateAxis(position.lon, 'E', 'W');
    }
  });
  const reportRoute = $('select[name="route"]');
  if (reportRoute) {
    const route = `${store.flight.origin} → ${store.flight.destination}`;
    reportRoute.replaceChildren(new Option(`${airports[store.flight.origin].name} (${store.flight.origin}) → ${airports[store.flight.destination].name} (${store.flight.destination})`, route, true, true));
  }
};

const originalRender = render;
render = function () {
  if (routeMap) {
    store.mapView = { center: routeMap.getCenter(), zoom: routeMap.getZoom() };
    routeMap.remove();
    routeMap = null;
    aircraftMarker = null;
    flownRoute = null;
    checkpointMapMarkers = [];
    routeTimingMapMarkers = [];
  }
  originalRender();
  if (!pilotIsAuthenticated() || !activeFlightIsValid(store.flight) || store.page === 'flight-setup') {
    positionReadout = null;
    return;
  }
  positionReadout = $('#map-position');
  if (store.page === 'route') initializeFlightMap();
  if (store.page === 'insights') ensureWeatherProxyForInsights();
  updateCheckpointUi();
};

render();
setInterval(() => {
  const clock = $('#clock');
  if (clock) clock.textContent = fmtClock();
  const speed = $('#speed');
  if (speed && activeFlightIsValid(store.flight)) {
    speed.innerHTML = `${store.flight.cruiseSpeedKmh + Math.floor(Math.random() * 5) - 2} <small>km/h</small>`;
  }
  if (!pilotIsAuthenticated() || !activeFlightIsValid(store.flight)) return;
  updateFlightMap();
  updateCheckpointUi();
}, 2100);
