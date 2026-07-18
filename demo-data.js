// ── DEMO DATA FALLBACKS ───────────────────────────────────────────────────────
// Patches load functions to show rich sample data when API returns empty arrays
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    /* ── helpers ── */
    const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
    const pick = arr => arr[rand(0, arr.length - 1)];
    const fmtDate = (offset = 0) => {
        const d = new Date(); d.setDate(d.getDate() + offset);
        return d.toISOString().split('T')[0];
    };
    const CITIES = ['Chennai', 'Mumbai', 'Kolkata', 'Hyderabad', 'Kochi', 'Bengaluru', 'Goa', 'Visakhapatnam'];
    const DRIVERS = ['Ravi Kumar', 'Suresh Pillai', 'Anand Singh', 'Mohan Das', 'Priya Menon', 'Kiran Reddy'];
    const GOODS = ['Electronics', 'Chemicals', 'FMCG', 'Textiles', 'Auto Parts', 'Pharma'];
    const VEH = ['MH-TRK-001', 'KA-TRK-002', 'TN-TRK-003', 'KL-TRK-004', 'AP-TRK-005'];

    // Patch after page loads
    window.addEventListener('load', () => {
        injectDemoPatches();
    });

    function injectDemoPatches() {

        // ── Routes ──────────────────────────────────────────────────────────────
        const origLoadRoutes = window.loadRoutes;
        window.loadRoutes = async function () {
            await origLoadRoutes?.();
            const tbody = document.getElementById('routesTableBody');
            if (!tbody) return;
            if (tbody.dataset.extraInjected) return;
            tbody.dataset.extraInjected = '1';

            const allRoutes = [
                ['Chennai–Mumbai Express',   'Chennai',   'Mumbai',        1337, 18, 2800, 1.2, 'road'],
                ['Kolkata–Hyderabad NH16',   'Kolkata',   'Hyderabad',     1195, 16, 1500, 1.1, 'road'],
                ['Kochi–Bengaluru Fast',     'Kochi',     'Bengaluru',      560,  9,  800, 1.0, 'road'],
                ['Mumbai–Goa Coastal',       'Mumbai',    'Goa',            594, 10, 1200, 1.3, 'road'],
                ['Chennai–Visakhapatnam',    'Chennai',   'Visakhapatnam',  783, 13, 1600, 1.1, 'road'],
                ['Delhi–Jaipur Expressway',  'Delhi',     'Jaipur',         282,  4,  450, 1.0, 'road'],
                ['Bengaluru–Hyderabad NH44', 'Bengaluru', 'Hyderabad',      575,  8,  950, 1.2, 'road'],
                ['Mumbai–Pune Highway',      'Mumbai',    'Pune',           149,  3,  350, 1.4, 'road'],
                ['Chennai–Coimbatore NH544', 'Chennai',   'Coimbatore',     497,  7,  700, 1.1, 'road'],
                ['Kolkata–Bhubaneswar NH16', 'Kolkata',   'Bhubaneswar',    441,  6,  600, 1.0, 'road'],
                ['Mumbai–Ahmedabad Rail',    'Mumbai',    'Ahmedabad',      492,  6,    0, 1.0, 'rail'],
                ['Chennai–Mumbai Sea Lane',  'Chennai',   'Mumbai',        1338, 72,    0, 1.0, 'sea'],
            ];

            const makeRow = r => `<tr>
                <td><strong>${r[0]}</strong></td>
                <td>${r[1]}</td><td>${r[2]}</td>
                <td style="font-family:var(--font-mono)">${r[3]} km</td>
                <td style="font-family:var(--font-mono)">${r[4]} hrs</td>
                <td style="font-family:var(--font-mono)">₹${r[5].toLocaleString('en-IN')}</td>
                <td><span style="color:${r[6]>=1.3?'var(--red)':r[6]>=1.1?'var(--yellow)':'var(--green)'};font-weight:600">${r[6]}x</span></td>
                <td><span class="pill ${r[7]}">${r[7].toUpperCase()}</span></td>
                <td><button class="btn-sm" style="color:var(--red)" onclick="void(0)">Del</button></td>
              </tr>`;

            // Decide full list to display
            let rows;
            if (tbody.querySelector('.loading-row') || tbody.querySelector('td[colspan]')) {
                rows = allRoutes;
            } else {
                const existing = tbody.innerText.toLowerCase();
                const extras = allRoutes.slice(5).filter(r => !existing.includes(r[0].toLowerCase()));
                rows = extras;
                if (!rows.length) return;
            }

            // ── Paginate: 10 per page ─────────────────────────────────────
            const PAGE_SIZE = 10;
            let currentPage = 1;
            const totalPages = () => Math.ceil(rows.length / PAGE_SIZE);

            function renderPage(page) {
                currentPage = page;
                const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
                tbody.innerHTML = slice.map(makeRow).join('');
                renderPager();
            }

            function renderPager() {
                // Remove old pager if any
                const old = document.getElementById('routesPager');
                if (old) old.remove();

                if (rows.length <= PAGE_SIZE) return; // no need for pager

                const tp = totalPages();
                const pager = document.createElement('div');
                pager.id = 'routesPager';
                pager.className = 'pagination';
                pager.innerHTML = `
                    <button class="page-btn" ${currentPage===1?'disabled':''} onclick="window._routesGoPage(${currentPage-1})">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    ${Array.from({length:tp},(_,i)=>`
                        <button class="page-btn${currentPage===i+1?' active':''}" onclick="window._routesGoPage(${i+1})">${i+1}</button>
                    `).join('')}
                    <button class="page-btn" ${currentPage===tp?'disabled':''} onclick="window._routesGoPage(${currentPage+1})">
                        <i class="fas fa-chevron-right"></i>
                    </button>
                    <span style="font-size:11px;color:var(--text-muted);margin-left:8px">
                        Showing ${(currentPage-1)*PAGE_SIZE+1}–${Math.min(currentPage*PAGE_SIZE,rows.length)} of ${rows.length} routes
                    </span>`;

                // Insert pager after the table's parent .table-wrap
                const wrap = document.getElementById('routesTableWrap') || tbody.closest('.table-wrap');
                if (wrap) wrap.after(pager);
                else document.getElementById('routes-page').appendChild(pager);
            }

            window._routesGoPage = renderPage;
            renderPage(1);
        };

        // ── Warehouses ──────────────────────────────────────────────────────────
        const origWH = window.loadWarehouses;
        window.loadWarehouses = async function () {
            await origWH?.();
            const grid = document.getElementById('warehouseGrid');
            if (!grid || grid.textContent.includes('No warehouses')) {
                const whs = [
                    { name: 'Chennai Central Hub',    city: 'Chennai',   is_hub: 1, used: 720,  total: 1000, kg: 18400, zones: 5, mgr: 'Ramesh Kumar'  },
                    { name: 'Mumbai Port Depot',      city: 'Mumbai',    is_hub: 1, used: 350,  total: 800,  kg: 9200,  zones: 3, mgr: 'Priya Shah'    },
                    { name: 'Kolkata East Yard',      city: 'Kolkata',   is_hub: 0, used: 200,  total: 500,  kg: 5100,  zones: 2, mgr: 'Sanjay Das'    },
                    { name: 'Hyderabad Dry Dock',     city: 'Hyderabad', is_hub: 0, used: 130,  total: 400,  kg: 3300,  zones: 2, mgr: 'Kavita Reddy'  },
                    { name: 'Bengaluru South Hub',    city: 'Bengaluru', is_hub: 1, used: 540,  total: 900,  kg: 14700, zones: 4, mgr: 'Arjun Nair'    },
                    { name: 'Delhi NCR Logistics',    city: 'Delhi',     is_hub: 0, used: 310,  total: 600,  kg: 7800,  zones: 3, mgr: 'Meena Sharma'  },
                    { name: 'Kochi Port Warehouse',   city: 'Kochi',     is_hub: 0, used:  90,  total: 350,  kg: 2200,  zones: 2, mgr: 'Thomas Varkey' },
                ];
                grid.innerHTML = whs.map(w => {
                    const pct = Math.round(w.used / w.total * 100);
                    return `<div class="wh-card${w.is_hub ? ' hub' : ''}" onclick="void(0)">
            <div class="wh-card-header">
              <div><div class="wh-name">${w.name}</div><div class="wh-city"><i class="fas fa-map-marker-alt"></i> ${w.city}</div></div>
              ${w.is_hub ? '<span class="wh-hub-badge">HUB</span>' : ''}
            </div>
            <div class="wh-capacity-bar"><div class="wh-capacity-fill" style="width:${pct}%"></div></div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${pct}% used — ${w.used} / ${w.total} cbm</div>
            <div class="wh-stats">
              <div class="wh-stat-item"><span>${w.kg.toLocaleString('en-IN')}</span> kgs stored</div>
              <div class="wh-stat-item"><span>${w.zones}</span> zones</div>
              <div class="wh-stat-item"><i class="fas fa-user" style="color:var(--text-muted)"></i> ${w.mgr}</div>
            </div>
          </div>`;
                }).join('');
            }
        };

        // ── Load Plans ──────────────────────────────────────────────────────────
        const origLP = window.loadLoadPlans;
        window.loadLoadPlans = async function () {
            await origLP?.();
            const tbody = document.getElementById('loadPlansTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            tbody.innerHTML = [
                [1, 'MH-TRK-001', 'Ravi Kumar', fmtDate(-2), 18500, 72.4, 91.2, 'Optimized'],
                [2, 'TN-TRK-003', 'Suresh Pillai', fmtDate(-1), 21200, 85.0, 105.0, 'Overloaded'],
                [3, 'KA-TRK-002', 'Anand Singh', fmtDate(0), 14000, 56.2, 70.0, 'Optimized'],
                [4, 'KL-TRK-004', 'Mohan Das', fmtDate(1), 9500, 38.1, 47.6, 'Pending'],
            ].map(r => `<tr>
        <td style="font-family:var(--font-mono);color:var(--accent)">#${r[0]}</td>
        <td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td>
        <td>${r[4].toLocaleString()} kg</td><td>${r[5].toFixed(2)} cbm</td>
        <td><div class="util-bar-wrap"><div class="util-bar"><div class="util-bar-fill${r[6] > 100 ? ' over' : ''}" style="width:${Math.min(100, r[6])}%"></div></div><span style="font-size:11px">${r[6].toFixed(1)}%</span></div></td>
        <td><span class="pill ${r[7] === 'Optimized' ? 'delivered' : 'in-transit'}">${r[7]}</span></td>
        <td></td>
      </tr>`).join('');
        };

        // ── Dispatches ──────────────────────────────────────────────────────────
        const origDisp = window.loadDispatches;
        window.loadDispatches = async function () {
            await origDisp?.();
            const histEl = document.getElementById('dispatchHistoryList');
            if (!histEl || !histEl.textContent.includes('No recent')) return;
            const items = [
                { oid: 'AHE1417', vid: 'MH-TRK-001', src: 'Chennai', dst: 'Mumbai', drv: 'Ravi Kumar', vno: 'MH12AB1234', st: 'Dispatched', at: new Date(Date.now() - 3600000 * 5).toISOString() },
                { oid: 'BKL2891', vid: 'TN-TRK-003', src: 'Kolkata', dst: 'Hyderabad', drv: 'Suresh Pillai', vno: 'TN09CD5678', st: 'Dispatched', at: new Date(Date.now() - 3600000 * 3).toISOString() },
                { oid: 'CMN3342', vid: 'KA-TRK-002', src: 'Kochi', dst: 'Bengaluru', drv: 'Anand Singh', vno: 'KA05EF9012', st: 'Pending', at: new Date(Date.now() - 1800000).toISOString() },
            ];
            histEl.innerHTML = items.map(d => `<div class="dp-dispatch-item">
        <div class="dp-dispatch-order-id">${d.oid} → ${d.vid}</div>
        <div class="dp-dispatch-route">${d.src} → ${d.dst}</div>
        <div class="dp-dispatch-route" style="color:var(--text-muted);font-size:11px">${d.drv} | ${d.vno}</div>
        <div class="dp-dispatch-time"><span class="pill ${d.st === 'Dispatched' ? 'delivered' : 'in-transit'}">${d.st}</span></div>
      </div>`).join('');
        };

        // ── Driver Management ───────────────────────────────────────────────────
        const origDrv = window.loadDriverMgmt;
        window.loadDriverMgmt = async function () {
            await origDrv?.();
            const tbody = document.getElementById('driverMgmtTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            const drivers = [
                { id: 'DRV-001', name: 'Ravi Kumar', contact: '9876543210', lic: 'TN1420180001234', type: 'HMV', exp: fmtDate(300), vno: 'MH12AB1234', avail: 'Busy', rating: 4.8, hrs: 7.5 },
                { id: 'DRV-002', name: 'Suresh Pillai', contact: '9123456789', lic: 'KL142017002345', type: 'HMV', exp: fmtDate(180), vno: 'TN09CD5678', avail: 'Available', rating: 4.5, hrs: 0 },
                { id: 'DRV-003', name: 'Anand Singh', contact: '9988776655', lic: 'MH142019003456', type: 'LMV-TR', exp: fmtDate(60), vno: 'KA05EF9012', avail: 'Busy', rating: 4.2, hrs: 6.0 },
                { id: 'DRV-004', name: 'Mohan Das', contact: '9900112233', lic: 'WB142016004567', type: 'HMV', exp: fmtDate(-5), vno: '', avail: 'Available', rating: 3.9, hrs: 0 },
                { id: 'DRV-005', name: 'Priya Menon', contact: '9344556677', lic: 'KL142020005678', type: 'HMV-TR', exp: fmtDate(400), vno: 'KL04GH3456', avail: 'Off', rating: 4.7, hrs: 0 },
            ];
            tbody.innerHTML = drivers.map(d => {
                const stars = '★'.repeat(Math.round(d.rating)) + '☆'.repeat(5 - Math.round(d.rating));
                const licCls = d.exp < fmtDate(0) ? 'expiry-crit' : d.exp < fmtDate(30) ? 'expiry-warn' : 'expiry-ok';
                return `<tr>
          <td style="font-family:var(--font-mono);color:var(--accent)">${d.id}</td>
          <td><strong>${d.name}</strong></td>
          <td>${d.contact}</td>
          <td style="font-family:var(--font-mono)">${d.lic}</td>
          <td>${d.type}</td>
          <td><span class="${licCls}">${d.exp}</span></td>
          <td>${d.vno ? `<span style="font-family:var(--font-mono)">${d.vno}</span>` : '<span style="color:var(--text-muted)">Unassigned</span>'}</td>
          <td><span class="avail-badge ${d.avail}">${d.avail}</span></td>
          <td><span class="driver-stars">${stars}</span></td>
          <td>${d.hrs} hrs</td>
          <td><button class="btn-sm" onclick="void(0)">Rate</button> <button class="btn-sm" onclick="void(0)">Edit</button></td>
        </tr>`;
            }).join('');
            const statsEl = document.getElementById('driverMgmtStats');
            if (statsEl && !statsEl.children.length) {
                statsEl.innerHTML = [
                    ['fas fa-users', 'var(--accent)', drivers.length, 'Total Drivers'],
                    ['fas fa-check-circle', 'var(--green)', 2, 'Available'],
                    ['fas fa-truck-moving', 'var(--orange)', 2, 'Busy'],
                    ['fas fa-star', 'var(--yellow)', '4.4', 'Avg Rating'],
                ].map(([ic, col, val, lab]) =>
                    `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
           <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
                ).join('');
            }
        };

        // ── Exceptions/Incidents ────────────────────────────────────────────────
        const origInc = window.loadIncidents;
        window.loadIncidents = async function () {
            await origInc?.();
            const tbody = document.getElementById('incidentsTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            const incidents = [
                { id: 1, type: 'Breakdown', oid: 'AHE1417', vid: 'MH-TRK-001', desc: 'Engine failure on NH48', loc: 'Pune, Maharashtra', sev: 'High', dmg: 45000, claim: 'Pending', rep: fmtDate(-3), res: null },
                { id: 2, type: 'Delay', oid: 'BKL2891', vid: 'TN-TRK-003', desc: 'Heavy traffic on NH16', loc: 'Vijayawada', sev: 'Low', dmg: 0, claim: '—', rep: fmtDate(-1), res: fmtDate(-1) },
                { id: 3, type: 'Accident', oid: 'CMN3342', vid: 'KA-TRK-002', desc: 'Minor collision at toll plaza', loc: 'Belgaum Toll', sev: 'Medium', dmg: 18000, claim: 'Filed', rep: fmtDate(-5), res: null },
            ];
            tbody.innerHTML = incidents.map(i => `<tr>
        <td style="font-family:var(--font-mono)">#${i.id}</td>
        <td>${i.type}</td><td style="color:var(--accent)">${i.oid}</td><td>${i.vid}</td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i.desc}</td>
        <td>${i.loc}</td>
        <td><span class="sev-${i.sev}">${i.sev}</span></td>
        <td>₹${i.dmg.toLocaleString('en-IN')}</td><td>${i.claim}</td>
        <td>${i.rep}</td>
        <td>${i.res ? `<span style="color:var(--green)">${i.res}</span>` : '<span style="color:var(--yellow)">Pending</span>'}</td>
        <td>${!i.res ? '<button class="btn-sm">Resolve</button>' : '—'}</td>
      </tr>`).join('');
        };

        // ── Hubs (Multi-Hub) ───────────────────────────────────────────────────
        const origHubs = window.loadHubs;
        window.loadHubs = async function () {
            await origHubs?.();
            const grid = document.getElementById('hubsGrid');
            if (grid && !grid.children.length) {
                const hubs = [
                    { name: 'Chennai Central Hub', city: 'Chennai', inv: 143, transfers: 3, mgr: 'Ramesh Kumar' },
                    { name: 'Mumbai Port Hub', city: 'Mumbai', inv: 89, transfers: 7, mgr: 'Priya Shah' },
                    { name: 'Kolkata East Hub', city: 'Kolkata', inv: 41, transfers: 2, mgr: 'Sanjay Das' },
                ];
                grid.innerHTML = hubs.map(h => `
          <div class="wh-card hub">
            <div class="wh-card-header">
              <div><div class="wh-name">${h.name}</div><div class="wh-city"><i class="fas fa-map-marker-alt"></i> ${h.city}</div></div>
              <span class="wh-hub-badge">HUB</span>
            </div>
            <div class="wh-stats">
              <div class="wh-stat-item"><span>${h.inv}</span> in stock</div>
              <div class="wh-stat-item"><span>${h.transfers}</span> active transfers</div>
              <div class="wh-stat-item"><i class="fas fa-user" style="color:var(--text-muted)"></i> ${h.mgr}</div>
            </div>
          </div>`).join('');
            }
            const tbody = document.getElementById('hubTransfersBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            tbody.innerHTML = [
                [1, 'AHE1417', 'Ravi Kumar', 'Chennai Central Hub', 'Mumbai Port Hub', 'Lane A3', 'In Transit', fmtDate(-1), null],
                [2, 'BKL2891', 'Suresh Pillai', 'Mumbai Port Hub', 'Kolkata East Hub', 'Lane B1', 'Arrived', fmtDate(-2), fmtDate(-1)],
                [3, 'CMN3342', 'Anand Singh', 'Kolkata East Hub', 'Hyderabad Yard', 'Lane C2', 'Pending', null, null],
            ].map(r => `<tr>
        <td style="font-family:var(--font-mono)">#${r[0]}</td>
        <td style="color:var(--accent)">${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td>
        <td>${r[5]}</td>
        <td><span class="pill ${r[6] === 'Arrived' ? 'delivered' : 'in-transit'}">${r[6]}</span></td>
        <td>${r[7] || '—'}</td><td>${r[8] || '—'}</td>
        <td>${r[6] === 'Pending' ? '<button class="btn-sm" onclick="void(0)">Depart</button>' : r[6] === 'In Transit' ? '<button class="btn-sm" style="color:var(--green)" onclick="void(0)">Arrive</button>' : '—'}</td>
      </tr>`).join('');
        };

        // ── Returns ────────────────────────────────────────────────────────────
        const origRet = window.loadReturns;
        window.loadReturns = async function () {
            await origRet?.();
            const tbody = document.getElementById('returnsTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            tbody.innerHTML = [
                ['RET-001', 'AHE1417', 'Ravi Kumar', 'Mumbai', 'Chennai', 'Electronics', 'In Transit', 'In Transit', 'Express'],
                ['RET-002', 'BKL2891', 'Suresh Pillai', 'Hyderabad', 'Kolkata', 'FMCG', 'Delivered', 'Delivered', 'Economy'],
                ['RET-003', 'CMN3342', 'Priya Menon', 'Bengaluru', 'Kochi', 'Textiles', 'In Transit', 'At Hub', 'Priority'],
            ].map(r => `<tr>
        <td style="font-family:var(--font-mono);color:var(--orange)">${r[0]}</td>
        <td style="color:var(--accent)">${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td><td>${r[5]}</td>
        <td><span class="pill ${r[6] === 'Delivered' ? 'delivered' : 'in-transit'}">${r[6]}</span></td>
        <td>${r[7]}</td><td>${r[8]}</td><td>${fmtDate(-2)}</td>
      </tr>`).join('');
        };

        // ── Customers ──────────────────────────────────────────────────────────
        const origCust = window.loadCustomers;
        window.loadCustomers = async function () {
            await origCust?.();
            const tbody = document.getElementById('customersTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            const custs = [
                { id: 1, name: 'Kiran Sharma', company: 'TechWave Industries', city: 'Mumbai', email: 'kiran@techwave.in', phone: '9876543210', gstin: '27AABCT1332L1ZJ', credit: 1500000, days: 30, status: 'Active', orders: 42, rev: 3840000 },
                { id: 2, name: 'Meera Nair', company: 'Coastal Exports Ltd', city: 'Kochi', email: 'meera@coastal.in', phone: '9123456789', gstin: '32AACCC1234M1ZA', credit: 800000, days: 45, status: 'Active', orders: 28, rev: 1920000 },
                { id: 3, name: 'Ajay Patel', company: 'Patel Pharma', city: 'Ahmedabad', email: 'ajay@patelpharma.com', phone: '9988776655', gstin: '24AAACP1234N1ZB', credit: 500000, days: 15, status: 'Active', orders: 15, rev: 720000 },
                { id: 4, name: 'Sunita Rao', company: 'Deccan Freight Co.', city: 'Hyderabad', email: 'sunita@deccan.in', phone: '9344556677', gstin: '36AABCD5678P1ZC', credit: 2000000, days: 60, status: 'Active', orders: 67, rev: 8100000 },
            ];
            tbody.innerHTML = custs.map(c => `<tr>
        <td style="font-family:var(--font-mono)">${c.id}</td>
        <td><strong>${c.name}</strong></td><td>${c.company}</td><td>${c.city}</td>
        <td>${c.email}</td><td>${c.phone}</td>
        <td style="font-family:var(--font-mono);font-size:11px">${c.gstin}</td>
        <td>₹${c.credit.toLocaleString('en-IN')}</td><td>${c.days} days</td>
        <td><span class="avail-badge Available">${c.status}</span></td>
        <td style="color:var(--accent);font-weight:700">${c.orders}</td>
        <td style="color:var(--green)">₹${c.rev.toLocaleString('en-IN')}</td>
        <td>
          <button class="btn-sm" onclick="void(0)">Orders</button>
          <button class="btn-sm" onclick="void(0)">Edit</button>
        </td>
      </tr>`).join('');
        };

        // ── Invoices (Billing) ─────────────────────────────────────────────────
        const origInv = window.loadInvoices;
        window.loadInvoices = async function () {
            await origInv?.();
            const tbody = document.getElementById('invoicesTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            const invs = [
                { no: 'INV-2025-001', oid: 'AHE1417', cust: 'TechWave Industries', base: 85000, gst: 15300, total: 100300, due: fmtDate(-10), status: 'Paid' },
                { no: 'INV-2025-002', oid: 'BKL2891', cust: 'Coastal Exports Ltd', base: 42000, gst: 7560, total: 49560, due: fmtDate(5), status: 'Unpaid' },
                { no: 'INV-2025-003', oid: 'CMN3342', cust: 'Patel Pharma', base: 28000, gst: 5040, total: 33040, due: fmtDate(-20), status: 'Overdue' },
                { no: 'INV-2025-004', oid: 'DMK4511', cust: 'Deccan Freight Co.', base: 120000, gst: 21600, total: 141600, due: fmtDate(15), status: 'Unpaid' },
            ];
            const sumEl = document.getElementById('invoiceSummaryRow');
            if (sumEl && !sumEl.children.length) {
                sumEl.innerHTML = [
                    ['fas fa-file-invoice', 'var(--accent)', invs.length, 'Total Invoices'],
                    ['fas fa-check-circle', 'var(--green)', 1, 'Paid'],
                    ['fas fa-clock', 'var(--yellow)', 2, 'Unpaid'],
                    ['fas fa-exclamation-circle', 'var(--red)', 1, 'Overdue'],
                    ['fas fa-rupee-sign', 'var(--green)', '₹3.25L', 'Total Billed'],
                    ['fas fa-hand-holding-usd', 'var(--orange)', '₹1.83L', 'Outstanding'],
                ].map(([ic, col, val, lab]) =>
                    `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
           <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
                ).join('');
            }
            tbody.innerHTML = invs.map(inv => {
                const cls = inv.status === 'Paid' ? 'delivered' : inv.status === 'Overdue' ? 'stopped' : 'in-transit';
                return `<tr>
          <td style="font-family:var(--font-mono);color:var(--accent)">${inv.no}</td>
          <td style="color:var(--accent)">${inv.oid}</td><td>${inv.cust}</td>
          <td>₹${inv.base.toLocaleString('en-IN')}</td>
          <td>₹${inv.gst.toLocaleString('en-IN')}</td>
          <td><strong style="color:var(--accent)">₹${inv.total.toLocaleString('en-IN')}</strong></td>
          <td>${inv.due}</td>
          <td><span class="pill ${cls}">${inv.status}</span></td>
          <td>${inv.status !== 'Paid' ? '<button class="btn-sm" style="color:var(--green)" onclick="void(0)">Mark Paid</button>' : '<span style="color:var(--green)"><i class="fas fa-check"></i> Done</span>'}</td>
        </tr>`;
            }).join('');
        };

        // ── Fuel Management ────────────────────────────────────────────────────
        const origFuel = window.loadFuelMgmt;
        window.loadFuelMgmt = async function () {
            await origFuel?.();
            const tbody = document.getElementById('fuelTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            const rows = [
                ['MH-TRK-001', 'MH12AB1234', 'Ravi Kumar', 65, 5850, 'IOCL Chennai', 87420, 8.4],
                ['TN-TRK-003', 'TN09CD5678', 'Suresh Pillai', 80, 7200, 'HPCL Mumbai', 92310, 7.9],
                ['KA-TRK-002', 'KA05EF9012', 'Anand Singh', 50, 4500, 'BPCL Pune', 75680, 9.2],
                ['KL-TRK-004', 'KL04GH3456', 'Priya Menon', 40, 3600, 'IOCL Kochi', 61200, 8.8],
            ];
            const sumEl = document.getElementById('fuelSummaryRow');
            if (sumEl && !sumEl.children.length) {
                sumEl.innerHTML = [
                    ['fas fa-tint', 'var(--accent)', '235L', 'Total Fuel'],
                    ['fas fa-rupee-sign', 'var(--red)', '₹21,150', 'Total Cost'],
                    ['fas fa-road', 'var(--green)', '8.6 km/L', 'Avg Efficiency'],
                ].map(([ic, col, val, lab]) =>
                    `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
           <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
                ).join('');
            }
            tbody.innerHTML = rows.map(r => `<tr>
        <td style="font-family:var(--font-mono);color:var(--accent)">${r[0]}</td>
        <td>${r[1]}</td><td>${r[2]}</td>
        <td><strong>${r[3]}</strong> L</td>
        <td>₹${r[4].toLocaleString('en-IN')}</td>
        <td>${r[5]}</td>
        <td>${r[6].toLocaleString()} km</td>
        <td>${r[7]} km/L</td>
        <td>${fmtDate(-rand(0, 3))}</td>
      </tr>`).join('');
        };

        // ── Geofencing ─────────────────────────────────────────────────────────
        const origGeo = window.loadGeofencing;
        window.loadGeofencing = async function () {
            await origGeo?.();
            const el = document.getElementById('geofencesList');
            if (el && el.textContent.includes('No zones')) {
                const zones = [
                    { id: 1, name: 'Chennai Port Zone', type: 'Warehouse Zone', radius: 5 },
                    { id: 2, name: 'Mumbai Delivery Hub', type: 'Delivery Zone', radius: 3 },
                    { id: 3, name: 'Pune Industrial Area', type: 'Hub Zone', radius: 10 },
                ];
                el.innerHTML = zones.map(g =>
                    `<div style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:600">${g.name}</div>
              <div style="font-size:11px;color:var(--text-muted)">${g.type} • R=${g.radius}km</div>
            </div>
            <button class="btn-sm" style="color:var(--red)" onclick="void(0)"><i class="fas fa-trash"></i></button>
          </div>`
                ).join('');
            }
            const tbody = document.getElementById('geofenceVehicleBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            tbody.innerHTML = [
                ['MH-TRK-001', 'MH12AB1234', 19.076, 72.877, 'moving', 'AHE1417'],
                ['TN-TRK-003', 'TN09CD5678', 13.082, 80.270, 'idle', 'BKL2891'],
                ['KA-TRK-002', 'KA05EF9012', 12.971, 77.594, 'moving', 'CMN3342'],
            ].map(v => `<tr>
        <td style="color:var(--accent);font-family:var(--font-mono)">${v[0]}</td>
        <td>${v[1]}</td><td>${v[2]}</td><td>${v[3]}</td>
        <td><span class="pill ${v[4] === 'moving' ? 'in-transit' : 'idle'}">${v[4]}</span></td>
        <td>${v[5]}</td>
      </tr>`).join('');
        };

        // ── Maintenance ────────────────────────────────────────────────────────
        const origMaint = window.loadMaintenance;
        window.loadMaintenance = async function () {
            await origMaint?.();
            const tbody = document.getElementById('maintenanceTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            tbody.innerHTML = [
                [1, 'MH12AB1234', 'Oil Change', fmtDate(3), 3500, null, 'GK Workshop', 'Scheduled'],
                [2, 'TN09CD5678', 'Brake Service', fmtDate(-5), 8000, 7800, 'AutoFix Chennai', 'Completed'],
                [3, 'KA05EF9012', 'Tyre Replacement', fmtDate(7), 22000, null, 'Apollo Tyres', 'Scheduled'],
                [4, 'KL04GH3456', 'Engine Overhaul', fmtDate(-15), 55000, null, 'Ashok Motors', 'Overdue'],
            ].map(m => `<tr>
        <td style="font-family:var(--font-mono)">#${m[0]}</td>
        <td>${m[1]}</td><td>${m[2]}</td><td>${m[3]}</td>
        <td>₹${m[4].toLocaleString('en-IN')}</td>
        <td>${m[5] ? '₹' + m[5].toLocaleString('en-IN') : '—'}</td>
        <td>${m[6]}</td>
        <td><span class="pill ${m[7] === 'Completed' ? 'delivered' : m[7] === 'Overdue' ? 'stopped' : 'in-transit'}">${m[7]}</span></td>
        <td>${m[7] === 'Completed' ? fmtDate(-5) : '—'}</td>
        <td>${m[7] !== 'Completed' ? '<button class="btn-sm" style="color:var(--green)" onclick="void(0)">Complete</button>' : '—'}</td>
      </tr>`).join('');
        };

        // ── Contracts ──────────────────────────────────────────────────────────
        const origContracts = window.loadContracts;
        window.loadContracts = async function () {
            await origContracts?.();
            const tbody = document.getElementById('contractsTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            tbody.innerHTML = [
                { id: 1, title: 'Annual Mumbai-Pune Route', client: 'TechWave Industries', start: '2025-01-01', end: '2025-12-31', val: 5000000, rate: 12.5, minOrd: 30, routes: 'Mumbai, Pune, Nashik', status: 'Active' },
                { id: 2, title: 'Coastal Express Contract', client: 'Coastal Exports Ltd', start: '2024-06-01', end: '2025-05-31', val: 2800000, rate: 10.0, minOrd: 20, routes: 'Kochi, Chennai, Goa', status: 'Active' },
                { id: 3, title: 'Pharma Logistics 2024', client: 'Patel Pharma', start: '2024-01-01', end: '2024-12-31', val: 1200000, rate: 14.0, minOrd: 15, routes: 'Ahmedabad, Mumbai', status: 'Expired' },
            ].map(c => `<tr>
        <td style="font-family:var(--font-mono)">#${c.id}</td>
        <td><strong>${c.title}</strong></td>
        <td>${c.client}</td><td>${c.start}</td><td>${c.end}</td>
        <td style="color:var(--accent)">₹${c.val.toLocaleString('en-IN')}</td>
        <td>₹${c.rate}/km</td><td>${c.minOrd}</td>
        <td style="font-size:11px">${c.routes}</td>
        <td><span class="pill ${c.status === 'Active' ? 'delivered' : 'stopped'}">${c.status}</span></td>
        <td><button class="btn-sm" style="color:var(--red)" onclick="void(0)">Expire</button></td>
      </tr>`).join('');
        };

        // ── Reports ────────────────────────────────────────────────────────────
        const origDelRep = window.loadDeliveryReport;
        window.loadDeliveryReport = async function () {
            await origDelRep?.();
            const tbody = document.getElementById('deliveryReportBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            tbody.innerHTML = [
                ['Chennai', 'Mumbai', 87, 79, 90.8, 1337, 7412000],
                ['Kolkata', 'Hyderabad', 52, 46, 88.5, 1195, 3124000],
                ['Kochi', 'Bengaluru', 34, 32, 94.1, 560, 1428000],
                ['Mumbai', 'Goa', 28, 25, 89.3, 594, 980000],
            ].map(r => `<tr>
        <td>${r[0]} → ${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td>
        <td><strong style="color:${r[4] >= 90 ? 'var(--green)' : 'var(--orange)'}">${r[4]}%</strong></td>
        <td>${r[5].toLocaleString()} km</td>
        <td>₹${r[6].toLocaleString('en-IN')}</td>
      </tr>`).join('');
        };

        const origVehRep = window.loadVehicleReport;
        window.loadVehicleReport = async function () {
            await origVehRep?.();
            const tbody = document.getElementById('vehicleReportBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            tbody.innerHTML = [
                ['MH12AB1234', '40ft Container', 42, 3840000, 1337],
                ['TN09CD5678', '20ft Container', 28, 1920000, 1195],
                ['KA05EF9012', 'Flatbed', 15, 720000, 560],
                ['KL04GH3456', '40ft Reefer', 67, 8100000, 980],
            ].map(v => `<tr>
        <td style="font-family:var(--font-mono);color:var(--accent)">${v[0]}</td>
        <td>${v[1]}</td><td>${v[2]}</td>
        <td>₹${v[3].toLocaleString('en-IN')}</td>
        <td>${v[4].toLocaleString()} km</td>
      </tr>`).join('');
        };

        const origFinRep = window.loadFinancialReport;
        window.loadFinancialReport = async function () {
            await origFinRep?.();
            const tbody = document.getElementById('financialReportBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            const months = ['Jan 2025', 'Feb 2025', 'Mar 2025', 'Apr 2025', 'May 2025'];
            tbody.innerHTML = months.map((m, i) => {
                const rev = rand(1500000, 3200000);
                const exp = rand(900000, 1800000);
                const profit = rev - exp;
                return `<tr>
          <td><strong>${m}</strong></td><td>${rand(40, 90)}</td>
          <td style="color:var(--green)">₹${rev.toLocaleString('en-IN')}</td>
          <td style="color:var(--red)">₹${exp.toLocaleString('en-IN')}</td>
          <td style="color:${profit >= 0 ? 'var(--green)' : 'var(--red)'}"><strong>₹${profit.toLocaleString('en-IN')}</strong></td>
        </tr>`;
            }).join('');
        };

        // ── Staff ──────────────────────────────────────────────────────────────
        const origStaff = window.loadStaff;
        window.loadStaff = async function () {
            await origStaff?.();
            const tbody = document.getElementById('staffTableBody');
            if (!tbody || !tbody.querySelector('.loading-row')) return;
            const staff = [
                { id: 1, name: 'Arjun Mehta', role: 'Manager', dept: 'Operations', email: 'arjun@fleet.in', phone: '9876554321', shift: 'Day', salary: 75000, date: '2021-03-15', status: 'Active' },
                { id: 2, name: 'Neha Gupta', role: 'Dispatcher', dept: 'Operations', email: 'neha@fleet.in', phone: '9988112233', shift: 'Night', salary: 38000, date: '2022-07-01', status: 'Active' },
                { id: 3, name: 'Rohan Verma', role: 'Accountant', dept: 'Finance', email: 'rohan@fleet.in', phone: '9123456000', shift: 'Day', salary: 45000, date: '2020-11-20', status: 'Active' },
                { id: 4, name: 'Anjali Singh', role: 'HR', dept: 'HR', email: 'anjali@fleet.in', phone: '9900334455', shift: 'Day', salary: 42000, date: '2023-01-10', status: 'On Leave' },
                { id: 5, name: 'Vikram Nair', role: 'IT', dept: 'IT', email: 'vikram@fleet.in', phone: '9344556677', shift: 'Day', salary: 65000, date: '2019-06-01', status: 'Active' },
            ];
            const statsEl = document.getElementById('staffStatsRow');
            if (statsEl && !statsEl.children.length) {
                statsEl.innerHTML = [
                    ['fas fa-users', 'var(--accent)', 5, 'Active Staff'],
                    ['fas fa-user-clock', 'var(--yellow)', 3, 'Day Shift'],
                    ['fas fa-user-clock', 'var(--purple)', 1, 'Night Shift'],
                    ['fas fa-sitemap', 'var(--green)', 3, 'Operations'],
                ].map(([ic, col, val, lab]) =>
                    `<div class="fleet-stat"><i class="${ic}" style="color:${col};font-size:20px"></i>
           <div><div class="fleet-stat-val">${val}</div><div class="fleet-stat-lbl">${lab}</div></div></div>`
                ).join('');
            }
            tbody.innerHTML = staff.map(s => `<tr>
        <td style="font-family:var(--font-mono)">#${s.id}</td>
        <td><strong>${s.name}</strong></td>
        <td>${s.role}</td><td>${s.dept}</td><td>${s.email}</td><td>${s.phone}</td>
        <td><span class="pill ${s.shift === 'Day' ? 'delivered' : 'in-transit'}">${s.shift}</span></td>
        <td>₹${s.salary.toLocaleString('en-IN')}</td>
        <td>${s.date}</td>
        <td><span class="avail-badge ${s.status === 'Active' ? 'Available' : 'Busy'}">${s.status}</span></td>
        <td><button class="btn-sm" onclick="void(0)">Edit</button></td>
      </tr>`).join('');
        };

        // ── Notifications ──────────────────────────────────────────────────────
        const origNotif = window.loadNotifHub;
        window.loadNotifHub = async function () {
            await origNotif?.();
            const el = document.getElementById('notifHubList');
            if (!el || !el.innerHTML.includes('bell-slash')) return;
            const notifs = [
                { id: 1, type: 'warn', priority: 'High', title: 'SLA Breach Risk — AHE1417', message: 'Order AHE1417 is at risk of missing its SLA deadline. Expected delivery in 2 hours, 45 minutes remaining.', related_type: 'order', related_id: 'AHE1417', is_read: false, created_at: new Date(Date.now() - 1800000).toISOString() },
                { id: 2, type: 'error', priority: 'High', title: 'Vehicle Breakdown — MH-TRK-001', message: 'Driver Ravi Kumar reported engine failure on NH48 near Pune. Assistance dispatched.', related_type: 'vehicle', related_id: 'MH-TRK-001', is_read: false, created_at: new Date(Date.now() - 3600000).toISOString() },
                { id: 3, type: 'success', priority: 'Normal', title: 'Delivery Confirmed — BKL2891', message: 'Order BKL2891 successfully delivered to Coastal Exports Ltd, Hyderabad.', related_type: 'order', related_id: 'BKL2891', is_read: true, created_at: new Date(Date.now() - 7200000).toISOString() },
                { id: 4, type: 'info', priority: 'Normal', title: 'Insurance Expiring Soon', message: 'Vehicle TN09CD5678 insurance expires in 18 days. Please renew immediately.', related_type: 'vehicle', related_id: 'TN09CD5678', is_read: true, created_at: new Date(Date.now() - 86400000).toISOString() },
                { id: 5, type: 'warn', priority: 'Normal', title: 'Maintenance Due — KA05EF9012', message: 'Scheduled tyre replacement for KA05EF9012 is due in 7 days.', related_type: 'vehicle', related_id: 'KA05EF9012', is_read: false, created_at: new Date(Date.now() - 86400000 * 2).toISOString() },
            ];
            const badge = document.getElementById('notifNavBadge');
            const unread = notifs.filter(n => !n.is_read).length;
            if (badge) { badge.style.display = unread ? 'inline-block' : 'none'; badge.textContent = unread; }
            const typeIcons = { info: 'fas fa-info-circle', warn: 'fas fa-exclamation-triangle', error: 'fas fa-times-circle', success: 'fas fa-check-circle' };
            const typeColors = { info: 'var(--accent)', warn: 'var(--yellow)', error: 'var(--red)', success: 'var(--green)' };
            el.innerHTML = notifs.map(n => {
                const ic = typeIcons[n.type] || 'fas fa-bell';
                const col = typeColors[n.type] || 'var(--accent)';
                const bg = n.is_read ? '' : 'background:rgba(99,120,255,0.06);';
                const dateStr = new Date(n.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                return `<div style="padding:14px 18px;border:1px solid var(--border);border-radius:12px;${bg}display:flex;gap:14px;align-items:flex-start;margin-bottom:8px">
          <i class="${ic}" style="color:${col};margin-top:3px;font-size:18px"></i>
          <div style="flex:1">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong style="color:var(--text-primary)">${n.title}</strong>
              <span style="font-size:10px;color:${n.priority === 'High' ? 'var(--red)' : 'var(--text-muted)'};font-weight:600">${n.priority} • ${dateStr}</span>
            </div>
            <div style="color:var(--text-secondary);font-size:13px;margin-top:4px">${n.message}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${n.related_type}: ${n.related_id}</div>
          </div>
          ${!n.is_read ? '<button class="btn-sm" onclick="void(0)"><i class="fas fa-check"></i></button>' : ''}
        </div>`;
            }).join('');
        };

    } // end injectDemoPatches

})();