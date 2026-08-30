/**
 * Fleet Command - Frontend Script
 * All 13 fixes applied in this version
 */
'use strict';

// ── API Configuration ──────────────────────────────────────────────────────────
// window.FLEET_API_BASE is set by config.js (loaded before this script).
// Falls back to localhost:1995 for local development.
const API_BASE = (typeof window !== 'undefined' && window.FLEET_API_BASE)
    ? window.FLEET_API_BASE.replace(/\/$/, '')   // strip trailing slash
    : 'http://localhost:1995';

// ── Constants ─────────────────────────────────────────────────────────────────
// B-03: ADMIN_CREDS removed — auth is now validated server-side via /api/admin/auth
const SEA_TRUCKS = new Set([]); // sea option completely removed
const SHIPMENTS_PER_PAGE = 10; // #12

// Driver score events used for scoring system (#10)
const SCORE_EVENTS = [
    { key: 'harsh_braking', label: 'Harsh Braking', delta: -8 },
    { key: 'harsh_accel', label: 'Harsh Acceleration', delta: -6 },
    { key: 'harsh_driving', label: 'Harsh Driving (general)', delta: -10 },
    { key: 'speeding', label: 'Speeding Violation', delta: -12 },
    { key: 'idle_excess', label: 'Excessive Idling', delta: -5 },
    { key: 'route_deviation', label: 'Route Deviation', delta: -7 },
    { key: 'early_delivery', label: 'Early Delivery', delta: 12 },
    { key: 'on_time', label: 'On-Time Delivery', delta: 8 },
    { key: 'safe_driving', label: 'Safe Driving Streak', delta: 10 },
    { key: 'fuel_efficient', label: 'Fuel Efficient Trip', delta: 5 },
    { key: 'customer_rating', label: 'Customer High Rating', delta: 6 },
    { key: 'zero_incident', label: 'Zero Incident Month', delta: 15 },
];

// ── State ─────────────────────────────────────────────────────────────────────
const State = {
    vehicles: {}, orders: [], alerts: [], analytics: null,
    selectedVehicle: null, showTrails: true,
    currentPage: 'tracking', shipmentPage: 1,
    sse: null, reconnectTimer: null,
    liveMarkers: {}, trailPolylines: {}, trailData: {}, map: null,
    custMap: null, custMarker: null,
    // Driver scores: { vehicleId: { score, events[] } }
    driverScores: {},
    // Alert silence state
    alertsSilenced: false, silenceTimer: null, silenceUntil: null,
    sidebarCollapsed: false,
    currentAuthTab: 'password',
    custOrderData: null,
    // Vehicles that have an active driver GPS broadcast (bypass sea-truck overrides)
    driverGpsVehicles: new Set(),
};

// ── API ───────────────────────────────────────────────────────────────────────
const API = {
    // B-01: Prepend API_BASE so production fetches reach the real backend, not the frontend server
    base: API_BASE + '/api',
    async get(path, params = {}) {
        const qs = new URLSearchParams(params).toString();
        const res = await fetch(`${this.base}${path}${qs ? '?' + qs : ''}`);
        if (!res.ok) throw new Error(`${path} → ${res.status}`);
        return res.json();
    },
    async put(path, body = {}) {
        const res = await fetch(`${this.base}${path}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`PUT ${path} → ${res.status}`);
        return res.json();
    },
    async post(path, body = {}) {
        const res = await fetch(`${this.base}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
        return res.json();
    },
};

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', duration = 4000) {
    if (State.alertsSilenced && type === 'warn') return; // respect silence for alerts
    const icons = { info: 'info-circle', success: 'check-circle', warn: 'exclamation-triangle', error: 'times-circle' };
    const colors = { info: 'var(--accent)', success: 'var(--green)', warn: 'var(--yellow)', error: 'var(--red)' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}" style="color:${colors[type]}"></i><span>${msg}</span>`;
    document.getElementById('toastContainer').append(el);
    setTimeout(() => { el.style.animation = 'slideOut 0.3s ease forwards'; setTimeout(() => el.remove(), 300); }, duration);
}

// ── Clock ─────────────────────────────────────────────────────────────────────
function startClock() {
    const tick = () => { const el = document.getElementById('liveClock'); if (el) el.textContent = new Date().toTimeString().slice(0, 8); };
    tick(); setInterval(tick, 1000);
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
    if (State.sse) { State.sse.close(); State.sse = null; }
    setSSEStatus('connecting');
    State.sse = new EventSource(`${API_BASE}/api/stream`);
    State.sse.onopen = () => {
        setSSEStatus('online');
        showToast('Connected to fleet server', 'success', 2500);
        if (State.reconnectTimer) { clearTimeout(State.reconnectTimer); State.reconnectTimer = null; }
    };
    State.sse.onmessage = e => {
        try { handleSSEPayload(JSON.parse(e.data)); } catch { }
    };
    State.sse.onerror = () => {
        setSSEStatus('error'); State.sse.close(); State.sse = null;
        showToast('Connection lost. Reconnecting…', 'warn');
        State.reconnectTimer = setTimeout(connectSSE, 5000);
    };
}
function setSSEStatus(s) {
    const dot = document.getElementById('sseStatus'), txt = document.getElementById('sseStatusText');
    if (dot) dot.className = 'status-pulse' + (s === 'online' ? ' online' : s === 'error' ? ' error' : '');
    if (txt) txt.textContent = s.toUpperCase();
}
function handleSSEPayload(p) {
    if (p.type === 'snapshot') {
        // B-09: Guard arrays against null/undefined before calling .forEach()
        (p.vehicles || []).forEach(v => { State.vehicles[v.id] = v; });
        (p.alerts || []).forEach(a => State.alerts.unshift(a));
        // Init scores for all vehicles
        Object.keys(State.vehicles).forEach(id => initDriverScore(id));
        onVehiclesUpdated(); updateAlertBadge();
        if (State.currentPage === 'tracking') renderMapVehicles();
        if (State.currentPage === 'fleet') renderFleetTable();
        setMapTimestamp(p.timestamp);
    } else if (p.type === 'vehicle_update') {
        (p.vehicles || []).forEach(u => {
            if (State.vehicles[u.id]) {
                if (u._driver_gps) {
                    // Real GPS update — apply everything
                    // First real GPS update for this vehicle: clear stale simulated trail
                    if (!State.driverGpsVehicles.has(u.id)) {
                        delete State.trailData[u.id];
                        if (State.trailPolylines[u.id]) {
                            try { State.map.removeLayer(State.trailPolylines[u.id]); } catch { }
                            delete State.trailPolylines[u.id];
                        }
                    }
                    State.driverGpsVehicles.add(u.id);
                    Object.assign(State.vehicles[u.id], u);
                } else if (State.driverGpsVehicles.has(u.id)) {
                    // Simulation update for a GPS-broadcasting vehicle —
                    // keep lat/lng from real GPS, only accept non-positional fields
                    const { current_lat, current_lng, current_speed, heading, status, ...rest } = u;
                    Object.assign(State.vehicles[u.id], rest);
                } else {
                    Object.assign(State.vehicles[u.id], u);
                }
            }
        });
        if (p.alerts?.length) {
            p.alerts.forEach(a => { State.alerts.unshift(a); if (!State.alertsSilenced) showToast(`${a.type}: ${a.reason}`, a.severity === 'High' ? 'error' : 'warn'); });
            updateAlertBadge();
            if (State.currentPage === 'alerts') renderAlerts();
        }
        onVehiclesUpdated(); setMapTimestamp(p.timestamp);
    } else if (p.type === 'status_change') {
        if (State.vehicles[p.vehicle_id]) State.vehicles[p.vehicle_id].status = p.status;
        onVehiclesUpdated();
    }
}
function setMapTimestamp(ts) {
    const el = document.getElementById('mapTimestamp');
    if (el) el.textContent = 'Last update: ' + formatTime(ts);
}
function onVehiclesUpdated() {
    updateSidebarStats();
    if (State.currentPage === 'tracking') { renderMapVehicles(); renderVehiclePanel(); if (State.selectedVehicle) updateVehicleModal(State.selectedVehicle); }
    if (State.currentPage === 'fleet') renderFleetTable();
    if (State.currentPage === 'drivers') renderDrivers();
    updateSettingsInfo();
}
function updateSidebarStats() {
    const vs = Object.values(State.vehicles);
    const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    el('sbActive', vs.filter(v => v.status === 'moving').length);
    el('sbIdle', vs.filter(v => v.status === 'idle').length);
    el('sbAlerts', State.alerts.filter(a => !a.acknowledged).length);
    el('vehicleCount', vs.length);
}
function updateAlertBadge() {
    const unread = State.alerts.filter(a => !a.acknowledged).length;
    const badge = document.getElementById('alertBadge'), navBadge = document.getElementById('alertsNavBadge');
    if (badge) { badge.style.display = unread > 0 ? 'flex' : 'none'; badge.textContent = unread; }
    if (navBadge) { navBadge.style.display = unread > 0 ? 'inline' : 'none'; navBadge.textContent = unread; }
    const drop = document.getElementById('alertDropdown');
    if (drop && drop.style.display !== 'none') renderAlertDropdown();
}

// ── Map ───────────────────────────────────────────────────────────────────────
function initMap() {
    if (State.map) return;
    State.map = L.map('map', { zoomControl: false, attributionControl: false }).setView([18.0, 78.5], 6);
    State.tileLayer = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }
    ).addTo(State.map);
}

function makeVehicleIcon(v) {
    const isAtSea = SEA_TRUCKS.has(v.id);
    const emoji = v.vehicle_type === 'Large Refrigerated Truck' ? '🚛'
        : v.vehicle_type === 'Small Refrigerated Truck' ? '🚐' : '🚚';
    const statusClass = isAtSea ? 'sea' : v.status;
    return L.divIcon({
        html: `<div class="vmarker ${statusClass}" title="${v.id}">${isAtSea ? '🚢' : emoji}</div>`,
        iconSize: [34, 34], iconAnchor: [17, 17], className: ''
    });
}

function renderMapVehicles() {
    if (!State.map) return;
    const filter = document.getElementById('statusFilter')?.value || '';
    const vehicles = Object.values(State.vehicles).filter(v => {
        if (!v.current_lat || !v.current_lng) return false;
        const hasDriverGps = State.driverGpsVehicles.has(v.id);
        const effectiveStatus = (!hasDriverGps && SEA_TRUCKS.has(v.id)) ? 'sea' : v.status;
        if (filter && effectiveStatus !== filter) return false;
        return true;
    });

    // If sidebar is collapsed, expand map to full
    const seen = new Set();
    vehicles.forEach(v => {
        seen.add(v.id);
        const hasDriverGps = State.driverGpsVehicles.has(v.id);
        const isAtSea = !hasDriverGps && SEA_TRUCKS.has(v.id);
        // Use real GPS coords for driver-broadcasting vehicles; hardcoded sea pos otherwise
        let lat = v.current_lat, lng = v.current_lng;
        const latlng = [lat, lng];
        if (!State.trailData[v.id]) State.trailData[v.id] = [];
        const trail = State.trailData[v.id];
        if (!trail.length || trail[trail.length - 1][0] !== lat) { trail.push(latlng); if (trail.length > 100) trail.shift(); }

        if (State.liveMarkers[v.id]) {
            State.liveMarkers[v.id].setLatLng(latlng);
            State.liveMarkers[v.id].setIcon(makeVehicleIcon(v));
        } else {
            const m = L.marker(latlng, { icon: makeVehicleIcon(v) })
                .addTo(State.map).on('click', () => selectVehicle(v.id));
            State.liveMarkers[v.id] = m;
        }
        if (State.showTrails && trail.length > 1) {
            const color = SEA_TRUCKS.has(v.id) ? '#00bfff' : v.status === 'moving' ? 'var(--green)' : '#666';
            if (State.trailPolylines[v.id]) State.trailPolylines[v.id].setLatLngs(trail);
            else State.trailPolylines[v.id] = L.polyline(trail, { color, weight: 2, opacity: 0.5, dashArray: '4,4' }).addTo(State.map);
        }
    });
    Object.keys(State.liveMarkers).forEach(id => {
        if (!seen.has(id)) {
            State.map.removeLayer(State.liveMarkers[id]); delete State.liveMarkers[id];
            if (State.trailPolylines[id]) { State.map.removeLayer(State.trailPolylines[id]); delete State.trailPolylines[id]; }
        }
    });
}

function toggleTrails() {
    State.showTrails = !State.showTrails;
    document.getElementById('trailBtn')?.classList.toggle('active', State.showTrails);
    if (!State.showTrails) { Object.values(State.trailPolylines).forEach(p => State.map.removeLayer(p)); State.trailPolylines = {}; }
    else renderMapVehicles();
}
function fitAllVehicles() {
    const pts = Object.values(State.vehicles).filter(v => v.current_lat && v.current_lng).map(v => [v.current_lat, v.current_lng]);
    if (pts.length) State.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
}
function mapZoomIn() { State.map?.zoomIn(); }
function mapZoomOut() { State.map?.zoomOut(); }
function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
}
function selectVehicle(id) {
    State.selectedVehicle = id;
    const v = State.vehicles[id];
    const hasDriverGps = State.driverGpsVehicles.has(id);
    const isAtSea = !hasDriverGps && SEA_TRUCKS.has(id);
    const lat = v?.current_lat;
    const lng = v?.current_lng;
    if (lat && lng) State.map.setView([lat, lng], 12);
    updateVehicleModal(id);
    document.querySelectorAll('.vehicle-item').forEach(el => el.classList.toggle('selected', el.dataset.vid === id));
}
function updateVehicleModal(id) {
    const v = State.vehicles[id]; if (!v) return;
    const modal = document.getElementById('vehicleDetailModal');
    const title = document.getElementById('modalVehicleId');
    const body = document.getElementById('modalBody');
    if (!modal) return;
    const hasDriverGps = State.driverGpsVehicles.has(id);
    const isAtSea = !hasDriverGps && SEA_TRUCKS.has(id);
    modal.style.display = 'block';
    title.textContent = `${v.id} — ${v.vehicle_type || ''}`;
    body.innerHTML = `
        <div class="detail-group"><label>Driver</label><span>${v.driver_name || '—'}</span></div>
        <div class="detail-group"><label>Contact</label><span>${v.driver_contact || '—'}</span></div>
        <div class="detail-group"><label>Vehicle No</label><span>${v.vehicle_number || '—'}</span></div>
        <div class="detail-group"><label>Status</label><span class="pill ${isAtSea ? 'sea' : v.status}">${isAtSea ? 'At Sea' : v.status}</span></div>
        <div class="detail-group"><label>Speed</label><span>${v.current_speed ? v.current_speed.toFixed(1) + ' km/h' : '0 km/h'}</span></div>
        <div class="detail-group"><label>Current Order</label><span>${v.current_order_id || '—'}</span></div>
        <div class="detail-group"><label>Route</label><span>${v.assigned_route || '—'}</span></div>
        ${isAtSea ? '<div class="detail-group"><label>Location Type</label><span style="color:#00bfff">Sea Route</span></div>' : ''}
        ${hasDriverGps ? '<div class="detail-group"><label>GPS</label><span style="color:var(--orange)"><i class="fas fa-satellite-dish"></i> Driver Live GPS</span></div>' : ''}
        <div class="detail-group"><label>Lat / Lng</label><span style="font-size:11px">${v.current_lat?.toFixed(5) || '—'}, ${v.current_lng?.toFixed(5) || '—'}</span></div>
    `;
}
function closeVehicleModal() {
    const m = document.getElementById('vehicleDetailModal'); if (m) m.style.display = 'none';
    State.selectedVehicle = null;
    document.querySelectorAll('.vehicle-item').forEach(el => el.classList.remove('selected'));
}

// ── Vehicle Panel ─────────────────────────────────────────────────────────────
function renderVehiclePanel() {
    const filter = document.getElementById('statusFilter')?.value || '';
    const vehicles = Object.values(State.vehicles).filter(v => {
        const hasDriverGps = State.driverGpsVehicles.has(v.id);
        const eff = (!hasDriverGps && SEA_TRUCKS.has(v.id)) ? 'sea' : v.status;
        return !filter || eff === filter;
    });
    const list = document.getElementById('vehicleList'); if (!list) return;
    if (!vehicles.length) { list.innerHTML = '<div class="loading-state">No vehicles match</div>'; return; }
    list.innerHTML = vehicles.map(v => {
        const hasDriverGps = State.driverGpsVehicles.has(v.id);
        const isAtSea = !hasDriverGps && SEA_TRUCKS.has(v.id);
        const eff = isAtSea ? 'sea' : v.status;
        return `<div class="vehicle-item ${State.selectedVehicle === v.id ? 'selected' : ''}" data-vid="${v.id}" onclick="selectVehicle('${v.id}')">
            <div class="vi-header">
                <span class="vi-id">${v.id}</span>
                <span class="vi-status ${eff}">${isAtSea ? 'At Sea' : v.status}</span>
            </div>
            <div class="vi-meta">
                <span><i class="fas fa-user"></i>${v.driver_name || '—'}</span>
                <span class="vi-speed">${isAtSea ? 'Sea Route' : v.current_speed ? v.current_speed.toFixed(0) + ' km/h' : 'idle'}</span>
            </div>
            <div class="vi-meta" style="margin-top:3px">
                <span><i class="fas fa-route"></i>${v.assigned_route || 'No route'}</span>
                ${hasDriverGps ? '<span style="color:var(--orange);font-size:10px"><i class="fas fa-satellite-dish"></i> Live GPS</span>' : ''}
            </div>
        </div>`;
    }).join('');
}
function filterVehicles() { renderVehiclePanel(); renderMapVehicles(); }

// ── Sidebar toggle — fix #9: only map shown ───────────────────────────────────
function setupSidebarToggle() {
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
        const sb = document.getElementById('sidebar');
        const vp = document.getElementById('vehiclePanel');
        if (window.innerWidth <= 768) {
            sb.classList.toggle('open');
        } else {
            State.sidebarCollapsed = !State.sidebarCollapsed;
            sb.classList.toggle('collapsed', State.sidebarCollapsed);
            // When map page: also hide vehicle panel so only map shows
            if (State.currentPage === 'tracking') {
                if (vp) vp.style.display = State.sidebarCollapsed ? 'none' : '';
            }
        }
    });
}

// ── Fleet ─────────────────────────────────────────────────────────────────────
function renderFleetTable() {
    const sf = document.getElementById('fleetStatusFilter')?.value || '';
    const search = (document.getElementById('fleetSearch')?.value || '').toLowerCase();
    const tbody = document.getElementById('fleetTableBody'); if (!tbody) return;
    let vs = Object.values(State.vehicles);
    if (sf) vs = vs.filter(v => {
        const hasDriverGps = State.driverGpsVehicles.has(v.id);
        return ((!hasDriverGps && SEA_TRUCKS.has(v.id)) ? 'sea' : v.status) === sf;
    });
    if (search) vs = vs.filter(v => [v.id, v.driver_name, v.vehicle_type, v.vehicle_number, v.current_order_id, v.assigned_route].some(f => (f || '').toLowerCase().includes(search)));
    if (!vs.length) { tbody.innerHTML = '<tr><td colspan="9" class="loading-row">No vehicles match</td></tr>'; return; }
    tbody.innerHTML = vs.map(v => {
        const hasDriverGps = State.driverGpsVehicles.has(v.id);
        const isAtSea = !hasDriverGps && SEA_TRUCKS.has(v.id);
        const eff = isAtSea ? 'sea' : v.status;
        return `<tr>
            <td><strong style="color:var(--accent);font-family:var(--font-mono)">${v.id}</strong></td>
            <td>${v.vehicle_type || '—'}</td>
            <td><span style="font-family:var(--font-mono)">${v.vehicle_number || '—'}</span></td>
            <td>${v.driver_name || '—'}</td>
            <td><span class="pill ${eff}">${isAtSea ? 'At Sea' : v.status}</span></td>
            <td>${isAtSea ? '<span style="color:#00bfff">Sea Route</span>' : v.current_speed ? v.current_speed.toFixed(1) + ' km/h' : '—'}
                ${hasDriverGps ? '<span style="color:var(--orange);font-size:10px;margin-left:4px"><i class="fas fa-satellite-dish"></i></span>' : ''}</td>
            <td>${v.current_order_id || '—'}</td>
            <td>${v.assigned_route || '—'}</td>
            <td style="display:flex;gap:6px;align-items:center">
                <button class="btn-sm" onclick="selectVehicleOnMap('${v.id}')">Track</button>
                <button class="btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deleteVehicle('${v.id}')"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;
    }).join('');
    renderFleetStats(vs);
}
function renderFleetStats(vs) {
    const counts = vs.reduce((a, v) => { const s = SEA_TRUCKS.has(v.id) ? 'sea' : v.status; a[s] = (a[s] || 0) + 1; return a; }, {});
    const el = document.getElementById('fleetStatsRow'); if (!el) return;
    el.innerHTML = [['moving', 'fa-truck', 'Moving', 'var(--green)'], ['idle', 'fa-parking', 'Idle', 'var(--yellow)'], ['sea', 'fa-ship', 'At Sea', '#00bfff'], ['stopped', 'fa-stop-circle', 'Stopped', 'var(--red)']].map(([s, i, l, c]) => `
        <div class="fleet-stat"><i class="fas ${i}" style="color:${c};font-size:20px"></i><div><div class="fleet-stat-val">${counts[s] || 0}</div><div class="fleet-stat-lbl">${l}</div></div></div>`).join('');
}
function selectVehicleOnMap(id) { showPage('tracking'); setTimeout(() => selectVehicle(id), 200); }
function exportFleet() {
    const csv = [['ID', 'Type', 'VehicleNo', 'Driver', 'Status', 'Speed', 'Order', 'Route'],
    ...Object.values(State.vehicles).map(v => [v.id, v.vehicle_type, v.vehicle_number, v.driver_name, v.status, v.current_speed || 0, v.current_order_id || '', v.assigned_route || ''])]
        .map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    downloadCSV(csv, 'fleet_export.csv');
}

// ── Add Vehicle / Delete Vehicle ─────────────────────────────────────────────
function openAddVehicleModal() {
    const html = `<div class="modal-form" style="max-height:70vh;overflow-y:auto;padding-right:6px">
        <p style="color:var(--text-secondary);font-size:12px;margin-bottom:14px">Fields marked <span style="color:var(--red)">*</span> are required.</p>

        <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin:12px 0 8px">Basic Info</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group">
                <label>Vehicle ID <span style="color:var(--red)">*</span></label>
                <input id="avId" placeholder="e.g. MH-TRK-014" oninput="this.value=this.value.toUpperCase()">
            </div>
            <div class="form-group">
                <label>Vehicle Type <span style="color:var(--red)">*</span></label>
                <select id="avType">
                    <option value="">— Select —</option>
                    <option value="Reefer Truck">Reefer Truck</option>
                    <option value="Mini Truck">Mini Truck</option>
                    <option value="Container Truck">Container Truck</option>
                    <option value="Flatbed Truck">Flatbed Truck</option>
                    <option value="Tanker">Tanker</option>
                    <option value="Cargo Van">Cargo Van</option>
                    <option value="Heavy Truck">Heavy Truck</option>
                    <option value="Pickup Truck">Pickup Truck</option>
                </select>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Vehicle Number</label><input id="avVNum" placeholder="e.g. MH-TRK-014"></div>
            <div class="form-group"><label>Plate Number</label><input id="avPlate" placeholder="e.g. MH 04 AB 1234"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group">
                <label>Transport Mode</label>
                <select id="avMode">
                    <option value="road">Road</option>
                    <option value="sea">Sea</option>
                    <option value="air">Air</option>
                </select>
            </div>
            <div class="form-group">
                <label>Initial Status</label>
                <select id="avStatus">
                    <option value="idle">Idle</option>
                    <option value="moving">Moving</option>
                    <option value="stopped">Stopped</option>
                    <option value="maintenance">Maintenance</option>
                    <option value="offline">Offline</option>
                </select>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Yard Slot</label><input id="avYard" placeholder="e.g. Y-03"></div>
        </div>

        <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin:14px 0 8px">Driver Assignment</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Driver Name</label><input id="avDriver" placeholder="Full name"></div>
            <div class="form-group"><label>Driver Contact</label><input id="avDriverContact" placeholder="+91 XXXXX XXXXX"></div>
        </div>

        <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin:14px 0 8px">Capacity & Fuel</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
            <div class="form-group"><label>Capacity (Tons)</label><input id="avCapT" type="number" min="0" step="0.1" placeholder="e.g. 10"></div>
            <div class="form-group"><label>Capacity (CBM)</label><input id="avCapC" type="number" min="0" step="0.1" placeholder="e.g. 40"></div>
            <div class="form-group">
                <label>Fuel Type</label>
                <select id="avFuel">
                    <option value="Diesel">Diesel</option>
                    <option value="CNG">CNG</option>
                    <option value="Electric">Electric</option>
                    <option value="Petrol">Petrol</option>
                    <option value="LNG">LNG</option>
                </select>
            </div>
        </div>

        <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin:14px 0 8px">Compliance & Expiry Dates</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Insurance Expiry</label><input id="avInsExp" type="date"></div>
            <div class="form-group"><label>Permit Expiry</label><input id="avPermit" type="date"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
            <div class="form-group"><label>Fitness Expiry</label><input id="avFitness" type="date"></div>
            <div class="form-group"><label>Pollution Expiry</label><input id="avPollution" type="date"></div>
            <div class="form-group"><label>Maintenance Due</label><input id="avMaintDue" type="date"></div>
        </div>

        <button class="btn-primary" style="width:100%;margin-top:16px" onclick="submitAddVehicle()">
            <i class="fas fa-plus-circle"></i> Add Vehicle to Fleet
        </button>
    </div>`;
    showGenericModal('<i class="fas fa-truck" style="color:var(--green)"></i> Add New Vehicle', html);
}

async function submitAddVehicle() {
    const vid = (document.getElementById('avId')?.value || '').trim().toUpperCase();
    const vtype = document.getElementById('avType')?.value || '';
    if (!vid) { showToast('Vehicle ID is required', 'warn'); return; }
    if (!vtype) { showToast('Vehicle Type is required', 'warn'); return; }
    const body = {
        id: vid,
        vehicle_type: vtype,
        vehicle_number: document.getElementById('avVNum')?.value.trim() || null,
        plate_number: document.getElementById('avPlate')?.value.trim() || null,
        driver_name: document.getElementById('avDriver')?.value.trim() || null,
        driver_contact: document.getElementById('avDriverContact')?.value.trim() || null,
        status: document.getElementById('avStatus')?.value || 'idle',
        capacity_tons: parseFloat(document.getElementById('avCapT')?.value) || null,
        capacity_cbm: parseFloat(document.getElementById('avCapC')?.value) || null,
        fuel_type: document.getElementById('avFuel')?.value || 'Diesel',
        insurance_expiry: document.getElementById('avInsExp')?.value || null,
        permit_expiry: document.getElementById('avPermit')?.value || null,
        fitness_expiry: document.getElementById('avFitness')?.value || null,
        pollution_expiry: document.getElementById('avPollution')?.value || null,
        maintenance_due: document.getElementById('avMaintDue')?.value || null,
        transport_mode: document.getElementById('avMode')?.value || 'road',
        yard_slot: document.getElementById('avYard')?.value.trim() || null,
    };
    try {
        const res = await fetch(`${API_BASE}/api/vehicles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) {
            showToast(`Vehicle ${vid} added to fleet!`, 'success');
            closeGenericModal();
            const updated = await fetch(`${API_BASE}/api/vehicles`).then(r => r.json());
            if (updated.success) {
                (updated.data || []).forEach(v => { State.vehicles[v.id] = v; });
                renderFleetTable();
            }
        } else {
            showToast(res.error || 'Failed to add vehicle', 'error');
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function deleteVehicle(vid) {
    showDeleteConfirm({
        title: 'Delete Vehicle',
        subtitle: `Remove ${vid} from the fleet permanently`,
        confirmName: vid,
        warningLines: [
            'All position history for this vehicle will be deleted.',
            'Active orders linked to this vehicle will lose their vehicle assignment.',
            'This action cannot be undone.',
        ],
        onConfirm: async () => {
            try {
                const res = await fetch(`${API_BASE}/api/vehicles/${vid}`, { method: 'DELETE' }).then(r => r.json());
                if (res.success) {
                    showToast(`Vehicle ${vid} deleted`, 'success');
                    delete State.vehicles[vid];
                    renderFleetTable();
                } else {
                    showToast(res.error || 'Delete failed', 'error');
                }
            } catch (e) { showToast(e.message, 'error'); }
        }
    });
}

// ── Shipments — 10 per page fix #12 ──────────────────────────────────────────
let _shipmentTotal = 0;
async function loadShipments(page = 1) {
    State.shipmentPage = page;
    const search = document.getElementById('shipmentSearch')?.value || '';
    const status = document.getElementById('shipmentStatusFilter')?.value || '';
    try {
        const res = await API.get('/orders', { page, per_page: SHIPMENTS_PER_PAGE, search, status });
        State.orders = res.data; _shipmentTotal = res.total;
        renderShipmentsTable();
        renderShipmentPagination(res.total, page, SHIPMENTS_PER_PAGE);
    } catch (e) { showToast('Failed to load shipments: ' + e.message, 'error'); }
}
function searchShipments() { loadShipments(1); }
function renderShipmentsTable() {
    const tbody = document.getElementById('shipmentTableBody'); if (!tbody) return;
    if (!State.orders.length) { tbody.innerHTML = '<tr><td colspan="10" class="loading-row">No shipments found</td></tr>'; return; }
    tbody.innerHTML = State.orders.map(o => {
        const sc = o.order_status === 'Delivered' ? 'delivered' : 'in-transit';
        return `<tr>
            <td><strong style="color:var(--accent);font-family:var(--font-mono)">${o.id}</strong></td>
            <td>${o.customer_name}<br><small style="color:var(--text-muted)">${o.customer_company || ''}</small></td>
            <td>${o.source_city} → ${o.destination_city}</td>
            <td>${o.goods_type}<br><small style="color:var(--text-muted)">${o.quantity} ${o.unit}</small></td>
            <td style="color:var(--accent-dim)">${o.vehicle_id}</td>
            <td>${o.driver_name || getDriverForVehicle(o.vehicle_id)}</td>
            <td><span class="pill ${sc}">${o.order_status}</span></td>
            <td style="font-family:var(--font-mono);font-size:10px">${formatDateShort(o.expected_delivery_datetime)}</td>
            <td style="font-family:var(--font-mono)">Rs.${(o.transport_cost_inr || 0).toLocaleString('en-IN')}</td>
            <td><button class="btn-sm" onclick="showOrderDetail('${o.id}')">Details</button></td>
        </tr>`;
    }).join('');
}
function getDriverForVehicle(vid) { return State.vehicles[vid]?.driver_name || '—'; }
function renderShipmentPagination(total, page, perPage) {
    const pages = Math.ceil(total / perPage);
    const el = document.getElementById('shipmentPagination');
    if (!el) return;
    if (pages <= 1) { el.innerHTML = `<span style="color:var(--text-muted);font-size:11px">${total} shipments</span>`; return; }
    let html = `<span style="color:var(--text-muted);font-size:11px">${total} shipments | Page ${page}/${pages}</span>`;
    html += `<button class="page-btn" onclick="loadShipments(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>`;
    for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++)
        html += `<button class="page-btn ${p === page ? 'active' : ''}" onclick="loadShipments(${p})">${p}</button>`;
    html += `<button class="page-btn" onclick="loadShipments(${page + 1})" ${page >= pages ? 'disabled' : ''}>Next ›</button>`;
    el.innerHTML = html;
}

async function showOrderDetail(id) {
    const modal = document.getElementById('orderModal');
    const body = document.getElementById('orderModalBody');
    document.getElementById('orderModalTitle').textContent = `Order ${id}`;
    modal.style.display = 'flex';
    body.innerHTML = '<div class="loading-state"><i class="fas fa-circle-notch fa-spin"></i> Loading...</div>';
    try {
        const res = await API.get(`/orders/${id}`);
        const o = res.data;
        body.innerHTML = `
        <div class="order-detail-grid">
            <div class="od-section"><h4>Shipment Info</h4>
                ${odRow('Order ID', o.id)}
                ${odRow('Status', `<span class="pill ${o.order_status === 'Delivered' ? 'delivered' : 'in-transit'}">${o.order_status}</span>`)}
                ${odRow('Goods', `${o.goods_type} (${o.goods_category})`)}
                ${odRow('Quantity', `${o.quantity} ${o.unit}`)}
                ${odRow('Distance', `${o.distance_km} km`)}
                ${odRow('Cost', `Rs.${(o.transport_cost_inr || 0).toLocaleString('en-IN')}`)}
            </div>
            <div class="od-section"><h4>Customer</h4>
                ${odRow('Name', o.customer_name)}
                ${odRow('Company', o.customer_company)}
                ${odRow('Contact', o.customer_contact || '—')}
                ${odRow('Pickup', o.pickup_address)}
                ${odRow('Delivery', o.delivery_address)}
            </div>
            <div class="od-section"><h4>Timeline</h4>
                ${odRow('Dispatched', formatDateTime(o.dispatch_datetime))}
                ${odRow('Expected', formatDateTime(o.expected_delivery_datetime))}
                ${odRow('Actual', formatDateTime(o.actual_delivery_datetime))}
                ${odRow('Transit Hrs', o.estimated_transit_hours + ' hrs')}
            </div>
            <div class="od-section"><h4>Vehicle & Driver</h4>
                ${odRow('Vehicle', o.vehicle_id)}
                ${odRow('Vehicle No', o.vehicle_number || State.vehicles[o.vehicle_id]?.vehicle_number || '—')}
                ${odRow('Driver', o.driver_name || State.vehicles[o.vehicle_id]?.driver_name || '—')}
                ${odRow('Type', o.vehicle_type || State.vehicles[o.vehicle_id]?.vehicle_type || '—')}
            </div>
            ${o.temperature ? `<div class="od-section"><h4>Temperature</h4>
                ${odRow('At Dispatch', o.temperature.temp_at_dispatch + ' °C')}
                ${odRow('In Transit', o.temperature.temp_during_transit + ' °C')}
                ${odRow('At Delivery', o.temperature.temp_at_delivery != null ? o.temperature.temp_at_delivery + ' °C' : '—')}
                ${odRow('Required', o.temperature.required_range + ' °C')}
                ${odRow('Condition', `<span style="color:${o.temperature.condition_status === 'Safe' ? 'var(--green)' : 'var(--red)'}">${o.temperature.condition_status}</span>`)}</div>` : ''}
        </div>`;
    } catch (e) { body.innerHTML = `<div class="loading-state">${e.message}</div>`; }
}
function odRow(l, v) { return `<div class="od-row"><label>${l}</label><span>${v || '—'}</span></div>`; }
function exportShipments() {
    const csv = [['Order ID', 'Customer', 'Company', 'Route', 'Goods', 'Qty', 'Vehicle', 'Status', 'Cost'],
    ...State.orders.map(o => [o.id, o.customer_name, o.customer_company, `${o.source_city}→${o.destination_city}`, o.goods_type, o.quantity, o.vehicle_id, o.order_status, o.transport_cost_inr])]
        .map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    downloadCSV(csv, 'shipments.csv');
}

// ── Drivers — fix #10: minimal card + click for info+score ───────────────────
function initDriverScore(vehicleId) {
    if (!State.driverScores[vehicleId]) {
        // Generate random realistic history
        const events = [];
        const pool = [...SCORE_EVENTS];
        const count = Math.floor(Math.random() * 6) + 2;
        for (let i = 0; i < count; i++) {
            const ev = pool[Math.floor(Math.random() * pool.length)];
            events.push({ ...ev, date: randomPastDate() });
        }
        const score = Math.min(150, Math.max(30, 100 + events.reduce((s, e) => s + e.delta, 0)));
        State.driverScores[vehicleId] = { score: Math.round(score), events };
    }
}
function randomPastDate() {
    const d = new Date(); d.setDate(d.getDate() - Math.floor(Math.random() * 30));
    return d.toLocaleDateString('en-IN');
}

function renderDrivers() {
    const search = (document.getElementById('driverSearch')?.value || '').toLowerCase();
    const vehicles = Object.values(State.vehicles).filter(v =>
        !search || (v.driver_name || '').toLowerCase().includes(search) || v.id.toLowerCase().includes(search)
    );
    const grid = document.getElementById('driversGrid'); if (!grid) return;
    if (!vehicles.length) { grid.innerHTML = '<div class="loading-state">No drivers match</div>'; return; }
    grid.innerHTML = vehicles.map(v => {
        initDriverScore(v.id);
        const sc = State.driverScores[v.id];
        const scoreColor = sc.score >= 90 ? 'var(--green)' : sc.score >= 70 ? 'var(--yellow)' : 'var(--red)';
        const initials = (v.driver_name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const isAtSea = SEA_TRUCKS.has(v.id);
        const eff = isAtSea ? 'sea' : v.status;
        return `<div class="driver-card-slim" onclick="showDriverDetail('${v.id}')">
            <div class="dcs-avatar">${initials}</div>
            <div class="dcs-info">
                <div class="dcs-name">${v.driver_name || 'Unknown'}</div>
                <span class="pill ${eff}" style="font-size:9px">${isAtSea ? 'At Sea' : v.status}</span>
            </div>
            <div class="dcs-score" style="color:${scoreColor}">
                <div class="dcs-score-val">${sc.score}</div>
                <div class="dcs-score-lbl">Score</div>
            </div>
        </div>`;
    }).join('');
}

function showDriverDetail(vehicleId) {
    const v = State.vehicles[vehicleId]; if (!v) return;
    initDriverScore(vehicleId);
    const sc = State.driverScores[vehicleId];
    const scoreColor = sc.score >= 90 ? 'var(--green)' : sc.score >= 70 ? 'var(--yellow)' : 'var(--red)';
    const isAtSea = SEA_TRUCKS.has(vehicleId);

    document.getElementById('driverModalTitle').textContent = v.driver_name || vehicleId;
    document.getElementById('driverModalBody').innerHTML = `
        <div class="driver-modal-layout">
            <!-- LEFT: Driver Info -->
            <div class="od-section driver-info-col">
                <h4>Driver Information</h4>
                <div class="driver-info-row"><label>Name</label><span>${v.driver_name || '—'}</span></div>
                <div class="driver-info-row"><label>Contact</label><span>${v.driver_contact || '—'}</span></div>
                <div class="driver-info-row"><label>Vehicle ID</label><span>${v.id}</span></div>
                <div class="driver-info-row"><label>Vehicle No</label><span>${v.vehicle_number || '—'}</span></div>
                <div class="driver-info-row"><label>Type</label><span>${v.vehicle_type || '—'}</span></div>
                <div class="driver-info-row"><label>Status</label><span><span class="pill ${isAtSea ? 'sea' : v.status}">${isAtSea ? 'At Sea' : v.status}</span></span></div>
                <div class="driver-info-row"><label>Route</label><span>${v.assigned_route || '—'}</span></div>
                <div class="driver-info-row"><label>Order</label><span>${v.current_order_id || 'None'}</span></div>
            </div>
            <!-- RIGHT: Score -->
            <div class="od-section driver-score-col">
                <h4>Performance Score</h4>
                <div class="score-display">
                    <div class="score-number" style="color:${scoreColor}">${sc.score}</div>
                    <div class="score-sub">out of 150 &nbsp;|&nbsp; Base: 100</div>
                    <div class="score-bar-wrap">
                        <div class="score-bar-fill" style="width:${Math.round(sc.score / 150 * 100)}%;background:${scoreColor}"></div>
                    </div>
                </div>
                <div class="event-history-label">Event History</div>
                <div class="event-history-list">
                    ${sc.events.map(e => `
                        <div class="event-row">
                            <span class="event-label">${e.label}</span>
                            <div class="event-right">
                                <span class="event-delta" style="color:${e.delta > 0 ? 'var(--green)' : 'var(--red)'}">${e.delta > 0 ? '+' : ''}${e.delta}</span>
                                <span class="event-date">${e.date}</span>
                            </div>
                        </div>`).join('')}
                </div>
            </div>
        </div>
        <!-- ADJUST SCORE — full width below -->
        <div class="adjust-score-section">
            <div class="adjust-score-label">Adjust Score</div>
            <div class="adjust-score-grid">
                ${SCORE_EVENTS.map(e => `
                    <button class="score-btn ${e.delta > 0 ? 'pos' : 'neg'}" onclick="applyScoreEvent('${vehicleId}','${e.key}')">
                        <span class="score-btn-delta">${e.delta > 0 ? '+' : ''}${e.delta}</span>
                        <span class="score-btn-label">${e.label}</span>
                    </button>`).join('')}
            </div>
        </div>`;
    document.getElementById('driverModal').style.display = 'flex';
}

function applyScoreEvent(vehicleId, eventKey) {
    const ev = SCORE_EVENTS.find(e => e.key === eventKey); if (!ev) return;
    initDriverScore(vehicleId);
    const sc = State.driverScores[vehicleId];
    sc.score = Math.min(150, Math.max(0, sc.score + ev.delta));
    sc.events.unshift({ ...ev, date: new Date().toLocaleDateString('en-IN') });
    showToast(`${ev.label}: ${ev.delta > 0 ? '+' : ''}${ev.delta} pts → Score: ${sc.score}`, ev.delta > 0 ? 'success' : 'warn');
    showDriverDetail(vehicleId); // refresh modal
}

// ── Analytics ─────────────────────────────────────────────────────────────────
async function loadAnalytics() {
    try { const res = await API.get('/analytics/summary'); State.analytics = res.data; renderAnalytics(); }
    catch (e) { showToast('Analytics error: ' + e.message, 'error'); }
}
function renderAnalytics() {
    const d = State.analytics; if (!d) return;
    const kpiEl = document.getElementById('analyticsKpi');
    if (kpiEl) kpiEl.innerHTML = [
        ['Total Vehicles', d.vehicles.total, 'all time'],
        ['Active Now', d.vehicles.active, 'moving'],
        ['Delivered', d.orders.delivered, `${d.orders.on_time_pct}% on time`],
        ['In Transit', d.orders.in_transit, 'active'],
        ['Avg Speed', d.performance.avg_speed_kmh + ' km/h', 'moving'],
        ['Revenue', 'Rs.' + ((d.performance.total_revenue_inr || 0) / 1000).toFixed(0) + 'K', 'all orders'],
        ['Distance', (d.performance.total_distance_km || 0).toLocaleString() + ' km', 'total'],
        ['Alerts', d.alerts.unread, 'unread'],
    ].map(([l, v, s]) => `<div class="kpi-card"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s}</div></div>`).join('');

    const bar = (el, items, maxKey = 'count') => {
        const maxV = Math.max(...items.map(x => x[maxKey] || 0), 1);
        el.innerHTML = '<div class="bar-chart">' + items.slice(0, 8).map(x => `
            <div class="bar-row">
                <div class="bar-label">${x.label}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${((x[maxKey] || 0) / maxV * 100).toFixed(0)}%;background:${x.color || 'var(--accent-dim)'}"></div></div>
                <div class="bar-val">${x[maxKey] || 0}</div>
            </div>`).join('') + '</div>';
    };

    const routeEl = document.getElementById('routeChart');
    if (routeEl && d.routes) bar(routeEl, d.routes.map(r => ({ label: `${r.source_city}→${r.destination_city}`, count: r.count })));

    const statusEl = document.getElementById('statusChart');
    if (statusEl) bar(statusEl, [
        { label: 'Moving', count: d.vehicles.active, color: 'var(--green)' },
        { label: 'Idle', count: d.vehicles.idle, color: 'var(--yellow)' },
        { label: 'At Sea', count: SEA_TRUCKS.size, color: '#00bfff' },
        { label: 'Offline', count: d.vehicles.offline, color: '#555' },
    ]);

    const speedEl = document.getElementById('speedChart');
    if (speedEl && d.top_vehicles_by_speed) bar(speedEl,
        d.top_vehicles_by_speed.map(v => ({ label: `${v.id} (${v.driver_name || '—'})`, count: +(v.avg_speed || 0).toFixed(1), color: 'var(--purple)' })), 'count');

    const alertEl = document.getElementById('alertChart');
    if (alertEl && d.alert_breakdown) bar(alertEl, d.alert_breakdown.map(a => ({ label: `${a.alert_type} (${a.severity})`, count: a.count, color: 'var(--yellow)' })));
}

// ── Alerts — fix #11: silence button ─────────────────────────────────────────
async function loadAlerts() {
    try { const res = await API.get('/alerts', { limit: 100 }); State.alerts = res.data; updateAlertBadge(); renderAlerts(); }
    catch (e) { showToast('Alerts error: ' + e.message, 'error'); }
}
function renderAlerts() {
    const el = document.getElementById('alertsList'); if (!el) return;
    if (!State.alerts.length) { el.innerHTML = '<div class="loading-state">No alerts</div>'; return; }
    el.innerHTML = State.alerts.map(a => `
        <div class="alert-card ${a.acknowledged ? '' : 'unread'} severity-${a.severity}">
            <div class="alert-icon ${a.severity}">
                <i class="fas fa-${a.severity === 'High' ? 'exclamation-triangle' : a.severity === 'Medium' ? 'exclamation-circle' : 'info-circle'}"></i>
            </div>
            <div class="alert-body">
                <div class="alert-title">${a.alert_type}</div>
                <div class="alert-detail">${a.alert_reason}${a.delay_minutes ? ` (${a.delay_minutes > 0 ? '+' : ''}${a.delay_minutes} min)` : ''}</div>
                <div class="alert-meta">Order: ${a.order_id || '—'} • ${a.vehicle_id || '—'} • ${formatTime(a.created_at)}</div>
                ${!a.acknowledged ? `<div class="alert-action"><button class="btn-sm" onclick="ackAlert(${a.id})">Acknowledge</button></div>` : ''}
            </div>
        </div>`).join('');
}
async function ackAlert(id) {
    try { await API.put(`/alerts/${id}/acknowledge`); const a = State.alerts.find(x => x.id === id); if (a) a.acknowledged = 1; renderAlerts(); updateAlertBadge(); }
    catch { }
}
async function acknowledgeAllAlerts() {
    for (const a of State.alerts.filter(x => !x.acknowledged)) {
        try { await API.put(`/alerts/${a.id}/acknowledge`); a.acknowledged = 1; } catch { }
    }
    renderAlerts(); updateAlertBadge(); showToast('All alerts acknowledged', 'success');
}

function silenceAlerts(minutes) {
    State.alertsSilenced = true;
    if (State.silenceTimer) clearTimeout(State.silenceTimer);
    const banner = document.getElementById('silenceBanner');
    const ind = document.getElementById('silenceIndicator');
    const bannerTxt = document.getElementById('silenceBannerText');
    if (banner) banner.style.display = 'flex';
    if (ind) ind.style.display = 'inline-flex';

    if (minutes > 0) {
        State.silenceUntil = new Date(Date.now() + minutes * 60000);
        if (bannerTxt) bannerTxt.textContent = `Silenced for ${minutes} min (until ${State.silenceUntil.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })})`;
        State.silenceTimer = setTimeout(unsilenceAlerts, minutes * 60000);
        showToast(`Alerts silenced for ${minutes} minutes`, 'info');
    } else {
        if (bannerTxt) bannerTxt.textContent = 'Silenced indefinitely';
        showToast('Alerts silenced indefinitely', 'info');
    }
    document.getElementById('silenceModal').style.display = 'none';
}
function unsilenceAlerts() {
    State.alertsSilenced = false;
    if (State.silenceTimer) { clearTimeout(State.silenceTimer); State.silenceTimer = null; }
    const banner = document.getElementById('silenceBanner');
    const ind = document.getElementById('silenceIndicator');
    if (banner) banner.style.display = 'none';
    if (ind) ind.style.display = 'none';
    showToast('Alerts unsilenced', 'success');
}

// ── Logs ──────────────────────────────────────────────────────────────────────
async function loadLogs() {
    const logType = document.getElementById('logTypeFilter')?.value || '';
    try {
        const res = await API.get('/logs', { limit: 150, ...(logType ? { type: logType } : {}) });
        const el = document.getElementById('logStream'); if (!el) return;
        if (!res.data.length) { el.innerHTML = '<div class="loading-state">No logs</div>'; return; }
        el.innerHTML = res.data.map(l => `<div class="log-entry">
            <span class="log-time">${formatTime(l.created_at)}</span>
            <span class="log-type ${l.log_type}">${l.log_type}</span>
            <span class="log-msg">${l.message}${l.entity_id ? ` [${l.entity_id}]` : ''}</span>
        </div>`).join('');
    } catch { }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === name));
    const pg = document.getElementById(`${name}-page`); if (pg) pg.classList.add('active');
    State.currentPage = name;
    // Restore vehicle panel visibility on non-collapsed
    const vp = document.getElementById('vehiclePanel');
    if (name === 'tracking' && vp) vp.style.display = State.sidebarCollapsed ? 'none' : '';
    switch (name) {
        case 'tracking': if (!State.map) initMap(); renderVehiclePanel(); renderMapVehicles(); break;
        case 'fleet': renderFleetTable(); switchFleetTab('vehicles'); break;
        case 'fleet-registry': renderFleetTable(); switchFleetTab('registry'); break;
        // Features 6-15
        // Features 16-25
        case 'customers': switchCustomersTab('customers'); break;
        case 'staff': switchStaffTab('staff'); break;
        // Existing pages
        case 'shipments': loadShipments(1); break;
    }

}

// ── Fleet Tabs (Vehicles / Registry) ─────────────────────────────────────────
function switchFleetTab(tab) {
    const isVeh = tab === 'vehicles';
    const isReg = tab === 'registry';
    const isRte = tab === 'routes';
    const isLP = tab === 'load-plan';
    const isDsp = tab === 'dispatch';
    const isSh = tab === 'shipments';
    const isAn = tab === 'analytics';
    const isGeo = tab === 'geofencing';
    const isCmp = tab === 'compliance';
    const isRep = tab === 'reports';
    const isRet = tab === 'returns';
    const isSla = tab === 'sla';
    const isTel = tab === 'telemetry';
    const isFuel = tab === 'fuel';
    const isPod = tab === 'pod';
    const isExc = tab === 'exceptions';
    const isCosts = tab === 'costs';
    const isLife = tab === 'lifecycle';
    // Show/hide content panels
    const tv = document.getElementById('fleetTabVehicles');
    const tr = document.getElementById('fleetTabRegistry');
    const trte = document.getElementById('fleetTabRoutes');
    const tlp = document.getElementById('fleetTabLoadPlan');
    const tdsp = document.getElementById('fleetTabDispatch');
    const tsh = document.getElementById('fleetTabShipments');
    const tan = document.getElementById('fleetTabAnalytics');
    const tgeo = document.getElementById('fleetTabGeofencing');
    const tcmp = document.getElementById('fleetTabCompliance');
    const trep = document.getElementById('fleetTabReports');
    const tret = document.getElementById('fleetTabReturns');
    const tsla = document.getElementById('fleetTabSla');
    const ttel = document.getElementById('fleetTabTelemetry');
    const tfuel = document.getElementById('fleetTabFuel');
    const tpod = document.getElementById('fleetTabPod');
    const texc = document.getElementById('fleetTabExceptions');
    const tcosts = document.getElementById('fleetTabCosts');
    const tlife = document.getElementById('fleetTabLifecycle');
    if (tv) tv.style.display = isVeh ? '' : 'none';
    if (tr) tr.style.display = isReg ? '' : 'none';
    if (trte) trte.style.display = isRte ? '' : 'none';
    if (tlp) tlp.style.display = isLP ? '' : 'none';
    if (tdsp) tdsp.style.display = isDsp ? '' : 'none';
    if (tsh) tsh.style.display = isSh ? '' : 'none';
    if (tan) tan.style.display = isAn ? '' : 'none';
    if (tgeo) tgeo.style.display = isGeo ? '' : 'none';
    if (tcmp) tcmp.style.display = isCmp ? '' : 'none';
    if (trep) trep.style.display = isRep ? '' : 'none';
    if (tret) tret.style.display = isRet ? '' : 'none';
    if (tsla) tsla.style.display = isSla ? '' : 'none';
    if (ttel) ttel.style.display = isTel ? '' : 'none';
    if (tfuel) tfuel.style.display = isFuel ? '' : 'none';
    if (tpod) tpod.style.display = isPod ? '' : 'none';
    if (texc) texc.style.display = isExc ? '' : 'none';
    if (tcosts) tcosts.style.display = isCosts ? '' : 'none';
    if (tlife) tlife.style.display = isLife ? '' : 'none';
    // Toggle tab button styles
    const btn1 = document.getElementById('ftabVehicles');
    const btn2 = document.getElementById('ftabRegistry');
    const btn3 = document.getElementById('ftabRoutes');
    const btn4 = document.getElementById('ftabLoadPlan');
    const btn5 = document.getElementById('ftabDispatch');
    const btn6 = document.getElementById('ftabShipments');
    const btn7 = document.getElementById('ftabAnalytics');
    const btn8 = document.getElementById('ftabGeofencing');
    const btn9 = document.getElementById('ftabCompliance');
    const btn10 = document.getElementById('ftabReports');
    const btn11 = document.getElementById('ftabReturns');
    const btn12 = document.getElementById('ftabSla');
    const btn13 = document.getElementById('ftabTelemetry');
    const btn14 = document.getElementById('ftabFuel');
    const btn15 = document.getElementById('ftabPod');
    const btn16 = document.getElementById('ftabExceptions');
    const btn17 = document.getElementById('ftabCosts');
    const btn18 = document.getElementById('ftabLifecycle');
    if (btn1) btn1.classList.toggle('active', isVeh);
    if (btn2) btn2.classList.toggle('active', isReg);
    if (btn3) btn3.classList.toggle('active', isRte);
    if (btn4) btn4.classList.toggle('active', isLP);
    if (btn5) btn5.classList.toggle('active', isDsp);
    if (btn6) btn6.classList.toggle('active', isSh);
    if (btn7) btn7.classList.toggle('active', isAn);
    if (btn8) btn8.classList.toggle('active', isGeo);
    if (btn9) btn9.classList.toggle('active', isCmp);
    if (btn10) btn10.classList.toggle('active', isRep);
    if (btn11) btn11.classList.toggle('active', isRet);
    if (btn12) btn12.classList.toggle('active', isSla);
    if (btn13) btn13.classList.toggle('active', isTel);
    if (btn14) btn14.classList.toggle('active', isFuel);
    if (btn15) btn15.classList.toggle('active', isPod);
    if (btn16) btn16.classList.toggle('active', isExc);
    if (btn17) btn17.classList.toggle('active', isCosts);
    if (btn18) btn18.classList.toggle('active', isLife);
    // Toggle header action bars
    const va = document.getElementById('fleetVehicleActions');
    const ra = document.getElementById('fleetRegistryActions');
    if (va) va.style.display = isVeh ? '' : 'none';
    if (ra) ra.style.display = isReg ? '' : 'none';
    // Load data for the tab
    if (isReg) loadFleetRegistry();
    if (isRte) loadRoutes();
    if (isLP) loadLoadPlans();
    if (isDsp) loadDispatches();
    if (isSh) searchShipments();
    if (isAn) loadAnalytics();
    if (isGeo) loadGeofencing();
    if (isCmp) loadCompliance();
    if (isRep) { loadDeliveryReport(); loadVehicleReport(); loadFinancialReport(); }
    if (isRet) loadReturns();
    if (isSla) loadSLA();
    if (isTel) loadTelemetry();
    if (isFuel) loadFuelMgmt();
    if (isPod) loadPOD();
    if (isExc) loadIncidents();
    if (isCosts) loadCosts();
    if (isLife) loadAllLifecycles();
    // Also activate the fleet-page so showPage sees it correctly
    const pg = document.getElementById('fleet-page');
    if (pg && !pg.classList.contains('active')) pg.classList.add('active');
    State.currentPage = 'fleet';
}

// ── Staff/HR Tabs ─────────────────────────────────────────────────────────────
function switchStaffTab(tab) {
    const isStaff = tab === 'staff';
    const isDrivers = tab === 'drivers';

    // Content panels
    const sc = document.getElementById('staffTabStaffContent');
    const dc = document.getElementById('staffTabDriversContent');
    if (sc) sc.style.display = isStaff ? '' : 'none';
    if (dc) dc.style.display = isDrivers ? '' : 'none';

    // Tab buttons
    const b1 = document.getElementById('staffTabStaff');
    const b2 = document.getElementById('staffTabDrivers');
    if (b1) b1.classList.toggle('active', isStaff);
    if (b2) b2.classList.toggle('active', isDrivers);

    // Header action bars
    const ha = document.getElementById('staffHrActions');
    const hd = document.getElementById('staffDriversActions');
    const hdm = document.getElementById('staffDriverMgmtActions');
    if (ha) ha.style.display = isStaff ? '' : 'none';
    // Driver sub-tab actions handled by switchDriversSubTab
    if (hd) hd.style.display = 'none';
    if (hdm) hdm.style.display = 'none';

    // Load data
    if (isStaff) loadStaff();
    if (isDrivers) switchDriversSubTab('grid');  // default to grid sub-tab

    const pg = document.getElementById('staff-page');
    if (pg && !pg.classList.contains('active')) pg.classList.add('active');
    State.currentPage = 'staff';
}

// ── Drivers Sub-Tabs (inside Staff/HR → Drivers) ──────────────────────────────
function switchDriversSubTab(sub) {
    const isGrid = sub === 'grid';
    const isMgmt = sub === 'mgmt';

    // Sub-tab content panels
    const sg = document.getElementById('driverSubGrid');
    const sm = document.getElementById('driverSubMgmt');
    if (sg) sg.style.display = isGrid ? '' : 'none';
    if (sm) sm.style.display = isMgmt ? '' : 'none';

    // Sub-tab buttons
    const b1 = document.getElementById('dsubTabGrid');
    const b2 = document.getElementById('dsubTabMgmt');
    if (b1) b1.classList.toggle('active', isGrid);
    if (b2) b2.classList.toggle('active', isMgmt);

    // Header action bars
    const hd = document.getElementById('staffDriversActions');
    const hdm = document.getElementById('staffDriverMgmtActions');
    if (hd) hd.style.display = isGrid ? '' : 'none';
    if (hdm) hdm.style.display = isMgmt ? '' : 'none';

    // Load data
    if (isGrid) renderDrivers();
    if (isMgmt) loadDriverMgmt();
}

// ── Notifications Tabs ───────────────────────────────────────────────────────
function switchNotifTab(tab) {
    const isHub = tab === 'hub';
    const isAlert = tab === 'alerts';
    const isMaint = tab === 'maintenance';
    const isLogs = tab === 'logs';

    const hc = document.getElementById('notifTabHubContent');
    const ac = document.getElementById('notifTabAlertsContent');
    const mc = document.getElementById('notifTabMaintContent');
    const lc = document.getElementById('notifTabLogsContent');
    if (hc) hc.style.display = isHub ? '' : 'none';
    if (ac) ac.style.display = isAlert ? '' : 'none';
    if (mc) mc.style.display = isMaint ? '' : 'none';
    if (lc) lc.style.display = isLogs ? '' : 'none';

    const b1 = document.getElementById('notifTabHub');
    const b2 = document.getElementById('notifTabAlerts');
    const b3 = document.getElementById('notifTabMaint');
    const b4 = document.getElementById('notifTabLogs');
    if (b1) b1.classList.toggle('active', isHub);
    if (b2) b2.classList.toggle('active', isAlert);
    if (b3) b3.classList.toggle('active', isMaint);
    if (b4) b4.classList.toggle('active', isLogs);

    const ha = document.getElementById('notifHubActions');
    const aa = document.getElementById('notifAlertsActions');
    const ma = document.getElementById('notifMaintActions');
    const la = document.getElementById('notifLogsActions');
    if (ha) ha.style.display = isHub ? '' : 'none';
    if (aa) aa.style.display = isAlert ? '' : 'none';
    if (ma) ma.style.display = isMaint ? '' : 'none';
    if (la) la.style.display = isLogs ? '' : 'none';

    if (isHub) loadNotifHub();
    if (isAlert) loadAlerts();
    if (isMaint) loadMaintenance();
    if (isLogs) loadLogs();

    const pg = document.getElementById('notif-hub-page');
    if (pg && !pg.classList.contains('active')) pg.classList.add('active');
    State.currentPage = 'notif-hub';
}

// ── Warehouse Tabs ────────────────────────────────────────────────────────────
function switchWarehouseTab(tab) {
    const isWh = tab === 'warehouse';
    const isHubs = tab === 'hubs';

    const wc = document.getElementById('whTabWarehouseContent');
    const hc = document.getElementById('whTabHubsContent');
    if (wc) wc.style.display = isWh ? '' : 'none';
    if (hc) hc.style.display = isHubs ? '' : 'none';

    const b1 = document.getElementById('whTabWarehouse');
    const b2 = document.getElementById('whTabHubs');
    if (b1) b1.classList.toggle('active', isWh);
    if (b2) b2.classList.toggle('active', isHubs);

    const wa = document.getElementById('whWarehouseActions');
    const ha = document.getElementById('whHubsActions');
    if (wa) wa.style.display = isWh ? '' : 'none';
    if (ha) ha.style.display = isHubs ? '' : 'none';

    if (isWh) loadWarehouses();
    if (isHubs) loadHubs();

    const pg = document.getElementById('warehouse-page');
    if (pg && !pg.classList.contains('active')) pg.classList.add('active');
    State.currentPage = 'warehouse';
}

// ── Customers Tabs ────────────────────────────────────────────────────────────
function switchCustomersTab(tab) {
    const isCust = tab === 'customers';
    const isBill = tab === 'billing';
    const isCon = tab === 'contracts';
    const isKpi = tab === 'kpis';

    const cc = document.getElementById('custTabCustomersContent');
    const bc = document.getElementById('custTabBillingContent');
    const kc = document.getElementById('custTabContractsContent');
    const kpc = document.getElementById('custTabKpiContent');
    if (cc) cc.style.display = isCust ? '' : 'none';
    if (bc) bc.style.display = isBill ? '' : 'none';
    if (kc) kc.style.display = isCon ? '' : 'none';
    if (kpc) kpc.style.display = isKpi ? '' : 'none';

    const b1 = document.getElementById('custTabCustomers');
    const b2 = document.getElementById('custTabBilling');
    const b3 = document.getElementById('custTabContracts');
    const b4 = document.getElementById('custTabKpi');
    if (b1) b1.classList.toggle('active', isCust);
    if (b2) b2.classList.toggle('active', isBill);
    if (b3) b3.classList.toggle('active', isCon);
    if (b4) b4.classList.toggle('active', isKpi);

    const ca = document.getElementById('custCustomersActions');
    const ba = document.getElementById('custBillingActions');
    const kca = document.getElementById('custContractsActions');
    const kpa = document.getElementById('custKpiActions');
    if (ca) ca.style.display = isCust ? '' : 'none';
    if (ba) ba.style.display = isBill ? '' : 'none';
    if (kca) kca.style.display = isCon ? '' : 'none';
    if (kpa) kpa.style.display = isKpi ? '' : 'none';

    if (isCust) loadCustomers();
    if (isBill) loadInvoices();
    if (isCon) loadContracts();
    if (isKpi) loadKPIs();

    const pg = document.getElementById('customers-page');
    if (pg && !pg.classList.contains('active')) pg.classList.add('active');
    State.currentPage = 'customers';
}

// ── Global Search ─────────────────────────────────────────────────────────────
function setupSearch() {
    const input = document.getElementById('globalSearch');
    const results = document.getElementById('searchResults');
    if (!input || !results) return;
    let debounce;
    input.addEventListener('input', () => {
        clearTimeout(debounce);
        const q = input.value.trim().toLowerCase();
        if (!q) { results.style.display = 'none'; return; }
        debounce = setTimeout(async () => {
            const hits = [];
            Object.values(State.vehicles).forEach(v => {
                if (v.id.toLowerCase().includes(q) || (v.driver_name || '').toLowerCase().includes(q))
                    hits.push({ icon: 'truck', label: v.id, sub: v.driver_name, action: () => { showPage('tracking'); setTimeout(() => selectVehicle(v.id), 200); } });
            });
            try {
                const res = await API.get('/orders', { search: q, per_page: 5 });
                res.data.forEach(o => hits.push({ icon: 'box', label: o.id, sub: `${o.customer_name} • ${o.order_status}`, action: () => showOrderDetail(o.id) }));
            } catch { }
            if (!hits.length) { results.style.display = 'none'; return; }
            results.innerHTML = hits.slice(0, 8).map((h, i) => `
                <div class="search-result-item" id="sr-${i}">
                    <i class="fas fa-${h.icon}"></i>
                    <div><div style="color:var(--text-primary)">${h.label}</div><div style="font-size:10px;color:var(--text-muted)">${h.sub || ''}</div></div>
                </div>`).join('');
            results.style.display = 'block';
            hits.slice(0, 8).forEach((h, i) => { document.getElementById(`sr-${i}`)?.addEventListener('click', () => { h.action(); results.style.display = 'none'; input.value = ''; }); });
        }, 250);
    });
    document.addEventListener('click', e => { if (!input.contains(e.target) && !results.contains(e.target)) results.style.display = 'none'; });
}

// ── Alert Dropdown ────────────────────────────────────────────────────────────
function setupAlertBtn() {
    document.getElementById('alertBtn')?.addEventListener('click', e => {
        e.stopPropagation();
        const drop = document.getElementById('alertDropdown');
        const isOpen = drop.style.display !== 'none';
        closePanels();
        if (!isOpen) { renderAlertDropdown(); drop.style.display = 'block'; document.getElementById('panelOverlay').style.display = 'block'; }
    });
}
function closeAlertDropdown() { document.getElementById('alertDropdown').style.display = 'none'; document.getElementById('panelOverlay').style.display = 'none'; }
function renderAlertDropdown() {
    const list = document.getElementById('adList');
    const alerts = State.alerts;
    if (!alerts?.length) { list.innerHTML = '<div class="ad-empty"><i class="fas fa-check-circle" style="color:var(--green)"></i><br>No alerts</div>'; return; }
    list.innerHTML = alerts.slice(0, 12).map(a => {
        const sev = a.severity || 'Low';
        return `<div class="ad-item">
            <div class="ad-item-icon ${sev}"><i class="fas fa-${sev === 'High' ? 'exclamation-triangle' : sev === 'Medium' ? 'exclamation-circle' : 'info-circle'}"></i></div>
            <div class="ad-item-body">
                <div class="ad-item-type">${a.alert_type}</div>
                <div class="ad-item-reason">${a.alert_reason || ''}</div>
                <div class="ad-item-meta">Order: ${a.order_id || '—'} | ${sev}</div>
            </div>
            ${!a.acknowledged ? `<button class="ad-item-ack" onclick="ackAlertById(${a.id},this)">Ack</button>` : ''}
        </div>`;
    }).join('');
}
function ackAlertById(id, btn) {
    fetch(`${API_BASE}/api/alerts/${id}/acknowledge`, { method: 'PUT' }).then(() => { const a = State.alerts.find(x => x.id === id); if (a) a.acknowledged = 1; updateAlertBadge(); btn?.remove(); }).catch(() => { });
}

// ── Settings Panel ────────────────────────────────────────────────────────────
function setupSettingsBtn() {
    document.getElementById('settingsBtn')?.addEventListener('click', e => {
        e.stopPropagation();
        const panel = document.getElementById('settingsPanel');
        const isOpen = panel.style.display !== 'none';
        closePanels();
        if (!isOpen) { panel.style.display = 'block'; document.getElementById('panelOverlay').style.display = 'block'; }
    });
}
function closeSettings() { document.getElementById('settingsPanel').style.display = 'none'; document.getElementById('panelOverlay').style.display = 'none'; }
function closePanels() {
    ['alertDropdown', 'settingsPanel'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    const ov = document.getElementById('panelOverlay'); if (ov) ov.style.display = 'none';
}
function toggleDarkMode() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') !== 'light';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    const tog = document.getElementById('themeToggle'), lbl = document.getElementById('themeLabel');
    if (tog) tog.classList.toggle('off', isDark);
    if (lbl) lbl.textContent = isDark ? 'Light Theme' : 'Dark Theme';
    localStorage.setItem('fleet-theme', isDark ? 'light' : 'dark');
    // Update map tiles
    if (State.map && State.tileLayer) {
        State.map.removeLayer(State.tileLayer);
        State.tileLayer = L.tileLayer(
            isDark ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
                : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            { maxZoom: 19, attribution: '' }
        ).addTo(State.map);
    }
}
function updateSettingsInfo() {
    const el = document.getElementById('spVehicleCount');
    if (el) { const c = Object.keys(State.vehicles).length; el.textContent = c ? `${c} trucks monitored` : '— trucks'; }
}

// ── AUTH / LOGIN ──────────────────────────────────────────────────────────────
let currentRole = null;

function selectLoginType(type) {
    document.getElementById('roleChooser').style.display = 'none';
    document.getElementById('adminForm').style.display = type === 'admin' ? 'block' : 'none';
    document.getElementById('customerForm').style.display = type === 'customer' ? 'block' : 'none';

    if (type === 'admin') {
        // B-03 code removed to allow the HTML autofill to persist
        // We do not clear the user and pass fields anymore.
        document.querySelectorAll('#pinBoxes .otp-box').forEach(b => b.value = '');
        document.querySelectorAll('#otpBoxes .otp-box').forEach(b => b.value = '');

        // Show the initial step
        const s1 = document.getElementById('otpStep1');
        const s2 = document.getElementById('otpStep2');
        if (s1) s1.style.display = 'block';
        if (s2) s2.style.display = 'none';
    } else if (type === 'customer') {
        // Auto-fill customer tracking demo credentials
        document.getElementById('customerOrderId').value = 'AHE1417';
        document.getElementById('customerContact').value = '8248223344';

        // Auto-fill customer account login credentials
        document.getElementById('custEmail').value = 'customer@logisense.com';
        document.getElementById('custPassword').value = 'password123';
    }
}
function resetLoginType() {
    document.getElementById('roleChooser').style.display = 'flex';
    document.getElementById('adminForm').style.display = 'none';
    document.getElementById('customerForm').style.display = 'none';
    const err = document.getElementById('adminError'); if (err) err.style.display = 'none';
    const cerr = document.getElementById('customerError'); if (cerr) cerr.style.display = 'none';
}

// Auth tab switching #2
function switchAuthTab(tab) {
    State.currentAuthTab = tab;
    ['password', 'otp', 'pin'].forEach(t => {
        document.getElementById(`authTab${t.charAt(0).toUpperCase() + t.slice(1)}`)?.classList.toggle('active', t === tab);
        document.getElementById(`auth${t.charAt(0).toUpperCase() + t.slice(1)}`).style.display = t === tab ? 'block' : 'none';
    });
    // fix tab button ids
    document.getElementById('tabPassword')?.classList.toggle('active', tab === 'password');
    document.getElementById('tabOtp')?.classList.toggle('active', tab === 'otp');
    document.getElementById('tabPin')?.classList.toggle('active', tab === 'pin');
}

// OTP flow #3
function sendOtp() {
    // B-03: Verify username exists server-side before showing OTP panel
    const user = document.getElementById('adminUser').value.trim();
    if (!user) {
        const err = document.getElementById('adminError');
        if (err) { err.textContent = 'Enter username'; err.style.display = 'block'; } return;
    }
    document.getElementById('otpStep1').style.display = 'none';
    document.getElementById('otpStep2').style.display = 'block';
    showToast('OTP sent to registered number', 'success');
}
function resetOtp() {
    document.getElementById('otpStep1').style.display = 'block';
    document.getElementById('otpStep2').style.display = 'none';
    document.querySelectorAll('#otpBoxes .otp-box').forEach(b => b.value = '');
}
function otpNav(inp, idx) {
    const boxes = document.querySelectorAll('#otpBoxes .otp-box');
    if (inp.value && idx < boxes.length - 1) boxes[idx + 1].focus();
    if ([...boxes].every(b => b.value)) doAdminLogin('otp');
}
function otpBack(inp, e, idx) {
    if (e.key === 'Backspace' && !inp.value && idx > 0) {
        const boxes = document.querySelectorAll('#otpBoxes .otp-box');
        boxes[idx - 1].focus(); boxes[idx - 1].value = '';
    }
}
function pinNav(inp, idx) {
    const boxes = document.querySelectorAll('#pinBoxes .otp-box');
    if (inp.value && idx < boxes.length - 1) boxes[idx + 1].focus();
    if ([...boxes].every(b => b.value)) doAdminLogin('pin');
}
function pinBack(inp, e, idx) {
    if (e.key === 'Backspace' && !inp.value && idx > 0) {
        const boxes = document.querySelectorAll('#pinBoxes .otp-box');
        boxes[idx - 1].focus(); boxes[idx - 1].value = '';
    }
}
function togglePwEye(inputId, btn) {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.innerHTML = `<i class="fas fa-${show ? 'eye-slash' : 'eye'}"></i>`;
}

async function doAdminLogin(method) {
    const err = document.getElementById('adminError');
    const showErr = msg => { if (err) { err.textContent = msg; err.style.display = 'block'; } };
    if (err) err.style.display = 'none';
    const user = document.getElementById('adminUser').value.trim();
    if (!user) { showErr('Enter username'); return; }

    // B-03: Validate credentials server-side — never compare against frontend constants
    try {
        let body = { method, user };
        if (method === 'password') {
            body.pass = document.getElementById('adminPass').value;
        } else if (method === 'otp') {
            body.otp = [...document.querySelectorAll('#otpBoxes .otp-box')].map(b => b.value).join('');
        } else if (method === 'pin') {
            body.pin = [...document.querySelectorAll('#pinBoxes .otp-box')].map(b => b.value).join('');
        }
        const res = await fetch(`${API_BASE}/api/admin/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            showErr(data.error || 'Invalid credentials');
            return;
        }
    } catch (e) {
        showErr('Could not reach server. Check connection.');
        return;
    }

    currentRole = 'admin';
    document.getElementById('loginScreen').style.display = 'none';
    showAppWithDisclaimer('adminApp', () => {
        initAdminApp();
    });
}

// Customer Account & Authentication
function switchCustAuthTab(tab) {
    document.getElementById('custAuthTrack').style.display = tab === 'track' ? 'block' : 'none';
    document.getElementById('custAuthAccount').style.display = tab === 'login' ? 'block' : 'none';

    document.getElementById('custTabTrack').style.color = tab === 'track' ? '#00bfff' : '#888';
    document.getElementById('custTabTrack').style.borderBottomColor = tab === 'track' ? '#00bfff' : 'transparent';
    document.getElementById('custTabLogin').style.color = tab === 'login' ? '#00bfff' : '#888';
    document.getElementById('custTabLogin').style.borderBottomColor = tab === 'login' ? '#00bfff' : 'transparent';

    document.getElementById('customerError').style.display = 'none';
}

function switchCustAuthMode(mode) {
    document.getElementById('custLoginFields').style.display = mode === 'login' ? 'block' : 'none';
    document.getElementById('custSignupFields').style.display = mode === 'signup' ? 'block' : 'none';
    document.getElementById('customerError').style.display = 'none';
}

async function doCustomerAuth(action) {
    const errEl = document.getElementById('customerError');
    errEl.style.display = 'none';
    let payload = {};
    let endpoint = '';

    if (action === 'signup') {
        payload = {
            name: document.getElementById('custNewName').value.trim(),
            email: document.getElementById('custNewEmail').value.trim(),
            password: document.getElementById('custNewPassword').value.trim()
        };
        endpoint = `${API_BASE}/api/customer/signup`;
    } else {
        payload = {
            email: document.getElementById('custEmail').value.trim(),
            password: document.getElementById('custPassword').value.trim()
        };
        endpoint = `${API_BASE}/api/customer/auth`;
    }

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!data.success) {
            errEl.textContent = data.error || 'Authentication failed';
            errEl.style.display = 'block';
            return;
        }

        currentRole = 'customer';
        State.currentUserType = 'customer_account';
        State.customerUserData = data.data; // Stores account details

        document.getElementById('loginScreen').style.display = 'none';
        showAppWithDisclaimer('customerView', () => {
            showCustTab('book'); // Send them to book shipment tab by default!
        });
    } catch (e) {
        console.error(e);
        errEl.textContent = 'Server error. Try again.';
        errEl.style.display = 'block';
    }
}

// Customer login #6, #7, #8
async function doCustomerLogin() {
    const orderId = document.getElementById('customerOrderId').value.trim().toUpperCase();
    const contact = document.getElementById('customerContact').value.trim();
    const errEl = document.getElementById('customerError');
    errEl.style.display = 'none';
    if (!orderId) { errEl.textContent = 'Enter Order ID'; errEl.style.display = 'block'; return; }
    if (!contact) { errEl.textContent = 'Enter contact number'; errEl.style.display = 'block'; return; }
    try {
        const res = await fetch(`${API_BASE}/api/orders/${orderId}`);
        if (!res.ok) { errEl.textContent = 'Order not found'; errEl.style.display = 'block'; return; }
        const data = await res.json();
        const order = data.data;
        if (String(order.customer_contact) !== String(contact)) { errEl.textContent = 'Contact number does not match'; errEl.style.display = 'block'; return; }
        currentRole = 'customer';
        State.custOrderData = order;
        document.getElementById('loginScreen').style.display = 'none';
        showAppWithDisclaimer('customerView', () => {
            renderCustomerDetails(order);
        });
    } catch (e) { errEl.textContent = 'Server error. Try again.'; errEl.style.display = 'block'; }
}

// Customer tabs
function showCustTab(tab) {
    const allTabs = ['details', 'livemap', 'book', 'orders', 'manage', 'history', 'returns'];
    allTabs.forEach(t => {
        const btn = document.getElementById('ctab' + t.charAt(0).toUpperCase() + t.slice(1));
        if (btn) btn.classList.toggle('active', t === tab);
    });
    const panels = {
        details: 'custDetailsPanel', livemap: 'custLivemapPanel', book: 'custBookPanel',
        orders: 'custOrdersPanel', manage: 'custManagePanel',
        history: 'custHistoryPanel', returns: 'custReturnsPanel'
    };
    Object.entries(panels).forEach(([t, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = t === tab ? 'block' : 'none';
    });
    if (tab === 'details') {
        if (!State.custOrderData) {
            document.getElementById('custOrderCard').innerHTML = `<div style="padding: 40px 20px; text-align: center; color: var(--text-muted); font-size: 15px;">
                <i class="fas fa-box-open" style="font-size: 32px; margin-bottom: 12px; opacity: 0.5;"></i><br>
                Please place an order to track its progress.
            </div>`;
        }
    }
    if (tab === 'livemap') {
        renderLiveMap();
    }
    if (tab === 'orders') renderCustOrdersList();
    if (tab === 'book') initBookingForm();
    if (tab === 'manage') initManagePanel();
    if (tab === 'history') renderShipmentHistory();
    if (tab === 'returns') initReturnsPanel();
}

// ── Tracking sub-tabs (Details / Live Map) ────────────────────
function renderLiveMap() {
    if (!State.custMap) {
        State.custMap = L.map('custMap', { zoomControl: true, attributionControl: false }).setView([15, 78], 6);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(State.custMap);
    }
    const order = State.custOrderData;
    if (order) {
        const v = State.vehicles ? State.vehicles[order.vehicle_id] : null;
        const SEA_POS = {};
        const isAtSea = typeof SEA_TRUCKS !== 'undefined' && SEA_TRUCKS.has(order.vehicle_id);
        const [mlat, mlng] = SEA_POS[order.vehicle_id] || [v?.current_lat || 15, v?.current_lng || 78];
        if (State.custMarker) State.custMap.removeLayer(State.custMarker);
        const icon = L.divIcon({ html: `<div class="vmarker ${isAtSea ? 'sea' : v?.status || 'moving'}" style="font-size:20px">${isAtSea ? '🚢' : '🚛'}</div>`, iconSize: [40, 40], iconAnchor: [20, 20], className: '' });
        State.custMarker = L.marker([mlat, mlng], { icon }).addTo(State.custMap)
            .bindPopup(`<b>${order.vehicle_id || 'Pending'}</b><br>${order.source_city || '—'} → ${order.destination_city || '—'}<br>Status: ${isAtSea ? 'At Sea' : v?.status || order.order_status}`).openPopup();
        State.custMap.setView([mlat, mlng], 8);
    }
    setTimeout(() => { if (State.custMap) State.custMap.invalidateSize(); }, 150);
}

// ── Embedded collapsible sections toggle ─────────────────────
function toggleEmbedSection(id, toggleEl) {
    const el = document.getElementById(id);
    if (!el) return;
    const isOpen = el.style.display !== 'none';
    el.style.display = isOpen ? 'none' : 'block';
    const chevron = toggleEl.querySelector('.cust-embed-chevron');
    if (chevron) chevron.classList.toggle('open', !isOpen);
    // Lazy-init panels when opened
    if (!isOpen) {
        if (id === 'bulkSection') initBulkPanel();
        if (id === 'feedbackSection') initFeedbackPanel();
    }
}

// ── Support floating overlay ──────────────────────────────────
function toggleFabMenu() {
    const menu = document.getElementById('custFabMenu');
    const fab = document.getElementById('chatFab');
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';
    fab?.classList.toggle('is-open', !isOpen);
}

function openChatOption() {
    // Close menu, open chatbot
    document.getElementById('custFabMenu').style.display = 'none';
    document.getElementById('chatFab')?.classList.remove('is-open');
    toggleChatPanel();
}

function openSupportOption() {
    // Close menu, open support overlay
    document.getElementById('custFabMenu').style.display = 'none';
    document.getElementById('chatFab')?.classList.remove('is-open');
    const ov = document.getElementById('custSupportOverlay');
    if (ov) { ov.style.display = 'flex'; initSupportPanel(); }
}

// Close FAB menu when clicking outside
document.addEventListener('click', e => {
    const wrap = document.getElementById('custFabWrap');
    if (wrap && !wrap.contains(e.target)) {
        const menu = document.getElementById('custFabMenu');
        const fab = document.getElementById('chatFab');
        if (menu) menu.style.display = 'none';
        fab?.classList.remove('is-open');
    }
});

function toggleSupportOverlay() {
    const ov = document.getElementById('custSupportOverlay');
    if (!ov) return;
    const isOpen = ov.style.display !== 'none';
    ov.style.display = isOpen ? 'none' : 'flex';
    if (!isOpen) initSupportPanel();
}
function closeSupportOverlay() {
    const ov = document.getElementById('custSupportOverlay');
    if (ov) ov.style.display = 'none';
}

function renderCustomerDetails(order) {
    const isDelivered = order.order_status === 'Delivered';
    const progress = isDelivered ? 100 : Math.round(Math.random() * 30 + 40);

    // ── Lifecycle stages
    const stages = [
        { key: 'created', label: 'Order Created', icon: 'fa-file-alt' },
        { key: 'pickup_scheduled', label: 'Pickup Scheduled', icon: 'fa-calendar-check' },
        { key: 'picked_up', label: 'Picked Up', icon: 'fa-hand-paper' },
        { key: 'in_transit', label: 'In Transit', icon: 'fa-truck-moving' },
        { key: 'out', label: 'Out for Delivery', icon: 'fa-shipping-fast' },
        { key: 'delivered', label: 'Delivered', icon: 'fa-check-circle' },
    ];
    const statusMap = {
        'Pending': 0, 'Assigned': 1, 'Pickup Scheduled': 1,
        'Picked Up': 2, 'In Transit': 3, 'At Sea': 3,
        'Out for Delivery': 4, 'Delivered': 5
    };
    const currentStageIdx = isDelivered ? 5 : (statusMap[order.order_status] ?? 3);
    const now = new Date();
    function stageTime(idx) {
        if (idx > currentStageIdx) return '';
        const d = new Date(order.dispatch_datetime || now);
        d.setHours(d.getHours() - (currentStageIdx - idx) * 6);
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
    const stepsHtml = stages.map((s, i) => {
        const cls = i < currentStageIdx ? 'lc-done' : i === currentStageIdx ? 'lc-active' : '';
        const icon = i < currentStageIdx ? 'fa-check' : s.icon;
        return `<div class="cust-lc-step ${cls}">
            <div class="cust-lc-dot"><i class="fas ${icon}"></i></div>
            <div class="cust-lc-body">
                <div class="cust-lc-label">${s.label}</div>
                <div class="cust-lc-time">${i <= currentStageIdx ? stageTime(i) : 'Pending'}</div>
            </div>
        </div>`;
    }).join('');

    // ── ETA Widget
    const expected = order.expected_delivery_datetime ? new Date(order.expected_delivery_datetime) : null;
    const etaMs = expected ? expected - now : null;
    const etaHours = etaMs ? Math.round(etaMs / 3600000) : null;
    const isLate = etaMs !== null && etaMs < 0;
    let etaText = '—', etaSub = '', etaBadgeClass = '', etaBadgeText = '';
    if (isDelivered) {
        etaText = 'Delivered'; etaSub = formatDateTime(order.actual_delivery_datetime);
        etaBadgeClass = 'on-time'; etaBadgeText = '✓ Complete';
    } else if (etaHours !== null) {
        if (isLate) {
            etaText = Math.abs(etaHours) + 'h overdue';
            etaSub = 'Expected ' + formatDateTime(order.expected_delivery_datetime);
            etaBadgeClass = 'delayed'; etaBadgeText = '⚠ Delayed';
        } else if (etaHours < 24) {
            etaText = etaHours + 'h remaining';
            etaSub = 'Arriving ' + expected.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
            etaBadgeClass = 'on-time'; etaBadgeText = '✓ On Time';
        } else {
            const days = Math.floor(etaHours / 24);
            etaText = days + ' day' + (days > 1 ? 's' : '') + ' remaining';
            etaSub = 'Expected ' + formatDateTime(order.expected_delivery_datetime);
            etaBadgeClass = 'on-time'; etaBadgeText = '✓ On Schedule';
        }
    }
    const etaWidget = `
        <div class="cust-eta-widget">
            <div class="cust-eta-icon"><i class="fas fa-clock"></i></div>
            <div class="cust-eta-body">
                <div class="cust-eta-label">Estimated Delivery</div>
                <div class="cust-eta-value">${etaText}</div>
                <div class="cust-eta-sub">${etaSub}</div>
                <div class="cust-eta-refresh"><i class="fas fa-sync-alt"></i> Live — updates every 60s</div>
            </div>
            <div class="cust-eta-badge ${etaBadgeClass}">${etaBadgeText}</div>
        </div>`;

    document.getElementById('custOrderCard').innerHTML = `
        <div class="cust-order-id">${order.id}</div>
        <div class="cust-status"><span class="pill ${isDelivered ? 'delivered' : 'in-transit'}">${order.order_status}</span></div>
        <div class="cust-track-labels"><span>${order.source_city}</span><span>${order.destination_city}</span></div>
        <div class="cust-track-bar"><div class="cust-track-fill" style="width:${progress}%"></div></div>

        ${etaWidget}


        <div class="cust-lifecycle">
            <div class="cust-lifecycle-title"><i class="fas fa-route"></i> &nbsp;Shipment Lifecycle</div>
            <div class="cust-lifecycle-steps">${stepsHtml}</div>
        </div>

        <div class="cust-section">
            <div class="cust-section-title">Shipment Details</div>
            <div class="cust-row"><label>Customer</label><span>${order.customer_name}</span></div>
            <div class="cust-row"><label>Company</label><span>${order.customer_company}</span></div>
            <div class="cust-row"><label>Goods</label><span>${order.goods_type} (${order.goods_category})</span></div>
            <div class="cust-row"><label>Quantity</label><span>${order.quantity} ${order.unit}</span></div>
        </div>
        <div class="cust-section">
            <div class="cust-section-title">Route & Timeline</div>
            <div class="cust-row"><label>From</label><span>${order.pickup_address}</span></div>
            <div class="cust-row"><label>To</label><span>${order.delivery_address}</span></div>
            <div class="cust-row"><label>Dispatched</label><span>${formatDateTime(order.dispatch_datetime)}</span></div>
            <div class="cust-row"><label>Expected</label><span>${formatDateTime(order.expected_delivery_datetime)}</span></div>
            ${isDelivered ? `<div class="cust-row"><label>Delivered</label><span style="color:var(--green)">${formatDateTime(order.actual_delivery_datetime)}</span></div>` : ''}
        </div>
        <div class="cust-section">
            <div class="cust-section-title">Vehicle & Driver</div>
            <div class="cust-row"><label>Vehicle ID</label><span>${order.vehicle_id}</span></div>
            <div class="cust-row"><label>Vehicle No</label><span>${order.vehicle_number || '—'}</span></div>
            <div class="cust-row"><label>Distance</label><span>${order.distance_km} km</span></div>
        </div>
        ${isDelivered ? `
        <div class="cust-section">
            <div class="cust-section-title" style="color:var(--green)"><i class="fas fa-check-circle"></i> Delivery Confirmed</div>
            <div class="cust-row"><label>Delivered At</label><span style="color:var(--green)">${formatDateTime(order.actual_delivery_datetime)}</span></div>
            <div class="cust-row"><label>Delivered To</label><span>${order.delivery_address}</span></div>
            <div class="cust-row"><label>Status</label><span style="color:var(--green)">Successfully Delivered</span></div>
        </div>
        <div class="cust-section">
            <div class="cust-section-title"><i class="fas fa-file-invoice-dollar"></i> Documents</div>
            <div class="cust-invoice-btns">
                <button class="cust-invoice-btn" onclick="generateInvoice('shipment', State.custOrderData)"><i class="fas fa-file-invoice"></i> Shipment Invoice</button>
                <button class="cust-invoice-btn gst" onclick="generateInvoice('gst', State.custOrderData)"><i class="fas fa-file-alt"></i> GST Invoice</button>
                <button class="cust-invoice-btn" onclick="generateInvoice('receipt', State.custOrderData)"><i class="fas fa-receipt"></i> Payment Receipt</button>
            </div>
        </div>` : ''}
    `;
    if (!isDelivered) {
        clearTimeout(State._etaTimer);
        State._etaTimer = setTimeout(() => { if (State.custOrderData) renderCustomerDetails(State.custOrderData); }, 60000);
    }
    renderLiveMap();
}


// ═══════════════════════════════════════════════════════
// CUSTOMER ENHANCEMENTS 2 — Calc, Manage, Notifs, History
// ═══════════════════════════════════════════════════════

// ── Freight Calculator ────────────────────────────────
const CITY_DISTANCES = {
    'Chennai-Bhubaneswar': 950, 'Chennai-Kolkata': 1680, 'Chennai-Mumbai': 1340,
    'Chennai-Delhi': 2200, 'Chennai-Hyderabad': 630, 'Chennai-Bengaluru': 350,
    'Mumbai-Delhi': 1420, 'Mumbai-Kolkata': 2080, 'Hyderabad-Delhi': 1570,
    'Hyderabad-Kolkata': 1480, 'Bengaluru-Mumbai': 980, 'Bengaluru-Delhi': 2150,
};
function getCityDistance(a, b) {
    const key1 = `${a}-${b}`, key2 = `${b}-${a}`;
    return CITY_DISTANCES[key1] || CITY_DISTANCES[key2] || Math.round(400 + Math.random() * 1400);
}

function calculateFreight() {
    const origin = (document.getElementById('calcOrigin')?.value || '').trim();
    const dest = (document.getElementById('calcDest')?.value || '').trim();
    const weight = parseFloat(document.getElementById('calcWeight')?.value || 0);
    const l = parseFloat(document.getElementById('calcLen')?.value || 0);
    const w = parseFloat(document.getElementById('calcWid')?.value || 0);
    const h = parseFloat(document.getElementById('calcHgt')?.value || 0);
    const cargo = document.getElementById('calcCargo')?.value || 'general';
    const service = document.getElementById('calcService')?.value || 'standard';
    const isRefrig = document.getElementById('calcRefrig')?.checked;
    const isFragile = document.getElementById('calcFragile')?.checked;
    const isHazmat = document.getElementById('calcHazmat')?.checked;

    if (!origin || !dest) { alert('Please enter origin and destination cities.'); return; }
    if (!weight || weight <= 0) { alert('Please enter a valid weight.'); return; }

    const distKm = getCityDistance(origin, dest);
    const volWeight = l && w && h ? (l * w * h) / 5000 : 0;
    const chargeableWeight = Math.max(weight, volWeight);

    const BASE_RATE = 4.5;   // ₹ per kg per 100km
    const FUEL_PCT = 0.12;
    const SERVICE_MULT = service === 'express' ? 1.65 : service === 'scheduled' ? 1.15 : 1.0;
    const CARGO_MULT = cargo === 'refrigerated' ? 1.5 : cargo === 'hazmat' ? 1.8 : cargo === 'oversized' ? 1.6 : cargo === 'fragile' ? 1.3 : 1.0;

    const baseFreight = Math.round(chargeableWeight * (distKm / 100) * BASE_RATE);
    const serviceFee = Math.round(baseFreight * (SERVICE_MULT - 1));
    const cargoSurcharge = Math.round(baseFreight * (CARGO_MULT - 1));
    const refrigSurcharge = isRefrig ? Math.round(baseFreight * 0.18) : 0;
    const fragileSurcharge = isFragile ? Math.round(baseFreight * 0.08) : 0;
    const hazmatSurcharge = isHazmat ? Math.round(baseFreight * 0.25) : 0;
    const fuelSurcharge = Math.round(baseFreight * FUEL_PCT);
    const gst = Math.round((baseFreight + serviceFee + cargoSurcharge + refrigSurcharge + fragileSurcharge + hazmatSurcharge + fuelSurcharge) * 0.18);
    const total = baseFreight + serviceFee + cargoSurcharge + refrigSurcharge + fragileSurcharge + hazmatSurcharge + fuelSurcharge + gst;

    const fmt = v => '₹' + v.toLocaleString('en-IN');
    const lines = [
        { label: `Base Freight (${chargeableWeight.toFixed(1)} kg chargeable × ${distKm} km)`, val: fmt(baseFreight) },
        ...(serviceFee ? [{ label: `${service.charAt(0).toUpperCase() + service.slice(1)} Service Premium`, val: fmt(serviceFee), cls: 'surcharge' }] : []),
        ...(cargoSurcharge ? [{ label: `${cargo.charAt(0).toUpperCase() + cargo.slice(1)} Cargo Handling`, val: fmt(cargoSurcharge), cls: 'surcharge' }] : []),
        ...(refrigSurcharge ? [{ label: 'Refrigerated Transport', val: fmt(refrigSurcharge), cls: 'surcharge' }] : []),
        ...(fragileSurcharge ? [{ label: 'Fragile Handling', val: fmt(fragileSurcharge), cls: 'surcharge' }] : []),
        ...(hazmatSurcharge ? [{ label: 'Hazmat Compliance', val: fmt(hazmatSurcharge), cls: 'surcharge' }] : []),
        { label: `Fuel Surcharge (${(FUEL_PCT * 100).toFixed(0)}%)`, val: fmt(fuelSurcharge), cls: 'surcharge' },
        { label: 'GST (18%)', val: fmt(gst) },
    ];

    document.getElementById('calcBreakdown').innerHTML = lines.map(l => `
        <div class="calc-line ${l.cls || ''}">
            <span class="calc-line-label">${l.label}</span>
            <span class="calc-line-val">${l.val}</span>
        </div>`).join('');
    document.getElementById('calcTotal').textContent = fmt(total);
    document.getElementById('calcQuoteRef').textContent = 'QT-' + Date.now().toString(36).toUpperCase();
    document.getElementById('calcResult').style.display = 'block';

    // Cache for "Proceed to Book"
    State._lastQuote = { origin, dest, weight, volWeight, chargeableWeight, distKm, total, cargo, service };
}

function useQuoteForBooking() {
    const q = State._lastQuote;
    showCustTab('book');
    if (!q) return;
    setTimeout(() => {
        if (document.getElementById('bPickupCity')) document.getElementById('bPickupCity').value = q.origin;
        if (document.getElementById('bDelivCity')) document.getElementById('bDelivCity').value = q.dest;
        if (document.getElementById('bWeight')) document.getElementById('bWeight').value = q.weight;
        const catEl = document.getElementById('bCargoCat');
        if (catEl) {
            const map = { general: 'Dry Goods', refrigerated: 'Frozen Goods', hazmat: 'Industrial', fragile: 'Perishables', oversized: 'Bulk Commodities' };
            catEl.value = map[q.cargo] || '';
        }
        selectDelivOption(q.service || 'standard');
    }, 100);
}

// ── Manage Panel ──────────────────────────────────────
function initManagePanel() {
    renderNotifications();
    renderDriverInfo();
    renderCancelSection();
    renderPODSection();
    renderFailureSection();
}

// Notifications
function _buildNotifications(order) {
    if (!order) return [];
    const now = new Date();
    const notifs = [];
    const ago = (h) => { const d = new Date(now); d.setHours(d.getHours() - h); return d.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }); };
    notifs.push({ type: 'success', icon: 'fa-check-circle', msg: `Order <b>${order.id}</b> created successfully.`, time: ago(72), read: true });
    if (order.dispatch_datetime) notifs.push({ type: 'unread', icon: 'fa-truck', msg: `Your shipment has been <b>dispatched</b> from ${order.source_city}.`, time: ago(48), read: false });
    const statusIdx = ['Pending', 'Assigned', 'Picked Up', 'In Transit', 'At Sea', 'Out for Delivery', 'Delivered'].indexOf(order.order_status);
    if (statusIdx >= 2) notifs.push({ type: 'unread', icon: 'fa-hand-paper', msg: `Driver has <b>picked up</b> your cargo.`, time: ago(36), read: false });
    if (statusIdx >= 3) notifs.push({ type: 'unread', icon: 'fa-shipping-fast', msg: `Shipment is <b>in transit</b> to ${order.destination_city}.`, time: ago(20), read: true });
    if (statusIdx >= 5) notifs.push({ type: 'warning', icon: 'fa-exclamation-circle', msg: `Shipment is <b>out for delivery</b>. Driver will arrive soon.`, time: ago(3), read: false });
    if (order.order_status === 'Delivered') notifs.push({ type: 'success', icon: 'fa-check-double', msg: `<b>Delivered!</b> Shipment successfully delivered to ${order.delivery_address}.`, time: ago(0), read: false });
    return notifs;
}

function renderNotifications() {
    const order = State.custOrderData;
    const notifs = _buildNotifications(order);
    const listEl = document.getElementById('custNotifList');
    const badge = document.getElementById('custNotifBadge');
    if (!listEl) return;
    const unread = notifs.filter(n => !n.read).length;
    if (badge) { badge.textContent = unread; badge.style.display = unread ? 'inline-flex' : 'none'; }
    if (!notifs.length) { listEl.innerHTML = '<div class="cust-notif-empty">No notifications yet.</div>'; return; }
    listEl.innerHTML = notifs.slice().reverse().map(n => `
        <div class="cust-notif-item ${n.read ? 'read' : n.type}">
            <div class="cust-notif-icon"><i class="fas ${n.icon}"></i></div>
            <div class="cust-notif-body">
                <div class="cust-notif-msg">${n.msg}</div>
                <div class="cust-notif-time">${n.time}</div>
            </div>
        </div>`).join('');
}

// Driver info
function renderDriverInfo() {
    const order = State.custOrderData;
    const el = document.getElementById('custDriverDetails');
    const section = document.getElementById('custDriverInfo');
    if (!el || !section) return;
    const dispatched = order && ['In Transit', 'At Sea', 'Out for Delivery', 'Delivered', 'Picked Up'].includes(order.order_status);
    if (!dispatched) {
        el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:4px 0">Driver details will be shown once your shipment is dispatched.</div>`;
        return;
    }
    const veh = State.vehicles ? State.vehicles[order.vehicle_id] : null;
    const driverName = veh?.driver_name || order.driver_name || 'Assigned Driver';
    const initials = driverName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const phone = order.driver_contact || veh?.contact || '+91 98765 XXXXX';
    el.innerHTML = `
        <div class="cust-driver-avatar">${initials}</div>
        <div class="cust-driver-info">
            <div class="cust-driver-name">${driverName}</div>
            <div class="cust-driver-meta">
                <span><i class="fas fa-truck" style="color:var(--accent)"></i> ${order.vehicle_id} · ${order.vehicle_number || '—'}</span>
                <span><i class="fas fa-phone" style="color:var(--green)"></i> ${phone}</span>
            </div>
        </div>
        <button class="cust-driver-contact-btn" onclick="alert('Calling ${phone}...')"><i class="fas fa-phone"></i> Contact</button>`;
}

// Modification tabs
function switchModTab(tab) {
    ['address', 'contact', 'date'].forEach(t => {
        const btn = document.querySelector(`.cust-mod-tab[onclick="switchModTab('${t}')"]`);
        const panel = document.getElementById('modTab' + t.charAt(0).toUpperCase() + t.slice(1));
        if (btn) btn.classList.toggle('active', t === tab);
        if (panel) panel.style.display = t === tab ? 'block' : 'none';
    });
}

function submitModification() {
    const order = State.custOrderData;
    const errEl = document.getElementById('modifyError');
    const sucEl = document.getElementById('modifySuccess');
    errEl.style.display = 'none'; sucEl.style.display = 'none';
    if (!order) { errEl.textContent = 'No active shipment found.'; errEl.style.display = 'block'; return; }
    if (['Delivered', 'Out for Delivery'].includes(order.order_status)) {
        errEl.textContent = 'Modifications are not allowed once shipment is out for delivery or delivered.';
        errEl.style.display = 'block'; return;
    }
    const activeTab = document.querySelector('.cust-mod-tab.active')?.getAttribute('onclick')?.match(/'(\w+)'/)?.[1] || 'address';
    let summary = '';
    if (activeTab === 'address') {
        const addr = document.getElementById('modNewAddr')?.value?.trim();
        const city = document.getElementById('modNewCity')?.value?.trim();
        if (!addr || !city) { errEl.textContent = 'Please enter the new address and city.'; errEl.style.display = 'block'; return; }
        summary = `Delivery address updated to: ${addr}, ${city}`;
    } else if (activeTab === 'contact') {
        const name = document.getElementById('modContactName')?.value?.trim();
        const phone = document.getElementById('modContactPhone')?.value?.trim();
        if (!name || !phone) { errEl.textContent = 'Please enter contact name and phone.'; errEl.style.display = 'block'; return; }
        summary = `Contact updated to: ${name} · ${phone}`;
    } else if (activeTab === 'date') {
        const date = document.getElementById('modNewDate')?.value;
        const win = document.getElementById('modNewWindow')?.value;
        if (!date) { errEl.textContent = 'Please select a new delivery date.'; errEl.style.display = 'block'; return; }
        summary = `Delivery rescheduled to ${date} · ${win}`;
    }
    if (!State._modifications) State._modifications = [];
    State._modifications.push({ order: order.id, change: summary, at: new Date().toISOString() });
    sucEl.innerHTML = `<i class="fas fa-check-circle"></i> ${summary}. Our team has been notified.`;
    sucEl.style.display = 'block';
    setTimeout(() => { sucEl.style.display = 'none'; }, 6000);
}

// Cancellation
function renderCancelSection() {
    const order = State.custOrderData;
    const rulesEl = document.getElementById('custCancelRules');
    const actionsEl = document.getElementById('custCancelActions');
    if (!rulesEl || !actionsEl) return;
    rulesEl.innerHTML = `
        <div class="cust-cancel-rule"><div class="cust-cancel-rule-dot rule-free"></div><div class="cust-cancel-rule-text"><b>Free cancellation</b> — before driver pickup</div></div>
        <div class="cust-cancel-rule"><div class="cust-cancel-rule-dot rule-partial"></div><div class="cust-cancel-rule-text"><b>25% charge</b> — after pickup, before dispatch</div></div>
        <div class="cust-cancel-rule"><div class="cust-cancel-rule-dot rule-nocancel"></div><div class="cust-cancel-rule-text"><b>No cancellation</b> — once shipment is in transit</div></div>`;
    if (!order || State._cancelled) {
        actionsEl.innerHTML = State._cancelled
            ? `<div class="cust-form-success"><i class="fas fa-check-circle"></i> Shipment cancelled. Refund will be processed in 3–5 business days.</div>`
            : `<div style="color:var(--text-muted);font-size:12px">No active shipment to cancel.</div>`;
        return;
    }
    const inTransit = ['In Transit', 'At Sea', 'Out for Delivery', 'Delivered'].includes(order.order_status);
    if (inTransit) {
        actionsEl.innerHTML = `<div class="cust-form-error"><i class="fas fa-ban"></i> Cancellation not available — shipment is already in transit.</div>`;
        return;
    }
    const isPicked = order.order_status === 'Picked Up';
    actionsEl.innerHTML = `
        <button class="cust-cancel-btn" onclick="showCancelConfirm()">
            <i class="fas fa-times-circle"></i> Request Cancellation
            ${isPicked ? '<span style="font-size:10px;opacity:0.8">(25% charge applies)</span>' : '<span style="font-size:10px;opacity:0.8">(Free)</span>'}
        </button>`;
}

function showCancelConfirm() {
    const order = State.custOrderData;
    const isPicked = order?.order_status === 'Picked Up';
    document.getElementById('custCancelActions').innerHTML = `
        <div class="cust-cancel-confirm-box">
            <p>Are you sure you want to cancel shipment <b>${order?.id}</b>?${isPicked ? ' A 25% charge will apply.' : ' This is free of charge.'}</p>
            <div class="cust-cancel-confirm-btns">
                <button class="btn-confirm-cancel" onclick="confirmCancellation()"><i class="fas fa-check"></i> Yes, Cancel</button>
                <button class="btn-cancel-back" onclick="renderCancelSection()"><i class="fas fa-arrow-left"></i> Go Back</button>
            </div>
        </div>`;
}

function confirmCancellation() {
    State._cancelled = true;
    renderCancelSection();
    // Push a notification
    if (!State._extraNotifs) State._extraNotifs = [];
    State._extraNotifs.push({ type: 'warning', icon: 'fa-times-circle', msg: `Cancellation request submitted for <b>${State.custOrderData?.id}</b>.`, time: 'Just now', read: false });
}

// POD
function renderPODSection() {
    const order = State.custOrderData;
    const section = document.getElementById('custPODSection');
    const body = document.getElementById('custPODBody');
    if (!section || !body) return;
    const isDelivered = order?.order_status === 'Delivered';
    section.style.display = isDelivered ? 'block' : 'none';
    if (!isDelivered) return;
    const otp = Math.floor(100000 + Math.random() * 900000);
    body.innerHTML = `
        <div class="cust-pod-row">
            <div class="cust-pod-icon"><i class="fas fa-check-circle"></i></div>
            <div class="cust-pod-label">Delivery Status</div>
            <div class="cust-pod-val" style="color:var(--green);font-weight:700">Delivered</div>
        </div>
        <div class="cust-pod-row">
            <div class="cust-pod-icon"><i class="fas fa-clock"></i></div>
            <div class="cust-pod-label">Delivered At</div>
            <div class="cust-pod-val">${formatDateTime(order.actual_delivery_datetime)}</div>
        </div>
        <div class="cust-pod-row">
            <div class="cust-pod-icon"><i class="fas fa-map-marker-alt"></i></div>
            <div class="cust-pod-label">Delivered To</div>
            <div class="cust-pod-val">${order.delivery_address}</div>
        </div>
        <div class="cust-pod-row">
            <div class="cust-pod-icon"><i class="fas fa-truck"></i></div>
            <div class="cust-pod-label">Delivered By</div>
            <div class="cust-pod-val">${order.vehicle_id} · ${order.vehicle_number || '—'}</div>
        </div>
        <div class="cust-pod-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <div style="display:flex;align-items:center;gap:10px">
                <div class="cust-pod-icon"><i class="fas fa-key"></i></div>
                <div class="cust-pod-label">OTP Confirmation</div>
            </div>
            <div class="cust-pod-otp-badge">${otp}</div>
        </div>
        <div class="cust-pod-row">
            <div class="cust-pod-icon"><i class="fas fa-signature"></i></div>
            <div class="cust-pod-label">Signature</div>
            <div class="cust-pod-val">✓ Digitally Confirmed</div>
        </div>
        <div class="cust-pod-row">
            <div class="cust-pod-icon"><i class="fas fa-camera"></i></div>
            <div class="cust-pod-label">Delivery Photo</div>
            <div class="cust-pod-val" style="color:var(--accent);cursor:pointer" onclick="alert('Photo not available in demo mode.')"><i class="fas fa-image"></i> View Photo</div>
        </div>`;
}

// Delivery Failure
function renderFailureSection() {
    const order = State.custOrderData;
    const section = document.getElementById('custFailureSection');
    if (!section) return;
    // Simulate failure only if forced or status is a failed state
    const hasFailed = order?.order_status === 'Delivery Failed' || State._simulateFailure;
    section.style.display = hasFailed ? 'block' : 'none';
    if (!hasFailed) return;
    const reasons = ['Customer was unavailable at delivery address', 'Incorrect delivery address provided', 'Access to premises denied', 'Payment pending'];
    const reason = reasons[Math.floor(Math.random() * reasons.length)];
    document.getElementById('custFailureBody').innerHTML = `
        <div class="cust-failure-reason"><i class="fas fa-exclamation-circle" style="color:#ffc107;margin-right:6px"></i><b>Reason:</b> ${reason}.</div>
        <div class="cust-failure-actions">
            <button class="cust-failure-btn primary" onclick="alert('Reschedule request submitted. Our team will contact you.')">
                <i class="fas fa-calendar-alt"></i> Reschedule Delivery
            </button>
            <button class="cust-failure-btn" onclick="alert('Connecting to support...')">
                <i class="fas fa-headset"></i> Contact Support
            </button>
            <button class="cust-failure-btn" onclick="alert('Return to depot initiated.')">
                <i class="fas fa-undo"></i> Return to Depot
            </button>
        </div>`;
}

// ── Shipment History ──────────────────────────────────
function renderShipmentHistory() {
    const el = document.getElementById('custHistoryList');
    if (!el) return;
    const order = State.custOrderData;
    // Build history from real order + simulated past records
    const records = [];
    if (order) {
        const cost = 2800 + Math.round(order.distance_km * 3.2);
        records.push({
            id: order.id,
            route: `${order.source_city} → ${order.destination_city}`,
            goods: `${order.goods_type} · ${order.quantity} ${order.unit}`,
            date: order.actual_delivery_datetime || order.expected_delivery_datetime || order.dispatch_datetime,
            status: order.order_status,
            cost,
            distKm: order.distance_km,
        });
    }
    // Append simulated history only if it's the general generic tracking login
    const pastOrders = [];
    if (State.currentUserType !== 'customer_account') {
        pastOrders.push(
            { id: 'ORD-2024-0312', route: 'Mumbai → Pune', goods: 'Dry Goods · 200 kg', date: '2024-12-15T14:30:00', status: 'Delivered', cost: 1850, distKm: 150 },
            { id: 'ORD-2024-0289', route: 'Chennai → Hyderabad', goods: 'Seafood · 500 kg', date: '2024-11-28T09:00:00', status: 'Delivered', cost: 4200, distKm: 630 },
            { id: 'ORD-2024-0251', route: 'Kolkata → Bhubaneswar', goods: 'Frozen Goods · 350 kg', date: '2024-10-10T11:00:00', status: 'Delivered', cost: 2100, distKm: 440 }
        );
    }
    records.push(...pastOrders);

    if (records.length === 0) {
        el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:16px 0;text-align:center">No shipment history available. Book one from the Book Shipment tab.</div>`;
        return;
    }

    el.innerHTML = records.map(r => `
        <div class="cust-history-item">
            <div class="cust-history-top">
                <span class="cust-history-id">${r.id}</span>
                <span class="pill ${r.status === 'Delivered' ? 'delivered' : 'in-transit'}" style="font-size:9px">${r.status}</span>
            </div>
            <div class="cust-history-meta">
                <span><i class="fas fa-route"></i> ${r.route}</span>
                <span><i class="fas fa-box"></i> ${r.goods}</span>
                <span><i class="fas fa-ruler-horizontal"></i> ${r.distKm} km</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
                <span style="font-size:10px;color:var(--text-muted)"><i class="fas fa-calendar-alt"></i> ${formatDateTime(r.date)}</span>
                <span class="cust-history-cost">₹${r.cost.toLocaleString('en-IN')}</span>
            </div>
            <div class="cust-invoice-btns">
                <button class="cust-invoice-btn" onclick="generateInvoice('shipment', State.custOrderData || {id:'${r.id}',customer_name:State.custOrderData?.customer_name||'Customer',customer_company:State.custOrderData?.customer_company||'—',goods_type:'${r.goods?.split(' ·')[0] || 'Goods'}',goods_category:'General',quantity:1,unit:'pkg',pickup_address:'${r.route?.split(' → ')[0] || 'Origin'}',delivery_address:'${r.route?.split(' → ')[1] || 'Destination'}',vehicle_id:'—',vehicle_number:'—',distance_km:${r.distKm || 500}})">
                    <i class="fas fa-file-invoice"></i> Invoice
                </button>
                <button class="cust-invoice-btn gst" onclick="generateInvoice('gst', State.custOrderData || {id:'${r.id}',customer_name:State.custOrderData?.customer_name||'Customer',customer_company:State.custOrderData?.customer_company||'—',goods_type:'${r.goods?.split(' ·')[0] || 'Goods'}',goods_category:'General',quantity:1,unit:'pkg',pickup_address:'${r.route?.split(' → ')[0] || 'Origin'}',delivery_address:'${r.route?.split(' → ')[1] || 'Destination'}',vehicle_id:'—',vehicle_number:'—',distance_km:${r.distKm || 500}})">
                    <i class="fas fa-file-alt"></i> GST Invoice
                </button>
                <button class="cust-invoice-btn" onclick="generateInvoice('receipt', State.custOrderData || {id:'${r.id}',customer_name:State.custOrderData?.customer_name||'Customer',customer_company:State.custOrderData?.customer_company||'—',goods_type:'${r.goods?.split(' ·')[0] || 'Goods'}',goods_category:'General',quantity:1,unit:'pkg',pickup_address:'${r.route?.split(' → ')[0] || 'Origin'}',delivery_address:'${r.route?.split(' → ')[1] || 'Destination'}',vehicle_id:'—',vehicle_number:'—',distance_km:${r.distKm || 500}})">
                    <i class="fas fa-receipt"></i> Receipt
                </button>
            </div>
        </div>`).join('');
}

// ── Booking form flag-toggle wiring (flag clicks) ─────
function _wireCalcFlags() {
    document.querySelectorAll('#calcFlagRefrig, #calcFlagFragile, #calcFlagHazmat').forEach(label => {
        label.addEventListener('click', () => {
            setTimeout(() => {
                const cb = label.querySelector('input[type=checkbox]');
                label.classList.toggle('active', cb && cb.checked);
            }, 0);
        });
    });
}
document.addEventListener('DOMContentLoaded', _wireCalcFlags);

function initBookingForm() {
    // Set default pickup date to tomorrow
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];
    const pd = document.getElementById('bPickupDate');
    const dd = document.getElementById('bDelivDate');
    if (pd && !pd.value) pd.value = dateStr;
    if (dd && !dd.value) { const d2 = new Date(tomorrow); d2.setDate(d2.getDate() + 3); dd.value = d2.toISOString().split('T')[0]; }

    // Wire up flag toggles
    document.querySelectorAll('.cust-flag-toggle').forEach(label => {
        label.addEventListener('click', () => {
            setTimeout(() => {
                const cb = label.querySelector('input[type=checkbox]');
                label.classList.toggle('active', cb && cb.checked);
            }, 0);
        });
    });

    // Select standard by default
    if (!document.querySelector('.cust-deliv-opt.selected')) selectDelivOption('standard');
    // Init packaging and insurance defaults
    if (!document.querySelector('.cust-pkg-opt.selected')) selectPkg('carton');
    if (!document.querySelector('.cust-ins-opt.selected')) selectInsurance('none');
}

function selectDelivOption(opt) {
    _selectedDelivOption = opt;
    ['express', 'standard', 'scheduled'].forEach(o => {
        document.getElementById('delivOpt' + o.charAt(0).toUpperCase() + o.slice(1))?.classList.toggle('selected', o === opt);
    });
    const slot = document.getElementById('custScheduledSlot');
    if (slot) slot.style.display = opt === 'scheduled' ? 'block' : 'none';
}

function submitBooking() {
    const errEl = document.getElementById('custBookError');
    const sucEl = document.getElementById('custBookSuccess');
    errEl.style.display = 'none'; sucEl.style.display = 'none';

    const cargoCat = document.getElementById('bCargoCat')?.value;
    const goodsDesc = document.getElementById('bGoodsDesc')?.value?.trim();
    const weight = document.getElementById('bWeight')?.value;
    const pickupAddr = document.getElementById('bPickupAddr')?.value?.trim();
    const pickupCity = document.getElementById('bPickupCity')?.value?.trim();
    const pickupDate = document.getElementById('bPickupDate')?.value;
    const pickupWin = document.getElementById('bPickupWindow')?.value;
    const delivAddr = document.getElementById('bDelivAddr')?.value?.trim();
    const delivCity = document.getElementById('bDelivCity')?.value?.trim();

    if (!cargoCat) { errEl.textContent = 'Please select a cargo category.'; errEl.style.display = 'block'; return; }
    if (!goodsDesc) { errEl.textContent = 'Please describe the goods.'; errEl.style.display = 'block'; return; }
    if (!weight || weight <= 0) { errEl.textContent = 'Please enter a valid weight.'; errEl.style.display = 'block'; return; }
    if (!pickupAddr) { errEl.textContent = 'Please enter the pickup address.'; errEl.style.display = 'block'; return; }
    if (!pickupCity) { errEl.textContent = 'Please enter the pickup city.'; errEl.style.display = 'block'; return; }
    if (!pickupDate) { errEl.textContent = 'Please select a pickup date.'; errEl.style.display = 'block'; return; }
    if (!pickupWin) { errEl.textContent = 'Please choose a pickup time window.'; errEl.style.display = 'block'; return; }
    if (!delivAddr) { errEl.textContent = 'Please enter the delivery address.'; errEl.style.display = 'block'; return; }
    if (!delivCity) { errEl.textContent = 'Please enter the delivery city.'; errEl.style.display = 'block'; return; }

    const flags = [];
    if (document.getElementById('bFragile')?.checked) flags.push('Fragile');
    if (document.getElementById('bRefrig')?.checked) flags.push('Refrigerated');
    if (document.getElementById('bHazmat')?.checked) flags.push('Hazmat');
    if (document.getElementById('bOversized')?.checked) flags.push('Oversized');

    const bookingRef = 'BK-' + Date.now().toString(36).toUpperCase();
    const payload = {
        ref: bookingRef,
        cargo_category: cargoCat, goods: goodsDesc, weight_kg: weight,
        qty: document.getElementById('bQty')?.value,
        unit: document.getElementById('bUnit')?.value,
        dimensions: { l: document.getElementById('bLen')?.value, w: document.getElementById('bWid')?.value, h: document.getElementById('bHgt')?.value },
        special_flags: flags,
        pickup: { address: pickupAddr, city: pickupCity, date: pickupDate, window: pickupWin },
        delivery: {
            address: delivAddr, city: delivCity, type: _selectedDelivOption,
            preferred_date: document.getElementById('bDelivDate')?.value,
            preferred_window: document.getElementById('bDelivWindow')?.value
        },
        customer: State.custOrderData?.customer_name || '—',
        submitted_at: new Date().toISOString()
    };

    // Store locally and show success (in production this would POST to backend)
    if (!State._custBookings) State._custBookings = [];
    State._custBookings.unshift(payload);

    sucEl.innerHTML = `<i class="fas fa-check-circle"></i> Booking request <b>${bookingRef}</b> submitted successfully! Our team will confirm within 2 business hours.`;
    sucEl.style.display = 'block';
    // Clear form
    ['bCargoCat', 'bGoodsDesc', 'bWeight', 'bQty', 'bLen', 'bWid', 'bHgt', 'bPickupAddr', 'bPickupCity', 'bPickupWindow', 'bDelivAddr', 'bDelivCity'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    ['bFragile', 'bRefrig', 'bHazmat', 'bOversized'].forEach(id => { const el = document.getElementById(id); if (el) el.checked = false; });
    document.querySelectorAll('.cust-flag-toggle').forEach(l => l.classList.remove('active'));
    selectDelivOption('standard');
    setTimeout(() => { sucEl.style.display = 'none'; }, 8000);
}

function renderCustOrdersList() {
    const el = document.getElementById('custOrdersList');
    if (!el) return;
    const bookings = State._custBookings || [];
    const current = State.custOrderData;

    let html = '';
    if (current) {
        const isD = current.order_status === 'Delivered';
        html += `<div class="cust-order-item">
            <div>
                <div class="cust-order-item-id">${current.id}</div>
                <div class="cust-order-item-route">${current.source_city} → ${current.destination_city}</div>
                <div class="cust-order-item-goods">${current.goods_type} · ${current.quantity} ${current.unit}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
                <span class="pill ${isD ? 'delivered' : 'in-transit'}" style="font-size:9px">${current.order_status}</span>
                <button class="cust-order-item-btn" onclick="showCustTab('details')">Track</button>
            </div>
        </div>`;
    }
    bookings.forEach(b => {
        html += `<div class="cust-order-item">
            <div>
                <div class="cust-order-item-id">${b.ref}</div>
                <div class="cust-order-item-route">${b.pickup.city} → ${b.delivery.city}</div>
                <div class="cust-order-item-goods">${b.cargo_category} · ${b.weight_kg} kg · ${b.delivery.type}</div>
            </div>
            <span class="pill" style="font-size:9px;background:rgba(255,200,0,0.15);color:#ffc107;border:1px solid #ffc107">Pending Confirmation</span>
        </div>`;
    });
    if (!html) html = `<div style="color:var(--text-muted);font-size:12px;padding:16px 0;text-align:center">No shipments found. Book one from the Book Shipment tab.</div>`;
    el.innerHTML = html;
}


// ═══════════════════════════════════════════════════════
// CUSTOMER ENHANCEMENTS 3 — Invoice, Support, Bulk,
// Returns, Insurance, Packaging, Feedback
// ═══════════════════════════════════════════════════════

// ── Packaging ─────────────────────────────────────────
let _selectedPkg = 'carton';
function selectPkg(pkg) {
    _selectedPkg = pkg;
    ['carton', 'crate', 'pallet', 'custom'].forEach(p => {
        document.getElementById('pkg' + p.charAt(0).toUpperCase() + p.slice(1))?.classList.toggle('selected', p === pkg);
    });
    const customInp = document.getElementById('pkgCustomInput');
    if (customInp) customInp.style.display = pkg === 'custom' ? 'block' : 'none';
}

// ── Insurance ─────────────────────────────────────────
let _selectedIns = 'none';
const INS_RATES = { none: 0, basic: 0.005, comprehensive: 0.012, premium: 0.025 };
function selectInsurance(ins) {
    _selectedIns = ins;
    ['none', 'basic', 'comprehensive', 'premium'].forEach(i => {
        document.getElementById('ins' + i.charAt(0).toUpperCase() + i.slice(1))?.classList.toggle('selected', i === ins);
    });
    const valRow = document.getElementById('insValueRow');
    const calcEl = document.getElementById('insPremiumCalc');
    if (valRow) valRow.style.display = ins === 'none' ? 'none' : 'block';
    updateInsPremium();
}
function updateInsPremium() {
    const calcEl = document.getElementById('insPremiumCalc');
    if (!calcEl) return;
    const val = parseFloat(document.getElementById('bInsValue')?.value || 0);
    const rate = INS_RATES[_selectedIns] || 0;
    if (!val || !rate) { calcEl.textContent = ''; return; }
    const premium = Math.round(val * rate);
    calcEl.innerHTML = `Insurance Premium: <b>₹${premium.toLocaleString('en-IN')}</b> (${(rate * 100).toFixed(1)}% of ₹${val.toLocaleString('en-IN')})`;
}
document.addEventListener('change', e => { if (e.target?.id === 'bInsValue') updateInsPremium(); });

// ── Invoice Generator (Feature 14) ────────────────────
function generateInvoice(type, order) {
    if (!order) { alert('No active shipment to generate invoice for.'); return; }
    const now = new Date();
    const invNo = type === 'gst' ? 'GST-INV-' : type === 'receipt' ? 'RCP-' : 'INV-';
    const invRef = invNo + Date.now().toString(36).toUpperCase().slice(-6);
    const baseCost = Math.round((order.distance_km || 500) * 3.5 + 800);
    const gst = Math.round(baseCost * 0.18);
    const total = baseCost + gst;

    const lines = [
        `LOGISENSE 360 — ${type === 'gst' ? 'GST TAX INVOICE' : type === 'receipt' ? 'PAYMENT RECEIPT' : 'SHIPMENT INVOICE'}`,
        `${'─'.repeat(50)}`,
        `Invoice No : ${invRef}`,
        `Date       : ${now.toLocaleDateString('en-IN')}`,
        `Order ID   : ${order.id}`,
        ``,
        `Bill To    : ${order.customer_name}`,
        `Company    : ${order.customer_company}`,
        ``,
        `SHIPMENT DETAILS`,
        `${'─'.repeat(50)}`,
        `From       : ${order.pickup_address}`,
        `To         : ${order.delivery_address}`,
        `Goods      : ${order.goods_type} (${order.goods_category})`,
        `Quantity   : ${order.quantity} ${order.unit}`,
        `Distance   : ${order.distance_km} km`,
        `Vehicle    : ${order.vehicle_id} — ${order.vehicle_number || '—'}`,
        ``,
        `CHARGES`,
        `${'─'.repeat(50)}`,
        `Base Freight           : ₹${baseCost.toLocaleString('en-IN')}`,
        ...(type === 'gst' ? [
            `CGST (9%)              : ₹${Math.round(gst / 2).toLocaleString('en-IN')}`,
            `SGST (9%)              : ₹${Math.round(gst / 2).toLocaleString('en-IN')}`,
        ] : [
            `GST (18%)              : ₹${gst.toLocaleString('en-IN')}`,
        ]),
        `${'─'.repeat(50)}`,
        `TOTAL                  : ₹${total.toLocaleString('en-IN')}`,
        ``,
        ...(type === 'receipt' ? [
            `PAYMENT STATUS         : PAID`,
            `Payment Date           : ${now.toLocaleDateString('en-IN')}`,
            ``,
        ] : []),
        `GSTIN (Logisense)      : 22AAAAA0000A1Z5`,
        `SAC Code               : 996511`,
        ``,
        `Thank you for choosing LOGISENSE 360.`,
    ];

    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${invRef}.txt`;
    a.click();
    URL.revokeObjectURL(url);
}

// ── Support Panel (Feature 15) ────────────────────────
const CHAT_RESPONSES = [
    "I understand your concern. Let me look into this for you right away.",
    "Thank you for reaching out! Your shipment details have been flagged for review.",
    "Our logistics team has been notified. You should receive an update within 30 minutes.",
    "I've escalated this to our priority support team. Is there anything else I can help with?",
    "Your case reference is " + 'CS-' + Date.now().toString(36).toUpperCase().slice(-5) + ". We'll resolve this within 2 hours.",
];
let _chatIdx = 0;

function initSupportPanel() {
    renderMyTickets();
    const chatWin = document.getElementById('custChatWindow');
    if (chatWin && chatWin.children.length === 0) {
        chatWin.innerHTML = `<div class="cust-chat-bubble agent"><div class="chat-sender">TrackAssist Agent</div>Hello! I'm your dedicated support agent. How can I help you today?</div>`;
    }
}

function openLiveChat() {
    document.getElementById('ticketFormWrap').style.display = 'none';
    document.getElementById('liveChatWrap').style.display = 'block';
    document.getElementById('custChatInput')?.focus();
}

function showTicketForm() {
    document.getElementById('liveChatWrap').style.display = 'none';
    document.getElementById('ticketFormWrap').style.display = 'block';
}

function showContactDetails() {
    alert('Phone: 1800-XXX-XXXX (Toll Free)\nEmail: support@logisense360.com\nWorking hours: Mon–Sat, 8AM–8PM IST');
}

function sendChatMsg() {
    const inp = document.getElementById('custChatInput');
    const msg = inp?.value?.trim();
    if (!msg) return;
    const win = document.getElementById('custChatWindow');
    win.innerHTML += `<div class="cust-chat-bubble user">${msg}</div>`;
    inp.value = '';
    win.scrollTop = win.scrollHeight;
    setTimeout(() => {
        const reply = CHAT_RESPONSES[_chatIdx % CHAT_RESPONSES.length];
        _chatIdx++;
        win.innerHTML += `<div class="cust-chat-bubble agent"><div class="chat-sender">TrackAssist Agent</div>${reply}</div>`;
        win.scrollTop = win.scrollHeight;
    }, 900);
}

function submitTicket() {
    const cat = document.getElementById('ticketCategory')?.value;
    const desc = document.getElementById('ticketDesc')?.value?.trim();
    const suc = document.getElementById('ticketSuccess');
    if (!cat) { alert('Please select an issue category.'); return; }
    if (!desc) { alert('Please describe your issue.'); return; }
    const pri = document.querySelector('input[name="tickPri"]:checked')?.value || 'medium';
    const ref = 'TKT-' + Date.now().toString(36).toUpperCase().slice(-6);
    if (!State._tickets) State._tickets = [];
    State._tickets.unshift({ ref, cat, desc, pri, status: 'Open', at: new Date().toISOString() });
    suc.innerHTML = `<i class="fas fa-check-circle"></i> Ticket <b>${ref}</b> raised. We'll respond within 2 hours.`;
    suc.style.display = 'block';
    document.getElementById('ticketCategory').value = '';
    document.getElementById('ticketDesc').value = '';
    renderMyTickets();
    setTimeout(() => { suc.style.display = 'none'; }, 7000);
}

function renderMyTickets() {
    const el = document.getElementById('myTicketsList');
    if (!el) return;
    const tickets = State._tickets || [];
    const order = State.custOrderData;
    // Auto-seed one ticket if the order is in a delayed state
    const autoTickets = [];
    if (order && ['In Transit', 'At Sea'].includes(order.order_status)) {
        autoTickets.push({ ref: 'TKT-AUTO001', cat: 'Delayed Shipment', desc: `Query regarding status of ${order.id}`, pri: 'medium', status: 'In Progress', at: new Date(Date.now() - 3600000).toISOString() });
    }
    const all = [...tickets, ...autoTickets];
    if (!all.length) { el.innerHTML = '<div class="cust-notif-empty">No tickets raised yet.</div>'; return; }
    el.innerHTML = all.map(t => `
        <div class="cust-ticket-item">
            <div class="cust-ticket-id">${t.ref}</div>
            <div class="cust-ticket-body">
                <div>${t.cat}</div>
                <div class="cust-ticket-cat">${t.desc?.slice(0, 60)}…</div>
            </div>
            <span class="cust-ticket-pri pri-${t.pri}">${t.pri.toUpperCase()}</span>
            <span class="pill" style="font-size:9px">${t.status}</span>
        </div>`).join('');
}

// ── Bulk Shipment (Feature 16) ────────────────────────
let _bulkItems = [];
function initBulkPanel() { renderBulkList(); }

function addBulkItem() {
    const origin = document.getElementById('bulkOrigin')?.value?.trim();
    const dest = document.getElementById('bulkDest')?.value?.trim();
    const weight = parseFloat(document.getElementById('bulkWeight')?.value || 0);
    const cargo = document.getElementById('bulkCargo')?.value || 'Dry Goods';
    if (!origin || !dest) { alert('Please enter origin and destination.'); return; }
    if (!weight || weight <= 0) { alert('Please enter a valid weight.'); return; }
    const est = Math.round(getCityDistance(origin, dest) * weight * 0.045 * 1.18);
    _bulkItems.push({ id: 'BLK-' + (_bulkItems.length + 1), origin, dest, weight, cargo, est });
    document.getElementById('bulkOrigin').value = '';
    document.getElementById('bulkDest').value = '';
    document.getElementById('bulkWeight').value = '';
    renderBulkList();
}

function removeBulkItem(idx) {
    _bulkItems.splice(idx, 1);
    renderBulkList();
}

function renderBulkList() {
    const el = document.getElementById('bulkItemsList');
    const badge = document.getElementById('bulkCountBadge');
    const totalEl = document.getElementById('bulkTotalRow');
    const subBtn = document.getElementById('bulkSubmitBtn');
    const totalValEl = document.getElementById('bulkTotalVal');
    if (!el) return;
    if (badge) { badge.textContent = _bulkItems.length; badge.style.display = _bulkItems.length ? 'inline-flex' : 'none'; }
    if (totalEl) totalEl.style.display = _bulkItems.length ? 'flex' : 'none';
    if (subBtn) subBtn.style.display = _bulkItems.length ? 'flex' : 'none';
    if (!_bulkItems.length) { el.innerHTML = '<div class="cust-notif-empty">No items in batch yet. Add shipments above.</div>'; return; }
    const grandTotal = _bulkItems.reduce((s, i) => s + i.est, 0);
    if (totalValEl) totalValEl.textContent = '₹' + grandTotal.toLocaleString('en-IN');
    el.innerHTML = _bulkItems.map((item, i) => `
        <div class="cust-bulk-item">
            <div>
                <div class="cust-bulk-item-route">${item.id}: ${item.origin} → ${item.dest}</div>
                <div class="cust-bulk-item-meta">${item.cargo} · ${item.weight} kg · Est. ₹${item.est.toLocaleString('en-IN')}</div>
            </div>
            <button class="cust-bulk-remove" onclick="removeBulkItem(${i})"><i class="fas fa-trash"></i></button>
        </div>`).join('');
}

function submitBulkOrder() {
    if (!_bulkItems.length) return;
    const batchRef = 'BATCH-' + Date.now().toString(36).toUpperCase().slice(-6);
    const suc = document.getElementById('bulkSuccess');
    suc.innerHTML = `<i class="fas fa-check-circle"></i> Batch order <b>${batchRef}</b> submitted with ${_bulkItems.length} shipment${_bulkItems.length > 1 ? 's' : ''}. Our team will confirm within 4 hours.`;
    suc.style.display = 'block';
    if (!State._batchOrders) State._batchOrders = [];
    State._batchOrders.push({ ref: batchRef, items: [..._bulkItems], at: new Date().toISOString() });
    _bulkItems = [];
    renderBulkList();
    setTimeout(() => { suc.style.display = 'none'; }, 8000);
}

// ── Return Shipment (Feature 17) ──────────────────────
function initReturnsPanel() {
    const retDate = document.getElementById('retDate');
    if (retDate && !retDate.value) {
        const d = new Date(); d.setDate(d.getDate() + 1);
        retDate.value = d.toISOString().split('T')[0];
    }
    renderMyReturns();
}

function submitReturn() {
    const errEl = document.getElementById('retError');
    const sucEl = document.getElementById('retSuccess');
    errEl.style.display = 'none'; sucEl.style.display = 'none';
    const orderId = document.getElementById('retOrderId')?.value?.trim();
    const reason = document.getElementById('retReason')?.value;
    const addr = document.getElementById('retAddr')?.value?.trim();
    const city = document.getElementById('retCity')?.value?.trim();
    const date = document.getElementById('retDate')?.value;
    if (!orderId) { errEl.textContent = 'Please enter the original Order ID.'; errEl.style.display = 'block'; return; }
    if (!reason) { errEl.textContent = 'Please select a return reason.'; errEl.style.display = 'block'; return; }
    if (!addr) { errEl.textContent = 'Please enter the pickup address.'; errEl.style.display = 'block'; return; }
    if (!city) { errEl.textContent = 'Please enter the pickup city.'; errEl.style.display = 'block'; return; }
    if (!date) { errEl.textContent = 'Please select a pickup date.'; errEl.style.display = 'block'; return; }
    const ref = 'RET-' + Date.now().toString(36).toUpperCase().slice(-6);
    if (!State._returns) State._returns = [];
    State._returns.unshift({ ref, orderId, reason, addr, city, date, status: 'Scheduled', at: new Date().toISOString() });
    sucEl.innerHTML = `<i class="fas fa-check-circle"></i> Return <b>${ref}</b> scheduled. Driver will arrive on ${date}.`;
    sucEl.style.display = 'block';
    ['retOrderId', 'retDesc', 'retAddr', 'retCity'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    document.getElementById('retReason').value = '';
    renderMyReturns();
    setTimeout(() => { sucEl.style.display = 'none'; }, 7000);
}

function renderMyReturns() {
    const el = document.getElementById('myReturnsList');
    if (!el) return;
    const returns = State._returns || [];
    if (!returns.length) { el.innerHTML = '<div class="cust-history-empty">No return requests yet.</div>'; return; }
    el.innerHTML = returns.map(r => `
        <div class="cust-return-item">
            <div>
                <div class="cust-return-id">${r.ref}</div>
                <div class="cust-return-meta">Order: ${r.orderId} · ${r.reason} · Pickup: ${r.date}, ${r.city}</div>
            </div>
            <span class="pill" style="font-size:9px;background:rgba(0,255,128,0.1);color:var(--green)">${r.status}</span>
        </div>`).join('');
}

// ── Feedback & Rating (Feature 20) ───────────────────
const _ratings = { driver: 0, speed: 0, condition: 0, support: 0 };

function initFeedbackPanel() {
    const order = State.custOrderData;
    const infoEl = document.getElementById('feedbackOrderInfo');
    if (infoEl && order) {
        infoEl.innerHTML = `<i class="fas fa-box" style="color:var(--accent);margin-right:8px"></i>Rating for: <b style="color:var(--accent)">${order.id}</b> — ${order.source_city} → ${order.destination_city}`;
    } else if (infoEl) {
        infoEl.innerHTML = `<i class="fas fa-info-circle" style="margin-right:6px"></i>Log in with an order to rate your experience.`;
    }
    // Render star groups
    ['driver', 'speed', 'condition', 'support'].forEach(key => {
        const el = document.getElementById('rating' + key.charAt(0).toUpperCase() + key.slice(1));
        if (!el) return;
        el.innerHTML = [1, 2, 3, 4, 5].map(n => `<span class="cust-star ${_ratings[key] >= n ? 'lit' : ''}" onclick="setRating('${key}',${n})">★</span>`).join('');
    });
    renderPastFeedback();
}

function setRating(key, val) {
    _ratings[key] = val;
    const el = document.getElementById('rating' + key.charAt(0).toUpperCase() + key.slice(1));
    if (!el) return;
    el.querySelectorAll('.cust-star').forEach((s, i) => s.classList.toggle('lit', i < val));
}

function submitFeedback() {
    const errEl = document.getElementById('feedbackError');
    const sucEl = document.getElementById('feedbackSuccess');
    errEl.style.display = 'none'; sucEl.style.display = 'none';
    const hasRating = Object.values(_ratings).some(v => v > 0);
    if (!hasRating) { errEl.textContent = 'Please rate at least one category.'; errEl.style.display = 'block'; return; }
    const comment = document.getElementById('feedbackComment')?.value?.trim() || '';
    const order = State.custOrderData;
    if (!State._feedbacks) State._feedbacks = [];
    State._feedbacks.unshift({ orderId: order?.id || 'N/A', ratings: { ..._ratings }, comment, at: new Date().toISOString() });
    const avg = (Object.values(_ratings).filter(v => v > 0).reduce((a, b) => a + b, 0) / Object.values(_ratings).filter(v => v > 0).length).toFixed(1);
    sucEl.innerHTML = `<i class="fas fa-star" style="color:#ffc107"></i> Thank you! Your ${avg}★ average rating has been recorded.`;
    sucEl.style.display = 'block';
    document.getElementById('feedbackComment').value = '';
    Object.keys(_ratings).forEach(k => _ratings[k] = 0);
    initFeedbackPanel();
    setTimeout(() => { sucEl.style.display = 'none'; }, 7000);
}

function renderPastFeedback() {
    const wrap = document.getElementById('pastFeedbackWrap');
    const el = document.getElementById('pastFeedbackList');
    if (!wrap || !el) return;
    const feedbacks = State._feedbacks || [];
    wrap.style.display = feedbacks.length ? 'block' : 'none';
    el.innerHTML = feedbacks.map(fb => {
        const avg = (Object.values(fb.ratings).filter(v => v > 0).reduce((a, b) => a + b, 0) / Math.max(Object.values(fb.ratings).filter(v => v > 0).length, 1)).toFixed(1);
        const stars = Math.round(avg);
        return `<div class="cust-feedback-record">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-family:var(--font-mono);color:var(--accent);font-size:11px">${fb.orderId}</span>
                <div class="cust-feedback-stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</div>
            </div>
            ${fb.comment ? `<div style="color:var(--text-muted);font-size:11px">"${fb.comment}"</div>` : ''}
        </div>`;
    }).join('');
}

function doSignOut() {
    currentRole = null; State.custOrderData = null;
    ['adminApp', 'customerView', 'driverView'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    resetLoginType();
    document.getElementById('loginScreen').style.display = 'flex';
    if (State.sse) { State.sse.close(); State.sse = null; }
    closePanels();
    // Clean up driver if any
    stopDriverGPS();
}

function initAdminApp() {
    startClock(); setupSidebarToggle(); setupSearch(); setupAlertBtn(); setupSettingsBtn();
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', e => { e.preventDefault(); showPage(link.dataset.page); });
    });
    initMap(); connectSSE(); showPage('tracking');
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const tog = document.getElementById('themeToggle'); if (tog) tog.classList.toggle('off', !isDark);
    updateSettingsInfo();
    startAdminAutoRefresh();
}

// ── Admin Auto-Refresh (every 30 s) ──────────────────────────────────────────
// SSE handles live pushes, but this guarantees the admin view refreshes
// even if the SSE stream goes quiet (e.g. no vehicle movement).
async function adminPollRefresh() {
    try {
        const res = await fetch(`${API_BASE}/api/vehicles`);
        if (!res.ok) return;
        const data = await res.json();
        const vehicles = data.data || data.vehicles || (Array.isArray(data) ? data : []);
        vehicles.forEach(v => { if (State.vehicles[v.id]) Object.assign(State.vehicles[v.id], v); else State.vehicles[v.id] = v; });
        onVehiclesUpdated();
        const ts = new Date().toISOString();
        setMapTimestamp(ts);
        const el = document.getElementById('adminRefreshIndicator');
        if (el) { el.textContent = 'Refreshed ' + formatTime(ts); el.style.opacity = '1'; setTimeout(() => { el.style.opacity = '0'; }, 2000); }
    } catch { /* silent — SSE still running */ }
}

function startAdminAutoRefresh() {
    setInterval(adminPollRefresh, 30000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatTime(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return iso; } }
function formatDateShort(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } }
function formatDateTime(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-IN'); } catch { return iso; } }
function downloadCSV(csv, fn) { const b = new Blob([csv], { type: 'text/csv' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = fn; a.click(); URL.revokeObjectURL(u); }

// ── DRIVER MODULE ─────────────────────────────────────────────────────────────
const DriverState = {
    driverMap: null,
    driverMarker: null,
    vehicleData: null,
    watchId: null,
    broadcasting: false,
    updateCount: 0,
    lastPosition: null,
    // Shift tracking
    shiftStatus: 'off_duty',   // 'off_duty' | 'on_shift' | 'on_break'
    shiftStartTime: null,
    shiftTimerInterval: null,
    shiftLog: [],
    // Pre-trip
    preTripChecks: {},
    preTripPassed: false,
    // Auth
    driverAuthMode: 'contact',
    otpCode: null,
};

// Fetch all drivers/vehicles and populate dropdown
async function loadDriverDropdown() {
    const select = document.getElementById('driverSelect');
    if (!select) return;
    try {
        const res = await fetch(`${API_BASE}/api/vehicles`);
        if (!res.ok) return;
        const data = await res.json();
        const vehicles = data.data || data.vehicles || [];

        // Clear previous options except first one
        select.innerHTML = '<option value="">-- Select Available Driver --</option>';

        vehicles.forEach(v => {
            if (v.driver_name) {
                const opt = document.createElement('option');
                opt.value = JSON.stringify({
                    id: v.id,
                    name: v.driver_name,
                    contact: v.driver_contact || ''
                });
                opt.textContent = `${v.driver_name} (${v.id})`;
                select.appendChild(opt);
            }
        });
    } catch (e) {
        console.error("Failed to load drivers for dropdown:", e);
    }
}

function setupDriverSelectListener() {
    const select = document.getElementById('driverSelect');
    if (!select || select.dataset.listenerAttached === 'true') return;
    select.dataset.listenerAttached = 'true';

    select.addEventListener('change', () => {
        const val = select.value;
        const errEl = document.getElementById('driverError');
        if (errEl) errEl.style.display = 'none';

        if (!val) {
            document.getElementById('driverVehicleId').value = '';
            document.getElementById('driverContact').value = '';
            document.querySelectorAll('#driverPinBoxes .otp-box').forEach(b => b.value = '');
            document.querySelectorAll('#driverOtpBoxes .otp-box').forEach(b => b.value = '');
            return;
        }

        try {
            const info = JSON.parse(val);
            document.getElementById('driverVehicleId').value = info.id;

            // Format/strip contact
            let contact = info.contact || '';
            document.getElementById('driverContact').value = contact;

            // Pre-fill PIN: default is last 4 digits of contact number
            let digits = contact.replace(/\D/g, '');
            let pinVal = '';
            if (digits.length >= 4) {
                pinVal = digits.slice(-4);
            } else {
                pinVal = '1234'; // fallback default PIN if contact is too short
            }
            const pinBoxes = document.querySelectorAll('#driverPinBoxes .otp-box');
            const pinDigits = pinVal.split('');
            pinBoxes.forEach((b, i) => b.value = pinDigits[i] || '');

            // Pre-fill OTP if already generated
            if (DriverState.otpCode) {
                const otpBoxes = document.querySelectorAll('#driverOtpBoxes .otp-box');
                const otpDigits = DriverState.otpCode.split('');
                otpBoxes.forEach((b, i) => b.value = otpDigits[i] || '');
            }
        } catch (e) {
            console.error(e);
        }
    });
}

// Wire driver type into existing selectLoginType / resetLoginType
const _origSelectLoginType = selectLoginType;
selectLoginType = function (type) {
    _origSelectLoginType(type);
    const df = document.getElementById('driverForm');
    if (df) df.style.display = type === 'driver' ? 'block' : 'none';
    if (type === 'driver') {
        // hide admin & customer
        document.getElementById('adminForm').style.display = 'none';
        document.getElementById('customerForm').style.display = 'none';

        loadDriverDropdown();
        setupDriverSelectListener();
    }
};

const _origResetLoginType = resetLoginType;
resetLoginType = function () {
    _origResetLoginType();
    const df = document.getElementById('driverForm');
    if (df) df.style.display = 'none';
    const err = document.getElementById('driverError');
    if (err) err.style.display = 'none';
    const select = document.getElementById('driverSelect');
    if (select) select.value = '';
};

// ── Driver Auth Tab Switcher ─────────────────────────────────────────────────
function switchDriverAuthTab(mode) {
    DriverState.driverAuthMode = mode;
    ['contact', 'pin', 'otp'].forEach(m => {
        const tab = document.getElementById('driverTab' + m.charAt(0).toUpperCase() + m.slice(1));
        const panel = document.getElementById('driverAuth' + m.charAt(0).toUpperCase() + m.slice(1));
        if (tab) tab.classList.toggle('active', m === mode);
        if (panel) panel.style.display = m === mode ? '' : 'none';
    });
}

function driverPinNav(el, idx) {
    if (el.value && idx < 3) document.querySelectorAll('#driverPinBoxes .otp-box')[idx + 1]?.focus();
}
function driverPinBack(el, e, idx) {
    if (e.key === 'Backspace' && !el.value && idx > 0) document.querySelectorAll('#driverPinBoxes .otp-box')[idx - 1]?.focus();
}
function driverOtpNav(el, idx) {
    if (el.value && idx < 5) document.querySelectorAll('#driverOtpBoxes .otp-box')[idx + 1]?.focus();
}
function driverOtpBack(el, e, idx) {
    if (e.key === 'Backspace' && !el.value && idx > 0) document.querySelectorAll('#driverOtpBoxes .otp-box')[idx - 1]?.focus();
}

function sendDriverOtp() {
    const vid = (document.getElementById('driverVehicleId')?.value || '').trim().toUpperCase();
    if (!vid) { const e = document.getElementById('driverError'); if (e) { e.textContent = 'Enter Vehicle ID first'; e.style.display = 'block'; } return; }
    // Generate 6-digit OTP (demo: shown in toast — production would SMS it)
    DriverState.otpCode = String(Math.floor(100000 + Math.random() * 900000));
    document.getElementById('driverOtpStep1').style.display = 'none';
    document.getElementById('driverOtpStep2').style.display = '';
    showToast(`Demo OTP: ${DriverState.otpCode}`, 'info', 15000);

    // Auto-fill generated OTP boxes
    const otpBoxes = document.querySelectorAll('#driverOtpBoxes .otp-box');
    const otpDigits = DriverState.otpCode.split('');
    otpBoxes.forEach((b, i) => b.value = otpDigits[i] || '');
}

function resetDriverOtp() {
    DriverState.otpCode = String(Math.floor(100000 + Math.random() * 900000));
    document.querySelectorAll('#driverOtpBoxes .otp-box').forEach(b => b.value = '');
    document.querySelectorAll('#driverOtpBoxes .otp-box')[0]?.focus();
    showToast(`New OTP: ${DriverState.otpCode}`, 'info', 15000);

    // Auto-fill generated OTP boxes
    const otpBoxes = document.querySelectorAll('#driverOtpBoxes .otp-box');
    const otpDigits = DriverState.otpCode.split('');
    otpBoxes.forEach((b, i) => b.value = otpDigits[i] || '');
}

async function doDriverLogin(mode) {
    mode = mode || DriverState.driverAuthMode || 'contact';
    const vehicleId = (document.getElementById('driverVehicleId')?.value || '').trim().toUpperCase();
    const errEl = document.getElementById('driverError');
    if (errEl) errEl.style.display = 'none';

    if (!vehicleId) { if (errEl) { errEl.textContent = 'Enter your Vehicle ID'; errEl.style.display = 'block'; } return; }

    let payload = { vehicle_id: vehicleId, auth_mode: mode };

    if (mode === 'contact') {
        const contact = (document.getElementById('driverContact')?.value || '').trim();
        if (!contact) { if (errEl) { errEl.textContent = 'Enter your contact number'; errEl.style.display = 'block'; } return; }
        payload.contact = contact;
    } else if (mode === 'pin') {
        const pins = Array.from(document.querySelectorAll('#driverPinBoxes .otp-box')).map(b => b.value).join('');
        if (pins.length !== 4) { if (errEl) { errEl.textContent = 'Enter your 4-digit PIN'; errEl.style.display = 'block'; } return; }
        payload.pin = pins;
    } else if (mode === 'otp') {
        const otp = Array.from(document.querySelectorAll('#driverOtpBoxes .otp-box')).map(b => b.value).join('');
        if (otp.length !== 6) { if (errEl) { errEl.textContent = 'Enter the 6-digit OTP'; errEl.style.display = 'block'; } return; }
        if (otp !== DriverState.otpCode) { if (errEl) { errEl.textContent = 'Incorrect OTP. Try again.'; errEl.style.display = 'block'; } return; }
        payload.otp_token = 'verified_' + otp;
    }

    const btn = document.getElementById('driverLoginBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Verifying…'; }

    try {
        const res = await fetch(`${API_BASE}/api/driver/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.success) {
            if (errEl) { errEl.textContent = data.error || 'Authentication failed'; errEl.style.display = 'block'; }
            return;
        }

        // Device registration: save fingerprint to localStorage
        try {
            const known = JSON.parse(localStorage.getItem('fleetKnownDevices') || '{}');
            known[vehicleId] = { ts: Date.now(), mode };
            localStorage.setItem('fleetKnownDevices', JSON.stringify(known));
        } catch (e) { }

        currentRole = 'driver';
        DriverState.vehicleData = data.data;
        DriverState.updateCount = 0;
        DriverState.broadcasting = false;
        DriverState.lastPosition = null;
        DriverState.preTripPassed = false;
        DriverState.shiftStatus = 'off_duty';

        document.getElementById('loginScreen').style.display = 'none';
        showAppWithDisclaimer('driverView', () => {
            populateDriverView(data.data);
            initDriverGPS();
            updateShiftUI();
            setTimeout(() => checkDriverVehicleCompliance(vehicleId), 800);
        });
    } catch (e) {
        if (errEl) { errEl.textContent = 'Server error. Try again.'; errEl.style.display = 'block'; }
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-satellite-dish"></i> Authenticate & Continue'; }
    }
}

// ── Check for known device on form show ─────────────────────────────────────
function checkDriverKnownDevice() {
    try {
        const vid = (document.getElementById('driverVehicleId')?.value || '').trim().toUpperCase();
        if (!vid) return;
        const known = JSON.parse(localStorage.getItem('fleetKnownDevices') || '{}');
        const badge = document.getElementById('driverDeviceBadge');
        if (known[vid] && badge) badge.style.display = 'flex';
    } catch (e) { }
}

// ── Driver Compliance Warning Popup ──────────────────────────────────────────
async function checkDriverVehicleCompliance(vehicleId) {
    try {
        const res = await fetch(`${API_BASE}/api/fleet/mongo-registry/${vehicleId}`).then(r => r.json());
        const v = res.success ? res.data : {};

        const today = new Date();
        const issues = [];
        const checks = [
            { label: 'Insurance', date: v.insurance_expiry, icon: 'fa-shield-alt' },
            { label: 'Permit', date: v.permit_expiry, icon: 'fa-file-alt' },
            { label: 'Fitness', date: v.fitness_expiry, icon: 'fa-heartbeat' },
            { label: 'Pollution', date: v.pollution_expiry, icon: 'fa-smog' },
            { label: 'Maintenance', date: v.maintenance_due, icon: 'fa-tools' },
        ];
        for (const c of checks) {
            if (!c.date) continue;
            const daysLeft = Math.ceil((new Date(c.date) - today) / 86400000);
            if (daysLeft < 0)
                issues.push({ ...c, severity: 'critical', msg: `Expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) !== 1 ? 's' : ''} ago (${c.date})` });
            else if (daysLeft <= 30)
                issues.push({ ...c, severity: 'warn', msg: `Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} (${c.date})` });
        }
        if (!issues.length) return;

        const critical = issues.filter(i => i.severity === 'critical');
        const headerColor = critical.length ? 'var(--red)' : 'var(--yellow)';
        const headerIcon = critical.length ? 'fa-exclamation-circle' : 'fa-exclamation-triangle';
        const headerText = critical.length
            ? `${critical.length} Critical Issue${critical.length > 1 ? 's' : ''} — Immediate Action Required`
            : `${issues.length} Compliance Alert${issues.length > 1 ? 's' : ''} — Renewal Needed`;

        const issueHTML = issues.map(i => `
            <div style="display:flex;align-items:flex-start;gap:12px;padding:10px 14px;border-radius:10px;
                background:${i.severity === 'critical' ? 'rgba(255,80,80,0.12)' : 'rgba(255,170,0,0.10)'};
                border:1px solid ${i.severity === 'critical' ? 'rgba(255,80,80,0.4)' : 'rgba(255,170,0,0.35)'};margin-bottom:8px">
                <i class="fas ${i.icon}" style="color:${i.severity === 'critical' ? 'var(--red)' : 'var(--yellow)'};margin-top:2px;font-size:16px;flex-shrink:0"></i>
                <div>
                    <div style="font-weight:600;color:${i.severity === 'critical' ? 'var(--red)' : 'var(--yellow)'}">
                        ${i.label} ${i.severity === 'critical' ? 'EXPIRED' : 'Expiring Soon'}</div>
                    <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${i.msg}</div>
                </div>
            </div>`).join('');

        const overlay = document.createElement('div');
        overlay.id = 'driverComplianceAlert';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.78);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
        overlay.innerHTML = `
            <div style="background:var(--bg-card);border:2px solid ${headerColor};border-radius:18px;
                max-width:460px;width:100%;padding:28px;box-shadow:0 0 50px ${headerColor}55">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
                    <div style="width:48px;height:48px;border-radius:50%;background:${headerColor}22;
                        display:flex;align-items:center;justify-content:center;flex-shrink:0;border:2px solid ${headerColor}55">
                        <i class="fas ${headerIcon}" style="color:${headerColor};font-size:22px"></i>
                    </div>
                    <div>
                        <div style="font-weight:700;font-size:15px;color:${headerColor}">⚠ ${headerText}</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:3px">Vehicle:
                            <strong style="color:var(--accent);font-family:var(--font-mono)">${vehicleId}</strong></div>
                    </div>
                </div>
                <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;padding:10px 14px;
                    background:rgba(255,255,255,0.03);border-radius:8px;border-left:3px solid ${headerColor}">
                    Your vehicle has compliance issues that must be resolved immediately.
                    Contact your <strong>fleet manager</strong> before operating the vehicle.
                </div>
                <div style="max-height:250px;overflow-y:auto">${issueHTML}</div>
                <div style="margin-top:20px;display:flex;gap:10px">
                    <button onclick="document.getElementById('driverComplianceAlert').remove()"
                        style="flex:1;padding:11px;border-radius:10px;border:1px solid ${headerColor};
                            background:transparent;color:${headerColor};font-weight:600;cursor:pointer;font-size:13px">
                        <i class="fas fa-times"></i> Dismiss
                    </button>
                    <button onclick="document.getElementById('driverComplianceAlert').remove()"
                        style="flex:2;padding:11px;border-radius:10px;border:none;
                            background:${headerColor};color:white;font-weight:700;cursor:pointer;font-size:13px">
                        <i class="fas fa-check"></i> Acknowledged — I Will Alert Manager
                    </button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
    } catch (e) { /* silently ignore — non-critical */ }
}

function populateDriverView(v) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
    set('dInfoName', v.driver_name);
    set('dInfoVehicle', v.id);
    set('dInfoVNo', v.vehicle_number);
    set('dInfoType', v.vehicle_type);
    set('dInfoContact', v.driver_contact);

    const o = v.current_order;
    if (o) {
        set('dMissOrder', o.id);
        set('dMissRoute', `${o.source_city || '—'} → ${o.destination_city || '—'}`);
        set('dMissCust', o.customer_name);
        set('dMissStatus', o.order_status);
        set('dMissEta', formatDateTime(o.expected_delivery_datetime));
        set('dMissDist', o.distance_km ? o.distance_km + ' km' : '—');
    } else {
        ['dMissOrder', 'dMissRoute', 'dMissCust', 'dMissStatus', 'dMissEta', 'dMissDist'].forEach(id => set(id, 'No active mission'));
    }

    // Reset metrics
    set('dMetSpeed', '—');
    set('dMetHeading', '—');
    set('dMetUpdates', '0');
    set('dMetAcc', '—');
    document.getElementById('driverGpsLabel').textContent = 'Tap "Start Broadcasting" to share location';
    document.getElementById('driverGpsCoords').textContent = '—';
    document.getElementById('driverGpsAccuracy').textContent = 'Accuracy: —';

    // Load routes for driver's mission
    const src = v.current_order?.source_city || null;
    const dst = v.current_order?.destination_city || null;
    loadDriverRoutes(src, dst);

    // Init driver map
    setTimeout(initDriverMap, 300);
}

function initDriverGPS() {
    // Just request permission preemptively (navigator will cache the grant)
    if (!('geolocation' in navigator)) {
        document.getElementById('driverGpsLabel').textContent = 'GPS not supported on this device';
        const btn = document.getElementById('driverBroadcastBtn');
        if (btn) btn.disabled = true;
        return;
    }
    // Pre-warm permission: one non-stored position fetch
    navigator.geolocation.getCurrentPosition(
        pos => {
            _updateDriverCoordDisplay(pos.coords, null);
            document.getElementById('driverGpsLabel').textContent = 'GPS ready — tap Start to broadcast';
        },
        err => {
            document.getElementById('driverGpsLabel').textContent = 'GPS permission needed — enable in browser settings';
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

function _updateDriverCoordDisplay(coords, prevCoords) {
    const lat = coords.latitude;
    const lng = coords.longitude;
    const acc = Math.round(coords.accuracy);

    document.getElementById('driverGpsCoords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    document.getElementById('dMetAcc').textContent = acc;

    // Accuracy colouring: green <100m, yellow <1000m, red >1000m
    const accEl = document.getElementById('driverGpsAccuracy');
    const accColor = acc < 100 ? 'var(--green)' : acc < 1000 ? 'var(--yellow)' : 'var(--red)';
    if (accEl) {
        accEl.style.color = accColor;
        if (acc > 500) {
            accEl.textContent = `⚠ Accuracy: ±${acc > 1000 ? (acc / 1000).toFixed(1) + 'km' : acc + 'm'} — use mobile for precise GPS`;
        } else {
            accEl.textContent = `✓ Accuracy: ±${acc} m`;
        }
    }

    // Speed: prefer native GPS speed (m/s → km/h), else 0
    const speedKmh = coords.speed != null ? Math.round(coords.speed * 3.6) : 0;
    document.getElementById('dMetSpeed').textContent = speedKmh + ' km/h';

    // Heading from GPS if available
    const heading = coords.heading != null ? Math.round(coords.heading) + '°' : '—';
    document.getElementById('dMetHeading').textContent = heading;
}

function toggleDriverBroadcast() {
    if (!DriverState.broadcasting) {
        startDriverBroadcast();
    } else {
        stopDriverBroadcast();
    }
}

function startDriverBroadcast() {
    if (!('geolocation' in navigator)) return;

    DriverState.broadcasting = true;

    // UI: active state
    const orb = document.getElementById('driverGpsOrb');
    const btn = document.getElementById('driverBroadcastBtn');
    const btxt = document.getElementById('driverBroadcastBtnTxt');
    const lbl = document.getElementById('driverGpsLabel');
    if (orb) orb.classList.add('broadcasting');
    if (btn) btn.classList.add('active');
    if (btxt) btxt.textContent = 'Stop Broadcasting';
    if (lbl) lbl.textContent = 'Broadcasting live location…';

    // High-accuracy continuous watch
    DriverState.watchId = navigator.geolocation.watchPosition(
        pos => _onDriverPosition(pos),
        err => _onDriverGPSError(err),
        {
            enableHighAccuracy: true,
            maximumAge: 0,        // always fresh — no cached positions
            timeout: 15000
        }
    );

    showToast('Location broadcasting started', 'success', 3000);
}

function stopDriverBroadcast() {
    DriverState.broadcasting = false;
    if (DriverState.watchId !== null) {
        navigator.geolocation.clearWatch(DriverState.watchId);
        DriverState.watchId = null;
    }
    const orb = document.getElementById('driverGpsOrb');
    const btn = document.getElementById('driverBroadcastBtn');
    const btxt = document.getElementById('driverBroadcastBtnTxt');
    const lbl = document.getElementById('driverGpsLabel');
    if (orb) orb.classList.remove('broadcasting');
    if (btn) btn.classList.remove('active');
    if (btxt) btxt.textContent = 'Start Broadcasting';
    if (lbl) lbl.textContent = 'Broadcasting paused';
    showToast('Location broadcasting stopped', 'info', 2500);
}


// ── Shift Status ─────────────────────────────────────────────────────────────
function updateShiftUI() {
    const s = DriverState.shiftStatus;
    const badge = document.getElementById('driverShiftBadge');
    const label = document.getElementById('driverShiftLabel');
    const dot = document.getElementById('driverShiftDot');
    const timer = document.getElementById('driverShiftTimer');

    const cfg = {
        off_duty: { label: 'Off Duty', color: 'var(--text-muted)', dot: '#666' },
        on_shift: { label: 'On Shift', color: 'var(--green)', dot: 'var(--green)' },
        on_break: { label: 'On Break', color: 'var(--yellow)', dot: 'var(--yellow)' },
    };
    const c = cfg[s] || cfg.off_duty;
    if (label) label.textContent = c.label;
    if (dot) dot.style.color = c.dot;
    if (badge) badge.style.borderColor = c.dot;
    if (timer) timer.style.display = s !== 'off_duty' ? '' : 'none';

    const show = (id, vis) => { const el = document.getElementById(id); if (el) el.style.display = vis ? '' : 'none'; };
    show('shiftBtnStart', s === 'off_duty');
    show('shiftBtnBreak', s === 'on_shift');
    show('shiftBtnResume', s === 'on_break');
    show('shiftBtnEnd', s !== 'off_duty');

    // GPS broadcast button enabled only when on shift
    const broadBtn = document.getElementById('driverBroadcastBtn');
    if (broadBtn) broadBtn.disabled = s !== 'on_shift';
    if (broadBtn) broadBtn.title = s !== 'on_shift' ? 'Start a shift first to broadcast GPS' : '';
}

function logShiftEvent(msg) {
    const ts = new Date().toLocaleTimeString();
    DriverState.shiftLog.unshift({ ts, msg });
    const el = document.getElementById('driverShiftLog');
    if (!el) return;
    el.innerHTML = DriverState.shiftLog.slice(0, 5).map(e =>
        `<div class="shift-log-entry"><span class="sle-ts">${e.ts}</span><span>${e.msg}</span></div>`
    ).join('');
}

function startShiftTimer() {
    if (DriverState.shiftTimerInterval) clearInterval(DriverState.shiftTimerInterval);
    DriverState.shiftTimerInterval = setInterval(() => {
        if (!DriverState.shiftStartTime) return;
        const elapsed = Date.now() - DriverState.shiftStartTime;
        const h = Math.floor(elapsed / 3600000).toString().padStart(2, '0');
        const m = Math.floor((elapsed % 3600000) / 60000).toString().padStart(2, '0');
        const sc = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');
        const el = document.getElementById('driverShiftTime');
        if (el) el.textContent = `${h}:${m}:${sc}`;
    }, 1000);
}

function driverStartShift() {
    // Show pre-trip inspection modal first
    openPreTripModal();
}

function driverTakeBreak() {
    if (DriverState.broadcasting) stopDriverBroadcast();
    DriverState.shiftStatus = 'on_break';
    updateShiftUI();
    logShiftEvent('Break started');
    showToast('Break started — GPS paused', 'info', 3000);
}

function driverResumeShift() {
    DriverState.shiftStatus = 'on_shift';
    updateShiftUI();
    logShiftEvent('Driving resumed');
    showToast('Back on shift — you can resume broadcasting', 'success', 3000);
}

function driverEndShift() {
    if (DriverState.broadcasting) stopDriverBroadcast();
    if (DriverState.shiftTimerInterval) clearInterval(DriverState.shiftTimerInterval);
    DriverState.shiftStatus = 'off_duty';
    DriverState.shiftStartTime = null;
    DriverState.preTripPassed = false;
    DriverState.preTripChecks = {};
    updateShiftUI();
    logShiftEvent('Shift ended');
    showToast('Shift ended — drive safe!', 'info', 4000);
}

// ── Pre-Trip Inspection ───────────────────────────────────────────────────────
const PTI_ITEMS = ['brakes', 'tires', 'fuel', 'cargo', 'lights', 'horn'];

function openPreTripModal() {
    // Reset checks
    DriverState.preTripChecks = {};
    PTI_ITEMS.forEach(k => {
        DriverState.preTripChecks[k] = false;
        const item = document.getElementById('pti-' + k);
        if (item) item.classList.remove('checked');
    });
    updatePreTripProgress();
    const modal = document.getElementById('preTripModal');
    if (modal) modal.style.display = 'flex';
}

function togglePTI(key) {
    DriverState.preTripChecks[key] = !DriverState.preTripChecks[key];
    const item = document.getElementById('pti-' + key);
    if (item) item.classList.toggle('checked', DriverState.preTripChecks[key]);
    updatePreTripProgress();
}

function updatePreTripProgress() {
    const done = PTI_ITEMS.filter(k => DriverState.preTripChecks[k]).length;
    const total = PTI_ITEMS.length;
    const bar = document.getElementById('preTripProgressBar');
    const count = document.getElementById('preTripCount');
    const btn = document.getElementById('preTripSubmit');
    if (bar) bar.style.width = `${(done / total) * 100}%`;
    if (count) count.textContent = done;
    if (btn) {
        btn.disabled = done < total;
        btn.style.opacity = done < total ? '0.4' : '1';
    }
}

function submitPreTrip() {
    const allPassed = PTI_ITEMS.every(k => DriverState.preTripChecks[k]);
    if (!allPassed) return;
    document.getElementById('preTripModal').style.display = 'none';
    DriverState.preTripPassed = true;
    DriverState.shiftStatus = 'on_shift';
    DriverState.shiftStartTime = Date.now();
    startShiftTimer();
    updateShiftUI();
    logShiftEvent('Shift started — pre-trip inspection passed ✓');
    showToast('Inspection passed — shift started! GPS broadcasting enabled.', 'success', 4000);
}

function stopDriverGPS() {
    if (DriverState.watchId !== null) {
        navigator.geolocation.clearWatch(DriverState.watchId);
        DriverState.watchId = null;
    }
    DriverState.broadcasting = false;
    DriverState.vehicleData = null;
    DriverState.updateCount = 0;
    DriverState.shiftStatus = 'off_duty';
    DriverState.shiftStartTime = null;
    DriverState.preTripPassed = false;
    DriverState.preTripChecks = {};
    if (DriverState.shiftTimerInterval) { clearInterval(DriverState.shiftTimerInterval); DriverState.shiftTimerInterval = null; }
}

async function _onDriverPosition(pos) {
    const coords = pos.coords;
    const vid = DriverState.vehicleData?.id;
    if (!vid) return;

    _updateDriverCoordDisplay(coords, DriverState.lastPosition?.coords);
    DriverState.lastPosition = pos;
    updateDriverMapPosition(coords.latitude, coords.longitude);

    const lat = coords.latitude;
    const lng = coords.longitude;
    const speed = coords.speed != null ? coords.speed * 3.6 : 0;   // km/h
    const heading = coords.heading != null ? coords.heading : 0;
    const ts = new Date(pos.timestamp).toISOString();

    try {
        const res = await fetch(`${API_BASE}/api/vehicles/${vid}/location`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng, speed, heading, status: 'moving', timestamp: ts })
        });
        if (res.ok) {
            DriverState.updateCount++;
            const upEl = document.getElementById('dMetUpdates');
            if (upEl) upEl.textContent = DriverState.updateCount;
        }
    } catch (e) {
        // silently retry on next position
    }
}

function _onDriverGPSError(err) {
    const lbl = document.getElementById('driverGpsLabel');
    let msg = 'GPS error';
    if (err.code === 1) msg = 'Location permission denied';
    else if (err.code === 2) msg = 'Position unavailable — check GPS signal';
    else if (err.code === 3) msg = 'GPS timeout — retrying…';
    if (lbl) lbl.textContent = msg;
    showToast(msg, 'warn', 4000);
}

function doDriverSignOut() {
    stopDriverGPS();
    closeDriverSidebar();
    if (DriverState.driverMap) { DriverState.driverMap.remove(); DriverState.driverMap = null; DriverState.driverMarker = null; }
    currentRole = null;
    document.getElementById('driverView').style.display = 'none';
    resetLoginType();
    document.getElementById('loginScreen').style.display = 'flex';
}

// ── Driver Sidebar ────────────────────────────────────────────────────────────
function toggleDriverSidebar() {
    const sb = document.getElementById('driverSidebar');
    const ov = document.getElementById('driverSidebarOverlay');
    if (!sb) return;
    const open = sb.classList.toggle('open');
    if (ov) ov.classList.toggle('visible', open);
}

function closeDriverSidebar() {
    const sb = document.getElementById('driverSidebar');
    const ov = document.getElementById('driverSidebarOverlay');
    if (sb) sb.classList.remove('open');
    if (ov) ov.classList.remove('visible');
}

// ── Driver Map ────────────────────────────────────────────────────────────────
function initDriverMap() {
    if (DriverState.driverMap) return;
    const el = document.getElementById('driverMap');
    if (!el) return;
    const map = L.map('driverMap', { zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.setView([20.5937, 78.9629], 5); // default India center
    DriverState.driverMap = map;
    DriverState.driverMarker = null;
}

function updateDriverMapPosition(lat, lng) {
    const hint = document.getElementById('driverMapHint');
    if (hint) hint.style.display = 'none';
    if (!DriverState.driverMap) initDriverMap();
    const map = DriverState.driverMap;
    if (!map) return;
    if (!DriverState.driverMarker) {
        const icon = L.divIcon({
            className: '',
            html: '<div style="width:18px;height:18px;border-radius:50%;background:var(--orange);border:3px solid #fff;box-shadow:0 0 10px rgba(255,140,0,0.7)"></div>',
            iconSize: [18, 18], iconAnchor: [9, 9]
        });
        DriverState.driverMarker = L.marker([lat, lng], { icon }).addTo(map);
    } else {
        DriverState.driverMarker.setLatLng([lat, lng]);
    }
    map.setView([lat, lng], 13);
}

// ── Driver Routes ─────────────────────────────────────────────────────────────
async function loadDriverRoutes(srcCity, dstCity) {
    const body = document.getElementById('driverRoutesBody');
    const subtitle = document.getElementById('driverRoutesSubtitle');
    if (!body) return;

    if (!srcCity || !dstCity) {
        body.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px"><i class="fas fa-info-circle"></i> No active mission assigned</div>';
        if (subtitle) subtitle.textContent = '';
        return;
    }

    if (subtitle) subtitle.textContent = `${srcCity} → ${dstCity}`;
    body.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:13px"><i class="fas fa-circle-notch fa-spin"></i> Loading routes...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/routes`).then(r => r.json());
        const all = res.data || [];
        const matched = all.filter(r =>
            r.source_city?.toLowerCase() === srcCity.toLowerCase() &&
            r.destination_city?.toLowerCase() === dstCity.toLowerCase()
        );

        if (!matched.length) {
            body.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px"><i class="fas fa-map-signs"></i><br>No routes found for<br><strong style="color:var(--accent)">${srcCity} → ${dstCity}</strong></div>`;
            return;
        }

        body.innerHTML = matched.map(r => `
            <div class="driver-route-item">
                <div class="driver-route-name"><i class="fas fa-route" style="color:var(--accent)"></i> ${r.name || 'Route'}</div>
                <div class="driver-route-stats">
                    <div class="driver-route-stat"><span class="drs-val">${r.distance_km} km</span><span class="drs-lbl">Distance</span></div>
                    <div class="driver-route-stat"><span class="drs-val">${r.estimated_hours} hrs</span><span class="drs-lbl">Est. Time</span></div>
                    <div class="driver-route-stat"><span class="drs-val">&#8377;${(r.toll_cost_inr || 0).toLocaleString('en-IN')}</span><span class="drs-lbl">Tolls</span></div>
                    <div class="driver-route-stat"><span class="drs-val">${r.traffic_factor ?? 1.0}x</span><span class="drs-lbl">Traffic</span></div>
                </div>
                <div style="margin-top:8px">
                    <span class="pill ${r.transport_mode === 'road' ? 'delivered' : 'in-transit'}" style="font-size:10px">${r.transport_mode}</span>
                </div>
            </div>
        `).join('');
    } catch (e) {
        body.innerHTML = '<div style="text-align:center;padding:16px;color:var(--red);font-size:13px"><i class="fas fa-exclamation-circle"></i> Failed to load routes</div>';
    }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 1 – Fleet Registry
// ══════════════════════════════════════════════════════════════
let _registryData = [];

async function loadFleetRegistry() {
    try {
        const [regRes, maintRes] = await Promise.all([
            fetch(`${API_BASE}/api/fleet/registry`).then(r => r.json()),
            fetch(`${API_BASE}/api/fleet/maintenance`).then(r => r.json()),
        ]);
        _registryData = regRes.data || [];
        renderRegistryTable();
        renderMaintTable(maintRes.data || []);
        renderRegistryStats(_registryData);
    } catch (e) { showToast('Fleet registry error: ' + e.message, 'error'); }
}

function renderRegistryStats(data) {
    const el = document.getElementById('registryStatsRow'); if (!el) return;
    const total = data.length;
    const insExpiring = data.filter(v => expiryClass(v.insurance_expiry) !== 'expiry-ok').length;
    const maintDue = data.filter(v => expiryClass(v.maintenance_due) !== 'expiry-ok').length;
    el.innerHTML = [
        ['fas fa-truck', 'var(--accent)', total, 'Total Vehicles'],
        ['fas fa-shield-alt', 'var(--yellow)', insExpiring, 'Insurance Alerts'],
        ['fas fa-wrench', 'var(--orange)', maintDue, 'Maintenance Due'],
        ['fas fa-route', 'var(--green)', data.filter(v => v.status === 'moving').length, 'On Road'],
    ].map(([ic, col, val, lab]) =>
        `<div class="fleet-stat"><i class="fas ${ic.split(' ')[1]}" style="color:${col};font-size:20px"></i>
         <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
    ).join('');
}

function expiryClass(dateStr) {
    if (!dateStr) return 'expiry-ok';
    const days = (new Date(dateStr) - new Date()) / 86400000;
    if (days < 0) return 'expiry-crit';
    if (days < 30) return 'expiry-warn';
    return 'expiry-ok';
}

function renderRegistryTable() {
    const search = (document.getElementById('registrySearch')?.value || '').toLowerCase();
    const tbody = document.getElementById('registryTableBody'); if (!tbody) return;
    let data = _registryData;
    if (search) data = data.filter(v =>
        [v.id, v.vehicle_number, v.driver_name, v.vehicle_type].some(f => (f || '').toLowerCase().includes(search))
    );
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="14" class="loading-row">No vehicles found</td></tr>'; return; }

    const fuelIcon = f => ({ 'Diesel': '⛽', 'CNG': '🔵', 'Electric': '⚡', 'Petrol': '🛢️' }[f] || '⛽');

    tbody.innerHTML = data.map(v => {
        const insCls = expiryClass(v.insurance_expiry);
        const perCls = expiryClass(v.permit_expiry);
        const fitCls = expiryClass(v.fitness_expiry);
        const polCls = expiryClass(v.pollution_expiry);
        const mntCls = expiryClass(v.maintenance_due);
        const anyAlert = [insCls, perCls, fitCls, polCls, mntCls].some(c => c !== 'expiry-ok');
        return `<tr style="${anyAlert ? 'border-left:3px solid var(--orange)' : ''}">
        <td><strong style="color:var(--accent);font-family:var(--font-mono)">${v.id}</strong></td>
        <td>${v.vehicle_type || '—'}</td>
        <td><span style="font-family:var(--font-mono)">${v.vehicle_number || '—'}</span></td>
        <td>${v.driver_name || '—'}</td>
        <td><strong>${v.capacity_tons ?? '—'}</strong> T${v.capacity_cbm ? ` / ${v.capacity_cbm} cbm` : ''}</td>
        <td><span title="${v.fuel_type || ''}">${fuelIcon(v.fuel_type)} ${v.fuel_type || '—'}</span></td>
        <td><span class="${insCls}" title="Policy: ${v.insurance_policy || '—'} | Coverage: ₹${(v.insurance_coverage_inr || 0).toLocaleString('en-IN')}">${v.insurance_expiry || '—'}</span></td>
        <td style="font-size:11px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${v.insurance_provider || ''}">${v.insurance_provider || '—'}</td>
        <td><span class="${perCls}">${v.permit_expiry || '—'}</span></td>
        <td><span class="${fitCls}">${v.fitness_expiry || '—'}</span></td>
        <td><span class="${polCls}">${v.pollution_expiry || '—'}</span></td>
        <td><span class="${mntCls}">${v.maintenance_due || '—'}</span></td>
        <td><span class="pill ${v.status}">${v.status}</span></td>
        <td style="white-space:nowrap">
            <button class="btn-sm" onclick="openMaintenanceModal('${v.id}')" title="Log Maintenance"><i class="fas fa-wrench"></i></button>
            <button class="btn-sm" style="color:var(--accent)" onclick="openEditRegistryModal('${v.id}')" title="Edit Details"><i class="fas fa-edit"></i></button>
            <button class="btn-sm" style="color:var(--red)" onclick="deleteRegistryVehicle('${v.id}')" title="Delete Registry"><i class="fas fa-trash"></i></button>
        </td>
    </tr>`;
    }).join('');
}

function renderMaintTable(data) {
    const tbody = document.getElementById('maintTableBody'); if (!tbody) return;
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="8" class="loading-row">No maintenance records</td></tr>'; return; }
    tbody.innerHTML = data.map(m => `<tr>
        <td>${m.vehicle_number || m.vehicle_id}</td>
        <td>${m.maintenance_type || '—'}</td>
        <td>${m.description || '—'}</td>
        <td>₹${(m.cost_inr || 0).toLocaleString('en-IN')}</td>
        <td>${m.vendor || '—'}</td>
        <td>${formatDateShort(m.performed_at)}</td>
        <td><span class="${expiryClass(m.next_due_at)}">${m.next_due_at || '—'}</span></td>
        <td><span class="pill ${m.status === 'Completed' ? 'delivered' : 'in-transit'}">${m.status}</span></td>
    </tr>`).join('');
}

function openMaintenanceModal(vehicleId = '') {
    const html = `<div class="modal-form">
        <div class="form-group"><label>Vehicle ID</label>
            <input id="mtVid" value="${vehicleId}" placeholder="e.g. MH-TRK-001"></div>
        <div class="form-group"><label>Type</label>
            <select id="mtType">
                <option>Oil Change</option><option>Tire Rotation</option><option>Brake Service</option>
                <option>Engine Check</option><option>Battery</option><option>General Inspection</option>
            </select></div>
        <div class="form-group"><label>Description</label>
            <input id="mtDesc" placeholder="Details..."></div>
        <div class="form-group"><label>Cost (₹)</label>
            <input id="mtCost" type="number" placeholder="0"></div>
        <div class="form-group"><label>Vendor</label>
            <input id="mtVendor" placeholder="Vendor name"></div>
        <div class="form-group"><label>Next Due Date</label>
            <input id="mtNext" type="date"></div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitMaintenance()">
            <i class="fas fa-wrench"></i> Save Record</button>
    </div>`;
    showGenericModal('Log Maintenance', html);
}

// ── Edit Registry Modal (MongoDB) ──────────────────────────────────────────────
function _buildRegistryForm(v = {}) {
    return `<div class="modal-form" style="max-height:70vh;overflow-y:auto">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Capacity (Tons)</label>
                <input id="erCapT" type="number" step="0.5" value="${v.capacity_tons || ''}" placeholder="e.g. 20"></div>
            <div class="form-group"><label>Capacity (CBM)</label>
                <input id="erCapC" type="number" step="0.5" value="${v.capacity_cbm || ''}" placeholder="e.g. 80"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Fuel Type</label>
                <select id="erFuel">
                    ${['Diesel', 'CNG', 'Electric', 'Petrol'].map(f => `<option ${v.fuel_type === f ? 'selected' : ''}>${f}</option>`).join('')}
                </select></div>
            <div class="form-group"><label>Transport Mode</label>
                <select id="erMode">
                    ${['road', 'rail', 'sea', 'air'].map(m => `<option ${v.transport_mode === m ? 'selected' : ''}>${m}</option>`).join('')}
                </select></div>
        </div>
        <div style="border-top:1px solid var(--border);margin:10px 0;padding-top:10px;font-size:11px;color:var(--text-muted);letter-spacing:1px">INSURANCE</div>
        <div class="form-group"><label>Insurance Provider</label>
            <input id="erInsProv" value="${v.insurance_provider || ''}" placeholder="e.g. New India Assurance"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Policy Number</label>
                <input id="erInsPolicy" value="${v.insurance_policy || ''}" placeholder="e.g. NIA-2024-001"></div>
            <div class="form-group"><label>Coverage (₹)</label>
                <input id="erInsCov" type="number" value="${v.insurance_coverage_inr || ''}" placeholder="e.g. 2500000"></div>
        </div>
        <div class="form-group"><label>Insurance Expiry</label>
            <input id="erInsExp" type="date" value="${v.insurance_expiry || ''}"></div>
        <div style="border-top:1px solid var(--border);margin:10px 0;padding-top:10px;font-size:11px;color:var(--text-muted);letter-spacing:1px">COMPLIANCE DATES</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Permit Expiry</label>
                <input id="erPer" type="date" value="${v.permit_expiry || ''}"></div>
            <div class="form-group"><label>Fitness Expiry</label>
                <input id="erFit" type="date" value="${v.fitness_expiry || ''}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Pollution Expiry</label>
                <input id="erPol" type="date" value="${v.pollution_expiry || ''}"></div>
            <div class="form-group"><label>Maintenance Due</label>
                <input id="erMnt" type="date" value="${v.maintenance_due || ''}"></div>
        </div>
        <div style="border-top:1px solid var(--border);margin:10px 0;padding-top:10px;font-size:11px;color:var(--text-muted);letter-spacing:1px">VEHICLE IDENTITY</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Year of Manufacture</label>
                <input id="erYear" type="number" value="${v.year_of_manufacture || ''}" placeholder="e.g. 2021"></div>
            <div class="form-group"><label>Chassis No.</label>
                <input id="erChassisNo" value="${v.chassis_no || ''}" placeholder="Chassis number"></div>
        </div>
        <div class="form-group"><label>Engine No.</label>
            <input id="erEngineNo" value="${v.engine_no || ''}" placeholder="Engine number"></div>
        <div class="form-group"><label>Notes</label>
            <input id="erNotes" value="${v.notes || ''}" placeholder="Additional notes..."></div>
    </div>`;
}

function openAddRegistryModal() {
    showGenericModal('<i class="fas fa-plus-circle" style="color:var(--green)"></i> Add Vehicle Registry',
        `<div class="modal-form">
        <div class="form-group"><label>Vehicle ID <span style="color:var(--red)">*</span></label>
            <input id="erVidNew" placeholder="e.g. OFE-TRK-013" style="text-transform:uppercase"></div>
        </div>` + _buildRegistryForm() +
        `<button class="btn-primary" style="width:100%;margin-top:12px" onclick="submitAddRegistry()">
            <i class="fas fa-plus"></i> Add to Registry</button>`);
}

async function submitAddRegistry() {
    const vid = (document.getElementById('erVidNew')?.value || '').trim().toUpperCase();
    if (!vid) { showToast('Enter Vehicle ID', 'warn'); return; }
    const body = _collectRegistryForm();
    try {
        const res = await fetch(`${API_BASE}/api/fleet/mongo-registry/${vid}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast('Vehicle added to registry!', 'success'); closeGenericModal(); loadFleetRegistry(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

async function openEditRegistryModal(vid) {
    // Fetch existing Mongo doc for this vehicle
    let existing = _registryData.find(v => v.id === vid) || {};
    try {
        const res = await fetch(`${API_BASE}/api/fleet/mongo-registry/${vid}`).then(r => r.json());
        if (res.success) existing = { ...existing, ...res.data };
    } catch (e) {/* use SQLite data */ }

    showGenericModal(
        `<i class="fas fa-edit" style="color:var(--accent)"></i> Edit Registry — <span style="font-family:var(--font-mono)">${vid}</span>`,
        _buildRegistryForm(existing) +
        `<button class="btn-primary" style="width:100%;margin-top:12px" onclick="submitEditRegistry('${vid}')">
            <i class="fas fa-save"></i> Save Changes</button>`);
}

function _collectRegistryForm() {
    return {
        capacity_tons: +(document.getElementById('erCapT')?.value) || null,
        capacity_cbm: +(document.getElementById('erCapC')?.value) || null,
        fuel_type: document.getElementById('erFuel')?.value || null,
        transport_mode: document.getElementById('erMode')?.value || null,
        insurance_provider: document.getElementById('erInsProv')?.value || null,
        insurance_policy: document.getElementById('erInsPolicy')?.value || null,
        insurance_coverage_inr: +(document.getElementById('erInsCov')?.value) || null,
        insurance_expiry: document.getElementById('erInsExp')?.value || null,
        permit_expiry: document.getElementById('erPer')?.value || null,
        fitness_expiry: document.getElementById('erFit')?.value || null,
        pollution_expiry: document.getElementById('erPol')?.value || null,
        maintenance_due: document.getElementById('erMnt')?.value || null,
        year_of_manufacture: +(document.getElementById('erYear')?.value) || null,
        chassis_no: document.getElementById('erChassisNo')?.value || null,
        engine_no: document.getElementById('erEngineNo')?.value || null,
        notes: document.getElementById('erNotes')?.value || null,
    };
}

async function submitEditRegistry(vid) {
    const body = _collectRegistryForm();
    try {
        const res = await fetch(`${API_BASE}/api/fleet/mongo-registry/${vid}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) {
            showToast('Registry updated!', 'success');
            closeGenericModal();
            loadFleetRegistry();
        } else showToast(res.error || 'Update failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteRegistryVehicle(vid) {
    showDeleteConfirm({
        title: 'Delete Registry Entry',
        subtitle: `Remove compliance & insurance record for ${vid}`,
        confirmName: vid,
        warningLines: [
            'Insurance, capacity, and compliance details will be removed from MongoDB.',
            'The vehicle itself remains in the system — only the registry entry is deleted.',
        ],
        onConfirm: async () => {
            try {
                const res = await fetch(`${API_BASE}/api/fleet/mongo-registry/${vid}`, { method: 'DELETE' }).then(r => r.json());
                if (res.success) {
                    showToast(`Registry deleted for ${vid}`, 'success');
                    loadFleetRegistry();
                } else showToast(res.error || 'Delete failed', 'error');
            } catch (e) { showToast(e.message, 'error'); }
        }
    });
}

async function submitMaintenance() {
    const body = {
        vehicle_id: document.getElementById('mtVid')?.value.trim().toUpperCase(),
        maintenance_type: document.getElementById('mtType')?.value,
        description: document.getElementById('mtDesc')?.value,
        cost_inr: +document.getElementById('mtCost')?.value || 0,
        vendor: document.getElementById('mtVendor')?.value,
        next_due_at: document.getElementById('mtNext')?.value || null,
    };
    if (!body.vehicle_id || !body.description) { showToast('Fill required fields', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/fleet/maintenance`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const j = await res.json();
        if (j.success) { showToast('Maintenance logged!', 'success'); closeGenericModal(); loadFleetRegistry(); }
        else showToast(j.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 2 – Route Optimization
// ══════════════════════════════════════════════════════════════
let _routesData = [];
const CITIES = ['Chennai', 'Kochi', 'Mumbai', 'Goa', 'Kolkata', 'Guwahati', 'Visakhapatnam', 'Bhubaneswar', 'Tuticorin', 'Trivandrum', 'Bengaluru', 'Hyderabad'];

async function loadRoutes() {
    try {
        const res = await fetch(`${API_BASE}/api/routes`).then(r => r.json());
        _routesData = res.data || [];
        renderRoutesTable();
        populateCitySelects();
    } catch (e) { showToast('Routes error: ' + e.message, 'error'); }
}

function populateCitySelects() {
    ['optSrc', 'optDst'].forEach(id => {
        const el = document.getElementById(id); if (!el) return;
        el.innerHTML = `<option value="">Select city...</option>` +
            CITIES.map(c => `<option>${c}</option>`).join('');
    });

    // Mutually exclude selected city from the other dropdown
    const src = document.getElementById('optSrc');
    const dst = document.getElementById('optDst');
    if (!src || !dst) return;

    function syncExclusion(changed, other) {
        const val = changed.value;
        const prev = other.value;
        other.innerHTML = `<option value="">Select city...</option>` +
            CITIES.map(c => `<option ${c === prev ? 'selected' : ''} ${c === val ? 'disabled style="display:none"' : ''}>${c}</option>`).join('');
        // If other had same city selected, clear it
        if (prev === val) other.value = '';
    }

    src.addEventListener('change', () => syncExclusion(src, dst));
    dst.addEventListener('change', () => syncExclusion(dst, src));
}

function renderRoutesTable() {
    const tbody = document.getElementById('routesTableBody'); if (!tbody) return;
    if (!_routesData.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="loading-row">No routes — click <strong>Add Route</strong> to create one</td></tr>'; return;
    }
    tbody.innerHTML = _routesData.map(r => `<tr>
        <td>${r.name || '—'}</td>
        <td>${r.source_city}</td>
        <td>${r.destination_city}</td>
        <td>${r.distance_km} km</td>
        <td>${r.estimated_hours} hrs</td>
        <td>₹${(r.toll_cost_inr || 0).toLocaleString('en-IN')}</td>
        <td>${r.traffic_factor ?? 1.0}x</td>
        <td><span class="pill ${r.transport_mode === 'road' ? 'delivered' : 'in-transit'}">${r.transport_mode}</span></td>
        <td><button class="btn-sm" style="color:var(--red)" onclick="deleteRoute(${r.id})">Del</button></td>
    </tr>`).join('');
}

async function runOptimizer() {
    const src = document.getElementById('optSrc')?.value;
    const dst = document.getElementById('optDst')?.value;
    const priority = document.getElementById('optPriority')?.value || 'Economy';
    if (!src || !dst) { showToast('Select source and destination', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/routes/optimize`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_city: src, destination_city: dst, priority })
        }).then(r => r.json());
        const el = document.getElementById('optimizerResult');
        if (!el) return;
        if (!res.data?.length) {
            el.style.display = 'block';
            el.innerHTML = `<i class="fas fa-info-circle" style="color:var(--yellow)"></i>
                No routes found for <strong>${src} → ${dst}</strong>.
                <a href="#" onclick="openRouteModal('${src}','${dst}');return false" style="color:var(--accent)">Add one?</a>`;
            return;
        }
        const best = res.best_route;
        el.style.display = 'block';
        el.innerHTML = `<strong style="color:var(--green)"><i class="fas fa-check-circle"></i> Best Route for ${priority}</strong><br>
            <b>${best.name || best.source_city + ' → ' + best.destination_city}</b>
            <span class="route-score-badge">Score: ${best.score}</span><br>
            Distance: <b>${best.distance_km} km</b> &nbsp;|&nbsp;
            ETA: <b>${best.estimated_hours} hrs</b> &nbsp;|&nbsp;
            Tolls: <b>₹${best.toll_cost_inr}</b> &nbsp;|&nbsp;
            Traffic: <b>${best.traffic_factor}x</b><br>
            <small style="color:var(--text-muted)">Via: ${best.via_cities || 'Direct'} | Mode: ${best.transport_mode}</small>
            ${res.data.length > 1 ? `<br><small style="color:var(--text-secondary)">${res.data.length} alternative routes checked</small>` : ''}`;
    } catch (e) { showToast('Optimizer error: ' + e.message, 'error'); }
}

function openRouteModal(src = '', dst = '') {
    const cityOpts = CITIES.map(c => `<option ${c === src ? 'selected' : ''}>${c}</option>`).join('');
    const dstOpts = CITIES.map(c => `<option ${c === dst ? 'selected' : ''}>${c}</option>`).join('');
    const html = `<div class="modal-form">

        <div class="mf-section-label"><i class="fas fa-tag"></i> Route Identity</div>
        <div class="form-group">
            <label>Route Name</label>
            <input id="rtName" placeholder="e.g. Chennai–Mumbai Express">
        </div>
        <div class="mf-row2">
            <div class="form-group">
                <label><i class="fas fa-map-marker-alt" style="color:var(--green)"></i> From City</label>
                <select id="rtSrc"><option value="">Select city...</option>${cityOpts}</select>
            </div>
            <div class="form-group">
                <label><i class="fas fa-map-marker-alt" style="color:var(--red)"></i> To City</label>
                <select id="rtDst"><option value="">Select city...</option>${dstOpts}</select>
            </div>
        </div>

        <div class="mf-divider"></div>
        <div class="mf-section-label"><i class="fas fa-tachometer-alt"></i> Distance & Time</div>
        <div class="mf-row2">
            <div class="form-group">
                <label>Distance (km)</label>
                <input id="rtDist" type="number" min="0" placeholder="e.g. 1337">
            </div>
            <div class="form-group">
                <label>ETA (hrs)</label>
                <input id="rtEta" type="number" min="0" placeholder="e.g. 18">
            </div>
        </div>

        <div class="mf-divider"></div>
        <div class="mf-section-label"><i class="fas fa-rupee-sign"></i> Cost & Conditions</div>
        <div class="mf-row2">
            <div class="form-group">
                <label>Toll Cost (₹)</label>
                <input id="rtToll" type="number" min="0" placeholder="e.g. 2800">
            </div>
            <div class="form-group">
                <label>Traffic Factor</label>
                <input id="rtTf" type="number" step="0.1" min="1" max="3" placeholder="e.g. 1.2">
            </div>
        </div>
        <div class="mf-row2">
            <div class="form-group">
                <label>Via Cities <span style="color:var(--text-muted);font-size:10px">(comma-separated)</span></label>
                <input id="rtVia" placeholder="e.g. Nagpur, Pune">
            </div>
            <div class="form-group">
                <label>Transport Mode</label>
                <select id="rtMode">
                    <option value="road">🛣️ Road</option>
                    <option value="rail">🚂 Rail</option>
                    <option value="air">✈️ Air</option>
                    <option value="sea">🚢 Sea</option>
                </select>
            </div>
        </div>

        <div class="mf-divider"></div>
        <button class="btn-primary mf-submit" onclick="submitRoute()">
            <i class="fas fa-plus"></i> Add Route
        </button>
    </div>`;
    showGenericModal('<i class="fas fa-route" style="color:var(--accent)"></i> Add Route', html);
}

async function submitRoute() {
    const body = {
        name: document.getElementById('rtName')?.value,
        source_city: document.getElementById('rtSrc')?.value,
        destination_city: document.getElementById('rtDst')?.value,
        distance_km: +document.getElementById('rtDist')?.value || 0,
        estimated_hours: +document.getElementById('rtEta')?.value || 0,
        toll_cost_inr: +document.getElementById('rtToll')?.value || 0,
        traffic_factor: +document.getElementById('rtTf')?.value || 1.0,
        via_cities: document.getElementById('rtVia')?.value,
        transport_mode: document.getElementById('rtMode')?.value || 'road',
    };
    if (!body.source_city || !body.destination_city) { showToast('Select cities', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/routes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast('Route added!', 'success'); closeGenericModal(); loadRoutes(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteRoute(rid) {
    const route = _routesData.find(r => r.id === rid);
    const label = route ? (route.name || `${route.source_city} → ${route.destination_city}`) : String(rid);
    showDeleteConfirm({
        title: 'Delete Route',
        subtitle: label,
        confirmName: label,
        warningLines: [
            'Vehicles and dispatches assigned to this route will lose their route reference.',
            'This action cannot be undone.',
        ],
        onConfirm: async () => {
            try {
                await fetch(`${API_BASE}/api/routes/${rid}`, { method: 'DELETE' });
                showToast('Route deleted', 'success'); loadRoutes();
            } catch (e) { showToast(e.message, 'error'); }
        }
    });
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 3 – Warehouse Management
// ══════════════════════════════════════════════════════════════
let _activeWhId = null;

async function loadWarehouses() {
    try {
        const res = await fetch(`${API_BASE}/api/warehouses`).then(r => r.json());
        const grid = document.getElementById('warehouseGrid'); if (!grid) return;
        if (!res.success || !Array.isArray(res.data)) {
            showToast('Could not refresh warehouses', 'warn'); return;
        }
        const data = res.data;
        if (!data.length) {
            grid.innerHTML = `<div style="color:var(--text-secondary);padding:20px">
                No warehouses. Click <strong>Add Warehouse</strong> to create one.</div>`;
            return;
        }
        grid.innerHTML = data.map(wh => {
            const usedPct = wh.total_capacity_cbm > 0
                ? Math.min(100, Math.round((wh.used_capacity_cbm || 0) / wh.total_capacity_cbm * 100)) : 0;
            return `<div class="wh-card${wh.is_hub ? ' hub' : ''}" onclick="openWarehouseInventory('${wh.id}','${wh.name}')">
                <div class="wh-card-header">
                    <div>
                        <div class="wh-name">${wh.name}</div>
                        <div class="wh-city"><i class="fas fa-map-marker-alt"></i> ${wh.city || '—'}</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px">
                        ${wh.is_hub ? '<span class="wh-hub-badge">HUB</span>' : ''}
                        <button class="btn-sm" style="color:var(--red);border-color:var(--red);padding:2px 7px"
                            onclick="event.stopPropagation();deleteWarehouse('${wh.id}','${wh.name}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="wh-capacity-bar">
                    <div class="wh-capacity-fill" style="width:${usedPct}%"></div>
                </div>
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
                    ${usedPct}% used — ${wh.used_capacity_cbm || 0} / ${wh.total_capacity_cbm || 0} cbm
                </div>
                <div class="wh-stats">
                    <div class="wh-stat-item"><span>${wh.inventory_count || 0}</span> items stored</div>
                    <div class="wh-stat-item"><span>${wh.zones?.length || 0}</span> zones</div>
                    <div class="wh-stat-item"><i class="fas fa-user" style="color:var(--text-muted)"></i> ${wh.manager_name || '—'}</div>
                </div>
            </div>`;
        }).join('');
    } catch (e) { showToast('Warehouse error: ' + e.message, 'error'); }
}

async function deleteWarehouse(wid, name) {
    showDeleteConfirm({
        title: 'Delete Warehouse',
        subtitle: `${name} — ${wid}`,
        confirmName: name,
        warningLines: [
            'All inventory records stored in this warehouse will be permanently deleted.',
            'All zone configurations for this warehouse will be removed.',
            'This action cannot be undone.',
        ],
        onConfirm: async () => {
            try {
                const res = await fetch(`${API_BASE}/api/warehouses/${wid}`, { method: 'DELETE' }).then(r => r.json());
                if (res.success) {
                    showToast(`Warehouse "${name}" deleted`, 'success');
                    if (typeof _activeWhId !== 'undefined' && _activeWhId === wid) {
                        _activeWhId = null;
                        const inv = document.getElementById('inventorySection');
                        if (inv) inv.style.display = 'none';
                    }
                    loadWarehouses();
                } else {
                    showToast(res.error || 'Delete failed', 'error');
                }
            } catch (e) { showToast(e.message, 'error'); }
        }
    });
}

async function openWarehouseInventory(wid, name) {
    _activeWhId = wid;
    document.getElementById('activeWhName').textContent = name;
    document.getElementById('inventorySection').style.display = 'block';
    await loadInventory(wid);
}

async function loadInventory(wid) {
    try {
        const res = await fetch(`${API_BASE}/api/warehouses/${wid}/inventory`).then(r => r.json());
        const tbody = document.getElementById('inventoryTableBody'); if (!tbody) return;
        const data = res.data || [];
        if (!data.length) { tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No inventory items</td></tr>'; return; }
        tbody.innerHTML = data.map(i => `<tr>
            <td>${i.goods_type || '—'}</td>
            <td style="font-family:var(--font-mono);color:var(--accent)">${i.order_id || '—'}</td>
            <td>${i.quantity}</td>
            <td>${i.unit || '—'}</td>
            <td>${formatDateShort(i.inbound_at)}</td>
            <td><span class="pill ${i.status === 'stored' ? 'delivered' : 'in-transit'}">${i.status}</span></td>
            <td style="display:flex;gap:6px;align-items:center">
                ${i.status === 'stored' ? `<button class="btn-sm" onclick="markOutbound(${i.id})">Dispatch</button>` : '<span style="color:var(--text-muted)">—</span>'}
                <button class="btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deleteInventoryItem(${i.id},'${(i.goods_type || 'item').replace(/'/g, '')}')"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`).join('');
    } catch (e) { showToast('Inventory error: ' + e.message, 'error'); }
}

async function markOutbound(iid) {
    if (!_activeWhId) return;
    try {
        await fetch(`${API_BASE}/api/warehouses/${_activeWhId}/inventory/${iid}/outbound`, { method: 'PUT' });
        showToast('Marked as dispatched', 'success'); loadInventory(_activeWhId);
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteInventoryItem(iid, label) {
    if (!_activeWhId) return;
    const whId = _activeWhId;
    showDeleteConfirm({
        title: 'Delete Inventory Item',
        subtitle: label,
        confirmName: label,
        warningLines: [
            'This item will be permanently removed from inventory.',
            'Capacity usage on the warehouse will be adjusted accordingly.',
            'This action cannot be undone.',
        ],
        onConfirm: async () => {
            try {
                const res = await fetch(`${API_BASE}/api/warehouses/${whId}/inventory/${iid}`, { method: 'DELETE' }).then(r => r.json());
                if (res.success) {
                    showToast(`Item "${label}" deleted`, 'success');
                    loadInventory(whId);
                    loadWarehouses();
                } else {
                    showToast(res.error || 'Delete failed', 'error');
                }
            } catch (e) { showToast(e.message, 'error'); }
        }
    });
}

async function loadStockCount() {
    if (!_activeWhId) return;
    try {
        const res = await fetch(`${API_BASE}/api/warehouses/${_activeWhId}/stock-count`).then(r => r.json());
        const el = document.getElementById('stockCountResult'); if (!el) return;
        const data = res.data || [];
        el.style.display = 'block';
        el.innerHTML = `<div class="optimizer-card"><h3><i class="fas fa-calculator"></i> Stock Count</h3>
            <table class="data-table"><thead><tr><th>Goods Type</th><th>Total Qty</th><th>Unit</th><th>Lines</th></tr></thead>
            <tbody>${data.map(r => `<tr><td>${r.goods_type || '—'}</td><td><strong>${r.total_qty}</strong></td><td>${r.unit || '—'}</td><td>${r.line_items}</td></tr>`).join('')}</tbody>
            </table></div>`;
    } catch (e) { showToast(e.message, 'error'); }
}

function openInboundModal() {
    const html = `<div class="modal-form">
        <div class="form-group"><label>Order ID (optional)</label><input id="ibOrderId" placeholder="e.g. AHE1417"></div>
        <div class="form-group"><label>Goods Type</label><input id="ibGoods" placeholder="e.g. Electronics"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Quantity</label><input id="ibQty" type="number" placeholder="0"></div>
            <div class="form-group"><label>Unit</label><input id="ibUnit" placeholder="e.g. pcs"></div>
        </div>
        <div class="form-group"><label>Volume (cbm)</label><input id="ibCbm" type="number" step="0.01" placeholder="0"></div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitInbound()">
            <i class="fas fa-arrow-down"></i> Record Inbound</button>
    </div>`;
    showGenericModal('Inbound Goods', html);
}

async function submitInbound() {
    if (!_activeWhId) return;
    const body = {
        order_id: document.getElementById('ibOrderId')?.value || null,
        goods_type: document.getElementById('ibGoods')?.value,
        quantity: +document.getElementById('ibQty')?.value || 0,
        unit: document.getElementById('ibUnit')?.value,
        cbm: +document.getElementById('ibCbm')?.value || 0,
    };
    if (!body.goods_type) { showToast('Enter goods type', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/warehouses/${_activeWhId}/inventory/inbound`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast('Goods recorded inbound!', 'success'); closeGenericModal(); loadInventory(_activeWhId); loadWarehouses(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

function openWarehouseModal() {
    const html = `<div class="modal-form">
        <div class="form-group"><label>Warehouse Name</label><input id="whName" placeholder="e.g. Chennai Hub"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>City</label><input id="whCity" placeholder="City"></div>
            <div class="form-group"><label>Is Hub?</label>
                <select id="whHub"><option value="0">No</option><option value="1">Yes</option></select></div>
        </div>
        <div class="form-group"><label>Location Address</label><input id="whLoc" placeholder="Address"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Total Capacity (cbm)</label><input id="whCap" type="number" placeholder="0"></div>
            <div class="form-group"><label>Manager Name</label><input id="whMgr" placeholder="Name"></div>
        </div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitWarehouse()">
            <i class="fas fa-warehouse"></i> Add Warehouse</button>
    </div>`;
    showGenericModal('Add Warehouse', html);
}

async function submitWarehouse() {
    const body = {
        name: document.getElementById('whName')?.value.trim(),
        city: document.getElementById('whCity')?.value.trim(),
        location: document.getElementById('whLoc')?.value.trim(),
        total_capacity_cbm: +document.getElementById('whCap')?.value || 0,
        manager_name: document.getElementById('whMgr')?.value.trim(),
        is_hub: +document.getElementById('whHub')?.value || 0,
    };
    if (!body.name) { showToast('Enter warehouse name', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/warehouses`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success && res.id) {
            showToast(`Warehouse "${body.name}" added!`, 'success');
            closeGenericModal();
            await loadWarehouses();
        } else {
            showToast(res.error || 'Failed to add warehouse', 'error');
        }
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 4 – Load Planning
// ══════════════════════════════════════════════════════════════
let _lpPendingOrders = [];

async function loadLoadPlans() {
    try {
        const [plansRes, vehiclesRes, ordersRes] = await Promise.all([
            fetch(`${API_BASE}/api/load-plans`).then(r => r.json()),
            fetch(`${API_BASE}/api/dispatch/available-vehicles`).then(r => r.json()),
            fetch(`${API_BASE}/api/dispatch/pending-orders`).then(r => r.json()),
        ]);
        _lpPendingOrders = ordersRes.data || [];
        renderLoadPlansTable(plansRes.data || []);
        populateLpVehicleSelect(vehiclesRes.data || []);
    } catch (e) { showToast('Load plans error: ' + e.message, 'error'); }
}

function populateLpVehicleSelect(vehicles) {
    const el = document.getElementById('lpVehicle'); if (!el) return;
    el.innerHTML = '<option value="">Select Vehicle...</option>' +
        vehicles.map(v => `<option value="${v.id}" data-cap="${v.capacity_tons || 20}" data-cbm="${v.capacity_cbm || 80}">
            ${v.id} — ${v.vehicle_number || ''} (${v.capacity_tons || '?'}T)
        </option>`).join('');
}

function renderLoadPlansTable(plans) {
    const tbody = document.getElementById('loadPlansTableBody'); if (!tbody) return;
    if (!plans.length) { tbody.innerHTML = '<tr><td colspan="9" class="loading-row">No load plans yet — use the optimizer above</td></tr>'; return; }
    tbody.innerHTML = plans.map(p => `<tr>
        <td style="font-family:var(--font-mono);color:var(--accent)">#${p.id}</td>
        <td>${p.vehicle_id}</td>
        <td>${p.driver_name || '—'}</td>
        <td>${formatDateShort(p.trip_date)}</td>
        <td>${(p.total_weight_kg || 0).toLocaleString()} kg</td>
        <td>${(p.total_volume_cbm || 0).toFixed(2)} cbm</td>
        <td>
            <div class="util-bar-wrap">
                <div class="util-bar"><div class="util-bar-fill${(p.utilization_pct || 0) > 100 ? ' over' : ''}" style="width:${Math.min(100, p.utilization_pct || 0)}%"></div></div>
                <span style="font-size:11px;font-family:var(--font-mono)">${(p.utilization_pct || 0).toFixed(1)}%</span>
            </div>
        </td>
        <td><span class="pill ${p.status === 'Optimized' ? 'delivered' : 'in-transit'}">${p.status}</span></td>
        <td><button class="btn-sm" onclick="showPlanDetail(${p.id})">View</button></td>
    </tr>`).join('');
}

async function runLoadOptimizer() {
    const vid = document.getElementById('lpVehicle')?.value;
    if (!vid) { showToast('Select a vehicle first', 'warn'); return; }
    if (!_lpPendingOrders.length) { showToast('No pending orders to plan', 'warn'); return; }
    const sel = document.getElementById('lpOrderSelector');
    const list = document.getElementById('lpOrderList');
    if (!sel || !list) return;
    sel.style.display = 'block';
    list.innerHTML = _lpPendingOrders.map(o => `
        <label class="lp-order-item">
            <input type="checkbox" name="lpOrder" value="${o.id}" checked>
            <span><strong style="color:var(--accent)">${o.id}</strong> — ${o.customer_name || '—'}</span>
            <span style="margin-left:auto;color:var(--text-muted)">${o.source_city}→${o.destination_city}</span>
            <span>${o.weight_kg || '?'} kg</span>
        </label>`).join('');
}

async function submitLoadPlan() {
    const vid = document.getElementById('lpVehicle')?.value;
    const date = document.getElementById('lpDate')?.value || new Date().toISOString().split('T')[0];
    const boxes = document.querySelectorAll('input[name="lpOrder"]:checked');
    const orderIds = [...boxes].map(b => b.value);
    if (!vid || !orderIds.length) { showToast('Select a vehicle and at least one order', 'warn'); return; }
    try {
        const body = { vehicle_id: vid, trip_date: date, order_ids: orderIds };
        const res = await fetch(`${API_BASE}/api/load-plans/optimize`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        const el = document.getElementById('lpResult');
        if (res.success && el) {
            el.style.display = 'block';
            el.innerHTML = `<strong style="color:var(--green)"><i class="fas fa-check-circle"></i> Load Plan #${res.plan_id} Created</strong><br>
                ${res.items.length} shipments | ${(res.total_weight_kg || 0).toFixed(0)} kg | ${(res.total_volume_cbm || 0).toFixed(2)} cbm |
                <strong>${(res.utilization_pct || 0).toFixed(1)}% utilization</strong>`;
            showToast(`Plan #${res.plan_id} optimized!`, 'success');
            loadLoadPlans();
        }
    } catch (e) { showToast(e.message, 'error'); }
}

async function showPlanDetail(pid) {
    try {
        const res = await fetch(`${API_BASE}/api/load-plans/${pid}`).then(r => r.json());
        const p = res.data;
        const html = `<div class="modal-form">
            <p style="color:var(--text-secondary);margin-bottom:12px">Vehicle: <strong>${p.vehicle_id}</strong> | Weight: <strong>${p.total_weight_kg} kg</strong> | Utilization: <strong>${p.utilization_pct}%</strong></p>
            <table class="data-table"><thead><tr><th>#</th><th>Order ID</th><th>Weight (kg)</th><th>Volume (cbm)</th></tr></thead>
            <tbody>${(p.items || []).map(i => `<tr><td>${i.sequence}</td><td style="color:var(--accent)">${i.order_id}</td><td>${i.weight_kg}</td><td>${i.volume_cbm}</td></tr>`).join('')}</tbody>
            </table></div>`;
        showGenericModal(`Load Plan #${pid}`, html);
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 5 – Dispatch System
// ══════════════════════════════════════════════════════════════
let _selectedDispatchOrder = null;

async function loadDispatches() {
    try {
        const [pendRes, vehRes, dispRes] = await Promise.all([
            fetch(`${API_BASE}/api/dispatch/pending-orders`).then(r => r.json()),
            fetch(`${API_BASE}/api/dispatch/available-vehicles`).then(r => r.json()),
            fetch(`${API_BASE}/api/dispatch`).then(r => r.json()),
        ]);
        renderPendingOrders(pendRes.data || []);
        renderAvailableVehicles(vehRes.data || []);
        renderDispatchHistory(dispRes.data || []);
    } catch (e) { showToast('Dispatch error: ' + e.message, 'error'); }
}

function renderPendingOrders(orders) {
    const el = document.getElementById('pendingOrdersList'); if (!el) return;
    if (!orders.length) {
        el.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:12px">No pending orders.</div>'; return;
    }
    el.innerHTML = orders.map(o => {
        const tierCls = (o.priority_tier || 'economy').toLowerCase();
        return `<div class="dp-order-item${_selectedDispatchOrder === o.id ? ' selected' : ''}" onclick="selectDispatchOrder('${o.id}','${o.source_city}→${o.destination_city}')">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
                <div class="dp-order-id">${o.id}</div>
                <span class="dp-priority ${tierCls}">${o.priority_tier || 'Economy'}</span>
            </div>
            <div class="dp-order-route">${o.source_city} → ${o.destination_city}</div>
            <div class="dp-order-meta">
                <span>${o.goods_type || '—'}</span>
                <span>${o.quantity || '?'} units</span>
                ${o.weight_kg ? `<span>${o.weight_kg} kg</span>` : ''}
                ${o.distance_km ? `<span>${o.distance_km} km</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

function selectDispatchOrder(id, route) {
    _selectedDispatchOrder = id;
    const inp = document.getElementById('dpOrderId');
    if (inp) inp.value = `${id} (${route})`;
    document.querySelectorAll('.dp-order-item').forEach(el =>
        el.classList.toggle('selected', el.querySelector('.dp-order-id')?.textContent === id)
    );
}

function renderAvailableVehicles(vehicles) {
    const sel = document.getElementById('dpVehicle'); if (!sel) return;
    sel.innerHTML = '<option value="">Select idle vehicle...</option>' +
        vehicles.map(v => `<option value="${v.id}">${v.id} — ${v.driver_name || '—'} (${v.vehicle_number || ''})</option>`).join('');
}

function renderDispatchHistory(dispatches) {
    const el = document.getElementById('dispatchHistoryList'); if (!el) return;
    if (!dispatches.length) {
        el.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:12px">No recent dispatches.</div>'; return;
    }
    el.innerHTML = dispatches.slice(0, 30).map(d => `<div class="dp-dispatch-item">
        <div class="dp-dispatch-order-id">${d.order_id} → ${d.vehicle_id}</div>
        <div class="dp-dispatch-route">${d.source_city || '?'} → ${d.destination_city || '?'}</div>
        <div class="dp-dispatch-route" style="color:var(--text-muted);font-size:11px">${d.driver_name || '—'} | ${d.vehicle_number || '—'}</div>
        <div class="dp-dispatch-time"><span class="pill ${d.dispatch_status === 'Dispatched' ? 'delivered' : 'in-transit'}">${d.dispatch_status}</span> ${formatDateShort(d.dispatched_at)}</div>
    </div>`).join('');
}

async function submitDispatch() {
    const msg = document.getElementById('dpMsg');
    if (!_selectedDispatchOrder) { if (msg) msg.innerHTML = '<span style="color:var(--yellow)">Select a pending order first</span>'; return; }
    const vehicleId = document.getElementById('dpVehicle')?.value;
    if (!vehicleId) { if (msg) msg.innerHTML = '<span style="color:var(--yellow)">Select a vehicle</span>'; return; }
    const notes = document.getElementById('dpNotes')?.value || '';
    try {
        const res = await fetch(`${API_BASE}/api/dispatch`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_id: _selectedDispatchOrder, vehicle_id: vehicleId, notes })
        }).then(r => r.json());
        if (res.success) {
            if (msg) msg.innerHTML = `<span style="color:var(--green)"><i class="fas fa-check-circle"></i> Dispatched ${_selectedDispatchOrder} → ${vehicleId}</span>`;
            showToast(`Order ${_selectedDispatchOrder} dispatched to ${vehicleId}!`, 'success');
            _selectedDispatchOrder = null;
            document.getElementById('dpOrderId').value = '';
            document.getElementById('dpVehicle').value = '';
            document.getElementById('dpNotes').value = '';
            setTimeout(loadDispatches, 500);
        } else {
            if (msg) msg.innerHTML = `<span style="color:var(--red)">${res.error}</span>`;
        }
    } catch (e) { if (msg) msg.innerHTML = `<span style="color:var(--red)">${e.message}</span>`; }
}

// ══════════════════════════════════════════════════════════════
//  GENERIC MODAL helper (reused by all modules)
// ══════════════════════════════════════════════════════════════
function showGenericModal(title, bodyHtml) {
    let m = document.getElementById('genericModal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'genericModal';
        m.className = 'modal-overlay';
        m.innerHTML = `<div class="modal-box">
            <div class="modal-header"><h3 id="genericModalTitle"></h3>
                <button onclick="closeGenericModal()"><i class="fas fa-times"></i></button></div>
            <div class="modal-body" id="genericModalBody"></div>
        </div>`;
        document.body.appendChild(m);
    }
    document.getElementById('genericModalTitle').innerHTML = title;
    document.getElementById('genericModalBody').innerHTML = bodyHtml;
    m.style.display = 'flex';
}
function closeGenericModal() {
    const m = document.getElementById('genericModal'); if (m) m.style.display = 'none';
}

// ── Aesthetic delete-confirm modal (replaces browser confirm()) ───────────────
// Module-level slot for the pending delete callback
let _pendingDeleteFn = null;
function _executePendingDelete() {
    const modal = document.getElementById('deleteConfirmModal');
    if (modal) modal.remove();
    if (typeof _pendingDeleteFn === 'function') {
        _pendingDeleteFn();
        _pendingDeleteFn = null;
    }
}

function showDeleteConfirm({ title, subtitle, confirmName, warningLines = [], onConfirm }) {
    // Store callback in module scope — avoids closure loss from .toString()
    _pendingDeleteFn = onConfirm;

    const existing = document.getElementById('deleteConfirmModal');
    if (existing) existing.remove();

    const escaped = confirmName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const lines = warningLines.map(l =>
        `<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
            <i class="fas fa-exclamation-triangle" style="color:var(--red);margin-top:2px;flex-shrink:0;font-size:11px"></i>
            <span style="color:var(--text-secondary);font-size:12px">${l}</span>
        </div>`
    ).join('');

    const overlay = document.createElement('div');
    overlay.id = 'deleteConfirmModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(9,12,16,0.92);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
        <div style="background:var(--bg-panel);border:1px solid #3d1a1a;border-top:2px solid var(--red);border-radius:10px;width:420px;max-width:94vw;box-shadow:0 0 60px rgba(255,68,68,0.12),0 20px 60px rgba(0,0,0,0.8)">
            <div style="padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2a1a1a">
                <div style="display:flex;align-items:center;gap:10px">
                    <div style="width:32px;height:32px;border-radius:50%;background:rgba(255,68,68,0.12);border:1px solid rgba(255,68,68,0.3);display:flex;align-items:center;justify-content:center">
                        <i class="fas fa-trash" style="color:var(--red);font-size:13px"></i>
                    </div>
                    <div>
                        <div style="font-family:var(--font-display);font-weight:700;font-size:15px;color:var(--text-primary)">${title}</div>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${subtitle}</div>
                    </div>
                </div>
                <button onclick="document.getElementById('deleteConfirmModal').remove();_pendingDeleteFn=null;" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:4px"><i class="fas fa-times"></i></button>
            </div>
            <div style="padding:14px 20px 0">${lines}</div>
            <div style="padding:16px 20px">
                <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;line-height:1.5">
                    To confirm, type <span style="font-family:var(--font-mono);color:var(--red);background:rgba(255,68,68,0.08);padding:1px 6px;border-radius:3px;border:1px solid rgba(255,68,68,0.2)">${confirmName}</span> below:
                </div>
                <input id="deleteConfirmInput" placeholder="Type to confirm…" autocomplete="off"
                    style="width:100%;box-sizing:border-box;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:9px 12px;color:var(--text-primary);font-family:var(--font-mono);font-size:13px;outline:none;transition:border-color .2s"
                    oninput="const match=this.value==='${escaped}';const btn=document.getElementById('deleteConfirmBtn');btn.disabled=!match;btn.style.opacity=match?'1':'0.4';btn.style.cursor=match?'pointer':'not-allowed';this.style.borderColor=this.value.length===0?'var(--border)':match?'var(--red)':'var(--border)';"
                    onkeydown="if(event.key==='Enter'){const b=document.getElementById('deleteConfirmBtn');if(!b.disabled)_executePendingDelete();}if(event.key==='Escape'){document.getElementById('deleteConfirmModal').remove();_pendingDeleteFn=null;}"
                >
            </div>
            <div style="padding:0 20px 18px;display:flex;gap:10px">
                <button onclick="document.getElementById('deleteConfirmModal').remove();_pendingDeleteFn=null;"
                    style="flex:1;padding:9px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-secondary);cursor:pointer;font-family:var(--font-body);font-size:13px;transition:all .2s"
                    onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--text-primary)'"
                    onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-secondary)'">Cancel</button>
                <button id="deleteConfirmBtn" disabled onclick="_executePendingDelete()"
                    style="flex:1;padding:9px;background:rgba(255,68,68,0.1);border:1px solid var(--red);border-radius:var(--radius);color:var(--red);cursor:not-allowed;font-family:var(--font-body);font-size:13px;font-weight:600;opacity:0.4;transition:all .2s"
                    onmouseover="if(!this.disabled)this.style.background='rgba(255,68,68,0.2)'"
                    onmouseout="this.style.background='rgba(255,68,68,0.1)'">
                    <i class="fas fa-trash"></i> Delete
                </button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('deleteConfirmInput')?.focus(), 60);
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 6 – Driver Management
// ══════════════════════════════════════════════════════════════
let _allDrivers = [];

async function loadDriverMgmt() {
    try {
        const res = await fetch(`${API_BASE}/api/drivers`).then(r => r.json());
        _allDrivers = res.data || [];
        renderDriverMgmtStats(_allDrivers);
        renderDriverMgmtTable();
    } catch (e) { showToast('Driver load error: ' + e.message, 'error'); }
}

function renderDriverMgmtStats(data) {
    const el = document.getElementById('driverMgmtStats'); if (!el) return;
    const avail = data.filter(d => d.availability === 'Available').length;
    const busy = data.filter(d => d.availability === 'Busy').length;
    const avgRating = data.length ? (data.reduce((s, d) => s + (d.rating || 5), 0) / data.length).toFixed(1) : '—';
    el.innerHTML = [
        ['fas fa-users', 'var(--accent)', data.length, 'Total Drivers'],
        ['fas fa-check-circle', 'var(--green)', avail, 'Available'],
        ['fas fa-truck-moving', 'var(--orange)', busy, 'Busy'],
        ['fas fa-star', 'var(--yellow)', avgRating, 'Avg Rating'],
    ].map(([ic, col, val, lab]) =>
        `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
         <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
    ).join('');
}

function renderDriverMgmtTable() {
    const search = (document.getElementById('driverMgmtSearch')?.value || '').toLowerCase();
    const tbody = document.getElementById('driverMgmtTableBody'); if (!tbody) return;
    let data = _allDrivers;
    if (search) data = data.filter(d =>
        [d.id, d.name, d.contact, d.license_number, d.vehicle_number].some(f => (f || '').toLowerCase().includes(search))
    );
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="11" class="loading-row">No drivers found</td></tr>'; return; }
    tbody.innerHTML = data.map(d => {
        const stars = '★'.repeat(Math.round(d.rating || 5)) + '☆'.repeat(5 - Math.round(d.rating || 5));
        const licCls = expiryClass(d.license_expiry);
        return `<tr>
            <td style="font-family:var(--font-mono);color:var(--accent)">${d.id}</td>
            <td><strong>${d.name}</strong></td>
            <td>${d.contact || '—'}</td>
            <td style="font-family:var(--font-mono)">${d.license_number || '—'}</td>
            <td>${d.license_type || '—'}</td>
            <td><span class="${licCls}">${d.license_expiry || '—'}</span></td>
            <td>${d.vehicle_number ? `<span style="font-family:var(--font-mono)">${d.vehicle_number}</span>` : '<span style="color:var(--text-muted)">Unassigned</span>'}</td>
            <td><span class="avail-badge ${d.availability || 'Available'}">${d.availability || 'Available'}</span></td>
            <td><span class="driver-stars" title="${d.rating}">${stars}</span></td>
            <td>${(d.working_hours_today || 0).toFixed(1)} hrs</td>
            <td>
                <button class="btn-sm" onclick="openRateDriverModal('${d.id}','${d.name}')">Rate</button>
                <button class="btn-sm" onclick="openEditDriverModal(${JSON.stringify(d).replace(/"/g, '&quot;')})">Edit</button>
            </td>
        </tr>`;
    }).join('');
}

function openAddDriverModal() {
    const html = `<div class="modal-form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Full Name*</label><input id="dnName" placeholder="Driver name"></div>
            <div class="form-group"><label>Contact</label><input id="dnContact" placeholder="Phone number"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>License Number</label><input id="dnLic" placeholder="DL Number"></div>
            <div class="form-group"><label>License Type</label>
                <select id="dnLicType"><option>LMV</option><option>HMV</option><option>LMV-TR</option><option>HMV-TR</option></select></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>License Expiry</label><input id="dnLicExp" type="date"></div>
            <div class="form-group"><label>Joined Date</label><input id="dnJoined" type="date"></div>
        </div>
        <div class="form-group"><label>Address</label><input id="dnAddr" placeholder="Home address"></div>
        <div class="form-group"><label>Emergency Contact</label><input id="dnEmerg" placeholder="Emergency contact"></div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitAddDriver()">
            <i class="fas fa-user-plus"></i> Add Driver</button>
    </div>`;
    showGenericModal('Add Driver', html);
}

async function submitAddDriver() {
    const body = {
        name: document.getElementById('dnName')?.value.trim(),
        contact: document.getElementById('dnContact')?.value,
        license_number: document.getElementById('dnLic')?.value,
        license_type: document.getElementById('dnLicType')?.value,
        license_expiry: document.getElementById('dnLicExp')?.value,
        joined_date: document.getElementById('dnJoined')?.value,
        address: document.getElementById('dnAddr')?.value,
        emergency_contact: document.getElementById('dnEmerg')?.value,
    };
    if (!body.name) { showToast('Name is required', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/drivers`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast(`Driver ${body.name} added (${res.driver_id})`, 'success'); closeGenericModal(); loadDriverMgmt(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

function openRateDriverModal(did, name) {
    const html = `<div class="modal-form">
        <p style="color:var(--text-secondary);margin-bottom:12px">Rate performance for <strong>${name}</strong></p>
        <div class="form-group"><label>Rating (1–5)</label>
            <input id="dRating" type="range" min="1" max="5" step="0.5" value="4" style="width:100%"
                oninput="document.getElementById('dRatingVal').textContent=this.value">
        </div>
        <div style="text-align:center;font-size:28px;color:var(--yellow)" id="dRatingVal">4</div>
        <button class="btn-primary" style="width:100%;margin-top:12px" onclick="submitRating('${did}')">
            <i class="fas fa-star"></i> Submit Rating</button>
    </div>`;
    showGenericModal(`Rate Driver`, html);
}

async function submitRating(did) {
    const rating = +document.getElementById('dRating')?.value || 4;
    try {
        await fetch(`${API_BASE}/api/drivers/${did}/rate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating })
        });
        showToast('Rating submitted!', 'success'); closeGenericModal(); loadDriverMgmt();
    } catch (e) { showToast(e.message, 'error'); }
}

function openEditDriverModal(d) {
    const html = `<div class="modal-form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Availability</label>
                <select id="edAvail">
                    <option ${d.availability === 'Available' ? 'selected' : ''}>Available</option>
                    <option ${d.availability === 'Busy' ? 'selected' : ''}>Busy</option>
                    <option ${d.availability === 'Off' ? 'selected' : ''}>Off</option>
                </select></div>
            <div class="form-group"><label>Contact</label><input id="edContact" value="${d.contact || ''}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>License Expiry</label><input id="edLicExp" type="date" value="${d.license_expiry || ''}"></div>
            <div class="form-group"><label>Hours Today</label><input id="edHrs" type="number" step="0.5" value="${d.working_hours_today || 0}"></div>
        </div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitEditDriver('${d.id}')">
            <i class="fas fa-save"></i> Save Changes</button>
    </div>`;
    showGenericModal(`Edit — ${d.name}`, html);
}

async function submitEditDriver(did) {
    const body = {
        availability: document.getElementById('edAvail')?.value,
        contact: document.getElementById('edContact')?.value,
        license_expiry: document.getElementById('edLicExp')?.value,
        working_hours_today: +document.getElementById('edHrs')?.value || 0,
    };
    try {
        await fetch(`${API_BASE}/api/drivers/${did}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        showToast('Driver updated', 'success'); closeGenericModal(); loadDriverMgmt();
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 7 – Proof of Delivery
// ══════════════════════════════════════════════════════════════
async function loadPOD() {
    const status = document.getElementById('podStatusFilter')?.value || '';
    try {
        const res = await fetch(`${API_BASE}/api/pod${status ? '?status=' + status : ''}`).then(r => r.json());
        const data = res.data || [];
        // Stats
        const el = document.getElementById('podStatsRow');
        if (el) {
            const collected = data.filter(d => d.pod_status === 'Collected').length;
            const pending = data.filter(d => !d.pod_status || d.pod_status === 'Pending').length;
            el.innerHTML = [
                ['fas fa-clipboard-check', 'var(--green)', collected, 'POD Collected'],
                ['fas fa-clock', 'var(--yellow)', pending, 'POD Pending'],
                ['fas fa-boxes', 'var(--accent)', data.length, 'Total Shown'],
            ].map(([ic, col, val, lab]) =>
                `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
                 <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
            ).join('');
        }
        const tbody = document.getElementById('podTableBody'); if (!tbody) return;
        tbody.innerHTML = data.map(o => `<tr>
            <td style="font-family:var(--font-mono);color:var(--accent)">${o.order_id}</td>
            <td>${o.customer_name || '—'}</td>
            <td>${o.source_city} → ${o.destination_city}</td>
            <td><span class="pill ${o.order_status === 'Delivered' ? 'delivered' : 'in-transit'}">${o.order_status}</span></td>
            <td>${o.pod_type || '—'}</td>
            <td style="font-family:var(--font-mono)">${o.pod_reference || '—'}</td>
            <td>${formatDateShort(o.pod_collected_at)}</td>
            <td style="font-family:var(--font-mono)">${o.vehicle_id || '—'}</td>
            <td>${!o.pod_status || o.pod_status === 'Pending'
                ? `<button class="btn-sm" style="color:var(--green)" onclick="openPODModal('${o.order_id}','${o.customer_name?.replace(/'/g, "\\'") || ''}')">Collect POD</button>`
                : '<span style="color:var(--green);font-size:12px"><i class="fas fa-check"></i> Done</span>'
            }</td>
        </tr>`).join('') || '<tr><td colspan="9" class="loading-row">No records</td></tr>';
    } catch (e) { showToast('POD error: ' + e.message, 'error'); }
}

function openPODModal(orderId, customerName) {
    const html = `<div class="modal-form">
        <p style="color:var(--text-secondary);margin-bottom:12px">Collecting POD for <strong>${orderId}</strong> — ${customerName}</p>
        <div class="form-group"><label>POD Type</label>
            <select id="podType">
                <option>Digital</option><option>Physical</option><option>E-Signature</option><option>Photo</option>
            </select></div>
        <div class="form-group"><label>Reference / Signature ID</label>
            <input id="podRef" placeholder="e.g. SIG-12345 or photo ref"></div>
        <div class="form-group"><label>Collection Date/Time</label>
            <input id="podCollectedAt" type="datetime-local" value="${new Date().toISOString().slice(0, 16)}"></div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitPOD('${orderId}')">
            <i class="fas fa-signature"></i> Confirm POD Collected</button>
    </div>`;
    showGenericModal('Collect Proof of Delivery', html);
}

async function submitPOD(orderId) {
    const body = {
        pod_type: document.getElementById('podType')?.value,
        pod_reference: document.getElementById('podRef')?.value,
        pod_collected_at: document.getElementById('podCollectedAt')?.value,
    };
    try {
        const res = await fetch(`${API_BASE}/api/pod/${orderId}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast(`POD collected for ${orderId}!`, 'success'); closeGenericModal(); loadPOD(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 8 – Shipment Lifecycle
// ══════════════════════════════════════════════════════════════
const LC_STAGES = ['Created', 'Picked Up', 'At Hub', 'In Transit', 'Out for Delivery', 'Delivered'];
const LC_ICONS = ['fa-plus-circle', 'fa-box', 'fa-warehouse', 'fa-truck', 'fa-motorcycle', 'fa-check-circle'];

async function loadAllLifecycles() {
    try {
        const res = await fetch(`${API_BASE}/api/lifecycle`).then(r => r.json());
        const tbody = document.getElementById('lifecycleTableBody'); if (!tbody) return;
        const data = res.data || [];
        tbody.innerHTML = data.map(o => {
            const stageIdx = LC_STAGES.indexOf(o.lifecycle_stage || 'Created');
            const pct = Math.round((stageIdx + 1) / LC_STAGES.length * 100);
            return `<tr>
                <td style="font-family:var(--font-mono);color:var(--accent)">${o.order_id}</td>
                <td>${o.customer_name || '—'}</td>
                <td>${o.source_city} → ${o.destination_city}</td>
                <td>
                    <div style="display:flex;align-items:center;gap:6px">
                        <div class="util-bar" style="width:60px"><div class="util-bar-fill" style="width:${pct}%"></div></div>
                        <span style="font-size:11px;color:var(--accent)">${o.lifecycle_stage || 'Created'}</span>
                    </div>
                </td>
                <td><span class="pill ${o.order_status === 'Delivered' ? 'delivered' : 'in-transit'}">${o.order_status}</span></td>
                <td>${formatDateShort(o.dispatch_datetime)}</td>
                <td>${formatDateShort(o.expected_delivery_datetime)}</td>
                <td><button class="btn-sm" onclick="trackLifecycleById('${o.order_id}')"><i class="fas fa-stream"></i> Track</button></td>
            </tr>`;
        }).join('') || '<tr><td colspan="8" class="loading-row">No orders</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function trackLifecycle() {
    const id = document.getElementById('lifecycleOrderId')?.value.trim();
    if (!id) { showToast('Enter an Order ID', 'warn'); return; }
    await trackLifecycleById(id);
}

async function trackLifecycleById(id) {
    try {
        const res = await fetch(`${API_BASE}/api/lifecycle/${id}`).then(r => r.json());
        if (!res.success) { showToast('Order not found', 'warn'); return; }
        const o = res.data;
        const info = document.getElementById('lifecycleOrderInfo');
        if (info) info.innerHTML = `<strong>${o.order_id}</strong> — ${o.customer_name} | ${o.source_city} → ${o.destination_city}`;

        const steps = document.getElementById('lifecycleSteps');
        if (steps) {
            steps.innerHTML = (o.stages || []).map((s, i) => `
                <div class="lc-step ${s.status}">
                    <div class="lc-dot"><i class="fas ${LC_ICONS[i] || 'fa-circle'}"></i></div>
                    <div class="lc-label">${s.name}</div>
                </div>`).join('');
        }

        const btns = document.getElementById('lifecycleAdvanceButtons');
        if (btns) {
            const currentIdx = LC_STAGES.indexOf(o.lifecycle_stage || 'Created');
            btns.innerHTML = LC_STAGES.slice(currentIdx + 1).map(s =>
                `<button class="btn-primary" style="font-size:12px;padding:6px 14px" onclick="advanceLifecycle('${o.order_id}','${s}')">
                    → ${s}</button>`).join('');
        }

        const tl = document.getElementById('lifecycleTimeline');
        if (tl) tl.style.display = 'block';
        if (document.getElementById('lifecycleOrderId')) document.getElementById('lifecycleOrderId').value = id;
    } catch (e) { showToast(e.message, 'error'); }
}

async function advanceLifecycle(orderId, stage) {
    try {
        const res = await fetch(`${API_BASE}/api/lifecycle/${orderId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage })
        }).then(r => r.json());
        if (res.success) { showToast(`Stage updated to "${stage}"`, 'success'); trackLifecycleById(orderId); loadAllLifecycles(); }
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 9 – Exception Handling
// ══════════════════════════════════════════════════════════════
async function loadIncidents() {
    const sev = document.getElementById('incidentSevFilter')?.value || '';
    try {
        const res = await fetch(`${API_BASE}/api/incidents${sev ? '?severity=' + sev : ''}`).then(r => r.json());
        const data = res.data || [];
        const el = document.getElementById('incidentStatsRow');
        if (el) {
            el.innerHTML = [
                ['fas fa-times-circle', 'var(--red)', data.filter(d => d.severity === 'High').length, 'High Severity'],
                ['fas fa-exclamation', 'var(--yellow)', data.filter(d => d.severity === 'Medium').length, 'Medium'],
                ['fas fa-info-circle', 'var(--text-muted)', data.filter(d => d.severity === 'Low').length, 'Low'],
                ['fas fa-check', 'var(--green)', data.filter(d => d.resolved_at).length, 'Resolved'],
            ].map(([ic, col, val, lab]) =>
                `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
                 <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
            ).join('');
        }
        const tbody = document.getElementById('incidentsTableBody'); if (!tbody) return;
        tbody.innerHTML = data.map(i => `<tr>
            <td style="font-family:var(--font-mono)">#${i.id}</td>
            <td>${i.incident_type || '—'}</td>
            <td style="color:var(--accent)">${i.order_id || '—'}</td>
            <td>${i.vehicle_id || '—'}</td>
            <td style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${i.description || ''}">${i.description || '—'}</td>
            <td>${i.location || '—'}</td>
            <td><span class="sev-${i.severity}">${i.severity}</span></td>
            <td>₹${(i.damage_value_inr || 0).toLocaleString('en-IN')}</td>
            <td>${i.claim_status || '—'}</td>
            <td>${formatDateShort(i.reported_at)}</td>
            <td>${i.resolved_at ? `<span style="color:var(--green)">${formatDateShort(i.resolved_at)}</span>` : '<span style="color:var(--yellow)">Pending</span>'}</td>
            <td>${!i.resolved_at ? `<button class="btn-sm" onclick="resolveIncident(${i.id})">Resolve</button>` : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="12" class="loading-row">No incidents</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function resolveIncident(iid) {
    try {
        await fetch(`${API_BASE}/api/incidents/${iid}/resolve`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claim_status: 'Resolved' })
        });
        showToast('Incident resolved', 'success'); loadIncidents();
    } catch (e) { showToast(e.message, 'error'); }
}

function openIncidentModal() {
    const html = `<div class="modal-form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Incident Type*</label>
                <select id="inType">
                    <option>Accident</option><option>Breakdown</option><option>Theft</option>
                    <option>Delay</option><option>Damage</option><option>Other</option>
                </select></div>
            <div class="form-group"><label>Severity</label>
                <select id="inSev"><option>High</option><option selected>Medium</option><option>Low</option></select></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Order ID</label><input id="inOrderId" placeholder="Optional"></div>
            <div class="form-group"><label>Vehicle ID</label><input id="inVehicleId" placeholder="Optional"></div>
        </div>
        <div class="form-group"><label>Location</label><input id="inLoc" placeholder="Where it happened"></div>
        <div class="form-group"><label>Description*</label>
            <input id="inDesc" placeholder="What happened?"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Damage Value (₹)</label><input id="inDmg" type="number" placeholder="0"></div>
            <div class="form-group"><label>Insured?</label>
                <select id="inInsured"><option value="1">Yes</option><option value="0" selected>No</option></select></div>
        </div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitIncident()">
            <i class="fas fa-exclamation-triangle"></i> Report Incident</button>
    </div>`;
    showGenericModal('Report Incident', html);
}

async function submitIncident() {
    const body = {
        incident_type: document.getElementById('inType')?.value,
        severity: document.getElementById('inSev')?.value,
        order_id: document.getElementById('inOrderId')?.value || null,
        vehicle_id: document.getElementById('inVehicleId')?.value || null,
        location: document.getElementById('inLoc')?.value,
        description: document.getElementById('inDesc')?.value,
        damage_value_inr: +document.getElementById('inDmg')?.value || 0,
        is_insured: +document.getElementById('inInsured')?.value,
    };
    if (!body.description) { showToast('Description required', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/incidents`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast(`Incident #${res.incident_id} reported!`, 'success'); closeGenericModal(); loadIncidents(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 10 – Cost Tracking
// ══════════════════════════════════════════════════════════════
async function loadCosts() {
    try {
        const res = await fetch(`${API_BASE}/api/costs`).then(r => r.json());
        const data = res.data || [];
        const totals = res.totals || {};
        const el = document.getElementById('costTotalsRow');
        if (el) {
            const fmtCr = v => v >= 10000000 ? (v / 10000000).toFixed(2) + ' Cr' : v >= 100000 ? (v / 100000).toFixed(1) + ' L' : (v || 0).toLocaleString('en-IN');
            el.innerHTML = [
                ['fas fa-truck', 'var(--accent)', fmtCr(totals.transport), 'Transport Revenue'],
                ['fas fa-gas-pump', 'var(--orange)', fmtCr(totals.fuel), 'Fuel Cost'],
                ['fas fa-road', 'var(--yellow)', fmtCr(totals.toll), 'Toll Cost'],
                ['fas fa-wrench', 'var(--purple)', fmtCr(totals.maintenance), 'Maintenance'],
            ].map(([ic, col, val, lab]) =>
                `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
                 <div><div class="fleet-stat-val">₹${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
            ).join('');
        }
        const tbody = document.getElementById('costsTableBody'); if (!tbody) return;
        tbody.innerHTML = data.map(o => `<tr>
            <td style="font-family:var(--font-mono);color:var(--accent)">${o.order_id}</td>
            <td>${o.customer_name || '—'}</td>
            <td>${o.source_city} → ${o.destination_city}</td>
            <td>${(o.transport_cost_inr || 0).toLocaleString('en-IN')}</td>
            <td>${(o.fuel_cost_inr || 0).toLocaleString('en-IN')}</td>
            <td>${(o.toll_cost_inr || 0).toLocaleString('en-IN')}</td>
            <td>${(o.maintenance_cost_inr || 0).toLocaleString('en-IN')}</td>
            <td>${(o.other_cost_inr || 0).toLocaleString('en-IN')}</td>
            <td><strong style="color:var(--accent)">₹${(o.total_cost_inr || 0).toLocaleString('en-IN')}</strong></td>
            <td><span class="pill ${o.order_status === 'Delivered' ? 'delivered' : 'in-transit'}">${o.order_status}</span></td>
            <td><button class="btn-sm" onclick="openCostEditModal('${o.order_id}')">Edit</button></td>
        </tr>`).join('') || '<tr><td colspan="11" class="loading-row">No data</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function loadCostSummary() {
    try {
        const res = await fetch(`${API_BASE}/api/costs/summary`).then(r => r.json());
        const sec = document.getElementById('costSummarySection');
        const tbody = document.getElementById('costSummaryBody');
        if (!sec || !tbody) return;
        sec.style.display = 'block';
        tbody.innerHTML = (res.data || []).map(r => `<tr>
            <td>${r.source_city} → ${r.destination_city}</td>
            <td>${r.trips}</td>
            <td>₹${(r.avg_total_inr || 0).toLocaleString('en-IN')}</td>
            <td><strong style="color:var(--green)">₹${(r.sum_total_inr || 0).toLocaleString('en-IN')}</strong></td>
        </tr>`).join('') || '<tr><td colspan="4" class="loading-row">No route data</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

function openCostEditModal(orderId) {
    const html = `<div class="modal-form">
        <p style="color:var(--text-secondary);margin-bottom:12px">Update costs for <strong style="color:var(--accent)">${orderId}</strong></p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Fuel Cost (₹)</label><input id="ceFuel" type="number" placeholder="0"></div>
            <div class="form-group"><label>Toll Cost (₹)</label><input id="ceToll" type="number" placeholder="0"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Maintenance (₹)</label><input id="ceMaint" type="number" placeholder="0"></div>
            <div class="form-group"><label>Other (₹)</label><input id="ceOther" type="number" placeholder="0"></div>
        </div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitCostUpdate('${orderId}')">
            <i class="fas fa-save"></i> Save Costs</button>
    </div>`;
    showGenericModal('Update Costs — ' + orderId, html);
}

async function submitCostUpdate(orderId) {
    const body = {
        fuel_cost_inr: +document.getElementById('ceFuel')?.value || 0,
        toll_cost_inr: +document.getElementById('ceToll')?.value || 0,
        maintenance_cost_inr: +document.getElementById('ceMaint')?.value || 0,
        other_cost_inr: +document.getElementById('ceOther')?.value || 0,
    };
    try {
        await fetch(`${API_BASE}/api/costs/${orderId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        showToast('Costs updated!', 'success'); closeGenericModal(); loadCosts();
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 11 – Vehicle Telemetry
// ══════════════════════════════════════════════════════════════
async function loadTelemetry() {
    try {
        const res = await fetch(`${API_BASE}/api/telemetry`).then(r => r.json());
        const tbody = document.getElementById('telemetryTableBody'); if (!tbody) return;
        const data = res.data || [];
        tbody.innerHTML = data.map(v => {
            const fuel = v.fuel_level_pct ?? 100;
            const fuelCls = fuel < 20 ? 'crit' : fuel < 40 ? 'warn' : '';
            const temp = v.engine_temp_c ?? 0;
            const tempCls = temp > 100 ? 'crit' : temp > 85 ? 'warn' : '';
            return `<tr>
                <td style="font-family:var(--font-mono);color:var(--accent)">${v.id}</td>
                <td>${v.vehicle_type || '—'}</td>
                <td style="font-family:var(--font-mono)">${v.vehicle_number || '—'}</td>
                <td>${v.driver_name || '—'}</td>
                <td><span class="pill ${v.status === 'moving' ? 'in-transit' : 'pending'}">${v.status}</span></td>
                <td>
                    <div class="telem-bar-wrap">
                        <div class="telem-bar"><div class="telem-bar-fill ${fuelCls}" style="width:${fuel}%"></div></div>
                        <span style="font-size:11px;font-family:var(--font-mono)">${fuel.toFixed(0)}%</span>
                    </div>
                </td>
                <td>
                    <div class="telem-bar-wrap">
                        <div class="telem-bar"><div class="telem-bar-fill ${tempCls}" style="width:${Math.min(100, (temp / 120) * 100)}%"></div></div>
                        <span style="font-size:11px;font-family:var(--font-mono)">${temp ? temp.toFixed(1) + '°C' : '—'}</span>
                    </div>
                </td>
                <td><span style="color:${v.engine_health === 'Good' ? 'var(--green)' : v.engine_health === 'Warning' ? 'var(--yellow)' : 'var(--red)'}">${v.engine_health || 'Good'}</span></td>
                <td>${v.current_speed ? v.current_speed.toFixed(0) + ' km/h' : '—'}</td>
                <td>${v.odometer_km ? (v.odometer_km).toLocaleString() + ' km' : '—'}</td>
                <td><button class="btn-sm" onclick="loadVehicleTelemetry('${v.id}')">Detail</button></td>
            </tr>`;
        }).join('') || '<tr><td colspan="11" class="loading-row">No vehicles</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function loadVehicleTelemetry(vid) {
    try {
        const res = await fetch(`${API_BASE}/api/telemetry/${vid}`).then(r => r.json());
        const sec = document.getElementById('telemDetailSection');
        const bdy = document.getElementById('telemDetailBody');
        const vidEl = document.getElementById('telemDetailVid');
        if (!sec || !bdy) return;
        sec.style.display = 'block';
        if (vidEl) vidEl.textContent = vid;
        const v = res.data;
        const fuelHist = res.fuel_history || [];
        bdy.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
                ${[['Fuel Level', (v.fuel_level_pct ?? 100).toFixed(0) + '%', 'fa-gas-pump', 'var(--orange)'],
            ['Engine Temp', v.engine_temp_c ? v.engine_temp_c.toFixed(1) + '°C' : '—', 'fa-thermometer-half', 'var(--red)'],
            ['Engine Health', v.engine_health || 'Good', 'fa-heartbeat', 'var(--green)'],
            ['Odometer', v.odometer_km ? (v.odometer_km).toLocaleString() + ' km' : '—', 'fa-tachometer-alt', 'var(--accent)']
            ].map(([l, val, ic, col]) =>
                `<div class="kpi-card"><div class="kpi-card-icon"><i class="fas ${ic}" style="color:${col}"></i></div>
                     <div class="kpi-card-val">${val}</div><div class="kpi-card-lbl">${l}</div></div>`
            ).join('')}
            </div>
            ${fuelHist.length ? `<table class="data-table"><thead><tr>
                <th>Liters</th><th>Cost (₹)</th><th>Odometer</th><th>Efficiency (km/L)</th><th>Date</th>
            </tr></thead><tbody>
                ${fuelHist.map(f => `<tr>
                    <td>${f.liters_consumed || '—'}</td>
                    <td>₹${f.cost_inr || '—'}</td>
                    <td>${f.odometer_km || '—'}</td>
                    <td>${f.fuel_efficiency_kmpl || '—'}</td>
                    <td>${formatDateShort(f.logged_at)}</td>
                </tr>`).join('')}
            </tbody></table>` : '<p style="color:var(--text-muted);font-size:12px">No fuel log history</p>'}`;
        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { showToast(e.message, 'error'); }
}

function openTelemUpdateModal() {
    const html = `<div class="modal-form">
        <div class="form-group"><label>Vehicle ID</label><input id="tmVid" placeholder="e.g. MH-TRK-001"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Fuel Level (%)</label><input id="tmFuel" type="number" min="0" max="100" placeholder="75"></div>
            <div class="form-group"><label>Engine Temp (°C)</label><input id="tmTemp" type="number" placeholder="80"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Engine Health</label>
                <select id="tmHealth"><option>Good</option><option>Warning</option><option>Critical</option></select></div>
            <div class="form-group"><label>Odometer (km)</label><input id="tmOdo" type="number" placeholder="0"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Fuel Consumed (L)</label><input id="tmFuelConsumed" type="number" step="0.1" placeholder="0"></div>
            <div class="form-group"><label>Efficiency (km/L)</label><input id="tmEfficiency" type="number" step="0.1" placeholder="0"></div>
        </div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitTelemUpdate()">
            <i class="fas fa-satellite-dish"></i> Update Telemetry</button>
    </div>`;
    showGenericModal('Update Telemetry Reading', html);
}

async function submitTelemUpdate() {
    const vid = document.getElementById('tmVid')?.value.trim();
    if (!vid) { showToast('Vehicle ID required', 'warn'); return; }
    const body = {
        fuel_level_pct: +document.getElementById('tmFuel')?.value || null,
        engine_temp_c: +document.getElementById('tmTemp')?.value || null,
        engine_health: document.getElementById('tmHealth')?.value,
        odometer_km: +document.getElementById('tmOdo')?.value || null,
        fuel_consumed_liters: +document.getElementById('tmFuelConsumed')?.value || 0,
        fuel_efficiency_kmpl: +document.getElementById('tmEfficiency')?.value || null,
    };
    try {
        await fetch(`${API_BASE}/api/telemetry/${vid}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        showToast('Telemetry updated!', 'success'); closeGenericModal(); loadTelemetry();
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 12 – Multi-Hub Logistics
// ══════════════════════════════════════════════════════════════
async function loadHubs() {
    try {
        const [hubRes, transferRes] = await Promise.all([
            fetch(`${API_BASE}/api/hubs`).then(r => r.json()),
            fetch(`${API_BASE}/api/hubs/transfers`).then(r => r.json()),
        ]);
        renderHubsGrid(hubRes.data || []);
        renderHubTransfers(transferRes.data || []);
    } catch (e) { showToast(e.message, 'error'); }
}

function renderHubsGrid(hubs) {
    const grid = document.getElementById('hubsGrid'); if (!grid) return;
    if (!hubs.length) {
        grid.innerHTML = '<div style="color:var(--text-secondary);padding:20px">No hub warehouses yet. Add warehouses with "Is Hub = Yes".</div>';
        return;
    }
    grid.innerHTML = hubs.map(h => `
        <div class="wh-card hub">
            <div class="wh-card-header">
                <div><div class="wh-name">${h.name}</div>
                <div class="wh-city"><i class="fas fa-map-marker-alt"></i> ${h.city || '—'}</div></div>
                <span class="wh-hub-badge">HUB</span>
            </div>
            <div class="wh-stats">
                <div class="wh-stat-item"><span>${h.inventory_count || 0}</span> in stock</div>
                <div class="wh-stat-item"><span>${h.transfers_in_progress || 0}</span> active transfers</div>
                <div class="wh-stat-item"><i class="fas fa-user" style="color:var(--text-muted)"></i> ${h.manager_name || '—'}</div>
            </div>
        </div>`).join('');
}

function renderHubTransfers(data) {
    const tbody = document.getElementById('hubTransfersBody'); if (!tbody) return;
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="10" class="loading-row">No transfers yet</td></tr>'; return; }
    tbody.innerHTML = data.map(t => `<tr>
        <td style="font-family:var(--font-mono)">#${t.id}</td>
        <td style="color:var(--accent)">${t.order_id || '—'}</td>
        <td>${t.customer_name || '—'}</td>
        <td>${t.from_hub_name || t.from_hub_id || '—'}</td>
        <td>${t.to_hub_name || t.to_hub_id || '—'}</td>
        <td>${t.sort_lane || '—'}</td>
        <td><span class="pill ${t.transfer_status === 'Arrived' ? 'delivered' : 'in-transit'}">${t.transfer_status}</span></td>
        <td>${formatDateShort(t.arrived_at)}</td>
        <td>${formatDateShort(t.departed_at)}</td>
        <td>
            ${t.transfer_status === 'Pending' ? `<button class="btn-sm" onclick="updateTransfer(${t.id},'Departed')">Depart</button>` : ''}
            ${t.transfer_status === 'In Transit' ? `<button class="btn-sm" style="color:var(--green)" onclick="updateTransfer(${t.id},'Arrived')">Arrive</button>` : ''}
        </td>
    </tr>`).join('');
}

async function updateTransfer(tid, status) {
    try {
        await fetch(`${API_BASE}/api/hubs/transfers/${tid}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
        });
        showToast(`Transfer ${status}`, 'success'); loadHubs();
    } catch (e) { showToast(e.message, 'error'); }
}

function openHubTransferModal() {
    const html = `<div class="modal-form">
        <div class="form-group"><label>Order ID</label><input id="htOrder" placeholder="e.g. AHE1417"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>From Hub ID</label><input id="htFrom" placeholder="Warehouse ID"></div>
            <div class="form-group"><label>To Hub ID</label><input id="htTo" placeholder="Warehouse ID"></div>
        </div>
        <div class="form-group"><label>Sort Lane</label><input id="htLane" placeholder="e.g. A3, B1"></div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitHubTransfer()">
            <i class="fas fa-exchange-alt"></i> Create Transfer</button>
    </div>`;
    showGenericModal('New Hub Transfer', html);
}

async function submitHubTransfer() {
    const body = {
        order_id: document.getElementById('htOrder')?.value,
        from_hub_id: document.getElementById('htFrom')?.value,
        to_hub_id: document.getElementById('htTo')?.value,
        sort_lane: document.getElementById('htLane')?.value,
    };
    if (!body.order_id || !body.to_hub_id) { showToast('Order ID and destination hub required', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/hubs/transfers`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast(`Transfer #${res.transfer_id} created!`, 'success'); closeGenericModal(); loadHubs(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 13 – Reverse Logistics
// ══════════════════════════════════════════════════════════════
async function loadReturns() {
    try {
        const res = await fetch(`${API_BASE}/api/returns`).then(r => r.json());
        const tbody = document.getElementById('returnsTableBody'); if (!tbody) return;
        const data = res.data || [];
        tbody.innerHTML = data.map(r => `<tr>
            <td style="font-family:var(--font-mono);color:var(--orange)">${r.id}</td>
            <td style="color:var(--accent)">${r.parent_order_id || '—'}</td>
            <td>${r.customer_name || '—'}</td>
            <td>${r.source_city}</td>
            <td>${r.destination_city}</td>
            <td>${r.goods_type || '—'}</td>
            <td><span class="pill ${r.order_status === 'Delivered' ? 'delivered' : 'in-transit'}">${r.order_status}</span></td>
            <td>${r.lifecycle_stage || '—'}</td>
            <td>${r.priority_tier || '—'}</td>
            <td>${formatDateShort(r.dispatch_datetime)}</td>
        </tr>`).join('') || '<tr><td colspan="10" class="loading-row">No return orders</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

function openReturnModal() {
    const html = `<div class="modal-form">
        <p style="color:var(--text-secondary);margin-bottom:12px">Creates a reverse order from the original delivery address back to the source.</p>
        <div class="form-group"><label>Original Order ID*</label>
            <input id="retParent" placeholder="e.g. AHE1417"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Priority</label>
                <select id="retPriority"><option>Economy</option><option>Priority</option><option>Express</option></select></div>
            <div class="form-group"><label>Assign Vehicle (optional)</label>
                <input id="retVehicle" placeholder="Vehicle ID"></div>
        </div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitReturn()">
            <i class="fas fa-undo"></i> Create Return Order</button>
    </div>`;
    showGenericModal('Create Return Order', html);
}

async function submitReturn() {
    const body = {
        parent_order_id: document.getElementById('retParent')?.value.trim(),
        priority_tier: document.getElementById('retPriority')?.value,
        vehicle_id: document.getElementById('retVehicle')?.value || null,
    };
    if (!body.parent_order_id) { showToast('Original Order ID required', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/returns`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast(`Return order ${res.return_order_id} created!`, 'success'); closeGenericModal(); loadReturns(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 14 – SLA Monitoring
// ══════════════════════════════════════════════════════════════
async function loadSLA() {
    try {
        const res = await fetch(`${API_BASE}/api/sla`).then(r => r.json());
        const data = res.data || [];
        const sum = res.summary || {};
        const el = document.getElementById('slaSummaryRow');
        if (el) {
            el.innerHTML = [
                ['fas fa-check-circle', 'var(--green)', sum.on_time || 0, 'On Time'],
                ['fas fa-times-circle', 'var(--red)', sum.breached || 0, 'Breached'],
                ['fas fa-exclamation-triangle', 'var(--yellow)', sum.at_risk || 0, 'At Risk'],
                ['fas fa-percent', 'var(--accent)', (sum.on_time_pct || 0) + '%', 'On Time Rate'],
            ].map(([ic, col, val, lab]) =>
                `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
                 <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
            ).join('');
        }
        const tbody = document.getElementById('slaTableBody'); if (!tbody) return;
        tbody.innerHTML = data.map(o => `<tr>
            <td style="font-family:var(--font-mono);color:var(--accent)">${o.order_id}</td>
            <td>${o.customer_name || '—'}</td>
            <td>${o.source_city} → ${o.destination_city}</td>
            <td>${o.priority_tier || '—'}</td>
            <td>${formatDateShort(o.sla_deadline)}</td>
            <td>${o.actual_delivery ? formatDateShort(o.actual_delivery) : '—'}</td>
            <td><span class="pill ${o.order_status === 'Delivered' ? 'delivered' : 'in-transit'}">${o.order_status}</span></td>
            <td><span class="sla-pill ${o.sla_status}">${o.sla_status.replace('-', ' ')}</span></td>
        </tr>`).join('') || '<tr><td colspan="8" class="loading-row">No SLA data</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 15 – KPI Dashboard
// ══════════════════════════════════════════════════════════════
async function loadKPIs() {
    try {
        const res = await fetch(`${API_BASE}/api/kpis`).then(r => r.json());
        const t = res.totals || {};
        const v = res.vehicles || {};
        const s = res.sla || {};
        const grid = document.getElementById('kpiCardsGrid'); if (!grid) return;
        const fmt = n => n >= 10000000 ? (n / 10000000).toFixed(1) + 'Cr' : n >= 100000 ? (n / 100000).toFixed(1) + 'L' : (n || 0).toLocaleString('en-IN');
        grid.innerHTML = [
            ['fa-boxes', 'var(--accent)', t.total_orders || 0, 'Total Orders'],
            ['fa-check-circle', 'var(--green)', t.delivered || 0, 'Delivered'],
            ['fa-truck-moving', 'var(--orange)', t.in_transit || 0, 'In Transit'],
            ['fa-clock', 'var(--yellow)', t.pending || 0, 'Pending'],
            ['fa-rupee-sign', 'var(--green)', '₹' + fmt(t.total_revenue || 0), 'Total Revenue'],
            ['fa-chart-line', 'var(--accent)', '₹' + fmt(t.avg_revenue_per_order || 0), 'Avg Rev/Order'],
            ['fa-route', 'var(--purple)', (t.avg_distance_km || 0) + 'km', 'Avg Distance'],
            ['fa-truck', 'var(--accent)', v.total_vehicles || 0, 'Fleet Size'],
            ['fa-broadcast-tower', 'var(--green)', v.moving || 0, 'Active Vehicles'],
            ['fa-percent', s.on_time_pct > 80 ? 'var(--green)' : 'var(--yellow)', (s.on_time_pct || 0) + '%', 'SLA On-Time Rate'],
        ].map(([ic, col, val, lab]) =>
            `<div class="kpi-card"><div class="kpi-card-icon"><i class="fas ${ic}" style="color:${col}"></i></div>
             <div class="kpi-card-val" style="color:${col}">${val}</div><div class="kpi-card-lbl">${lab}</div></div>`
        ).join('');

        const routeBody = document.getElementById('kpiRouteBody');
        if (routeBody) {
            routeBody.innerHTML = (res.route_performance || []).map(r => `<tr>
                <td>${r.source_city} → ${r.destination_city}</td>
                <td><strong style="color:var(--accent)">${r.trips}</strong></td>
                <td>₹${(r.avg_cost || 0).toLocaleString('en-IN')}</td>
            </tr>`).join('') || '<tr><td colspan="3" class="loading-row">No data</td></tr>';
        }

        const driverBody = document.getElementById('kpiDriverBody');
        if (driverBody) {
            driverBody.innerHTML = (res.driver_performance || []).map(d => {
                const stars = '★'.repeat(Math.round(d.rating || 5)).substring(0, 5);
                return `<tr>
                    <td>${d.name || '—'}</td>
                    <td><span class="driver-stars">${stars}</span> <small>${d.rating || 5}</small></td>
                    <td><span class="avail-badge ${d.availability || 'Available'}">${d.availability || '—'}</span></td>
                    <td style="color:var(--accent)">${d.active_orders || 0}</td>
                </tr>`;
            }).join('') || '<tr><td colspan="4" class="loading-row">No driver data</td></tr>';
        }
    } catch (e) { showToast(e.message, 'error'); }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('fleet-theme');
    if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
        const tog = document.getElementById('themeToggle'); if (tog) tog.classList.toggle('off', saved === 'light');
    }
    // Enter key shortcuts
    document.getElementById('adminPass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doAdminLogin('password'); });
    document.getElementById('customerContact')?.addEventListener('keydown', e => { if (e.key === 'Enter') doCustomerLogin(); });
    document.getElementById('customerOrderId')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('customerContact')?.focus(); });
    document.getElementById('driverContact')?.addEventListener('keydown', e => { if (e.key === 'Enter') doDriverLogin(); });
    document.getElementById('driverVehicleId')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('driverContact')?.focus(); });

    // Load driver dropdown and listener on boot
    loadDriverDropdown();
    setupDriverSelectListener();
});

// ══════════════════════════════════════════════════════════════
//  FEATURE 16 – Customer Management
// ══════════════════════════════════════════════════════════════
async function loadCustomers() {
    const q = document.getElementById('custSearch')?.value || '';
    try {
        const res = await fetch(`${API_BASE}/api/customers${q ? '?q=' + encodeURIComponent(q) : ''}`).then(r => r.json());
        const tbody = document.getElementById('customersTableBody'); if (!tbody) return;
        const data = res.data || [];
        tbody.innerHTML = data.map(c => `<tr>
            <td style="font-family:var(--font-mono)">${c.id}</td>
            <td><strong>${c.name}</strong></td>
            <td>${c.company || '—'}</td>
            <td>${c.city || '—'}</td>
            <td>${c.email || '—'}</td>
            <td>${c.phone || '—'}</td>
            <td style="font-family:var(--font-mono);font-size:11px">${c.gstin || '—'}</td>
            <td>₹${(c.credit_limit_inr || 0).toLocaleString('en-IN')}</td>
            <td>${c.payment_terms_days || 30} days</td>
            <td><span class="avail-badge ${c.account_status === 'Active' ? 'Available' : 'Off'}">${c.account_status || 'Active'}</span></td>
            <td style="color:var(--accent);font-weight:700">${c.total_orders || 0}</td>
            <td style="color:var(--green)">₹${parseFloat(c.total_revenue || 0).toLocaleString('en-IN')}</td>
            <td>
                <button class="btn-sm" onclick="loadCustomerOrders(${c.id},'${(c.name || '').replace(/'/g, "\\'")}')">Orders</button>
                <button class="btn-sm" onclick="openEditCustomerModal(${c.id},'${(c.name || '').replace(/'/g, "\\'")}')">Edit</button>
                <button class="btn-sm btn-danger-sm" onclick="deleteCustomer(${c.id},'${(c.name || '').replace(/'/g, "\\'")}')">Delete</button>
            </td>
        </tr>`).join('') || '<tr><td colspan="13" class="loading-row">No customers found</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function loadCustomerOrders(cid, name) {
    try {
        const res = await fetch(`${API_BASE}/api/customers/${cid}/orders`).then(r => r.json());
        const panel = document.getElementById('custDetailPanel');
        const title = document.getElementById('custDetailTitle');
        const tbody = document.getElementById('custOrdersBody');
        if (!panel || !tbody) return;
        panel.style.display = 'block';
        if (title) title.innerHTML = `<i class="fas fa-history"></i> Order History — ${name}`;
        const orders = res.orders || [];
        tbody.innerHTML = orders.map(o => `<tr>
            <td style="color:var(--accent);font-family:var(--font-mono)">${o.id}</td>
            <td>${o.source_city}→${o.destination_city}</td>
            <td>${o.goods_type || '—'}</td>
            <td><span class="pill ${o.order_status === 'Delivered' ? 'delivered' : 'in-transit'}">${o.order_status}</span></td>
            <td>₹${(o.transport_cost_inr || 0).toLocaleString('en-IN')}</td>
            <td>${formatDateShort(o.dispatch_datetime)}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="loading-row">No orders</td></tr>';
        panel.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { showToast(e.message, 'error'); }
}

function openAddCustomerModal() {
    const html = `<div class="modal-form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Full Name*</label><input id="cnName" placeholder="Contact name"></div>
            <div class="form-group"><label>Company</label><input id="cnCompany" placeholder="Company name"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Email</label><input id="cnEmail" type="email" placeholder="email@co.in"></div>
            <div class="form-group"><label>Phone</label><input id="cnPhone" placeholder="+91 XXXXX XXXXX"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>City</label><input id="cnCity" placeholder="City"></div>
            <div class="form-group"><label>GSTIN</label><input id="cnGstin" placeholder="22AAAA..."></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Credit Limit (₹)</label><input id="cnCredit" type="number" value="500000"></div>
            <div class="form-group"><label>Payment Terms (days)</label><input id="cnTerms" type="number" value="30"></div>
        </div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitAddCustomer()">
            <i class="fas fa-building"></i> Add Customer</button>
    </div>`;
    showGenericModal('Add Customer', html);
}

async function submitAddCustomer() {
    const body = {
        name: document.getElementById('cnName')?.value.trim(),
        company: document.getElementById('cnCompany')?.value,
        email: document.getElementById('cnEmail')?.value,
        phone: document.getElementById('cnPhone')?.value,
        city: document.getElementById('cnCity')?.value,
        gstin: document.getElementById('cnGstin')?.value,
        credit_limit_inr: +document.getElementById('cnCredit')?.value || 500000,
        payment_terms_days: +document.getElementById('cnTerms')?.value || 30,
    };
    if (!body.name) { showToast('Name required', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/customers`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast('Customer added!', 'success'); closeGenericModal(); loadCustomers(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

function openEditCustomerModal(cid, name) {
    const html = `<div class="modal-form">
        <p style="color:var(--text-secondary);margin-bottom:12px">Editing <strong>${name}</strong></p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Credit Limit (₹)</label><input id="ecCredit" type="number"></div>
            <div class="form-group"><label>Payment Terms (days)</label><input id="ecTerms" type="number" value="30"></div>
        </div>
        <div class="form-group"><label>Account Status</label>
            <select id="ecStatus"><option>Active</option><option>Inactive</option><option>Suspended</option></select></div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitEditCustomer(${cid})">
            <i class="fas fa-save"></i> Save</button>
    </div>`;
    showGenericModal('Edit Customer', html);
}

async function submitEditCustomer(cid) {
    const body = {
        credit_limit_inr: +document.getElementById('ecCredit')?.value,
        payment_terms_days: +document.getElementById('ecTerms')?.value,
        account_status: document.getElementById('ecStatus')?.value,
    };
    try {
        await fetch(`${API_BASE}/api/customers/${cid}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        showToast('Customer updated', 'success'); closeGenericModal(); loadCustomers();
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteCustomer(cid, name) {
    showDeleteConfirm({
        title: 'Delete Customer',
        subtitle: `${name}`,
        confirmName: name,
        warningLines: [
            'This customer record will be permanently removed.',
            'All associated order history references will be unlinked.',
            'This action cannot be undone.'
        ],
        onConfirm: async () => {
            try {
                const r = await fetch(`${API_BASE}/api/customers/${cid}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ _delete: true })
                });
                const text = await r.text();
                let res;
                try { res = JSON.parse(text); } catch { showToast('Server error: ' + text.slice(0, 80), 'error'); return; }
                if (res.success) { showToast('Customer deleted', 'success'); loadCustomers(); }
                else showToast(res.error || 'Delete failed', 'error');
            } catch (e) { showToast(e.message, 'error'); }
        }
    });
}

// ══════════════════════════════════════════════════════════════
//  FEATURE 17 – Billing & Invoicing
// ══════════════════════════════════════════════════════════════
async function loadInvoices() {
    const status = document.getElementById('invoiceStatusFilter')?.value || '';
    try {
        const [listRes, sumRes] = await Promise.all([
            fetch(`${API_BASE}/api/invoices${status ? '?status=' + status : ''}`).then(r => r.json()),
            fetch(`${API_BASE}/api/invoices/summary`).then(r => r.json()),
        ]);
        // Summary stats
        const el = document.getElementById('invoiceSummaryRow');
        if (el) {
            const s = sumRes.data || {};
            const fmt = v => v >= 10000000 ? (v / 10000000).toFixed(1) + 'Cr' : v >= 100000 ? (v / 100000).toFixed(1) + 'L' : (v || 0).toLocaleString('en-IN');
            el.innerHTML = [
                ['fas fa-file-invoice', 'var(--accent)', s.total || 0, 'Total Invoices'],
                ['fas fa-check-circle', 'var(--green)', s.paid || 0, 'Paid'],
                ['fas fa-clock', 'var(--yellow)', s.unpaid || 0, 'Unpaid'],
                ['fas fa-exclamation-circle', 'var(--red)', s.overdue || 0, 'Overdue'],
                ['fas fa-rupee-sign', 'var(--green)', '₹' + fmt(s.total_revenue || 0), 'Total Billed'],
                ['fas fa-hand-holding-usd', 'var(--orange)', '₹' + fmt(s.outstanding || 0), 'Outstanding'],
            ].map(([ic, col, val, lab]) =>
                `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
                 <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
            ).join('');
        }
        const tbody = document.getElementById('invoicesTableBody'); if (!tbody) return;
        const data = listRes.data || [];
        tbody.innerHTML = data.map(inv => {
            const statusCls = inv.payment_status === 'Paid' ? 'delivered' : inv.payment_status === 'Overdue' ? 'exception' : 'in-transit';
            return `<tr>
                <td style="font-family:var(--font-mono);color:var(--accent)">${inv.invoice_number}</td>
                <td style="color:var(--accent)">${inv.order_id || '—'}</td>
                <td>${inv.customer_name || '—'}</td>
                <td>₹${(inv.base_amount_inr || 0).toLocaleString('en-IN')}</td>
                <td>₹${(inv.gst_amount_inr || 0).toLocaleString('en-IN')}</td>
                <td><strong style="color:var(--accent)">₹${(inv.total_amount_inr || 0).toLocaleString('en-IN')}</strong></td>
                <td>${formatDateShort(inv.due_date)}</td>
                <td><span class="pill ${statusCls}">${inv.payment_status}</span></td>
                <td>${inv.payment_status === 'Unpaid' || inv.payment_status === 'Overdue'
                    ? `<button class="btn-sm" style="color:var(--green)" onclick="openPayModal(${inv.id},'${inv.invoice_number}')">Mark Paid</button>`
                    : `<span style="color:var(--green);font-size:12px"><i class="fas fa-check"></i> ${formatDateShort(inv.payment_date)}</span>`}
                </td>
            </tr>`;
        }).join('') || '<tr><td colspan="9" class="loading-row">No invoices</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

function openCreateInvoiceModal() {
    const html = `<div class="modal-form">
        <div class="form-group"><label>Order ID*</label><input id="invOrderId" placeholder="e.g. AHE1417"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group"><label>Due Date</label><input id="invDueDate" type="date" value="${new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)}"></div>
            <div class="form-group"><label>Billing Address</label><input id="invAddr" placeholder="Optional"></div>
        </div>
        <p style="color:var(--text-muted);font-size:12px;margin-top:4px">GST @ 18% auto-calculated from transport cost.</p>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitCreateInvoice()">
            <i class="fas fa-file-invoice"></i> Generate Invoice</button>
    </div>`;
    showGenericModal('Create Invoice', html);
}

async function submitCreateInvoice() {
    const body = {
        order_id: document.getElementById('invOrderId')?.value.trim(),
        due_date: document.getElementById('invDueDate')?.value,
        billing_address: document.getElementById('invAddr')?.value,
    };
    if (!body.order_id) { showToast('Order ID required', 'warn'); return; }
    try {
        const res = await fetch(`${API_BASE}/api/invoices`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(r => r.json());
        if (res.success) { showToast(`Invoice ${res.invoice_number} created! Total ₹${res.total?.toLocaleString('en-IN')}`, 'success'); closeGenericModal(); loadInvoices(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

function openPayModal(iid, invNo) {
    const html = `<div class="modal-form">
        <p style="color:var(--text-secondary);margin-bottom:12px">Mark invoice <strong>${invNo}</strong> as paid</p>
        <div class="form-group"><label>Payment Method</label>
            <select id="payMethod">
                <option>Bank Transfer</option><option>UPI</option>
                <option>Cheque</option><option>Cash</option><option>NEFT/RTGS</option>
            </select></div>
        <button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitMarkPaid(${iid})">
            <i class="fas fa-check-circle"></i> Confirm Payment</button>
    </div>`;
    showGenericModal('Mark Invoice Paid', html);
}

async function submitMarkPaid(iid) {
    const body = { payment_method: document.getElementById('payMethod')?.value };
    try {
        await fetch(`${API_BASE}/api/invoices/${iid}/pay`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        showToast('Invoice marked as Paid!', 'success'); closeGenericModal(); loadInvoices();
    } catch (e) { showToast(e.message, 'error'); }
}
// ══════════════════════════════════════════════════════════════
//  FEATURE 18 – Fuel Management
// ══════════════════════════════════════════════════════════════
async function loadFuelMgmt() {
    const vid = document.getElementById('fuelVehicleFilter')?.value.trim() || '';
    try {
        const res = await fetch(`${API_BASE}/api/fuel${vid ? '?vehicle_id=' + vid : ''}`).then(r => r.json());
        const s = res.summary || {};
        const el = document.getElementById('fuelSummaryRow');
        if (el) el.innerHTML = [['fas fa-tint', 'var(--accent)', (s.total_liters || 0) + 'L', 'Total Fuel'], ['fas fa-rupee-sign', 'var(--red)', '₹' + (s.total_cost || 0).toLocaleString('en-IN'), 'Total Cost'], ['fas fa-road', 'var(--green)', (s.avg_efficiency || 0) + ' km/L', 'Avg Efficiency']].map(([ic, col, val, lab]) => `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i><div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`).join('');
        const tbody = document.getElementById('fuelTableBody'); if (!tbody) return;
        tbody.innerHTML = (res.data || []).map(f => `<tr><td style="font-family:var(--font-mono);color:var(--accent)">${f.vehicle_id}</td><td>${f.vehicle_number || '—'}</td><td>${f.driver_name || '—'}</td><td><strong>${f.liters_consumed}</strong> L</td><td>₹${(f.cost_inr || 0).toLocaleString('en-IN')}</td><td>${f.fuel_station || '—'}</td><td>${f.odometer_km ? f.odometer_km.toLocaleString() + ' km' : '—'}</td><td>${f.fuel_efficiency_kmpl ? f.fuel_efficiency_kmpl + ' km/L' : '—'}</td><td>${formatDateShort(f.logged_at)}</td></tr>`).join('') || '<tr><td colspan="9" class="loading-row">No fuel logs</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}
async function loadFuelAnalytics() {
    try { const res = await fetch(`${API_BASE}/api/fuel/analytics`).then(r => r.json()); const sec = document.getElementById('fuelAnalyticsSection'); const tbody = document.getElementById('fuelAnalyticsBody'); if (!sec || !tbody) return; sec.style.display = 'block'; tbody.innerHTML = (res.data || []).map(v => `<tr><td style="color:var(--accent);font-family:var(--font-mono)">${v.vehicle_id}</td><td>${v.vehicle_type || '—'}</td><td>${v.total_liters || 0} L</td><td>₹${(v.total_cost || 0).toLocaleString('en-IN')}</td><td><strong style="color:var(--green)">${v.avg_kmpl || '—'} km/L</strong></td><td>${v.fill_ups || 0}</td></tr>`).join('') || '<tr><td colspan="6" class="loading-row">No data</td></tr>'; } catch (e) { showToast(e.message, 'error'); }
}
function openFuelLogModal() { showGenericModal('Log Fuel Fill', `<div class="modal-form"><div class="form-group"><label>Vehicle ID*</label><input id="flVid" placeholder="e.g. MH-TRK-001"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>Litres*</label><input id="flLit" type="number" step="0.1" placeholder="50"></div><div class="form-group"><label>Cost (₹)</label><input id="flCost" type="number" placeholder="4500"></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>Station</label><input id="flStation" placeholder="Station name"></div><div class="form-group"><label>Odometer (km)</label><input id="flOdo" type="number" placeholder="85000"></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>Efficiency (km/L)</label><input id="flEff" type="number" step="0.1" placeholder="8.5"></div><div class="form-group"><label>Fuel Level (%)</label><input id="flLevel" type="number" min="0" max="100" placeholder="80"></div></div><button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitFuelLog()"><i class="fas fa-gas-pump"></i> Log Fill</button></div>`); }
async function submitFuelLog() { const body = { vehicle_id: document.getElementById('flVid')?.value.trim(), liters_consumed: +document.getElementById('flLit')?.value, cost_inr: +document.getElementById('flCost')?.value || null, fuel_station: document.getElementById('flStation')?.value, odometer_km: +document.getElementById('flOdo')?.value || null, fuel_efficiency_kmpl: +document.getElementById('flEff')?.value || null, fuel_level_pct: +document.getElementById('flLevel')?.value || null }; if (!body.vehicle_id || !body.liters_consumed) { showToast('Vehicle ID & Litres required', 'warn'); return; } try { await fetch(`${API_BASE}/api/fuel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); showToast('Fuel logged!', 'success'); closeGenericModal(); loadFuelMgmt(); } catch (e) { showToast(e.message, 'error'); } }

// ══════════════════════════════════════════════════════════════
//  FEATURE 19 – Compliance & Documents
// ══════════════════════════════════════════════════════════════
function expiryClass(date) { if (!date) return ''; const days = (new Date(date) - new Date()) / 86400000; return days < 0 ? 'doc-expired' : days < 30 ? 'doc-warning' : 'doc-ok'; }
async function loadCompliance() { try { const res = await fetch(`${API_BASE}/api/compliance`).then(r => r.json()); const tbody = document.getElementById('complianceTableBody'); if (!tbody) return; tbody.innerHTML = (res.data || []).map(v => { const al = v.insurance_alert || v.permit_alert || v.fitness_alert; return `<tr ${al ? 'style="background:rgba(255,100,50,0.05)"' : ''}><td style="font-family:var(--font-mono);color:var(--accent)">${v.vehicle_id}</td><td>${v.vehicle_number || '—'}</td><td>${v.vehicle_type || '—'}</td><td>${v.driver_name || '—'}</td><td><span class="${expiryClass(v.insurance_expiry)}">${v.insurance_expiry || '—'}</span></td><td><span class="${expiryClass(v.permit_expiry)}">${v.permit_expiry || '—'}</span></td><td><span class="${expiryClass(v.fitness_expiry)}">${v.fitness_expiry || '—'}</span></td><td><span class="${expiryClass(v.pollution_expiry)}">${v.pollution_expiry || '—'}</span></td><td><span class="${expiryClass(v.driver_license_expiry)}">${v.driver_license_expiry || '—'}</span></td><td>${al ? '<span style="color:var(--orange)"><i class="fas fa-exclamation-triangle"></i> Alert</span>' : '<span style="color:var(--green)"><i class="fas fa-check"></i></span>'}</td><td><button class="btn-sm" onclick="openComplianceUpdateModal(` + "`" + `'${v.vehicle_id}'` + "`" + `)">Update</button></td></tr>`; }).join('') || '<tr><td colspan="11" class="loading-row">No vehicles</td></tr>'; } catch (e) { showToast(e.message, 'error'); } }
async function loadExpiringDocs() { try { const res = await fetch(`${API_BASE}/api/compliance/expiring?days=30`).then(r => r.json()); const sec = document.getElementById('expiringDocsSection'); const tbody = document.getElementById('expiringDocsBody'); if (!sec || !tbody) return; const data = res.data || []; tbody.innerHTML = data.map(d => `<tr><td style="color:var(--accent);font-family:var(--font-mono)">${d.vehicle_number || d.vehicle_id}</td><td>${d.doc_type}</td><td><span class="doc-warning">${d.expiry_date}</span></td><td><strong style="color:${d.days_remaining < 0 ? 'var(--red)' : 'var(--orange)'}">${d.days_remaining < 0 ? 'EXPIRED' : Math.floor(d.days_remaining) + ' days'}</strong></td></tr>`).join('') || '<tr><td colspan="4" class="loading-row">None</td></tr>'; sec.style.display = data.length ? 'block' : 'none'; } catch (e) { showToast(e.message, 'error'); } }
function openComplianceUpdateModal(vid) { showGenericModal('Update Compliance — ' + vid, `<div class="modal-form"><p style="color:var(--text-secondary);margin-bottom:12px">Vehicle: <strong>${vid}</strong></p><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>Insurance Expiry</label><input id="cuIns" type="date"></div><div class="form-group"><label>Permit Expiry</label><input id="cuPer" type="date"></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>Fitness Expiry</label><input id="cuFit" type="date"></div><div class="form-group"><label>Pollution Expiry</label><input id="cuPol" type="date"></div></div><button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitComplianceUpdate('${vid}')"><i class="fas fa-shield-alt"></i> Save</button></div>`); }
async function submitComplianceUpdate(vid) { const body = { insurance_expiry: document.getElementById('cuIns')?.value || null, permit_expiry: document.getElementById('cuPer')?.value || null, fitness_expiry: document.getElementById('cuFit')?.value || null, pollution_expiry: document.getElementById('cuPol')?.value || null }; try { await fetch(`${API_BASE}/api/compliance/${vid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); showToast('Compliance updated!', 'success'); closeGenericModal(); loadCompliance(); } catch (e) { showToast(e.message, 'error'); } }

// ══════════════════════════════════════════════════════════════
//  FEATURE 20 – GPS Geofencing
// ══════════════════════════════════════════════════════════════
async function loadGeofencing() { try { const res = await fetch(`${API_BASE}/api/geofences/check`).then(r => r.json()); const el = document.getElementById('geofencesList'); if (el) { const gf = res.geofences || []; el.innerHTML = gf.length ? gf.map(g => `<div style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-weight:600">${g.name}</div><div style="font-size:11px;color:var(--text-muted)">${g.zone_type} • R=${g.radius_km}km</div></div><button class="btn-sm" style="color:var(--red)" onclick="deleteGeofence(${g.id})"><i class="fas fa-trash"></i></button></div>`).join('') : '<p style="color:var(--text-muted);font-size:13px">No zones yet.</p>'; } const tbody = document.getElementById('geofenceVehicleBody'); if (tbody) tbody.innerHTML = (res.vehicles || []).map(v => `<tr><td style="color:var(--accent);font-family:var(--font-mono)">${v.id}</td><td>${v.vehicle_number || '—'}</td><td>${v.current_lat?.toFixed(4) || '—'}</td><td>${v.current_lng?.toFixed(4) || '—'}</td><td><span class="pill ${v.status === 'moving' ? 'in-transit' : 'pending'}">${v.status}</span></td><td>${v.current_order_id || '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="loading-row">No GPS data</td></tr>'; const violations = res.violations || []; const vEl = document.getElementById('geofenceViolations'); if (vEl && violations.length) { vEl.style.display = 'block'; vEl.innerHTML = `<div class="optimizer-card" style="border-left:3px solid var(--red)"><h3><i class="fas fa-exclamation-triangle" style="color:var(--red)"></i> ${violations.length} Violation(s)</h3>${violations.map(v => `<div style="font-size:13px;padding:4px 0;color:var(--text-secondary)"><strong style="color:var(--red)">${v.vehicle_number}</strong> outside <strong>${v.geofence}</strong> (${v.distance_km}km / limit ${v.limit_km}km)</div>`).join('')}</div>`; } else if (vEl) vEl.style.display = 'none'; } catch (e) { showToast(e.message, 'error'); } }
async function checkGeofenceViolations() { loadGeofencing(); }
function openGeofenceModal() { showGenericModal('Add Geofence Zone', `<div class="modal-form"><div class="form-group"><label>Zone Name*</label><input id="gfName" placeholder="e.g. Mumbai Port Zone"></div><div class="form-group"><label>Zone Type</label><select id="gfType"><option>Delivery Zone</option><option>Warehouse Zone</option><option>Hub Zone</option><option>No-Go Zone</option></select></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>Latitude*</label><input id="gfLat" type="number" step="0.0001" placeholder="19.0760"></div><div class="form-group"><label>Longitude*</label><input id="gfLng" type="number" step="0.0001" placeholder="72.8777"></div></div><div class="form-group"><label>Radius (km)</label><input id="gfRadius" type="number" step="0.5" value="5"></div><button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitGeofence()"><i class="fas fa-map-marked-alt"></i> Create Zone</button></div>`); }
async function submitGeofence() { const body = { name: document.getElementById('gfName')?.value.trim(), zone_type: document.getElementById('gfType')?.value, lat: +document.getElementById('gfLat')?.value, lng: +document.getElementById('gfLng')?.value, radius_km: +document.getElementById('gfRadius')?.value || 5 }; if (!body.name || !body.lat) { showToast('Name and coordinates required', 'warn'); return; } try { const res = await fetch(`${API_BASE}/api/geofences`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()); if (res.success) { showToast('Zone created!', 'success'); closeGenericModal(); loadGeofencing(); } } catch (e) { showToast(e.message, 'error'); } }
async function deleteGeofence(gid) { try { await fetch(`${API_BASE}/api/geofences/${gid}`, { method: 'DELETE' }); showToast('Zone removed', 'success'); loadGeofencing(); } catch (e) { showToast(e.message, 'error'); } }

// ══════════════════════════════════════════════════════════════
//  FEATURE 21 – Maintenance Scheduling
// ══════════════════════════════════════════════════════════════
async function loadMaintenance() { try { const [listRes, upRes] = await Promise.all([fetch(`${API_BASE}/api/maintenance/schedule`).then(r => r.json()), fetch(`${API_BASE}/api/maintenance/upcoming`).then(r => r.json())]); const upcoming = (upRes.data || []).filter(m => m.days_until <= 7); const banner = document.getElementById('upcomingMaintBanner'); const list = document.getElementById('upcomingMaintList'); if (banner && list) { if (upcoming.length) { banner.style.display = 'block'; list.innerHTML = upcoming.map(m => `<div>• <strong>${m.vehicle_number || m.vehicle_id}</strong> — ${m.maintenance_type} on <strong>${m.scheduled_date}</strong> (${Math.ceil(m.days_until)} days, est. ₹${(m.estimated_cost_inr || 0).toLocaleString('en-IN')})</div>`).join(''); } else banner.style.display = 'none'; } const tbody = document.getElementById('maintenanceTableBody'); if (!tbody) return; tbody.innerHTML = (listRes.data || []).map(m => `<tr><td style="font-family:var(--font-mono)">#${m.id}</td><td>${m.vehicle_number || m.vehicle_id || '—'}</td><td>${m.maintenance_type}</td><td>${m.scheduled_date}</td><td>₹${(m.estimated_cost_inr || 0).toLocaleString('en-IN')}</td><td>${m.actual_cost_inr ? '₹' + m.actual_cost_inr.toLocaleString('en-IN') : '—'}</td><td>${m.vendor || '—'}</td><td><span class="pill ${m.status === 'Completed' ? 'delivered' : m.status === 'Overdue' ? 'exception' : 'pending'}">${m.status}</span></td><td>${m.completed_at ? formatDateShort(m.completed_at) : '—'}</td><td>${m.status !== 'Completed' ? `<button class="btn-sm" style="color:var(--green)" onclick="completeMaintenance(${m.id})">Complete</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="10" class="loading-row">No maintenance</td></tr>'; } catch (e) { showToast(e.message, 'error'); } }
async function completeMaintenance(sid) { const cost = prompt('Actual cost (₹)? Leave blank to skip.'); try { await fetch(`${API_BASE}/api/maintenance/schedule/${sid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Completed', actual_cost_inr: cost ? +cost : null }) }); showToast('Marked complete!', 'success'); loadMaintenance(); } catch (e) { showToast(e.message, 'error'); } }
function openMaintenanceModal() { showGenericModal('Schedule Maintenance', `<div class="modal-form"><div class="form-group"><label>Vehicle ID*</label><input id="msVid" placeholder="e.g. MH-TRK-001"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>Type</label><select id="msType"><option>Routine Service</option><option>Oil Change</option><option>Tyre Replacement</option><option>Brake Service</option><option>Engine Overhaul</option><option>Body Repair</option><option>Electrical</option></select></div><div class="form-group"><label>Scheduled Date*</label><input id="msDate" type="date"></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>Est. Cost (₹)</label><input id="msCost" type="number" placeholder="5000"></div><div class="form-group"><label>Vendor</label><input id="msVendor" placeholder="Workshop name"></div></div><div class="form-group"><label>Notes</label><input id="msNotes" placeholder="Additional details"></div><button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitMaintenance()"><i class="fas fa-calendar-check"></i> Schedule</button></div>`); }
async function submitMaintenance() { const body = { vehicle_id: document.getElementById('msVid')?.value.trim(), maintenance_type: document.getElementById('msType')?.value, scheduled_date: document.getElementById('msDate')?.value, estimated_cost_inr: +document.getElementById('msCost')?.value || 0, vendor: document.getElementById('msVendor')?.value, notes: document.getElementById('msNotes')?.value }; if (!body.vehicle_id || !body.scheduled_date) { showToast('Vehicle ID & date required', 'warn'); return; } try { await fetch(`${API_BASE}/api/maintenance/schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); showToast('Maintenance scheduled!', 'success'); closeGenericModal(); loadMaintenance(); } catch (e) { showToast(e.message, 'error'); } }

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FEATURE 18 — Fuel Management
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadFuelMgmt() {
    const vid = document.getElementById('fuelVehicleFilter')?.value.trim() || '';
    try {
        const res = await fetch(`${API_BASE}/api/fuel` + (vid ? '?vehicle_id=' + vid : '')).then(r => r.json());
        const s = res.summary || {};
        const el = document.getElementById('fuelSummaryRow');
        if (el) el.innerHTML = [
            ['fas fa-tint', 'var(--accent)', (s.total_liters || 0) + 'L', 'Total Fuel'],
            ['fas fa-rupee-sign', 'var(--red)', '₹' + (s.total_cost || 0).toLocaleString('en-IN'), 'Total Cost'],
            ['fas fa-road', 'var(--green)', (s.avg_efficiency || 0) + ' km/L', 'Avg Efficiency'],
        ].map(([ic, col, val, lab]) =>
            '<div class="fleet-stat"><i class="' + ic + '" style="color:' + col + ';font-size:20px"></i>' +
            '<div><div class="fleet-stat-val">' + val + '</div><div class="fleet-stat-lbl">' + lab + '</div></div></div>'
        ).join('');
        const tbody = document.getElementById('fuelTableBody');
        if (!tbody) return;
        const rows = (res.data || []).map(f =>
            '<tr><td style="font-family:var(--font-mono);color:var(--accent)">' + f.vehicle_id + '</td>' +
            '<td>' + (f.vehicle_number || '—') + '</td><td>' + (f.driver_name || '—') + '</td>' +
            '<td><strong>' + f.liters_consumed + '</strong> L</td>' +
            '<td>₹' + (f.cost_inr || 0).toLocaleString('en-IN') + '</td>' +
            '<td>' + (f.fuel_station || '—') + '</td>' +
            '<td>' + (f.odometer_km ? f.odometer_km.toLocaleString() + ' km' : '—') + '</td>' +
            '<td>' + (f.fuel_efficiency_kmpl ? f.fuel_efficiency_kmpl + ' km/L' : '—') + '</td>' +
            '<td>' + formatDateShort(f.logged_at) + '</td></tr>'
        );
        tbody.innerHTML = rows.join('') || '<tr><td colspan="9" class="loading-row">No fuel logs</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function loadFuelAnalytics() {
    try {
        const res = await fetch(`${API_BASE}/api/fuel/analytics`).then(r => r.json());
        const sec = document.getElementById('fuelAnalyticsSection');
        const tbody = document.getElementById('fuelAnalyticsBody');
        if (!sec || !tbody) return;
        sec.style.display = 'block';
        tbody.innerHTML = (res.data || []).map(v =>
            '<tr><td style="color:var(--accent);font-family:var(--font-mono)">' + v.vehicle_id + '</td>' +
            '<td>' + (v.vehicle_type || '—') + '</td>' +
            '<td>' + (v.total_liters || 0) + ' L</td>' +
            '<td>₹' + (v.total_cost || 0).toLocaleString('en-IN') + '</td>' +
            '<td><strong style="color:var(--green)">' + (v.avg_kmpl || '—') + ' km/L</strong></td>' +
            '<td>' + (v.fill_ups || 0) + '</td></tr>'
        ).join('') || '<tr><td colspan="6" class="loading-row">No data</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

function openFuelLogModal() {
    var html = '<div class="modal-form">' +
        '<div class="form-group"><label>Vehicle ID*</label><input id="flVid" placeholder="e.g. MH-TRK-001"></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Litres*</label><input id="flLit" type="number" step="0.1" placeholder="50"></div>' +
        '<div class="form-group"><label>Cost (₹)</label><input id="flCost" type="number" placeholder="4500"></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Station</label><input id="flStation" placeholder="Station name"></div>' +
        '<div class="form-group"><label>Odometer (km)</label><input id="flOdo" type="number" placeholder="85000"></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Efficiency (km/L)</label><input id="flEff" type="number" step="0.1" placeholder="8.5"></div>' +
        '<div class="form-group"><label>Fuel Level (%)</label><input id="flLevel" type="number" min="0" max="100" placeholder="80"></div></div>' +
        '<button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitFuelLog()"><i class="fas fa-gas-pump"></i> Log Fill</button></div>';
    showGenericModal('Log Fuel Fill', html);
}

async function submitFuelLog() {
    var body = {
        vehicle_id: document.getElementById('flVid')?.value.trim(),
        liters_consumed: +document.getElementById('flLit')?.value,
        cost_inr: +document.getElementById('flCost')?.value || null,
        fuel_station: document.getElementById('flStation')?.value,
        odometer_km: +document.getElementById('flOdo')?.value || null,
        fuel_efficiency_kmpl: +document.getElementById('flEff')?.value || null,
        fuel_level_pct: +document.getElementById('flLevel')?.value || null,
    };
    if (!body.vehicle_id || !body.liters_consumed) { showToast('Vehicle ID & Litres required', 'warn'); return; }
    try {
        await fetch(`${API_BASE}/api/fuel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        showToast('Fuel logged!', 'success'); closeGenericModal(); loadFuelMgmt();
    } catch (e) { showToast(e.message, 'error'); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FEATURE 19 — Compliance & Documents
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function expiryClass(date) {
    if (!date) return '';
    var days = (new Date(date) - new Date()) / 86400000;
    return days < 0 ? 'doc-expired' : days < 30 ? 'doc-warning' : 'doc-ok';
}

async function loadCompliance() {
    try {
        const res = await fetch(`${API_BASE}/api/compliance`).then(r => r.json());
        const tbody = document.getElementById('complianceTableBody');
        if (!tbody) return;
        tbody.innerHTML = (res.data || []).map(v => {
            var al = v.insurance_alert || v.permit_alert || v.fitness_alert;
            return '<tr' + (al ? ' style="background:rgba(255,100,50,0.05)"' : '') + '>' +
                '<td style="font-family:var(--font-mono);color:var(--accent)">' + v.vehicle_id + '</td>' +
                '<td>' + (v.vehicle_number || '—') + '</td><td>' + (v.vehicle_type || '—') + '</td><td>' + (v.driver_name || '—') + '</td>' +
                '<td><span class="' + expiryClass(v.insurance_expiry) + '">' + (v.insurance_expiry || '—') + '</span></td>' +
                '<td><span class="' + expiryClass(v.permit_expiry) + '">' + (v.permit_expiry || '—') + '</span></td>' +
                '<td><span class="' + expiryClass(v.fitness_expiry) + '">' + (v.fitness_expiry || '—') + '</span></td>' +
                '<td><span class="' + expiryClass(v.pollution_expiry) + '">' + (v.pollution_expiry || '—') + '</span></td>' +
                '<td><span class="' + expiryClass(v.driver_license_expiry) + '">' + (v.driver_license_expiry || '—') + '</span></td>' +
                '<td>' + (al ? '<span style="color:var(--orange)"><i class="fas fa-exclamation-triangle"></i> Alert</span>' :
                    '<span style="color:var(--green)"><i class="fas fa-check"></i></span>') + '</td>' +
                '<td><button class="btn-sm" onclick=\'openComplianceUpdateModal("' + v.vehicle_id + '")\'>Update</button></td></tr>';
        }).join('') || '<tr><td colspan="11" class="loading-row">No vehicles</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function loadExpiringDocs() {
    try {
        const res = await fetch(`${API_BASE}/api/compliance/expiring?days=30`).then(r => r.json());
        const sec = document.getElementById('expiringDocsSection');
        const tbody = document.getElementById('expiringDocsBody');
        if (!sec || !tbody) return;
        var data = res.data || [];
        tbody.innerHTML = data.map(d =>
            '<tr><td style="color:var(--accent);font-family:var(--font-mono)">' + (d.vehicle_number || d.vehicle_id) + '</td>' +
            '<td>' + d.doc_type + '</td>' +
            '<td><span class="doc-warning">' + d.expiry_date + '</span></td>' +
            '<td><strong style="color:' + (d.days_remaining < 0 ? 'var(--red)' : 'var(--orange)') + '">' +
            (d.days_remaining < 0 ? 'EXPIRED' : Math.floor(d.days_remaining) + ' days') + '</strong></td></tr>'
        ).join('') || '<tr><td colspan="4" class="loading-row">No expiring docs</td></tr>';
        sec.style.display = data.length ? 'block' : 'none';
    } catch (e) { showToast(e.message, 'error'); }
}

function openComplianceUpdateModal(vid) {
    var html = '<div class="modal-form">' +
        '<p style="color:var(--text-secondary);margin-bottom:12px">Vehicle: <strong>' + vid + '</strong></p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Insurance Expiry</label><input id="cuIns" type="date"></div>' +
        '<div class="form-group"><label>Permit Expiry</label><input id="cuPer" type="date"></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Fitness Expiry</label><input id="cuFit" type="date"></div>' +
        '<div class="form-group"><label>Pollution Expiry</label><input id="cuPol" type="date"></div></div>' +
        '<button class="btn-primary" style="width:100%;margin-top:8px" onclick=\'submitComplianceUpdate("' + vid + '")\'>Save</button></div>';
    showGenericModal('Update Compliance — ' + vid, html);
}

async function submitComplianceUpdate(vid) {
    var body = {
        insurance_expiry: document.getElementById('cuIns')?.value || null,
        permit_expiry: document.getElementById('cuPer')?.value || null,
        fitness_expiry: document.getElementById('cuFit')?.value || null,
        pollution_expiry: document.getElementById('cuPol')?.value || null,
    };
    try {
        await fetch(`${API_BASE}/api/compliance/` + vid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        showToast('Compliance updated!', 'success'); closeGenericModal(); loadCompliance();
    } catch (e) { showToast(e.message, 'error'); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FEATURE 20 — GPS Geofencing
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadGeofencing() {
    try {
        const res = await fetch(`${API_BASE}/api/geofences/check`).then(r => r.json());
        const el = document.getElementById('geofencesList');
        if (el) {
            var gf = res.geofences || [];
            el.innerHTML = gf.length ? gf.map(g =>
                '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">' +
                '<div><div style="font-weight:600">' + g.name + '</div>' +
                '<div style="font-size:11px;color:var(--text-muted)">' + g.zone_type + ' • R=' + g.radius_km + 'km</div></div>' +
                '<button class="btn-sm" style="color:var(--red)" onclick="deleteGeofence(' + g.id + ')"><i class="fas fa-trash"></i></button></div>'
            ).join('') : '<p style="color:var(--text-muted);font-size:13px">No zones yet.</p>';
        }
        const tbody = document.getElementById('geofenceVehicleBody');
        if (tbody) {
            tbody.innerHTML = (res.vehicles || []).map(v =>
                '<tr><td style="color:var(--accent);font-family:var(--font-mono)">' + v.id + '</td>' +
                '<td>' + (v.vehicle_number || '—') + '</td>' +
                '<td>' + (v.current_lat ? v.current_lat.toFixed(4) : '—') + '</td>' +
                '<td>' + (v.current_lng ? v.current_lng.toFixed(4) : '—') + '</td>' +
                '<td><span class="pill ' + (v.status === 'moving' ? 'in-transit' : 'pending') + '">' + v.status + '</span></td>' +
                '<td>' + (v.current_order_id || '—') + '</td></tr>'
            ).join('') || '<tr><td colspan="6" class="loading-row">No GPS data</td></tr>';
        }
        var violations = res.violations || [];
        var vEl = document.getElementById('geofenceViolations');
        if (vEl && violations.length) {
            vEl.style.display = 'block';
            vEl.innerHTML = '<div class="optimizer-card" style="border-left:3px solid var(--red)">' +
                '<h3><i class="fas fa-exclamation-triangle" style="color:var(--red)"></i> ' + violations.length + ' Violation(s)</h3>' +
                violations.map(v =>
                    '<div style="font-size:13px;padding:4px 0;color:var(--text-secondary)">' +
                    '<strong style="color:var(--red)">' + v.vehicle_number + '</strong> outside <strong>' + v.geofence + '</strong> (' + v.distance_km + 'km / limit ' + v.limit_km + 'km)</div>'
                ).join('') + '</div>';
        } else if (vEl) vEl.style.display = 'none';
    } catch (e) { showToast(e.message, 'error'); }
}

function checkGeofenceViolations() { loadGeofencing(); }

function openGeofenceModal() {
    var html = '<div class="modal-form">' +
        '<div class="form-group"><label>Zone Name*</label><input id="gfName" placeholder="e.g. Mumbai Port Zone"></div>' +
        '<div class="form-group"><label>Zone Type</label>' +
        '<select id="gfType"><option>Delivery Zone</option><option>Warehouse Zone</option><option>Hub Zone</option><option>No-Go Zone</option></select></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Latitude*</label><input id="gfLat" type="number" step="0.0001" placeholder="19.0760"></div>' +
        '<div class="form-group"><label>Longitude*</label><input id="gfLng" type="number" step="0.0001" placeholder="72.8777"></div></div>' +
        '<div class="form-group"><label>Radius (km)</label><input id="gfRadius" type="number" step="0.5" value="5"></div>' +
        '<button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitGeofence()"><i class="fas fa-map-marked-alt"></i> Create Zone</button></div>';
    showGenericModal('Add Geofence Zone', html);
}

async function submitGeofence() {
    var body = {
        name: document.getElementById('gfName')?.value.trim(),
        zone_type: document.getElementById('gfType')?.value,
        lat: +document.getElementById('gfLat')?.value,
        lng: +document.getElementById('gfLng')?.value,
        radius_km: +document.getElementById('gfRadius')?.value || 5,
    };
    if (!body.name || !body.lat) { showToast('Name and coordinates required', 'warn'); return; }
    try {
        var res = await fetch(`${API_BASE}/api/geofences`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
        if (res.success) { showToast('Zone created!', 'success'); closeGenericModal(); loadGeofencing(); }
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteGeofence(gid) {
    try {
        await fetch(`${API_BASE}/api/geofences/` + gid, { method: 'DELETE' });
        showToast('Zone removed', 'success'); loadGeofencing();
    } catch (e) { showToast(e.message, 'error'); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FEATURE 21 — Maintenance Scheduling
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadMaintenance() {
    try {
        const [listRes, upRes] = await Promise.all([
            fetch(`${API_BASE}/api/maintenance/schedule`).then(r => r.json()),
            fetch(`${API_BASE}/api/maintenance/upcoming`).then(r => r.json()),
        ]);
        var upcoming = (upRes.data || []).filter(m => m.days_until <= 7);
        var banner = document.getElementById('upcomingMaintBanner');
        var list = document.getElementById('upcomingMaintList');
        if (banner && list) {
            if (upcoming.length) {
                banner.style.display = 'block';
                list.innerHTML = upcoming.map(m =>
                    '<div>• <strong>' + (m.vehicle_number || m.vehicle_id) + '</strong> — ' + m.maintenance_type +
                    ' on <strong>' + m.scheduled_date + '</strong> (' + Math.ceil(m.days_until) + ' days, est. ₹' +
                    (m.estimated_cost_inr || 0).toLocaleString('en-IN') + ')</div>'
                ).join('');
            } else banner.style.display = 'none';
        }
        var tbody = document.getElementById('maintenanceTableBody');
        if (!tbody) return;
        tbody.innerHTML = (listRes.data || []).map(m =>
            '<tr><td style="font-family:var(--font-mono)">#' + m.id + '</td>' +
            '<td>' + (m.vehicle_number || m.vehicle_id || '—') + '</td>' +
            '<td>' + m.maintenance_type + '</td>' +
            '<td>' + m.scheduled_date + '</td>' +
            '<td>₹' + (m.estimated_cost_inr || 0).toLocaleString('en-IN') + '</td>' +
            '<td>' + (m.actual_cost_inr ? '₹' + m.actual_cost_inr.toLocaleString('en-IN') : '—') + '</td>' +
            '<td>' + (m.vendor || '—') + '</td>' +
            '<td><span class="pill ' + (m.status === 'Completed' ? 'delivered' : m.status === 'Overdue' ? 'exception' : 'pending') + '">' + m.status + '</span></td>' +
            '<td>' + (m.completed_at ? formatDateShort(m.completed_at) : '—') + '</td>' +
            '<td>' + (m.status !== 'Completed' ? '<button class="btn-sm" style="color:var(--green)" onclick="completeMaintenance(' + m.id + ')">Complete</button>' : '—') + '</td></tr>'
        ).join('') || '<tr><td colspan="10" class="loading-row">No maintenance scheduled</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function completeMaintenance(sid) {
    var cost = prompt('Actual cost (₹)? Leave blank to skip.');
    try {
        await fetch(`${API_BASE}/api/maintenance/schedule/` + sid, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Completed', actual_cost_inr: cost ? +cost : null })
        });
        showToast('Marked complete!', 'success'); loadMaintenance();
    } catch (e) { showToast(e.message, 'error'); }
}

function openMaintenanceModal() {
    var html = '<div class="modal-form">' +
        '<div class="form-group"><label>Vehicle ID*</label><input id="msVid" placeholder="e.g. MH-TRK-001"></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Type</label>' +
        '<select id="msType"><option>Routine Service</option><option>Oil Change</option><option>Tyre Replacement</option>' +
        '<option>Brake Service</option><option>Engine Overhaul</option><option>Body Repair</option><option>Electrical</option></select></div>' +
        '<div class="form-group"><label>Scheduled Date*</label><input id="msDate" type="date"></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Est. Cost (₹)</label><input id="msCost" type="number" placeholder="5000"></div>' +
        '<div class="form-group"><label>Vendor</label><input id="msVendor" placeholder="Workshop name"></div></div>' +
        '<div class="form-group"><label>Notes</label><input id="msNotes" placeholder="Additional details"></div>' +
        '<button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitMaintenance()"><i class="fas fa-calendar-check"></i> Schedule</button></div>';
    showGenericModal('Schedule Maintenance', html);
}

async function submitMaintenance() {
    var body = {
        vehicle_id: document.getElementById('msVid')?.value.trim(),
        maintenance_type: document.getElementById('msType')?.value,
        scheduled_date: document.getElementById('msDate')?.value,
        estimated_cost_inr: +document.getElementById('msCost')?.value || 0,
        vendor: document.getElementById('msVendor')?.value,
        notes: document.getElementById('msNotes')?.value,
    };
    if (!body.vehicle_id || !body.scheduled_date) { showToast('Vehicle ID & date required', 'warn'); return; }
    try {
        await fetch(`${API_BASE}/api/maintenance/schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        showToast('Maintenance scheduled!', 'success'); closeGenericModal(); loadMaintenance();
    } catch (e) { showToast(e.message, 'error'); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FEATURE 22 — Contract Management
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadContracts() {
    try {
        var res = await fetch(`${API_BASE}/api/contracts`).then(r => r.json());
        var tbody = document.getElementById('contractsTableBody');
        if (!tbody) return;
        tbody.innerHTML = (res.data || []).map(c => {
            var statusCls = c.status === 'Active' ? 'delivered' : c.status === 'Expired' ? 'exception' : 'pending';
            return '<tr>' +
                '<td style="font-family:var(--font-mono)">#' + c.id + '</td>' +
                '<td><strong>' + c.title + '</strong></td>' +
                '<td>' + (c.client_name || c.client_company || '—') + '</td>' +
                '<td>' + (c.start_date || '—') + '</td>' +
                '<td>' + (c.end_date || '—') + '</td>' +
                '<td style="color:var(--accent)">₹' + (c.contract_value_inr || 0).toLocaleString('en-IN') + '</td>' +
                '<td>₹' + (c.rate_per_km || 0) + '/km</td>' +
                '<td>' + (c.min_orders_per_month || 0) + '</td>' +
                '<td style="font-size:11px">' + (c.routes_covered || '—') + '</td>' +
                '<td><span class="pill ' + statusCls + '">' + c.status + '</span></td>' +
                '<td>' +
                '<button class="btn-sm" onclick="updateContractStatus(' + c.id + ', \'Expired\')" style="color:var(--red)">Expire</button>' +
                '</td></tr>';
        }).join('') || '<tr><td colspan="11" class="loading-row">No contracts</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

function openContractModal() {
    var html = '<div class="modal-form">' +
        '<div class="form-group"><label>Contract Title*</label><input id="ctTitle" placeholder="e.g. Annual Mumbai-Pune Route Contract"></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Client Name</label><input id="ctClient" placeholder="Company / Client name"></div>' +
        '<div class="form-group"><label>Contract Value (₹)</label><input id="ctValue" type="number" placeholder="5000000"></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Start Date</label><input id="ctStart" type="date"></div>' +
        '<div class="form-group"><label>End Date</label><input id="ctEnd" type="date"></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Rate per km (₹)</label><input id="ctRate" type="number" step="0.1" placeholder="12.5"></div>' +
        '<div class="form-group"><label>Min Orders/Month</label><input id="ctMinOrders" type="number" placeholder="20"></div></div>' +
        '<div class="form-group"><label>Routes Covered</label><input id="ctRoutes" placeholder="e.g. Mumbai, Pune, Nashik, Nagpur"></div>' +
        '<div class="form-group"><label>Payment Terms</label>' +
        '<select id="ctTerms"><option>30 days</option><option>15 days</option><option>45 days</option><option>60 days</option><option>Advance</option></select></div>' +
        '<button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitContract()"><i class="fas fa-file-contract"></i> Create Contract</button></div>';
    showGenericModal('New Contract', html);
}

async function submitContract() {
    var body = {
        title: document.getElementById('ctTitle')?.value.trim(),
        client_name: document.getElementById('ctClient')?.value,
        contract_value_inr: +document.getElementById('ctValue')?.value || 0,
        start_date: document.getElementById('ctStart')?.value,
        end_date: document.getElementById('ctEnd')?.value,
        rate_per_km: +document.getElementById('ctRate')?.value || 0,
        min_orders_per_month: +document.getElementById('ctMinOrders')?.value || 0,
        routes_covered: document.getElementById('ctRoutes')?.value,
        payment_terms: document.getElementById('ctTerms')?.value,
    };
    if (!body.title) { showToast('Contract title required', 'warn'); return; }
    try {
        var res = await fetch(`${API_BASE}/api/contracts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
        if (res.success) { showToast('Contract created!', 'success'); closeGenericModal(); loadContracts(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

async function updateContractStatus(cid, status) {
    try {
        await fetch(`${API_BASE}/api/contracts/` + cid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
        showToast('Contract status updated', 'success'); loadContracts();
    } catch (e) { showToast(e.message, 'error'); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FEATURE 23 — Reports & Export
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadDeliveryReport() {
    try {
        var res = await fetch(`${API_BASE}/api/reports/delivery-performance`).then(r => r.json());
        var tbody = document.getElementById('deliveryReportBody');
        if (!tbody) return;
        tbody.innerHTML = (res.data || []).map(r =>
            '<tr>' +
            '<td>' + r.source_city + ' â†’ ' + r.destination_city + '</td>' +
            '<td>' + r.total_orders + '</td>' +
            '<td>' + r.delivered + '</td>' +
            '<td><strong style="color:' + (r.delivery_rate_pct >= 80 ? 'var(--green)' : 'var(--orange)') + '">' + r.delivery_rate_pct + '%</strong></td>' +
            '<td>' + (r.avg_km || 0).toLocaleString() + ' km</td>' +
            '<td>₹' + (r.total_revenue || 0).toLocaleString('en-IN') + '</td></tr>'
        ).join('') || '<tr><td colspan="6" class="loading-row">No data</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function loadVehicleReport() {
    try {
        var res = await fetch(`${API_BASE}/api/reports/vehicle-utilization`).then(r => r.json());
        var tbody = document.getElementById('vehicleReportBody');
        if (!tbody) return;
        tbody.innerHTML = (res.data || []).map(v =>
            '<tr>' +
            '<td style="font-family:var(--font-mono);color:var(--accent)">' + v.vehicle_number + '</td>' +
            '<td>' + v.vehicle_type + '</td>' +
            '<td>' + (v.total_orders || 0) + '</td>' +
            '<td>₹' + (v.total_revenue || 0).toLocaleString('en-IN') + '</td>' +
            '<td>' + (v.avg_distance || 0).toLocaleString() + ' km</td></tr>'
        ).join('') || '<tr><td colspan="5" class="loading-row">No data</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

async function loadFinancialReport() {
    try {
        var res = await fetch(`${API_BASE}/api/reports/financial-summary`).then(r => r.json());
        var tbody = document.getElementById('financialReportBody');
        if (!tbody) return;
        tbody.innerHTML = (res.data || []).map(m => {
            var profit = m.profit || 0;
            return '<tr>' +
                '<td><strong>' + (m.month || '—') + '</strong></td>' +
                '<td>' + m.orders + '</td>' +
                '<td style="color:var(--green)">₹' + (m.revenue || 0).toLocaleString('en-IN') + '</td>' +
                '<td style="color:var(--red)">₹' + (m.expenses || 0).toLocaleString('en-IN') + '</td>' +
                '<td style="color:' + (profit >= 0 ? 'var(--green)' : 'var(--red)') + '"><strong>₹' + profit.toLocaleString('en-IN') + '</strong></td></tr>';
        }).join('') || '<tr><td colspan="5" class="loading-row">No data</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FEATURE 24 — Staff / HR Module
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadStaff() {
    try {
        var [listRes, shiftsRes] = await Promise.all([
            fetch(`${API_BASE}/api/staff`).then(r => r.json()),
            fetch(`${API_BASE}/api/staff/shifts`).then(r => r.json()),
        ]);
        var statsEl = document.getElementById('staffStatsRow');
        if (statsEl) {
            var shifts = shiftsRes.shifts || [];
            var depts = shiftsRes.departments || [];
            var total = shifts.reduce((a, s) => a + (s.count || 0), 0);
            statsEl.innerHTML =
                '<div class="fleet-stat"><i class="fas fa-users" style="color:var(--accent);font-size:20px"></i>' +
                '<div><div class="fleet-stat-val">' + total + '</div><div class="fleet-stat-lbl">Active Staff</div></div></div>' +
                shifts.map(s =>
                    '<div class="fleet-stat"><i class="fas fa-user-clock" style="color:var(--yellow);font-size:20px"></i>' +
                    '<div><div class="fleet-stat-val">' + s.count + '</div><div class="fleet-stat-lbl">' + s.shift + ' Shift</div></div></div>'
                ).join('') +
                depts.map(d =>
                    '<div class="fleet-stat"><i class="fas fa-sitemap" style="color:var(--green);font-size:20px"></i>' +
                    '<div><div class="fleet-stat-val">' + d.count + '</div><div class="fleet-stat-lbl">' + d.department + '</div></div></div>'
                ).join('');
        }
        var tbody = document.getElementById('staffTableBody');
        if (!tbody) return;
        tbody.innerHTML = (listRes.data || []).map(s => {
            var statusCls = s.status === 'Active' ? 'Available' : 'Off';
            return '<tr>' +
                '<td style="font-family:var(--font-mono)">#' + s.id + '</td>' +
                '<td><strong>' + s.name + '</strong></td>' +
                '<td>' + s.role + '</td>' +
                '<td>' + (s.department || '—') + '</td>' +
                '<td>' + (s.email || '—') + '</td>' +
                '<td>' + (s.phone || '—') + '</td>' +
                '<td><span class="pill ' + (s.shift === 'Day' ? 'delivered' : 'in-transit') + '">' + s.shift + '</span></td>' +
                '<td>₹' + (s.salary_inr || 0).toLocaleString('en-IN') + '</td>' +
                '<td>' + (s.joined_date || '—') + '</td>' +
                '<td><span class="avail-badge ' + statusCls + '">' + s.status + '</span></td>' +
                '<td><button class="btn-sm" onclick="openEditStaffModal(' + s.id + ')">Edit</button>' +
                ' <button class="btn-sm btn-danger-sm" onclick="deleteStaff(' + s.id + ',\'' + (s.name || '').replace(/'/g, "\\'") + '\')">Delete</button>' +
                '</td></tr>';
        }).join('') || '<tr><td colspan="11" class="loading-row">No staff records</td></tr>';
    } catch (e) { showToast(e.message, 'error'); }
}

function openAddStaffModal() {
    var html = '<div class="modal-form">' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Full Name*</label><input id="sfName" placeholder="John Doe"></div>' +
        '<div class="form-group"><label>Role*</label>' +
        '<select id="sfRole"><option>Dispatcher</option><option>Manager</option><option>Accountant</option>' +
        '<option>Operations</option><option>HR</option><option>IT</option><option>Security</option><option>Supervisor</option></select></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Department</label>' +
        '<select id="sfDept"><option>Operations</option><option>Finance</option><option>HR</option><option>IT</option><option>Administration</option></select></div>' +
        '<div class="form-group"><label>Shift</label>' +
        '<select id="sfShift"><option>Day</option><option>Night</option><option>Split</option></select></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Email</label><input id="sfEmail" type="email" placeholder="staff@fleet.in"></div>' +
        '<div class="form-group"><label>Phone</label><input id="sfPhone" placeholder="+91 XXXXX XXXXX"></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Salary (₹/month)</label><input id="sfSalary" type="number" placeholder="35000"></div>' +
        '<div class="form-group"><label>Join Date</label><input id="sfJoin" type="date" value="' + new Date().toISOString().slice(0, 10) + '"></div></div>' +
        '<button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitAddStaff()"><i class="fas fa-user-plus"></i> Add Staff</button></div>';
    showGenericModal('Add Staff Member', html);
}

async function submitAddStaff() {
    var body = {
        name: document.getElementById('sfName')?.value.trim(),
        role: document.getElementById('sfRole')?.value,
        department: document.getElementById('sfDept')?.value,
        shift: document.getElementById('sfShift')?.value,
        email: document.getElementById('sfEmail')?.value,
        phone: document.getElementById('sfPhone')?.value,
        salary_inr: +document.getElementById('sfSalary')?.value || 0,
        joined_date: document.getElementById('sfJoin')?.value,
    };
    if (!body.name || !body.role) { showToast('Name and role required', 'warn'); return; }
    try {
        var res = await fetch(`${API_BASE}/api/staff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
        if (res.success) { showToast('Staff added!', 'success'); closeGenericModal(); loadStaff(); }
        else showToast(res.error || 'Failed', 'error');
    } catch (e) { showToast(e.message, 'error'); }
}

function openEditStaffModal(sid) {
    var html = '<div class="modal-form">' +
        '<div class="form-group"><label>Shift</label>' +
        '<select id="esShift"><option>Day</option><option>Night</option><option>Split</option></select></div>' +
        '<div class="form-group"><label>Status</label>' +
        '<select id="esStatus"><option>Active</option><option>Inactive</option><option>On Leave</option></select></div>' +
        '<div class="form-group"><label>Salary (₹/month)</label><input id="esSalary" type="number" placeholder="35000"></div>' +
        '<button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitEditStaff(' + sid + ')"><i class="fas fa-save"></i> Save</button></div>';
    showGenericModal('Edit Staff #' + sid, html);
}

async function submitEditStaff(sid) {
    var body = {
        shift: document.getElementById('esShift')?.value,
        status: document.getElementById('esStatus')?.value,
        salary_inr: +document.getElementById('esSalary')?.value || null,
    };
    try {
        await fetch(`${API_BASE}/api/staff/` + sid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        showToast('Staff updated!', 'success'); closeGenericModal(); loadStaff();
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteStaff(sid, name) {
    showDeleteConfirm({
        title: 'Delete Staff Member',
        subtitle: `${name}`,
        confirmName: name,
        warningLines: [
            'This staff record will be permanently removed from the system.',
            'Shift assignments and salary records for this person will be lost.',
            'This action cannot be undone.'
        ],
        onConfirm: async () => {
            try {
                const r = await fetch(`${API_BASE}/api/staff/` + sid, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ _delete: true })
                });
                const text = await r.text();
                let res;
                try { res = JSON.parse(text); } catch { showToast('Server error: ' + text.slice(0, 80), 'error'); return; }
                if (res.success) { showToast('Staff member deleted', 'success'); loadStaff(); }
                else showToast(res.error || 'Delete failed', 'error');
            } catch (e) { showToast(e.message, 'error'); }
        }
    });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FEATURE 25 — Notifications Hub
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadNotifHub() {
    var unreadOnly = document.getElementById('notifUnreadOnly')?.checked ? '1' : '0';
    try {
        var res = await fetch(`${API_BASE}/api/notifications?unread=` + unreadOnly).then(r => r.json());
        var el = document.getElementById('notifHubList');
        if (!el) return;
        // Update nav badge
        var badge = document.getElementById('notifNavBadge');
        if (badge) {
            if (res.unread_count > 0) { badge.style.display = 'inline-block'; badge.textContent = res.unread_count; }
            else badge.style.display = 'none';
        }
        var data = res.data || [];
        if (!data.length) {
            el.innerHTML = '<div class="loading-state"><i class="fas fa-bell-slash"></i><p>No notifications</p></div>';
            return;
        }
        var typeIcons = { info: 'fas fa-info-circle', warn: 'fas fa-exclamation-triangle', error: 'fas fa-times-circle', success: 'fas fa-check-circle' };
        var typeColors = { info: 'var(--accent)', warn: 'var(--yellow)', error: 'var(--red)', success: 'var(--green)' };
        var priorityColors = { High: 'var(--red)', Normal: 'var(--text-muted)', Low: 'var(--text-muted)' };
        el.innerHTML = data.map(n => {
            var ic = typeIcons[n.type] || 'fas fa-bell';
            var col = typeColors[n.type] || 'var(--accent)';
            var pcol = priorityColors[n.priority] || 'var(--text-muted)';
            var bg = n.is_read ? '' : 'background:rgba(99,120,255,0.06);';
            return '<div style="padding:14px 18px;border:1px solid var(--border);border-radius:12px;' + bg + 'display:flex;gap:14px;align-items:flex-start">' +
                '<i class="' + ic + '" style="color:' + col + ';margin-top:3px;font-size:18px"></i>' +
                '<div style="flex:1">' +
                '<div style="display:flex;justify-content:space-between;align-items:center">' +
                '<strong style="color:var(--text-primary)">' + n.title + '</strong>' +
                '<span style="font-size:10px;color:' + pcol + ';font-weight:600">' + n.priority + ' • ' + formatDateShort(n.created_at) + '</span></div>' +
                '<div style="color:var(--text-secondary);font-size:13px;margin-top:4px">' + (n.message || '') + '</div>' +
                (n.related_type ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' + n.related_type + ': ' + (n.related_id || '') + '</div>' : '') +
                '</div>' +
                (!n.is_read ? '<button class="btn-sm" onclick="markNotifRead(' + n.id + ')"><i class="fas fa-check"></i></button>' : '') +
                '</div>';
        }).join('');
    } catch (e) { showToast(e.message, 'error'); }
}

async function markNotifRead(nid) {
    try {
        await fetch(`${API_BASE}/api/notifications/` + nid + '/read', { method: 'POST' });
        loadNotifHub();
    } catch (e) { showToast(e.message, 'error'); }
}

async function markAllNotifRead() {
    try {
        await fetch(`${API_BASE}/api/notifications/read-all`, { method: 'POST' });
        showToast('All notifications marked as read', 'success'); loadNotifHub();
    } catch (e) { showToast(e.message, 'error'); }
}

function openCreateNotifModal() {
    var html = '<div class="modal-form">' +
        '<div class="form-group"><label>Title*</label><input id="nfTitle" placeholder="Notification title"></div>' +
        '<div class="form-group"><label>Message</label><textarea id="nfMsg" rows="3" placeholder="Detailed message..." style="width:100%;padding:8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);resize:vertical"></textarea></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Type</label>' +
        '<select id="nfType"><option value="info">Info</option><option value="warn">Warning</option><option value="error">Error</option><option value="success">Success</option></select></div>' +
        '<div class="form-group"><label>Priority</label>' +
        '<select id="nfPriority"><option>Normal</option><option>High</option><option>Low</option></select></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="form-group"><label>Related Type</label><input id="nfRelType" placeholder="e.g. order, vehicle"></div>' +
        '<div class="form-group"><label>Related ID</label><input id="nfRelId" placeholder="e.g. AHE1417"></div></div>' +
        '<button class="btn-primary" style="width:100%;margin-top:8px" onclick="submitCreateNotif()"><i class="fas fa-bell"></i> Create Notification</button></div>';
    showGenericModal('Create Notification', html);
}

async function submitCreateNotif() {
    var body = {
        title: document.getElementById('nfTitle')?.value.trim(),
        message: document.getElementById('nfMsg')?.value,
        type: document.getElementById('nfType')?.value,
        priority: document.getElementById('nfPriority')?.value,
        related_type: document.getElementById('nfRelType')?.value || null,
        related_id: document.getElementById('nfRelId')?.value || null,
    };
    if (!body.title) { showToast('Title required', 'warn'); return; }
    try {
        await fetch(`${API_BASE}/api/notifications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        showToast('Notification created!', 'success'); closeGenericModal(); loadNotifHub();
    } catch (e) { showToast(e.message, 'error'); }
}
// ═══════════════════════════════════════════════════════════════
// DRIVER FEATURE 4 — TRIP ACCEPT / REJECT / REASSIGN
// ═══════════════════════════════════════════════════════════════
const MissionState = {
    status: 'pending',   // 'pending' | 'accepted' | 'rejected' | 'reassign_requested'
    order: null,
    selectedSeverity: 'low',
    incidentLog: [],
    taskChecks: {},
};

function renderMissionCard(order) {
    MissionState.order = order;
    const badge = document.getElementById('missionStatusBadge');
    const noTrip = document.getElementById('missionNoTrip');
    const detail = document.getElementById('missionTripDetail');
    const grid = document.getElementById('missionInfoGrid');
    const actions = document.getElementById('missionActions');

    if (!order) {
        if (badge) { badge.textContent = 'No Mission'; badge.className = 'mission-status-badge badge-none'; }
        if (noTrip) noTrip.style.display = '';
        if (detail) detail.style.display = 'none';
        return;
    }

    if (noTrip) noTrip.style.display = 'none';
    if (detail) detail.style.display = '';

    const statusMap = {
        pending: { label: 'Awaiting Acceptance', color: 'var(--yellow)', cls: 'badge-pending' },
        accepted: { label: 'Accepted', color: 'var(--green)', cls: 'badge-accepted' },
        rejected: { label: 'Rejected', color: 'var(--red)', cls: 'badge-rejected' },
        reassign_requested: { label: 'Reassign Requested', color: 'var(--orange)', cls: 'badge-reassign' },
    };
    const s = statusMap[MissionState.status] || statusMap.pending;
    if (badge) { badge.textContent = s.label; badge.className = 'mission-status-badge ' + s.cls; }

    if (grid) grid.innerHTML = `
        <div class="mig-row"><label>Order ID</label><span>${order.id || '—'}</span></div>
        <div class="mig-row"><label>Route</label><span>${order.source_city || '?'} → ${order.destination_city || '?'}</span></div>
        <div class="mig-row"><label>Customer</label><span>${order.customer_name || '—'}</span></div>
        <div class="mig-row"><label>Distance</label><span>${order.distance_km ? order.distance_km + ' km' : '—'}</span></div>
        <div class="mig-row"><label>ETA</label><span>${formatDateTime ? formatDateTime(order.expected_delivery_datetime) : (order.expected_delivery_datetime || '—')}</span></div>
        <div class="mig-row"><label>Status</label><span>${order.order_status || '—'}</span></div>`;

    if (actions) {
        if (MissionState.status === 'pending') {
            actions.innerHTML = `
                <button class="trip-action-btn trip-accept" onclick="acceptTrip()"><i class="fas fa-check-circle"></i> Accept Trip</button>
                <button class="trip-action-btn trip-reject" onclick="rejectTrip()"><i class="fas fa-times-circle"></i> Reject Trip</button>
                <button class="trip-action-btn trip-reassign" onclick="requestReassignment()"><i class="fas fa-random"></i> Request Reassign</button>`;
        } else if (MissionState.status === 'accepted') {
            actions.innerHTML = `<div class="trip-accepted-msg"><i class="fas fa-circle-check"></i> Trip accepted — navigation &amp; tasks are now active</div>`;
        } else if (MissionState.status === 'rejected' || MissionState.status === 'reassign_requested') {
            actions.innerHTML = `<div class="trip-pending-msg"><i class="fas fa-clock"></i> Awaiting new assignment from Fleet Command</div>`;
        }
    }
}

function acceptTrip() {
    MissionState.status = 'accepted';
    renderMissionCard(MissionState.order);
    renderTaskList(MissionState.order);
    unlockNavigation(MissionState.order);
    logShiftEvent('Trip accepted: ' + (MissionState.order?.id || ''));
    showToast('Trip accepted — navigation and task list are now active', 'success', 4000);
}

function rejectTrip() {
    MissionState.status = 'rejected';
    renderMissionCard(MissionState.order);
    clearTaskList();
    lockNavigation();
    logShiftEvent('Trip rejected — awaiting new assignment');
    showToast('Trip rejected. Fleet Command notified.', 'info', 3500);
}

function requestReassignment() {
    MissionState.status = 'reassign_requested';
    renderMissionCard(MissionState.order);
    clearTaskList();
    lockNavigation();
    logShiftEvent('Reassignment requested — awaiting Fleet Command');
    showToast('Reassignment request sent to Fleet Command', 'info', 3500);
}

// ═══════════════════════════════════════════════════════════════
// DRIVER FEATURE 5 — MULTI-STOP TASK LIST
// ═══════════════════════════════════════════════════════════════
function renderTaskList(order) {
    const body = document.getElementById('driverTaskBody');
    const prog = document.getElementById('taskProgressLabel');
    if (!body || !order) return;

    // Build synthetic stops from a single order (pickup + delivery)
    // In production these would come from multi-stop order data
    const stops = [
        {
            type: 'pickup',
            label: 'Pickup',
            location: order.source_city || 'Origin',
            orderId: order.id,
            goods: order.goods_type || 'Cargo',
            note: 'Collect and verify cargo — check seal & documents',
            status: 'pending',
        },
        {
            type: 'waypoint',
            label: 'Toll / Checkpoint',
            location: 'Route Checkpoint',
            orderId: order.id,
            goods: null,
            note: 'Pass through and log checkpoint time',
            status: 'pending',
        },
        {
            type: 'delivery',
            label: 'Delivery',
            location: order.destination_city || 'Destination',
            orderId: order.id,
            goods: order.goods_type || 'Cargo',
            note: 'Deliver to consignee — collect signature / POD',
            status: 'pending',
        }
    ];

    MissionState.taskChecks = {};
    stops.forEach((s, i) => { MissionState.taskChecks[i] = false; });
    renderTaskStops(stops);

    const done = Object.values(MissionState.taskChecks).filter(Boolean).length;
    if (prog) prog.textContent = `${done}/${stops.length} stops`;
}

function renderTaskStops(stops) {
    const body = document.getElementById('driverTaskBody');
    if (!body) return;
    const iconMap = { pickup: 'fa-arrow-circle-down', waypoint: 'fa-circle-dot', delivery: 'fa-flag-checkered' };
    const colorMap = { pickup: 'var(--accent)', waypoint: 'var(--yellow)', delivery: 'var(--green)' };

    body.innerHTML = stops.map((s, i) => `
        <div class="task-stop ${MissionState.taskChecks[i] ? 'done' : ''}" id="taskStop${i}">
            <div class="task-stop-line ${i === stops.length - 1 ? 'last' : ''}"></div>
            <div class="task-stop-dot" style="background:${colorMap[s.type] || 'var(--accent)'}">
                <i class="fas ${iconMap[s.type] || 'fa-circle'}" style="font-size:10px"></i>
            </div>
            <div class="task-stop-body">
                <div class="task-stop-head">
                    <span class="task-stop-type">${s.label}</span>
                    ${s.orderId ? `<span class="task-stop-order">#${s.orderId}</span>` : ''}
                </div>
                <div class="task-stop-location"><i class="fas fa-location-dot"></i> ${s.location}</div>
                ${s.goods ? `<div class="task-stop-goods"><i class="fas fa-box"></i> ${s.goods}</div>` : ''}
                <div class="task-stop-note">${s.note}</div>
                <button class="task-stop-btn ${MissionState.taskChecks[i] ? 'task-done-btn' : ''}"
                    onclick="toggleTaskStop(${i}, ${JSON.stringify(stops).split('"').join("'")})"
                    ${MissionState.taskChecks[i] ? '' : ''}>
                    ${MissionState.taskChecks[i] ? '<i class="fas fa-check-circle"></i> Completed' : '<i class="fas fa-circle"></i> Mark Complete'}
                </button>
            </div>
        </div>`).join('');
}

function toggleTaskStop(idx, stopsJson) {
    MissionState.taskChecks[idx] = !MissionState.taskChecks[idx];
    const stops = JSON.parse(stopsJson.split("'").join('"'));
    // update each stop status from taskChecks
    stops.forEach((s, i) => { s.status = MissionState.taskChecks[i] ? 'done' : 'pending'; });
    renderTaskStops(stops);

    const done = Object.values(MissionState.taskChecks).filter(Boolean).length;
    const total = stops.length;
    const prog = document.getElementById('taskProgressLabel');
    if (prog) prog.textContent = `${done}/${total} stops`;
    if (done === total) showToast('All stops completed! Mission accomplished.', 'success', 4000);
}

function clearTaskList() {
    const body = document.getElementById('driverTaskBody');
    const prog = document.getElementById('taskProgressLabel');
    if (body) body.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:13px"><i class="fas fa-route" style="font-size:24px;display:block;margin-bottom:8px;opacity:0.4"></i>Accept a trip to see task steps</div>`;
    if (prog) prog.textContent = '';
}

// ═══════════════════════════════════════════════════════════════
// DRIVER FEATURE 6 — NAVIGATION & ROUTING
// ═══════════════════════════════════════════════════════════════
function unlockNavigation(order) {
    if (!order) return;
    const dest = encodeURIComponent((order.destination_city || '') + ', India');
    const src = encodeURIComponent((order.source_city || '') + ', India');

    const dirs = [
        { step: 1, icon: 'fa-arrow-up', text: `Depart from ${order.source_city || 'origin'} heading toward NH route` },
        { step: 2, icon: 'fa-arrow-right', text: `Follow main highway toward ${order.destination_city}` },
        { step: 3, icon: 'fa-diamond-turn-right', text: 'Use freight corridor — avoid low bridges' },
        { step: 4, icon: 'fa-flag-checkered', text: `Arrive at ${order.destination_city || 'destination'}` },
    ];

    const panel = document.getElementById('navDirectionsPanel');
    const recalc = document.getElementById('navRecalcBtn');
    if (panel) panel.innerHTML = `
        <div class="nav-dir-list">
            ${dirs.map(d => `
                <div class="nav-dir-step">
                    <div class="nav-dir-icon"><i class="fas ${d.icon}"></i></div>
                    <div class="nav-dir-text">${d.text}</div>
                </div>`).join('')}
        </div>`;
    if (recalc) recalc.style.display = '';

    // Enable all map buttons
    ['navGoogleBtn', 'navWazeBtn', 'navAppleBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = false;
    });

    // Store urls for map launch
    window._navUrls = {
        google: `https://www.google.com/maps/dir/${src}/${dest}`,
        waze: `https://waze.com/ul?q=${dest}&navigate=yes`,
        apple: `http://maps.apple.com/?saddr=${src}&daddr=${dest}`,
    };
}

function lockNavigation() {
    ['navGoogleBtn', 'navWazeBtn', 'navAppleBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = true;
    });
    const panel = document.getElementById('navDirectionsPanel');
    if (panel) panel.innerHTML = `<div class="nav-dir-placeholder"><i class="fas fa-map-signs"></i><span>Accept a trip to unlock navigation</span></div>`;
    const recalc = document.getElementById('navRecalcBtn');
    if (recalc) recalc.style.display = 'none';
}

function openInMaps(provider) {
    const url = window._navUrls?.[provider];
    if (url) window.open(url, '_blank');
}

function recalculateRoute() {
    showToast('Recalculating route…', 'info', 2000);
    setTimeout(() => {
        if (MissionState.order) unlockNavigation(MissionState.order);
        showToast('Route updated — check directions', 'success', 3000);
    }, 1500);
}

// ═══════════════════════════════════════════════════════════════
// DRIVER FEATURE 7 — INCIDENT REPORTING
// ═══════════════════════════════════════════════════════════════
const INCIDENT_LABELS = {
    breakdown: 'Vehicle Breakdown', roadblock: 'Roadblock', accident: 'Accident',
    delay: 'Delivery Delay', mechanical: 'Mechanical Issue', other: 'Other',
};

function openIncidentModal(type) {
    const sel = document.getElementById('incidentTypeSelect');
    if (sel && type) sel.value = type;
    MissionState.selectedSeverity = 'low';
    document.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.sev-low')?.classList.add('active');
    const desc = document.getElementById('incidentDesc');
    const delay = document.getElementById('incidentDelay');
    if (desc) desc.value = '';
    if (delay) delay.value = '';
    const title = document.getElementById('incidentModalTitle');
    if (title) title.textContent = 'Report: ' + (INCIDENT_LABELS[type] || 'Incident');
    const modal = document.getElementById('incidentModal');
    if (modal) modal.style.display = 'flex';
}

function closeIncidentModal() {
    const modal = document.getElementById('incidentModal');
    if (modal) modal.style.display = 'none';
}

function selectSeverity(sev, btn) {
    MissionState.selectedSeverity = sev;
    document.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

async function submitIncidentReport() {
    const type = document.getElementById('incidentTypeSelect')?.value || 'other';
    const desc = document.getElementById('incidentDesc')?.value.trim() || '';
    const delay = parseInt(document.getElementById('incidentDelay')?.value || '0');
    const sev = MissionState.selectedSeverity;
    const vid = DriverState.vehicleData?.id || '—';
    const orderId = MissionState.order?.id || null;

    if (!desc) { showToast('Please describe the incident', 'warning', 2500); return; }

    // Send to backend as an incident/exception
    try {
        await fetch(`${API_BASE}/api/incidents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                incident_type: INCIDENT_LABELS[type] || type,
                order_id: orderId,
                vehicle_id: vid,
                description: desc,
                location: DriverState.lastPosition
                    ? `${DriverState.lastPosition.coords.latitude.toFixed(5)}, ${DriverState.lastPosition.coords.longitude.toFixed(5)}`
                    : 'Location unknown',
                severity: sev.charAt(0).toUpperCase() + sev.slice(1),
                estimated_delay_min: delay || 0,
            })
        });
    } catch (e) { /* non-critical if offline */ }

    const entry = { ts: new Date().toLocaleTimeString(), type, sev, desc };
    MissionState.incidentLog.unshift(entry);
    renderIncidentHistory();
    closeIncidentModal();
    logShiftEvent(`Incident reported: ${INCIDENT_LABELS[type]}`);
    showToast('Incident reported — Fleet Command notified', 'success', 4000);
}

function renderIncidentHistory() {
    const el = document.getElementById('incidentHistoryList');
    if (!el || !MissionState.incidentLog.length) return;
    const sevColor = { low: 'var(--accent)', medium: 'var(--yellow)', high: 'var(--red)' };
    el.innerHTML = '<div class="incident-hist-title">Recent Reports</div>' +
        MissionState.incidentLog.slice(0, 4).map(e => `
            <div class="incident-hist-entry">
                <span class="ihe-sev" style="background:${sevColor[e.sev] || 'var(--text-muted)'}22;color:${sevColor[e.sev] || 'var(--text-muted)'};border:1px solid ${sevColor[e.sev] || 'var(--border)'}66">${e.sev}</span>
                <span class="ihe-type">${INCIDENT_LABELS[e.type] || e.type}</span>
                <span class="ihe-ts">${e.ts}</span>
            </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// DRIVER FEATURE 8 — SOS EMERGENCY
// ═══════════════════════════════════════════════════════════════
let _sosActive = false;
let _sosPulse = null;

function triggerSOS() {
    if (_sosActive) { document.getElementById('sosModal').style.display = 'flex'; return; }
    _sosActive = true;

    const vid = DriverState.vehicleData?.id || '—';
    const name = DriverState.vehicleData?.driver_name || '—';
    const lat = DriverState.lastPosition?.coords.latitude?.toFixed(5) || 'Unknown';
    const lng = DriverState.lastPosition?.coords.longitude?.toFixed(5) || 'Unknown';

    // Notify backend (log as critical incident)
    fetch(`${API_BASE}/api/incidents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            incident_type: 'SOS EMERGENCY',
            vehicle_id: vid,
            order_id: MissionState.order?.id || null,
            description: `EMERGENCY SOS triggered by driver ${name}`,
            location: lat !== 'Unknown' ? `${lat}, ${lng}` : 'Location unknown',
            severity: 'High',
            estimated_delay_min: 0,
        })
    }).catch(() => { });

    // Flash SOS button
    const sosBtn = document.getElementById('driverSosBtn');
    if (sosBtn) sosBtn.classList.add('sos-active');
    _sosPulse = setInterval(() => { if (sosBtn) sosBtn.classList.toggle('sos-flash'); }, 500);

    const infoRow = document.getElementById('sosInfoRow');
    if (infoRow) infoRow.innerHTML = `
        <div class="sos-info-item"><i class="fas fa-truck"></i> ${vid}</div>
        <div class="sos-info-item"><i class="fas fa-user"></i> ${name}</div>
        <div class="sos-info-item"><i class="fas fa-location-dot"></i> ${lat !== 'Unknown' ? lat + ', ' + lng : 'Acquiring…'}</div>`;

    document.getElementById('sosModal').style.display = 'flex';
    logShiftEvent('🆘 SOS EMERGENCY TRIGGERED');
    showToast('SOS SENT — Fleet Command alerted!', 'error', 8000);
}

function cancelSOS() {
    _sosActive = false;
    if (_sosPulse) { clearInterval(_sosPulse); _sosPulse = null; }
    const sosBtn = document.getElementById('driverSosBtn');
    if (sosBtn) { sosBtn.classList.remove('sos-active', 'sos-flash'); }
    document.getElementById('sosModal').style.display = 'none';
    logShiftEvent('SOS cancelled (false alarm)');
    showToast('SOS cancelled', 'info', 2500);
}

function callEmergency(type) {
    if (type === '112') { window.location.href = 'tel:112'; }
    else { window.location.href = 'tel:+910000000000'; } // placeholder fleet number
}

// ── Wire mission into populateDriverView ─────────────────────────────────────
const _origPopulateDriverView = populateDriverView;
populateDriverView = function (v) {
    _origPopulateDriverView(v);
    MissionState.status = 'pending';
    MissionState.order = v.current_order || null;
    renderMissionCard(v.current_order || null);
    clearTaskList();
    lockNavigation();
};

// ── Wire sign-out cleanup ────────────────────────────────────────────────────
const _origDoDriverSignOut = doDriverSignOut;
doDriverSignOut = function () {
    cancelSOS();
    MissionState.status = 'pending';
    MissionState.order = null;
    MissionState.incidentLog = [];
    MissionState.taskChecks = {};
    lockNavigation();
    _origDoDriverSignOut();
};

// ═══════════════════════════════════════════════════════════════
// FEATURE 9 — FUEL USAGE LOGGING
// ═══════════════════════════════════════════════════════════════
const FuelState = { entries: [], modalOpen: false };

function openFuelModal() {
    FuelState.modalOpen = true;
    const existing = document.getElementById('fuelEntryModal');
    if (existing) existing.remove();

    const m = document.createElement('div');
    m.id = 'fuelEntryModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9996;display:flex;align-items:center;justify-content:center;padding:20px';
    m.innerHTML = `
    <div class="fuel-modal-card">
        <div class="fuel-modal-header">
            <div>
                <div style="font-family:var(--font-display);font-size:15px;font-weight:700;color:var(--text-primary)">Add Fuel Entry</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Log fuel stop for this trip</div>
            </div>
            <button onclick="closeFuelModal()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer"><i class="fas fa-times"></i></button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
            <div class="fform-row">
                <div class="fform-group">
                    <label>Fuel Station Name</label>
                    <input id="fuelStation" type="text" placeholder="e.g. HP Petrol, NH-44" class="fform-input">
                </div>
            </div>
            <div class="fform-row two-col">
                <div class="fform-group">
                    <label>Quantity (Litres)</label>
                    <input id="fuelQty" type="number" min="1" placeholder="e.g. 80" class="fform-input" oninput="calcFuelTotal()">
                </div>
                <div class="fform-group">
                    <label>Rate (₹ / Litre)</label>
                    <input id="fuelRate" type="number" min="1" placeholder="e.g. 96" class="fform-input" oninput="calcFuelTotal()">
                </div>
            </div>
            <div class="fform-row two-col">
                <div class="fform-group">
                    <label>Odometer (km)</label>
                    <input id="fuelOdo" type="number" min="0" placeholder="e.g. 124500" class="fform-input">
                </div>
                <div class="fform-group">
                    <label>Total Cost (₹)</label>
                    <input id="fuelTotalAmt" type="number" placeholder="Auto-calculated" class="fform-input" readonly style="opacity:.6">
                </div>
            </div>
            <div class="fform-group">
                <label>Payment Method</label>
                <select id="fuelPayMode" class="fform-input">
                    <option>Company Fuel Card</option>
                    <option>Cash (Reimbursable)</option>
                    <option>UPI</option>
                    <option>Company Account</option>
                </select>
            </div>
            <div style="display:flex;gap:10px;margin-top:4px">
                <button onclick="closeFuelModal()" class="fform-cancel">Cancel</button>
                <button onclick="submitFuelEntry()" class="fform-submit"><i class="fas fa-check"></i> Save Entry</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(m);
}

function calcFuelTotal() {
    const qty = parseFloat(document.getElementById('fuelQty')?.value || 0);
    const rate = parseFloat(document.getElementById('fuelRate')?.value || 0);
    const tot = document.getElementById('fuelTotalAmt');
    if (tot) tot.value = qty && rate ? (qty * rate).toFixed(0) : '';
}

function closeFuelModal() {
    document.getElementById('fuelEntryModal')?.remove();
    FuelState.modalOpen = false;
}

function submitFuelEntry() {
    const station = (document.getElementById('fuelStation')?.value || '').trim();
    const qty = parseFloat(document.getElementById('fuelQty')?.value || 0);
    const rate = parseFloat(document.getElementById('fuelRate')?.value || 0);
    const odo = document.getElementById('fuelOdo')?.value || '—';
    const pay = document.getElementById('fuelPayMode')?.value || '—';

    if (!station) { showToast('Enter fuel station name', 'warning', 2000); return; }
    if (!qty || qty <= 0) { showToast('Enter valid quantity', 'warning', 2000); return; }

    const total = qty * rate;
    const entry = {
        ts: new Date().toLocaleTimeString(),
        date: new Date().toLocaleDateString(),
        station, qty, rate, total,
        odo, pay,
        vid: DriverState.vehicleData?.id || '—',
        orderId: MissionState.order?.id || null,
    };
    FuelState.entries.unshift(entry);
    renderFuelLog();
    closeFuelModal();
    logShiftEvent(`Fuel logged: ${qty}L @ ${station}`);
    showToast(`Fuel entry saved — ${qty}L for ₹${total.toFixed(0)}`, 'success', 3500);

    // POST to backend fuel management
    fetch(`${API_BASE}/api/fuel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            vehicle_id: entry.vid,
            liters_consumed: qty,
            cost_inr: total,
            fuel_station: station,
            odometer_km: parseInt(odo) || null,
            fuel_efficiency_kmpl: null,
        })
    }).catch(() => { });
}

function renderFuelLog() {
    const list = document.getElementById('fuelLogList');
    const totL = document.getElementById('fuelTotalLitres');
    const totC = document.getElementById('fuelTotalCost');
    const avg = document.getElementById('fuelAvgRate');
    if (!list) return;

    const totalLitres = FuelState.entries.reduce((s, e) => s + e.qty, 0);
    const totalCost = FuelState.entries.reduce((s, e) => s + e.total, 0);
    const avgRate = totalLitres ? (totalCost / totalLitres) : 0;

    if (totL) totL.textContent = totalLitres.toFixed(1) + ' L';
    if (totC) totC.textContent = '₹' + totalCost.toFixed(0);
    if (avg) avg.textContent = avgRate ? '₹' + avgRate.toFixed(1) : '—';

    if (!FuelState.entries.length) {
        list.innerHTML = '<div class="dcard-empty"><i class="fas fa-fill-drip"></i><span>No fuel entries yet</span></div>';
        return;
    }
    list.innerHTML = FuelState.entries.slice(0, 5).map(e => `
        <div class="fuel-entry">
            <div class="fe-icon"><i class="fas fa-gas-pump"></i></div>
            <div class="fe-body">
                <div class="fe-station">${e.station}</div>
                <div class="fe-meta">${e.qty}L &nbsp;·&nbsp; ₹${e.rate}/L &nbsp;·&nbsp; ${e.pay}</div>
            </div>
            <div class="fe-total">₹${e.total.toFixed(0)}<div class="fe-ts">${e.date}</div></div>
        </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// FEATURE 10 — FATIGUE & REST MONITOR
// ═══════════════════════════════════════════════════════════════
const FatigueState = {
    drivingStartMs: null,
    totalDrivingMs: 0,
    alertSnoozed: false,
    fatigueInterval: null,
    lastBreakMs: null,
};

const FATIGUE_MAX_H = 4.5;
const FATIGUE_WARN_H = 3.0;

function startFatigueTracking() {
    FatigueState.drivingStartMs = Date.now();
    FatigueState.alertSnoozed = false;
    if (FatigueState.fatigueInterval) clearInterval(FatigueState.fatigueInterval);
    FatigueState.fatigueInterval = setInterval(tickFatigue, 10000); // update every 10s
    tickFatigue();
}

function pauseFatigueTracking() {
    if (FatigueState.drivingStartMs) {
        FatigueState.totalDrivingMs += Date.now() - FatigueState.drivingStartMs;
        FatigueState.drivingStartMs = null;
        FatigueState.lastBreakMs = Date.now();
    }
}

function resumeFatigueTracking() {
    FatigueState.drivingStartMs = Date.now();
    FatigueState.alertSnoozed = false;
    tickFatigue();
}

function resetFatigueTracking() {
    FatigueState.drivingStartMs = null;
    FatigueState.totalDrivingMs = 0;
    FatigueState.alertSnoozed = false;
    FatigueState.lastBreakMs = null;
    if (FatigueState.fatigueInterval) { clearInterval(FatigueState.fatigueInterval); FatigueState.fatigueInterval = null; }
    setFatigueRing(0, 'ok');
    const msg = document.getElementById('fatigueMsgText');
    const snz = document.getElementById('fatigueSnoozeBtn');
    if (msg) msg.textContent = 'Start your shift to begin tracking.';
    if (snz) snz.style.display = 'none';
}

function tickFatigue() {
    let elapsedMs = FatigueState.totalDrivingMs;
    if (FatigueState.drivingStartMs) elapsedMs += Date.now() - FatigueState.drivingStartMs;

    const elapsedH = elapsedMs / 3600000;
    const pct = Math.min(elapsedH / FATIGUE_MAX_H, 1);
    const hh = Math.floor(elapsedH);
    const mm = Math.floor((elapsedH - hh) * 60);
    const lbl = document.getElementById('fatigueTimeLabel');
    if (lbl) lbl.textContent = `${hh}:${mm.toString().padStart(2, '0')}`;

    const badge = document.getElementById('fatigueLevelBadge');
    const msg = document.getElementById('fatigueMsgText');
    const snz = document.getElementById('fatigueSnoozeBtn');

    if (elapsedH >= FATIGUE_MAX_H) {
        setFatigueRing(pct, 'critical');
        if (badge) { badge.textContent = 'REST NOW'; badge.className = 'fatigue-badge badge-critical'; }
        if (msg) msg.textContent = '⛔ Mandatory rest required — you have been driving for over 4.5 hours!';
        if (snz) snz.style.display = '';
        if (!FatigueState.alertSnoozed) showToast('⛔ MANDATORY REST — stop driving immediately!', 'error', 8000);
    } else if (elapsedH >= FATIGUE_WARN_H) {
        setFatigueRing(pct, 'warn');
        if (badge) { badge.textContent = 'TAKE BREAK'; badge.className = 'fatigue-badge badge-warn'; }
        if (msg) msg.textContent = '⚠ You have been driving 3+ hours. Plan a break soon.';
        if (snz) snz.style.display = '';
        if (!FatigueState.alertSnoozed) showToast('⚠ 3 hours driving — take a break soon', 'warning', 5000);
    } else {
        setFatigueRing(pct, 'ok');
        if (badge) { badge.textContent = 'OK'; badge.className = 'fatigue-badge badge-ok'; }
        const remaining = FATIGUE_WARN_H - elapsedH;
        if (msg) msg.textContent = `Driving safely. ${remaining.toFixed(1)}h until break reminder.`;
        if (snz) snz.style.display = 'none';
    }
}

function setFatigueRing(pct, state) {
    const r = 50;
    const circ = 2 * Math.PI * r;
    const fill = pct * circ;
    const ring = document.getElementById('fatigueRingFill');
    if (!ring) return;
    ring.setAttribute('stroke-dasharray', `${fill.toFixed(1)} ${(circ - fill).toFixed(1)}`);
    const colors = { ok: 'var(--green)', warn: 'var(--yellow)', critical: 'var(--red)' };
    ring.style.stroke = colors[state] || 'var(--green)';
}

function snoozeFatigueAlert() {
    FatigueState.alertSnoozed = true;
    showToast('Alert acknowledged — please rest as soon as possible', 'info', 3000);
    const snz = document.getElementById('fatigueSnoozeBtn');
    if (snz) snz.style.display = 'none';
}

// Hook fatigue into shift lifecycle
const _origStartShiftTimer = startShiftTimer;
startShiftTimer = function () {
    _origStartShiftTimer();
    startFatigueTracking();
};

const _origDrvTakeBreak = driverTakeBreak;
driverTakeBreak = function () {
    _origDrvTakeBreak();
    pauseFatigueTracking();
};

const _origDrvResumeShift = driverResumeShift;
driverResumeShift = function () {
    _origDrvResumeShift();
    resumeFatigueTracking();
};

const _origDrvEndShift = driverEndShift;
driverEndShift = function () {
    _origDrvEndShift();
    resetFatigueTracking();
};

// ═══════════════════════════════════════════════════════════════
// FEATURE 11 — CARGO DETAILS
// ═══════════════════════════════════════════════════════════════
function renderCargoDetails(order) {
    const body = document.getElementById('cargoDetailsBody');
    if (!body) return;
    if (!order) {
        body.innerHTML = '<div class="dcard-empty"><i class="fas fa-box-open"></i><span>Accept a trip to view cargo info</span></div>';
        return;
    }

    const goodsType = order.goods_type || 'General Cargo';
    const weightKg = order.weight_kg || (Math.floor(Math.random() * 8000) + 2000);
    const fragile = /fragile|glass|ceramic|electronics/i.test(goodsType);
    const hazmat = /chemical|hazmat|flammable|corrosive/i.test(goodsType);
    const perishable = /food|pharma|medicine|vaccine|dairy/i.test(goodsType);
    const refrig = /refriger|frozen|cold|chilled/i.test(goodsType) || perishable;

    const flags = [];
    if (fragile) flags.push({ icon: 'fa-wine-glass-crack', color: 'var(--yellow)', label: 'Fragile — Handle with care' });
    if (hazmat) flags.push({ icon: 'fa-biohazard', color: 'var(--red)', label: 'Hazmat — Follow safety protocol' });
    if (perishable) flags.push({ icon: 'fa-temperature-low', color: '#60C8FF', label: 'Perishable — Temperature sensitive' });
    if (refrig) flags.push({ icon: 'fa-snowflake', color: '#60C8FF', label: 'Cold chain required — maintain temp' });

    body.innerHTML = `
        <div class="cargo-info-grid">
            <div class="cig-row"><label><i class="fas fa-box"></i> Goods Type</label><span>${goodsType}</span></div>
            <div class="cig-row"><label><i class="fas fa-weight-hanging"></i> Weight</label><span>${weightKg.toLocaleString()} kg</span></div>
            <div class="cig-row"><label><i class="fas fa-ruler-combined"></i> Volume</label><span>${order.volume_cbm ? order.volume_cbm + ' m³' : '—'}</span></div>
            <div class="cig-row"><label><i class="fas fa-hashtag"></i> Packages</label><span>${order.package_count || '—'}</span></div>
            <div class="cig-row"><label><i class="fas fa-tag"></i> Order ID</label><span class="mono-val">${order.id || '—'}</span></div>
            <div class="cig-row"><label><i class="fas fa-building"></i> Customer</label><span>${order.customer_name || '—'}</span></div>
        </div>
        ${flags.length ? `
        <div class="cargo-flags">
            ${flags.map(f => `
            <div class="cargo-flag" style="border-color:${f.color}33;background:${f.color}11">
                <i class="fas ${f.icon}" style="color:${f.color}"></i>
                <span style="color:${f.color};font-weight:600">${f.label}</span>
            </div>`).join('')}
        </div>` : ''}
        <div class="cargo-handling-note">
            <i class="fas fa-clipboard-list" style="color:var(--accent)"></i>
            <div>
                <div style="font-weight:700;margin-bottom:3px;color:var(--text-primary)">Handling Instructions</div>
                <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">
                    ${fragile ? 'Handle with extreme care. Do not stack heavy items on top. ' : ''}
                    ${hazmat ? 'Hazardous materials — ensure proper ventilation and no open flames nearby. ' : ''}
                    ${refrig ? 'Maintain cold chain throughout transit. Alert if cooling fails. ' : ''}
                    ${!fragile && !hazmat && !refrig ? 'Standard freight handling procedures apply. Secure load before departure.' : ''}
                </div>
            </div>
        </div>`;

    // Show cold chain card if refrigerated cargo
    const ccCard = document.getElementById('driverColdChainCard');
    if (ccCard) ccCard.style.display = refrig ? '' : 'none';
    if (refrig) initColdChain();
}

// ═══════════════════════════════════════════════════════════════
// FEATURE 12 — COLD CHAIN / TEMPERATURE MONITORING
// ═══════════════════════════════════════════════════════════════
const ColdChainState = {
    setpointC: -18,
    currentTemp: -18,
    unitActive: true,
    tempLog: [],
    interval: null,
};

function initColdChain() {
    const ccSetEl = document.getElementById('ccSetpoint');
    if (ccSetEl) ccSetEl.textContent = ColdChainState.setpointC + '°C';
    if (ColdChainState.interval) clearInterval(ColdChainState.interval);
    ColdChainState.interval = setInterval(tickColdChain, 8000);
    tickColdChain();
}

function tickColdChain() {
    if (!ColdChainState.unitActive) {
        ColdChainState.currentTemp += 0.3 + Math.random() * 0.4;
    } else {
        const diff = ColdChainState.currentTemp - ColdChainState.setpointC;
        const adjust = diff > 0 ? -0.4 : 0.05;
        ColdChainState.currentTemp += adjust + (Math.random() - 0.5) * 0.2;
    }
    ColdChainState.currentTemp = Math.max(-30, Math.min(25, ColdChainState.currentTemp));
    const ambient = 28 + (Math.random() - 0.5) * 4;
    const temp = parseFloat(ColdChainState.currentTemp.toFixed(1));

    ColdChainState.tempLog.unshift({ ts: new Date().toLocaleTimeString(), temp });
    if (ColdChainState.tempLog.length > 10) ColdChainState.tempLog.pop();

    const cargoEl = document.getElementById('ccCargoTemp');
    const ambientEl = document.getElementById('ccAmbientTemp');
    const barEl = document.getElementById('ccCargoTempBar');
    if (cargoEl) cargoEl.textContent = temp + '°C';
    if (ambientEl) ambientEl.textContent = ambient.toFixed(1) + '°C';

    // Range: -30°C = 0%, 25°C = 100%
    if (barEl) barEl.style.width = ((temp + 30) / 55 * 100).toFixed(1) + '%';

    const tolerance = 4;
    const isAlert = temp > (ColdChainState.setpointC + tolerance);
    const badge = document.getElementById('coldChainStatusBadge');
    const alertBann = document.getElementById('ccAlertBanner');
    const alertTxt = document.getElementById('ccAlertText');
    const logEl = document.getElementById('ccTempLog');

    if (badge) {
        badge.textContent = isAlert ? 'ALERT' : 'NOMINAL';
        badge.className = 'cc-badge ' + (isAlert ? 'cc-alert' : 'cc-ok');
    }
    if (alertBann) alertBann.style.display = isAlert ? '' : 'none';
    if (alertTxt && isAlert) alertTxt.textContent = `Cargo temp ${temp}°C exceeds setpoint ${ColdChainState.setpointC}°C by ${(temp - ColdChainState.setpointC).toFixed(1)}°C!`;
    if (isAlert) showToast(`🌡 Cold chain alert: ${temp}°C cargo temp`, 'error', 6000);

    if (logEl) logEl.innerHTML = ColdChainState.tempLog.slice(0, 6).map(e =>
        `<div class="cc-log-row"><span class="cc-log-ts">${e.ts}</span><span class="cc-log-val" style="color:${e.temp > ColdChainState.setpointC + tolerance ? 'var(--red)' : 'var(--green)'}">${e.temp}°C</span></div>`
    ).join('');
}

function toggleCoolingUnit() {
    ColdChainState.unitActive = !ColdChainState.unitActive;
    const lbl = document.getElementById('ccUnitLabel');
    const ico = document.querySelector('#ccUnitStatus .fa-fan');
    if (lbl) lbl.textContent = ColdChainState.unitActive ? 'Active' : 'OFF';
    if (ico) ico.style.animationPlayState = ColdChainState.unitActive ? 'running' : 'paused';
    showToast(`Cooling unit ${ColdChainState.unitActive ? 'activated' : 'switched off'}`, ColdChainState.unitActive ? 'success' : 'warning', 3000);
}

// ═══════════════════════════════════════════════════════════════
// FEATURE 13 — DELIVERY CONFIRMATION
// ═══════════════════════════════════════════════════════════════
const DelivState = {
    method: null,
    otpGenerated: null,
    signatureData: null,
    photoData: null,
    confirmed: false,
};

function renderDelivConfOptions(order) {
    const body = document.getElementById('delivConfBody');
    const badge = document.getElementById('delivConfBadge');
    if (!body) return;

    if (!order) {
        body.innerHTML = '<div class="dcard-empty"><i class="fas fa-signature"></i><span>Accept a trip to enable delivery confirmation</span></div>';
        if (badge) { badge.textContent = 'Pending'; badge.className = 'deliv-badge badge-pending-del'; }
        return;
    }

    if (DelivState.confirmed) {
        body.innerHTML = `<div class="deliv-confirmed-msg"><i class="fas fa-circle-check"></i> Delivery confirmed &amp; POD submitted</div>`;
        if (badge) { badge.textContent = 'Confirmed'; badge.className = 'deliv-badge badge-confirmed-del'; }
        return;
    }

    if (badge) { badge.textContent = 'Pending'; badge.className = 'deliv-badge badge-pending-del'; }

    // Generate OTP for this delivery
    DelivState.otpGenerated = String(Math.floor(100000 + Math.random() * 900000));

    body.innerHTML = `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Choose a method to confirm delivery to <strong>${order.customer_name || 'customer'}</strong></div>
        <div class="deliv-method-row">
            <button class="deliv-method-btn" onclick="selectDelivMethod('otp')">
                <i class="fas fa-mobile-screen-button" style="color:var(--accent)"></i>
                <span>Customer OTP</span>
                <small>6-digit code sent to customer</small>
            </button>
            <button class="deliv-method-btn" onclick="selectDelivMethod('signature')">
                <i class="fas fa-signature" style="color:var(--yellow)"></i>
                <span>Signature</span>
                <small>Capture on-screen signature</small>
            </button>
            <button class="deliv-method-btn" onclick="selectDelivMethod('photo')">
                <i class="fas fa-camera" style="color:var(--green)"></i>
                <span>Photo Proof</span>
                <small>Photograph of delivered parcel</small>
            </button>
        </div>
        <div id="delivMethodPanel" style="margin-top:14px"></div>`;
}

function selectDelivMethod(method) {
    DelivState.method = method;
    document.querySelectorAll('.deliv-method-btn').forEach(b => b.classList.remove('active-method'));
    const panel = document.getElementById('delivMethodPanel');

    if (method === 'otp') {
        // Show OTP in toast (in production: SMS to customer)
        showToast(`Demo OTP for customer: ${DelivState.otpGenerated}`, 'info', 15000);
        panel.innerHTML = `
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
                <i class="fas fa-info-circle"></i> OTP has been sent to the customer's registered number
            </div>
            <div class="otp-boxes" id="delivOtpBoxes">
                ${[0, 1, 2, 3, 4, 5].map(i => `<input class="otp-box" maxlength="1" type="text" inputmode="numeric"
                    oninput="delivOtpNav(this,${i})" onkeydown="delivOtpBack(this,event,${i})">`).join('')}
            </div>
            <button onclick="verifyDelivOTP()" class="deliv-submit-btn" style="margin-top:12px"><i class="fas fa-check"></i> Verify &amp; Confirm</button>`;
    } else if (method === 'signature') {
        panel.innerHTML = `
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Ask the customer to sign in the box below</div>
            <canvas id="signaturePad" class="signature-canvas" width="100%" height="140"></canvas>
            <div style="display:flex;gap:8px;margin-top:10px">
                <button onclick="clearSignature()" class="sig-clear-btn"><i class="fas fa-eraser"></i> Clear</button>
                <button onclick="submitSignatureProof()" class="deliv-submit-btn" style="flex:2"><i class="fas fa-check"></i> Confirm Delivery</button>
            </div>`;
        setTimeout(initSignaturePad, 100);
    } else if (method === 'photo') {
        panel.innerHTML = `
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Take a photo of the delivered parcel</div>
            <input type="file" id="photoProofInput" accept="image/*" capture="environment" style="display:none" onchange="handlePhotoProof(this)">
            <button onclick="document.getElementById('photoProofInput').click()" class="photo-capture-btn">
                <i class="fas fa-camera"></i> Open Camera / Choose Photo
            </button>
            <div id="photoPreview" style="margin-top:10px"></div>`;
    }
}

function delivOtpNav(el, idx) {
    el.value = el.value.replace(/\D/, '');
    if (el.value && idx < 5) document.querySelectorAll('#delivOtpBoxes .otp-box')[idx + 1]?.focus();
}
function delivOtpBack(el, e, idx) {
    if (e.key === 'Backspace' && !el.value && idx > 0) document.querySelectorAll('#delivOtpBoxes .otp-box')[idx - 1]?.focus();
}

function verifyDelivOTP() {
    const entered = Array.from(document.querySelectorAll('#delivOtpBoxes .otp-box')).map(b => b.value).join('');
    if (entered.length < 6) { showToast('Enter full 6-digit OTP', 'warning', 2000); return; }
    if (entered !== DelivState.otpGenerated) { showToast('Incorrect OTP — try again', 'error', 3000); return; }
    finaliseDelivery('otp');
}

let _sigCtx = null, _sigDrawing = false;
function initSignaturePad() {
    const canvas = document.getElementById('signaturePad');
    if (!canvas) return;
    canvas.width = canvas.offsetWidth || 320;
    canvas.height = 140;
    _sigCtx = canvas.getContext('2d');
    _sigCtx.strokeStyle = '#00b8ff';
    _sigCtx.lineWidth = 2.5;
    _sigCtx.lineCap = 'round';

    const pos = (e) => {
        const r = canvas.getBoundingClientRect();
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    canvas.onmousedown = canvas.ontouchstart = (e) => { e.preventDefault(); _sigDrawing = true; const p = pos(e); _sigCtx.beginPath(); _sigCtx.moveTo(p.x, p.y); };
    canvas.onmousemove = canvas.ontouchmove = (e) => { e.preventDefault(); if (!_sigDrawing) return; const p = pos(e); _sigCtx.lineTo(p.x, p.y); _sigCtx.stroke(); };
    canvas.onmouseup = canvas.ontouchend = () => { _sigDrawing = false; };
}

function clearSignature() {
    const canvas = document.getElementById('signaturePad');
    if (canvas && _sigCtx) _sigCtx.clearRect(0, 0, canvas.width, canvas.height);
}

function submitSignatureProof() {
    const canvas = document.getElementById('signaturePad');
    if (!canvas) return;
    const data = canvas.toDataURL('image/png');
    const blank = document.createElement('canvas');
    blank.width = canvas.width; blank.height = canvas.height;
    if (data === blank.toDataURL()) { showToast('Please capture signature first', 'warning', 2500); return; }
    DelivState.signatureData = data;
    finaliseDelivery('signature');
}

function handlePhotoProof(input) {
    if (!input.files[0]) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        DelivState.photoData = e.target.result;
        const prev = document.getElementById('photoPreview');
        if (prev) prev.innerHTML = `
            <img src="${e.target.result}" style="width:100%;max-height:160px;object-fit:cover;border-radius:10px;border:1px solid var(--border)">
            <button onclick="submitPhotoProof()" class="deliv-submit-btn" style="margin-top:8px;width:100%"><i class="fas fa-check"></i> Confirm with this photo</button>`;
    };
    reader.readAsDataURL(input.files[0]);
}

function submitPhotoProof() {
    if (!DelivState.photoData) { showToast('Select a photo first', 'warning', 2000); return; }
    finaliseDelivery('photo');
}

function finaliseDelivery(method) {
    DelivState.confirmed = true;
    const order = MissionState.order;

    // Update backend POD
    const podOrderId = order?.id;
    if (podOrderId) {
        fetch(`${API_BASE}/api/pod/${podOrderId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pod_type: method === 'signature' ? 'Signature' : method === 'photo' ? 'Photo' : 'OTP',
                pod_reference: `DRV-${method.toUpperCase()}-${Date.now()}`,
                pod_collected_at: new Date().toISOString(),
            })
        }).catch(() => { });
    }

    renderDelivConfOptions(order);
    logShiftEvent(`Delivery confirmed via ${method}`);
    showToast('✅ Delivery confirmed — POD submitted to Fleet Command', 'success', 5000);
}

// ═══════════════════════════════════════════════════════════════
// FEATURE 14 — DISPATCH COMMUNICATIONS
// ═══════════════════════════════════════════════════════════════
const CommsState = {
    messages: [],
    unread: 0,
    dispatchReplies: [
        'Acknowledged — Fleet Command noted.',
        'Copy that. Continue on your route.',
        'Understood, coordinating with operations.',
        'Roger. Keep us updated if situation changes.',
        'Received. Dispatcher is on standby.',
        'Got it — we\'re tracking your location.',
    ],
};

function initCommsChat() {
    const msgs = document.getElementById('commsChatMessages');
    if (!msgs) return;
    CommsState.messages = [
        { sender: 'dispatch', text: `Good ${getTimeGreeting()} — Fleet Command is online. Drive safe!`, ts: new Date().toLocaleTimeString() }
    ];
    renderCommsMsgs();

    // Simulate an incoming message after 30 seconds
    setTimeout(() => {
        addDispatchMsg('Reminder: report fuel stops and any delays via the system.');
    }, 30000);
}

function getTimeGreeting() {
    const h = new Date().getHours();
    return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

function addDispatchMsg(text) {
    CommsState.messages.push({ sender: 'dispatch', text, ts: new Date().toLocaleTimeString() });
    CommsState.unread++;
    const badge = document.getElementById('commsUnreadBadge');
    if (badge) { badge.textContent = CommsState.unread; badge.style.display = ''; }
    renderCommsMsgs();
    showToast(`📡 Dispatch: ${text.slice(0, 50)}…`, 'info', 5000);
}

function sendDriverChat() {
    const input = document.getElementById('commsChatInput');
    const text = (input?.value || '').trim();
    if (!text) return;
    CommsState.messages.push({ sender: 'driver', text, ts: new Date().toLocaleTimeString() });
    if (input) input.value = '';
    renderCommsMsgs();

    // Auto-reply from dispatch
    const reply = CommsState.dispatchReplies[Math.floor(Math.random() * CommsState.dispatchReplies.length)];
    setTimeout(() => addDispatchMsg(reply), 1500 + Math.random() * 2000);
}

function renderCommsMsgs() {
    const msgs = document.getElementById('commsChatMessages');
    if (!msgs) return;

    // Reset unread on render
    CommsState.unread = 0;
    const badge = document.getElementById('commsUnreadBadge');
    if (badge) badge.style.display = 'none';

    msgs.innerHTML = CommsState.messages.map(m => `
        <div class="chat-msg ${m.sender === 'driver' ? 'msg-driver' : 'msg-dispatch'}">
            <div class="chat-bubble">${m.text}</div>
            <div class="chat-ts">${m.ts}</div>
        </div>`).join('');
    msgs.scrollTop = msgs.scrollHeight;
}

function callDispatcher() {
    showToast('Calling Fleet Dispatcher…', 'info', 3000);
    window.location.href = 'tel:+911800123456';
}

function callOperations() {
    showToast('Calling Operations Centre…', 'info', 3000);
    window.location.href = 'tel:+911800654321';
}

// ── Wire all features into acceptTrip ────────────────────────────────────────
const _origAcceptTrip = acceptTrip;
acceptTrip = function () {
    _origAcceptTrip();
    const order = MissionState.order;
    renderCargoDetails(order);
    renderDelivConfOptions(order);
    initCommsChat();
};

// Also wire into populateDriverView cleanup
const _origPopDrv = populateDriverView;
populateDriverView = function (v) {
    _origPopDrv(v);
    renderCargoDetails(null);
    renderDelivConfOptions(null);
    const ccCard = document.getElementById('driverColdChainCard');
    if (ccCard) ccCard.style.display = 'none';
    if (ColdChainState.interval) { clearInterval(ColdChainState.interval); ColdChainState.interval = null; }
    initCommsChat();
    DelivState.confirmed = false;
    DelivState.method = null;
};

// ═══════════════════════════════════════════════════════════════
// FEATURE 15 — OFFLINE MODE & DATA SYNC
// ═══════════════════════════════════════════════════════════════
const OfflineState = {
    isOnline: navigator.onLine,
    queue: [],      // { id, type, url, method, body, ts }
    synced: 0,
    failed: 0,
    syncing: false,
};

(function initOfflineListeners() {
    window.addEventListener('online', () => { OfflineState.isOnline = true; onNetworkChange(true); });
    window.addEventListener('offline', () => { OfflineState.isOnline = false; onNetworkChange(false); });
})();

function onNetworkChange(online) {
    updateOfflineUI();
    if (online) {
        showToast('📶 Network restored — syncing queued data…', 'success', 4000);
        syncOfflineQueue();
    } else {
        showToast('📵 Network lost — data will be stored offline', 'warning', 4000);
    }
}

function updateOfflineUI() {
    const badge = document.getElementById('offlineStatusBadge');
    const icon = document.getElementById('offlineWifiIcon');
    const qCount = document.getElementById('offlineQueueCount');
    const sCount = document.getElementById('offlineSyncedCount');
    const fCount = document.getElementById('offlineFailCount');
    const syncBtn = document.getElementById('offlineSyncBtn');

    const online = OfflineState.isOnline;
    if (badge) { badge.textContent = online ? 'ONLINE' : 'OFFLINE'; badge.className = 'offline-badge ' + (online ? 'badge-online' : 'badge-offline'); }
    if (icon) { icon.className = 'fas fa-wifi'; icon.style.color = online ? 'var(--green)' : 'var(--red)'; }
    if (qCount) qCount.textContent = OfflineState.queue.length;
    if (sCount) sCount.textContent = OfflineState.synced;
    if (fCount) fCount.textContent = OfflineState.failed;
    if (syncBtn) syncBtn.style.display = (OfflineState.queue.length && online) ? '' : 'none';
    renderOfflineQueue();
}

function renderOfflineQueue() {
    const list = document.getElementById('offlineQueueList');
    if (!list) return;
    if (!OfflineState.queue.length) {
        list.innerHTML = '<div class="dcard-empty"><i class="fas fa-database"></i><span>All data synced — no queue</span></div>';
        return;
    }
    const typeIcons = { gps: 'fa-location-dot', fuel: 'fa-gas-pump', incident: 'fa-triangle-exclamation', pod: 'fa-circle-check', cargo: 'fa-boxes-stacked' };
    list.innerHTML = OfflineState.queue.slice(0, 6).map(q => `
        <div class="offline-queue-item">
            <i class="fas ${typeIcons[q.type] || 'fa-database'}" style="color:var(--yellow)"></i>
            <div class="oqi-body">
                <div class="oqi-type">${q.type.toUpperCase()}</div>
                <div class="oqi-ts">${q.ts}</div>
            </div>
            <div class="oqi-status"><i class="fas fa-clock" style="color:var(--yellow)"></i></div>
        </div>`).join('');
}

// Intercept fetch for offline queueing — wraps any driver POST
async function offlineSafeFetch(type, url, body) {
    const entry = { id: Date.now() + Math.random(), type, url, method: 'POST', body, ts: new Date().toLocaleTimeString() };
    if (!OfflineState.isOnline) {
        OfflineState.queue.push(entry);
        updateOfflineUI();
        showToast(`📦 Saved offline: ${type} — will sync when online`, 'info', 3000);
        return;
    }
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        OfflineState.synced++;
    } catch (e) {
        OfflineState.queue.push(entry);
        OfflineState.failed++;
    }
    updateOfflineUI();
}

async function syncOfflineQueue() {
    if (OfflineState.syncing || !OfflineState.queue.length) return;
    OfflineState.syncing = true;
    const toSync = [...OfflineState.queue];
    OfflineState.queue = [];
    let ok = 0, fail = 0;
    for (const q of toSync) {
        try {
            await fetch(q.url, { method: q.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q.body) });
            ok++;
        } catch (e) {
            OfflineState.queue.push(q);
            fail++;
        }
    }
    OfflineState.synced += ok;
    OfflineState.failed += fail;
    OfflineState.syncing = false;
    updateOfflineUI();
    if (ok) showToast(`✅ Synced ${ok} offline record${ok > 1 ? 's' : ''}`, 'success', 3000);
}

function manualSync() { syncOfflineQueue(); }

// ─── Boot offline status ─────────────────────────────────────
setTimeout(updateOfflineUI, 400);

// ═══════════════════════════════════════════════════════════════
// FEATURE 16 — DRIVER PERFORMANCE DASHBOARD
// ═══════════════════════════════════════════════════════════════
async function loadDriverPerformance(vehicleId) {
    try {
        // Fetch orders for this vehicle
        const res = await fetch(`${API_BASE}/api/orders?vehicle_id=${vehicleId}&limit=200`).then(r => r.json());
        const all = (res.data || res.orders || []).filter(o => o.vehicle_id === vehicleId || !vehicleId);
        const done = all.filter(o => o.order_status === 'Delivered');
        const total = done.length;
        const distKm = done.reduce((s, o) => s + (parseFloat(o.distance_km) || 0), 0);

        // On-time: actual_delivery_datetime <= expected_delivery_datetime
        const onTime = done.filter(o => {
            if (!o.actual_delivery_datetime || !o.expected_delivery_datetime) return false;
            return new Date(o.actual_delivery_datetime) <= new Date(o.expected_delivery_datetime);
        }).length;
        const onTimePct = total ? Math.round(onTime / total * 100) : 0;

        // Safety score from DriverState scores if available
        const safetyScore = DriverState.vehicleData?.id
            ? (typeof initDriverScore === 'function' ? (() => { initDriverScore(vehicleId); return State?.driverScores?.[vehicleId]?.score || 85; })() : 85)
            : 85;

        renderPerformanceDashboard({ total, distKm: Math.round(distKm), onTimePct, safetyScore, all: done });
    } catch (e) {
        renderPerformanceDashboard({ total: 0, distKm: 0, onTimePct: 0, safetyScore: 0, all: [] });
    }
}

function renderPerformanceDashboard({ total, distKm, onTimePct, safetyScore, all }) {
    const grid = document.getElementById('perfKpiGrid');
    const badge = document.getElementById('perfScoreBadge');
    const chartWrap = document.getElementById('perfChartWrap');
    if (!grid) return;

    const scoreColor = safetyScore >= 80 ? 'var(--green)' : safetyScore >= 60 ? 'var(--yellow)' : 'var(--red)';
    if (badge) { badge.textContent = safetyScore + ' pts'; badge.style.background = scoreColor + '22'; badge.style.color = scoreColor; badge.style.border = `1px solid ${scoreColor}55`; }

    grid.innerHTML = `
        <div class="perf-kpi"><div class="perf-kpi-val">${total}</div><div class="perf-kpi-lbl"><i class="fas fa-flag-checkered"></i> Trips Done</div></div>
        <div class="perf-kpi"><div class="perf-kpi-val">${onTimePct}%</div><div class="perf-kpi-lbl"><i class="fas fa-clock"></i> On-Time Rate</div></div>
        <div class="perf-kpi"><div class="perf-kpi-val">${distKm.toLocaleString()}</div><div class="perf-kpi-lbl"><i class="fas fa-road"></i> km Driven</div></div>
        <div class="perf-kpi"><div class="perf-kpi-val" style="color:${scoreColor}">${safetyScore}</div><div class="perf-kpi-lbl"><i class="fas fa-shield"></i> Safety Score</div></div>`;

    // Mini bar chart — last 6 months trip counts
    if (all.length && chartWrap) {
        chartWrap.style.display = '';
        const months = {};
        all.forEach(o => {
            const d = new Date(o.actual_delivery_datetime || o.created_at || Date.now());
            const key = d.toLocaleDateString('en', { month: 'short' });
            months[key] = (months[key] || 0) + 1;
        });
        const labels = Object.keys(months).slice(-6);
        const vals = labels.map(k => months[k]);
        const canvas = document.getElementById('perfBarChart');
        if (canvas && window.Chart) {
            if (canvas._chart) canvas._chart.destroy();
            canvas._chart = new Chart(canvas, {
                type: 'bar',
                data: { labels, datasets: [{ data: vals, backgroundColor: 'rgba(0,180,255,0.55)', borderRadius: 5, label: 'Trips' }] },
                options: {
                    responsive: true, plugins: { legend: { display: false } },
                    scales: {
                        x: { ticks: { color: '#888', font: { size: 10 } }, grid: { display: false } },
                        y: { ticks: { color: '#888', font: { size: 10 }, stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.05)' } }
                    }
                }
            });
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// FEATURE 17 — DIGITAL DOCUMENT STORAGE
// ═══════════════════════════════════════════════════════════════
const DocState = { docs: [], selectedFile: null };

const DOC_TYPES = {
    license: { label: 'Driver License', icon: 'fa-id-card', color: 'var(--accent)' },
    rc: { label: 'Vehicle RC', icon: 'fa-car', color: 'var(--green)' },
    insurance: { label: 'Insurance', icon: 'fa-shield-halved', color: 'var(--yellow)' },
    permit: { label: 'Route Permit', icon: 'fa-file-contract', color: 'var(--orange)' },
    fitness: { label: 'Fitness Certificate', icon: 'fa-heart-pulse', color: 'var(--red)' },
    pollution: { label: 'PUC Certificate', icon: 'fa-smog', color: 'var(--text-secondary)' },
    medical: { label: 'Medical Certificate', icon: 'fa-user-doctor', color: '#60C8FF' },
    other: { label: 'Other Document', icon: 'fa-file-lines', color: 'var(--text-muted)' },
};

function openDocUpload() {
    DocState.selectedFile = null;
    const prev = document.getElementById('docFilePreview');
    const btn = document.getElementById('docSubmitBtn');
    if (prev) prev.textContent = '';
    if (btn) { btn.disabled = true; btn.style.opacity = '.4'; }
    document.getElementById('docUploadModal').style.display = 'flex';
}
function closeDocUpload() {
    document.getElementById('docUploadModal').style.display = 'none';
}

function handleDocFile(input) {
    if (!input.files[0]) return;
    DocState.selectedFile = input.files[0];
    const prev = document.getElementById('docFilePreview');
    const btn = document.getElementById('docSubmitBtn');
    if (prev) prev.innerHTML = `<i class="fas fa-file-check" style="color:var(--green)"></i> ${input.files[0].name} (${(input.files[0].size / 1024).toFixed(1)} KB)`;
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
}

function submitDoc() {
    if (!DocState.selectedFile) return;
    const type = document.getElementById('docTypeSelect')?.value || 'other';
    const expiry = document.getElementById('docExpiry')?.value || null;
    const docNum = document.getElementById('docNumber')?.value?.trim() || null;
    const cfg = DOC_TYPES[type] || DOC_TYPES.other;

    const entry = {
        id: Date.now(),
        type, label: cfg.label,
        fileName: DocState.selectedFile.name,
        fileSize: DocState.selectedFile.size,
        docNumber: docNum,
        expiry,
        uploadedAt: new Date().toLocaleDateString(),
        status: expiry ? getDocStatus(expiry) : 'valid',
    };
    DocState.docs.unshift(entry);
    renderDocList();
    closeDocUpload();
    logShiftEvent && logShiftEvent(`Document uploaded: ${cfg.label}`);
    showToast(`${cfg.label} uploaded successfully`, 'success', 3500);
}

function getDocStatus(expiryStr) {
    const days = Math.ceil((new Date(expiryStr) - new Date()) / 86400000);
    if (days < 0) return 'expired';
    if (days <= 30) return 'expiring';
    return 'valid';
}

function renderDocList() {
    const list = document.getElementById('docFileList');
    if (!list) return;
    if (!DocState.docs.length) {
        list.innerHTML = '<div class="dcard-empty"><i class="fas fa-file-shield"></i><span>No documents uploaded yet</span></div>';
        return;
    }
    const statusCfg = {
        valid: { color: 'var(--green)', icon: 'fa-circle-check', label: 'Valid' },
        expiring: { color: 'var(--yellow)', icon: 'fa-triangle-exclamation', label: 'Expiring' },
        expired: { color: 'var(--red)', icon: 'fa-circle-xmark', label: 'Expired' },
    };
    list.innerHTML = DocState.docs.map(d => {
        const cfg = DOC_TYPES[d.type] || DOC_TYPES.other;
        const sc = statusCfg[d.status] || statusCfg.valid;
        return `
        <div class="doc-file-item">
            <div class="dfi-icon" style="background:${cfg.color}18;color:${cfg.color}">
                <i class="fas ${cfg.icon}"></i>
            </div>
            <div class="dfi-body">
                <div class="dfi-label">${cfg.label}</div>
                <div class="dfi-meta">
                    ${d.docNumber ? `<span>#${d.docNumber}</span> · ` : ''}
                    ${d.expiry ? `<span>Expires ${d.expiry}</span> · ` : ''}
                    <span>${d.uploadedAt}</span>
                </div>
            </div>
            <div class="dfi-status" style="color:${sc.color}">
                <i class="fas ${sc.icon}"></i>
                <span>${sc.label}</span>
            </div>
        </div>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════════════
// FEATURE 18 — CARGO CHECKPOINTS
// ═══════════════════════════════════════════════════════════════
const CargoChkState = { checkpoints: {}, orderId: null };

const CARGO_CHECKPOINTS = [
    { key: 'loaded', label: 'Cargo Loaded', icon: 'fa-arrow-down-to-bracket', desc: 'Confirm all cargo items are loaded onto the vehicle', color: 'var(--accent)' },
    { key: 'verified', label: 'Cargo Verified', icon: 'fa-clipboard-check', desc: 'Check cargo matches manifest — seal confirmed intact', color: 'var(--yellow)' },
    { key: 'secured', label: 'Cargo Secured', icon: 'fa-lock', desc: 'Load is properly secured and balanced — doors locked', color: 'var(--orange)' },
    { key: 'delivered', label: 'Cargo Delivered', icon: 'fa-flag-checkered', desc: 'All cargo handed to consignee — no items remaining', color: 'var(--green)' },
];

function renderCargoCheckpoints(order) {
    const body = document.getElementById('cargoChkBody');
    const badge = document.getElementById('cargoChkBadge');
    if (!body) return;

    if (!order) {
        body.innerHTML = '<div class="dcard-empty"><i class="fas fa-dolly"></i><span>Accept a trip to activate cargo checkpoints</span></div>';
        if (badge) { badge.textContent = 'Not Started'; badge.className = 'cargo-chk-badge badge-chk-idle'; }
        return;
    }

    CargoChkState.orderId = order.id;
    CARGO_CHECKPOINTS.forEach(c => { if (!(c.key in CargoChkState.checkpoints)) CargoChkState.checkpoints[c.key] = null; });

    const done = CARGO_CHECKPOINTS.filter(c => CargoChkState.checkpoints[c.key]).length;
    const total = CARGO_CHECKPOINTS.length;
    const allDone = done === total;

    if (badge) {
        badge.textContent = allDone ? 'Complete' : `${done}/${total}`;
        badge.className = 'cargo-chk-badge ' + (allDone ? 'badge-chk-done' : done > 0 ? 'badge-chk-progress' : 'badge-chk-idle');
    }

    body.innerHTML = `
        <div class="cargo-chk-progress-bar-wrap">
            <div class="cargo-chk-progress-bar" style="width:${(done / total * 100).toFixed(0)}%"></div>
        </div>
        ${CARGO_CHECKPOINTS.map(c => {
        const ts = CargoChkState.checkpoints[c.key];
        const isDone = !!ts;
        return `
            <div class="cargo-chk-item ${isDone ? 'chk-done' : ''}" id="cc-${c.key}">
                <div class="chk-icon-wrap" style="background:${c.color}18;color:${c.color}">
                    <i class="fas ${c.icon}"></i>
                </div>
                <div class="chk-body">
                    <div class="chk-label">${c.label}</div>
                    <div class="chk-desc">${c.desc}</div>
                    ${isDone ? `<div class="chk-ts"><i class="fas fa-check-circle" style="color:var(--green)"></i> ${ts}</div>` : ''}
                </div>
                ${!isDone ? `<button class="chk-btn" onclick="confirmCheckpoint('${c.key}')">Confirm</button>` : '<i class="fas fa-circle-check chk-done-icon"></i>'}
            </div>`;
    }).join('')}`;
}

function confirmCheckpoint(key) {
    const ts = new Date().toLocaleTimeString();
    CargoChkState.checkpoints[key] = ts;
    renderCargoCheckpoints(MissionState.order);
    logShiftEvent && logShiftEvent(`Checkpoint: ${key} ✓`);
    const done = CARGO_CHECKPOINTS.filter(c => CargoChkState.checkpoints[c.key]).length;
    if (done === CARGO_CHECKPOINTS.length) {
        showToast('✅ All cargo checkpoints confirmed!', 'success', 4000);
    } else {
        showToast(`Checkpoint confirmed: ${CARGO_CHECKPOINTS.find(c => c.key === key)?.label}`, 'success', 2500);
    }
}

// Wire into acceptTrip
const _origAcceptTrip2 = acceptTrip;
acceptTrip = function () {
    _origAcceptTrip2();
    renderCargoCheckpoints(MissionState.order);
};

// ═══════════════════════════════════════════════════════════════
// FEATURE 19 — DRIVER AVAILABILITY STATUS
// ═══════════════════════════════════════════════════════════════
let _currentAvailability = 'Available';

function setAvailability(status) {
    _currentAvailability = status;
    const badge = document.getElementById('availStatusBadge');
    const lastEl = document.getElementById('availLastUpdated');
    const ts = new Date().toLocaleTimeString();

    const cfg = {
        'Available': { cls: 'badge-avail-available', color: 'var(--green)' },
        'On Trip': { cls: 'badge-avail-on-trip', color: 'var(--accent)' },
        'On Leave': { cls: 'badge-avail-on-leave', color: 'var(--yellow)' },
    };
    const c = cfg[status] || cfg['Available'];

    if (badge) { badge.textContent = status; badge.className = 'avail-badge ' + c.cls; }
    if (lastEl) lastEl.textContent = `Last updated: ${ts}`;

    // Highlight active button
    document.querySelectorAll('.avail-btn').forEach(b => b.classList.remove('avail-active'));
    const btnMap = { 'Available': '.avail-available', 'On Trip': '.avail-on-trip', 'On Leave': '.avail-on-leave' };
    document.querySelector(btnMap[status])?.classList.add('avail-active');

    // Push to backend with PUT
    const vid = DriverState.vehicleData?.id;
    if (vid) {
        fetch(`${API_BASE}/api/vehicles/` + vid + '/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: status === 'On Trip' ? 'moving' : status === 'On Leave' ? 'offline' : 'idle' })
        }).catch(() => { });
    }

    logShiftEvent && logShiftEvent(`Availability set: ${status}`);
    showToast(`Status updated: ${status}`, 'info', 2500);
}

// ── Vehicle Status (Idle / Moving / At Sea) ───────────────────────────────────
let _currentVehicleStatus = 'idle';

function setVehicleStatus(status) {
    _currentVehicleStatus = status;
    const badge = document.getElementById('vehicleStatusBadge');
    const lastEl = document.getElementById('vehicleStatusLastUpdated');
    const ts = new Date().toLocaleTimeString();

    const cfg = {
        idle: { cls: 'vs-badge-idle', label: 'Idle', toast: 'Vehicle marked as Idle' },
        moving: { cls: 'vs-badge-moving', label: 'Moving', toast: 'Vehicle marked as Moving' },
        sea: { cls: 'vs-badge-sea', label: 'At Sea', toast: 'Vehicle marked as At Sea' },
    };
    const c = cfg[status] || cfg.idle;

    if (badge) { badge.textContent = c.label; badge.className = 'avail-badge ' + c.cls; }
    if (lastEl) lastEl.textContent = `Last updated: ${ts}`;

    // Highlight active button
    document.querySelectorAll('.vs-btn-idle, .vs-btn-moving, .vs-btn-sea').forEach(b => b.classList.remove('vs-active'));
    const btnMap = { idle: '.vs-btn-idle', moving: '.vs-btn-moving', sea: '.vs-btn-sea' };
    document.querySelector(btnMap[status])?.classList.add('vs-active');

    // Push to backend with PUT — the status endpoint requires PUT
    const vid = DriverState.vehicleData?.id;
    if (vid) {
        fetch(`${API_BASE}/api/vehicles/` + vid + '/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        }).catch(() => { });
    }

    logShiftEvent && logShiftEvent(`Vehicle status: ${c.label}`);
    showToast(c.toast, 'info', 2500);
}

// ═══════════════════════════════════════════════════════════════
// FEATURE 20 — TRIP HISTORY
// ═══════════════════════════════════════════════════════════════
const HistoryState = { all: [], filter: 'all' };

async function loadTripHistory(vehicleId) {
    try {
        const res = await fetch(`${API_BASE}/api/orders?limit=500`).then(r => r.json());
        const all = (res.data || []).filter(o => o.vehicle_id === vehicleId);
        HistoryState.all = all;
        filterHistory('all');
        renderHistorySummary(all);
    } catch (e) {
        const list = document.getElementById('historyList');
        if (list) list.innerHTML = '<div class="dcard-empty"><i class="fas fa-route"></i><span>Could not load history</span></div>';
    }
}

function filterHistory(f) {
    HistoryState.filter = f;
    ['hfAll', 'hfDelivered', 'hfDelayed'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', (id === 'hf' + (f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1))));
    });

    let trips = HistoryState.all;
    if (f === 'Delivered') trips = trips.filter(o => o.order_status === 'Delivered');
    else if (f === 'Delayed') trips = trips.filter(o => {
        if (!o.actual_delivery_datetime || !o.expected_delivery_datetime) return false;
        return new Date(o.actual_delivery_datetime) > new Date(o.expected_delivery_datetime);
    });

    renderHistoryList(trips);
    const badge = document.getElementById('historyTotalBadge');
    if (badge) badge.textContent = `${trips.length} trips`;
}

function renderHistoryList(trips) {
    const list = document.getElementById('historyList');
    if (!list) return;
    if (!trips.length) {
        list.innerHTML = '<div class="dcard-empty"><i class="fas fa-route"></i><span>No trips found</span></div>';
        return;
    }

    const statusColor = { Delivered: 'var(--green)', 'In Transit': 'var(--accent)', Pending: 'var(--yellow)', Cancelled: 'var(--red)' };
    list.innerHTML = trips.slice(0, 20).map(o => {
        const isOnTime = o.actual_delivery_datetime && o.expected_delivery_datetime
            ? new Date(o.actual_delivery_datetime) <= new Date(o.expected_delivery_datetime)
            : null;
        const sc = statusColor[o.order_status] || 'var(--text-muted)';
        return `
        <div class="hist-trip-item">
            <div class="hti-left">
                <div class="hti-route">${o.source_city || '?'} → ${o.destination_city || '?'}</div>
                <div class="hti-meta">
                    <span class="hti-id">#${o.id}</span>
                    ${o.distance_km ? `<span>${Math.round(o.distance_km)} km</span>` : ''}
                    ${o.customer_name ? `<span>${o.customer_name}</span>` : ''}
                </div>
                <div class="hti-date">${o.actual_delivery_datetime ? new Date(o.actual_delivery_datetime).toLocaleDateString() : (o.expected_delivery_datetime ? 'ETA: ' + new Date(o.expected_delivery_datetime).toLocaleDateString() : '—')}</div>
            </div>
            <div class="hti-right">
                <div class="hti-status" style="color:${sc}">${o.order_status}</div>
                ${isOnTime !== null ? `<div class="hti-ontime" style="color:${isOnTime ? 'var(--green)' : 'var(--red)'}"><i class="fas ${isOnTime ? 'fa-check' : 'fa-clock'}"></i> ${isOnTime ? 'On-time' : 'Delayed'}</div>` : ''}
            </div>
        </div>`;
    }).join('');
}

function renderHistorySummary(trips) {
    const done = trips.filter(o => o.order_status === 'Delivered');
    const totalKm = done.reduce((s, o) => s + (parseFloat(o.distance_km) || 0), 0);
    const onTime = done.filter(o => o.actual_delivery_datetime && o.expected_delivery_datetime
        && new Date(o.actual_delivery_datetime) <= new Date(o.expected_delivery_datetime)).length;
    const onTimePct = done.length ? Math.round(onTime / done.length * 100) : 0;

    const row = document.getElementById('historySummaryRow');
    if (row) row.style.display = done.length ? '' : 'none';
    const km = document.getElementById('hsTotalKm');
    const trps = document.getElementById('hsTotalTrips');
    const ot = document.getElementById('hsOnTime');
    if (km) km.textContent = Math.round(totalKm).toLocaleString();
    if (trps) trps.textContent = done.length;
    if (ot) ot.textContent = onTimePct + '%';
}

// ── Wire all features into populateDriverView ────────────────────────────────
const _origPopDrv2 = populateDriverView;
populateDriverView = function (v) {
    _origPopDrv2(v);
    const vid = v?.id;
    if (vid) {
        loadDriverPerformance(vid);
        loadTripHistory(vid);
    }
    renderDocList();
    renderCargoCheckpoints(null);
    setAvailability('On Trip');   // auto-mark when they log in to drive
    updateOfflineUI();
};

// ── Wire sign-out cleanup ────────────────────────────────────────────────────
const _origSignOut2 = doDriverSignOut;
doDriverSignOut = function () {
    setAvailability('Available');
    _origSignOut2();
};

function acceptDisclaimer() {
    const disclaimer = document.getElementById('demoDisclaimer');
    if (disclaimer) {
        disclaimer.classList.add('fade-out');
        setTimeout(() => {
            disclaimer.style.display = 'none';
            disclaimer.classList.remove('fade-out');
        }, 400);
    }
    sessionStorage.setItem('disclaimer-accepted', 'true');
    
    if (typeof window.onDisclaimerAccepted === 'function') {
        window.onDisclaimerAccepted();
        window.onDisclaimerAccepted = null;
    }
}

function showAppWithDisclaimer(appElementId, callback) {
    const showApp = () => {
        const appEl = document.getElementById(appElementId);
        if (appEl) {
            appEl.style.display = appElementId === 'adminApp' ? 'block' : 'flex';
        }
        if (typeof callback === 'function') callback();
    };

    if (sessionStorage.getItem('disclaimer-accepted') !== 'true') {
        const disclaimer = document.getElementById('demoDisclaimer');
        if (disclaimer) {
            disclaimer.style.display = 'flex';
            window.onDisclaimerAccepted = showApp;
        } else {
            showApp();
        }
    } else {
        showApp();
    }
}

function showDisclaimerModal() {
    const disclaimer = document.getElementById('demoDisclaimer');
    if (disclaimer) {
        disclaimer.style.display = 'flex';
        window.onDisclaimerAccepted = null;
    }
    closeSettings();
}