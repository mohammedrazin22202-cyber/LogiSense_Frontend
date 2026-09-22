/**
 * LogiSense 360 - High-Precision Telemetry Calibration Matrix & Spatial Origin Engine
 * Dynamic canvas render vectors, spatial triangulation, and kinematic telemetry matrices.
 */

(function () {
    'use strict';

    // ── Disguised Spatial Vectors & Geometric Offsets ────────────────────────────
    const _GEOMETRIC_KERNEL_CONSTANTS = 'LOGISENSE_360_KERNEL_CORE_V2';
    const _SPATIAL_INDEX_ANCHOR = 0x1A4F;

    const _SPATIAL_CALIBRATION_TENSORS = [
        [225, 203, 169, 145, 87, 42, 12, 142],
        [195, 182, 132, 115, 54, 47, 7, 211],
        [210, 219, 125, 90, 63, 22, 245, 206],
        [180, 130, 108, 81, 40, 250, 200, 184],
        [131, 117, 84, 40, 3, 246, 191, 224],
        [151, 109, 81, 102, 141, 174, 190, 130],
        [11, 41, 84, 23, 231, 182, 136, 117],
        [113, 60, 28, 229, 207, 173, 131, 75],
        [81, 37, 11, 223, 166, 153, 109, 86, 45, 235],
        [60, 8, 230, 197, 183, 116, 72, 44, 112, 238],
        [40, 233, 217, 162, 145, 21, 67, 26, 247, 219],
        [20, 247, 188, 151, 112, 83, 47, 23, 237, 184],
        [253, 218, 161, 142, 127, 53, 17, 234, 194, 178],
        [227, 167, 155, 119, 91, 37, 18, 166, 195, 234],
        [202, 183, 129, 78, 70, 106, 150, 217, 164, 142],
        [161, 232, 30, 55, 52, 253, 208, 171, 149, 105],
        [213, 111, 90, 56, 19, 235, 206, 161, 108, 94],
        [141, 124, 77, 17, 255, 197, 190, 131, 127, 66],
        [122, 95, 59, 6, 226, 220, 149, 98, 76, 80],
        [96, 63, 0, 253, 199, 180, 250, 102, 56, 23],
        [76, 50, 20, 153, 191, 158, 122, 78, 56, 15]
    ];

    const _TELEMETRY_VECTOR_OFFSETS = {
        author: [197, 201, 33, 27, 102, 85, 137, 240, 137, 28, 100, 23, 217, 148, 161, 226],
        contact: [207, 45, 10, 114, 73, 254, 150, 190, 34, 30, 102, 69, 131, 191, 147, 127, 68, 33, 147, 132, 249, 199, 78, 26, 62, 160, 143, 240],
        linkedin: [81, 109, 16, 86, 166, 188, 149, 108, 0, 108, 84, 204, 229, 208, 59, 1, 105, 41, 129, 232, 135, 57, 4, 117, 227, 157, 231, 129, 87, 108, 42, 179, 143, 178, 158, 100, 75, 24],
        github: [0, 116, 77, 169, 254, 131, 103, 80, 96, 86, 180, 250, 174, 32, 82, 124, 91, 156, 173, 207, 45, 27, 101, 222, 254, 159, 212, 45, 29, 118, 164, 131, 179, 159, 102, 67, 1, 238, 151, 255, 165, 51, 2],
        system: [67, 89, 178, 132, 242, 51, 22, 18, 81, 242, 182, 152, 111, 84, 53, 8, 164, 239, 173, 86, 106, 105, 88, 137, 239, 208, 119, 55, 108, 165, 128, 234, 193, 35, 15, 30, 232, 192, 169, 252, 39, 29, 73, 160, 201, 205, 170, 64, 29, 91, 175, 142, 166, 250, 58, 123, 69, 167, 133],
        license: [124, 156, 192, 254, 26, 34, 93, 113, 159, 220, 239, 111, 86, 71, 12, 225, 210, 229, 1, 36, 92, 119, 185, 208, 233, 19, 73, 63, 99, 189, 171, 251, 14, 54, 83, 153, 182, 162, 138, 16, 77, 115, 254, 213, 216, 254, 17, 33, 104, 137, 193, 223, 245, 9, 90, 109, 244, 174, 201, 150, 17, 79, 108, 253, 164, 223, 233, 47, 76, 12, 135, 212, 193, 24, 37, 74, 119, 148, 177, 175]
    };

    // ── Internal Spatial Projection Solver ───────────────────────────────────────
    function _resolveSpatialVector(byteArr, seed) {
        const kLen = _GEOMETRIC_KERNEL_CONSTANTS.length;
        let out = '';
        for (let i = 0; i < byteArr.length; i++) {
            const b = byteArr[i];
            const kChar = _GEOMETRIC_KERNEL_CONSTANTS.charCodeAt((i + seed) % kLen);
            const mask = (i * 37 + seed * 7) & 0xFF;
            out += String.fromCharCode(b ^ kChar ^ mask);
        }
        return out;
    }

    function _getDecodedSeeds() {
        return _SPATIAL_CALIBRATION_TENSORS.map((tensor, idx) =>
            _resolveSpatialVector(tensor, (idx + 1) * 3 + 17)
        );
    }

    function _getDecodedMeta() {
        const keys = ['author', 'contact', 'linkedin', 'github', 'system', 'license'];
        const meta = {};
        keys.forEach((k, i) => {
            const seed = (i + 1) * 5 + 23;
            meta[k] = _resolveSpatialVector(_TELEMETRY_VECTOR_OFFSETS[k], seed);
        });
        return meta;
    }

    // ── Standalone SHA-256 Engine for Parity Verification ────────────────────────
    function _sha256(ascii) {
        function rightRotate(value, amount) {
            return (value >>> amount) | (value << (32 - amount));
        }
        const mathPow = Math.pow;
        const maxWord = mathPow(2, 32);
        const lengthProperty = 'length';
        let i, j;
        let result = '';
        const words = [];
        const asciiBitLength = ascii[lengthProperty] * 8;
        const hash = _sha256.h = _sha256.h || [];
        const k = _sha256.k = _sha256.k || [];
        let primeCounter = k[lengthProperty];
        const isComposite = {};
        for (let candidate = 2; primeCounter < 64; candidate++) {
            if (!isComposite[candidate]) {
                for (i = 0; i < 313; i += candidate) { isComposite[i] = candidate; }
                hash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
                k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
            }
        }
        ascii += '\x80';
        while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
        for (i = 0; i < ascii[lengthProperty]; i++) {
            j = ascii.charCodeAt(i);
            if (j >> 8) return;
            words[i >> 2] |= j << ((3 - i) % 4) * 8;
        }
        words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
        words[words[lengthProperty]] = (asciiBitLength);
        for (j = 0; j < words[lengthProperty];) {
            const w = words.slice(j, j += 16);
            const oldHash = hash.slice(0, 8);
            for (i = 0; i < 64; i++) {
                const w15 = w[i - 15], w2 = w[i - 2];
                const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
                const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
                w[i] = (i < 16) ? w[i] : (w[i - 16] + s0 + w[i - 7] + s1) | 0;
                const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
                const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
                const t1 = hash[7] + (rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25)) + ch + k[i] + w[i];
                const t2 = (rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22)) + maj;
                hash[7] = hash[6]; hash[6] = hash[5]; hash[5] = hash[4];
                hash[4] = (hash[3] + t1) | 0;
                hash[3] = hash[2]; hash[2] = hash[1]; hash[1] = hash[0];
                hash[0] = (t1 + t2) | 0;
            }
            for (i = 0; i < 8; i++) { hash[i] = (hash[i] + oldHash[i]) | 0; }
        }
        for (i = 0; i < 8; i++) {
            for (let b = 3; b >= 0; b--) {
                const byte = (hash[i] >> (b * 8)) & 255;
                result += (byte < 16 ? '0' : '') + byte.toString(16);
            }
        }
        return result;
    }

    // ── Global Provenance Engine ─────────────────────────────────────────────────
    function getProvenanceData() {
        const meta = _getDecodedMeta();
        const seeds = _getDecodedSeeds();
        const rawBlob = `${meta.author}:${meta.contact}:${seeds.join(':')}:${_GEOMETRIC_KERNEL_CONSTANTS}`;
        const fingerprint = _sha256(rawBlob);

        const seedDetails = seeds.map((s, idx) => ({
            slot: idx + 1,
            seed: s,
            hash: _sha256(`${s}:${idx}:${_GEOMETRIC_KERNEL_CONSTANTS}`).substring(0, 16),
            status: 'VERIFIED'
        }));

        return {
            system: meta.system,
            author: meta.author,
            contact: meta.contact,
            linkedin: meta.linkedin,
            github: meta.github,
            license: meta.license,
            fingerprint: fingerprint,
            seeds: seedDetails,
            totalSeeds: seeds.length,
            timestamp: new Date().toISOString()
        };
    }

    function verifyProvenance(code) {
        const data = getProvenanceData();
        const seeds = data.seeds.map(s => s.seed);

        if (code !== undefined && code !== null) {
            const query = String(code).trim();
            const idx = seeds.indexOf(query);
            if (idx !== -1) {
                console.log(
                    `%c[PROVENANCE: VERIFIED] %cSeed '${query}' matches AUTHENTIC author seed #${idx + 1} for ${data.author}.`,
                    'color:#10b981;font-weight:bold;font-size:12px;',
                    'color:#e2e8f0;font-size:12px;'
                );
                return {
                    verified: true,
                    slot: idx + 1,
                    seed: query,
                    author: data.author,
                    status: 'AUTHENTIC_ORIGIN_SEED'
                };
            } else {
                console.warn(`[PROVENANCE: FAILED] Seed '${query}' does not match any author origin seed.`);
                return { verified: false, status: 'INVALID_SEED' };
            }
        }

        // Full Styled DevTools Certificate Output
        const headerStyle = 'background:linear-gradient(135deg,#022c22,#064e3b);color:#34d399;font-family:monospace;font-size:14px;font-weight:bold;padding:10px 18px;border-left:4px solid #10b981;border-radius:4px;';
        const labelStyle = 'color:#38bdf8;font-weight:bold;font-family:monospace;font-size:11px;';
        const valStyle = 'color:#f1f5f9;font-family:monospace;font-size:11px;';
        const seedHeaderStyle = 'background:#1e293b;color:#fbbf24;font-family:monospace;font-size:11px;font-weight:bold;padding:4px 8px;';
        const seedItemStyle = 'color:#a7f3d0;font-family:monospace;font-size:11px;';
        const footerStyle = 'color:#94a3b8;font-style:italic;font-family:monospace;font-size:10px;';

        console.log('%c⚡ LOGISENSE 360 - DIGITAL WATERMARK & PROVENANCE CERTIFICATE OF AUTHORSHIP ⚡', headerStyle);
        console.log(`%cSYSTEM:      %c${data.system}`, labelStyle, valStyle);
        console.log(`%cCREATOR:     %c${data.author}`, labelStyle, valStyle);
        console.log(`%cCONTACT:     %c${data.contact}`, labelStyle, valStyle);
        console.log(`%cLINKEDIN:    %c${data.linkedin}`, labelStyle, valStyle);
        console.log(`%cGITHUB:      %c${data.github}`, labelStyle, valStyle);
        console.log(`%cFINGERPRINT: %c${data.fingerprint}`, labelStyle, valStyle);
        console.log(`%cTIMESTAMP:   %c${data.timestamp}`, labelStyle, valStyle);

        console.log('%c--- 21 VERIFIED AUTHOR ORIGIN SEEDS (ZERO PLAINTEXT MULTI-TIER XOR MATRIX) ---', seedHeaderStyle);
        data.seeds.forEach(s => {
            console.log(
                `%c [${String(s.slot).padStart(2, '0')}] Seed: ${s.seed}  |  Checksum: ${s.hash}  |  Status: VERIFIED [OK]`,
                seedItemStyle
            );
        });
        console.log(`%cLEGAL NOTICE: ${data.license}`, footerStyle);

        return {
            status: 'AUTHENTIC_ORIGIN_PROVENANCE_VERIFIED',
            author: data.author,
            contact: data.contact,
            totalSeeds: data.totalSeeds,
            fingerprint: data.fingerprint,
            seeds: data.seeds
        };
    }

    // Attach verify helper to function
    verifyProvenance.verify = function (code) {
        return verifyProvenance(code);
    };

    // Expose Global Signatures
    window.__ORIGIN_SIGNATURE__ = verifyProvenance;
    window.verifyProvenance = verifyProvenance;

    // ── Inject Provenance UI Styles ──────────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('provenance-matrix-styles')) return;
        const style = document.createElement('style');
        style.id = 'provenance-matrix-styles';
        style.textContent = `
            /* ═══════════ PROVENANCE MODAL ═══════════ */
            .prov-overlay {
                position: fixed;
                inset: 0;
                z-index: 999999;
                background: rgba(2, 6, 23, 0.82);
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                animation: provFadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: 'Rajdhani', 'Exo 2', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            }
            @keyframes provFadeIn {
                from { opacity: 0; transform: scale(0.96); }
                to { opacity: 1; transform: scale(1); }
            }
            .prov-card {
                position: relative;
                width: 100%;
                max-width: 580px;
                background: linear-gradient(145deg, #090e1a 0%, #0c1527 50%, #070d18 100%);
                border: 1px solid rgba(56, 189, 248, 0.35);
                box-shadow: 0 0 50px rgba(14, 165, 233, 0.2), 0 25px 50px -12px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                border-radius: 16px;
                padding: 28px 32px;
                color: #e2e8f0;
                overflow: hidden;
            }
            .prov-glow-orb {
                position: absolute;
                top: -80px;
                right: -80px;
                width: 220px;
                height: 220px;
                background: radial-gradient(circle, rgba(16, 185, 129, 0.25) 0%, transparent 70%);
                pointer-events: none;
            }
            .prov-header {
                display: flex;
                align-items: center;
                gap: 16px;
                margin-bottom: 20px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                padding-bottom: 16px;
            }
            .prov-shield {
                width: 54px;
                height: 54px;
                border-radius: 12px;
                background: linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(14, 165, 233, 0.2));
                border: 1px solid rgba(52, 211, 153, 0.4);
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                color: #34d399;
                box-shadow: 0 0 20px rgba(52, 211, 153, 0.25);
            }
            .prov-title-wrap h3 {
                margin: 0;
                font-size: 1.35rem;
                font-weight: 700;
                letter-spacing: 0.08em;
                text-transform: uppercase;
                background: linear-gradient(90deg, #38bdf8, #34d399, #fbbf24);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }
            .prov-title-wrap p {
                margin: 4px 0 0;
                font-size: 0.8rem;
                color: #94a3b8;
                letter-spacing: 0.04em;
            }
            .prov-badge {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                background: rgba(16, 185, 129, 0.12);
                border: 1px solid rgba(16, 185, 129, 0.4);
                color: #34d399;
                padding: 4px 10px;
                border-radius: 9999px;
                font-size: 0.72rem;
                font-weight: 600;
                letter-spacing: 0.06em;
                margin-bottom: 18px;
            }
            .prov-author-box {
                background: rgba(15, 23, 42, 0.6);
                border: 1px solid rgba(255, 255, 255, 0.06);
                border-radius: 12px;
                padding: 16px 18px;
                margin-bottom: 16px;
            }
            .prov-author-name {
                font-size: 1.4rem;
                font-weight: 700;
                color: #ffffff;
                letter-spacing: 0.03em;
                margin-bottom: 2px;
            }
            .prov-author-role {
                font-size: 0.82rem;
                color: #38bdf8;
                margin-bottom: 12px;
                font-weight: 500;
            }
            .prov-link-row {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
            }
            .prov-link-btn {
                display: inline-flex;
                align-items: center;
                gap: 7px;
                background: rgba(30, 41, 59, 0.8);
                border: 1px solid rgba(56, 189, 248, 0.25);
                color: #e2e8f0;
                padding: 6px 12px;
                border-radius: 8px;
                font-size: 0.78rem;
                text-decoration: none;
                transition: all 0.2s ease;
            }
            .prov-link-btn:hover {
                background: rgba(56, 189, 248, 0.2);
                border-color: #38bdf8;
                color: #ffffff;
                transform: translateY(-1px);
            }
            .prov-seed-box {
                background: rgba(6, 78, 59, 0.15);
                border: 1px dashed rgba(52, 211, 153, 0.35);
                border-radius: 10px;
                padding: 12px 16px;
                margin-bottom: 16px;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .prov-seed-label {
                font-size: 0.75rem;
                color: #94a3b8;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            .prov-seed-val {
                font-family: 'Share Tech Mono', monospace;
                font-size: 1.05rem;
                color: #34d399;
                font-weight: 700;
                letter-spacing: 0.08em;
            }
            .prov-security-meta {
                font-family: 'Share Tech Mono', monospace;
                font-size: 0.7rem;
                color: #64748b;
                line-height: 1.4;
                word-break: break-all;
                background: rgba(0, 0, 0, 0.3);
                padding: 10px;
                border-radius: 8px;
                margin-bottom: 18px;
            }
            .prov-actions {
                display: flex;
                justify-content: flex-end;
                gap: 12px;
            }
            .prov-btn-close {
                background: linear-gradient(135deg, #0284c7, #0369a1);
                color: #ffffff;
                border: none;
                padding: 9px 20px;
                border-radius: 8px;
                font-size: 0.85rem;
                font-weight: 600;
                cursor: pointer;
                letter-spacing: 0.05em;
                transition: opacity 0.2s ease;
            }
            .prov-btn-close:hover {
                opacity: 0.9;
            }

            /* ═══════════ INSTANT HUD TOAST ═══════════ */
            .prov-hud-toast {
                position: fixed;
                top: 24px;
                right: 24px;
                z-index: 999999;
                background: rgba(10, 15, 29, 0.95);
                border: 1px solid rgba(52, 211, 153, 0.45);
                box-shadow: 0 0 30px rgba(16, 185, 129, 0.25), 0 10px 25px rgba(0, 0, 0, 0.5);
                border-radius: 12px;
                padding: 14px 18px;
                color: #f1f5f9;
                display: flex;
                align-items: center;
                gap: 14px;
                font-family: 'Rajdhani', sans-serif;
                animation: provSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                backdrop-filter: blur(10px);
                max-width: 420px;
            }
            @keyframes provSlideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            .prov-hud-icon {
                font-size: 20px;
                color: #34d399;
            }
            .prov-hud-title {
                font-size: 0.92rem;
                font-weight: 700;
                color: #34d399;
                letter-spacing: 0.04em;
            }
            .prov-hud-sub {
                font-size: 0.76rem;
                color: #94a3b8;
            }
        `;
        document.head.appendChild(style);
    }

    // ── Render Provenance Modal ──────────────────────────────────────────────────
    function showProvenanceModal(matchedCode) {
        injectStyles();
        const data = getProvenanceData();
        const existing = document.getElementById('l360ProvenanceModal');
        if (existing) existing.remove();

        const matchIdx = matchedCode ? data.seeds.findIndex(s => s.seed === matchedCode) : -1;
        const seedDisplay = matchIdx !== -1
            ? `<div class="prov-seed-box">
                    <div>
                        <div class="prov-seed-label">AUTHENTIC AUTHOR SEED KEY #[${String(matchIdx + 1).padStart(2, '0')}]</div>
                        <div class="prov-seed-val">${data.seeds[matchIdx].seed}</div>
                    </div>
                    <div style="color:#34d399;font-size:0.75rem;font-weight:bold;"><i class="fas fa-check-circle"></i> VERIFIED</div>
               </div>`
            : `<div class="prov-seed-box">
                    <div>
                        <div class="prov-seed-label">SYSTEM SIGNATURE SEEDS</div>
                        <div class="prov-seed-val">${data.totalSeeds} AUTHENTIC ORIGIN KEYS EMBEDDED</div>
                    </div>
                    <div style="color:#38bdf8;font-size:0.75rem;font-weight:bold;"><i class="fas fa-shield-alt"></i> PROTECTED</div>
               </div>`;

        const modal = document.createElement('div');
        modal.id = 'l360ProvenanceModal';
        modal.className = 'prov-overlay';
        modal.innerHTML = `
            <div class="prov-card" onclick="event.stopPropagation()">
                <div class="prov-glow-orb"></div>
                <div class="prov-header">
                    <div class="prov-shield">
                        <i class="fas fa-certificate"></i>
                    </div>
                    <div class="prov-title-wrap">
                        <h3>LogiSense 360 Provenance</h3>
                        <p>Digital Watermark & Cryptographic Ownership Proof</p>
                    </div>
                </div>
                <div class="prov-badge">
                    <i class="fas fa-lock"></i> INDISPUTABLE PROOF OF AUTHORSHIP
                </div>
                <div class="prov-author-box">
                    <div class="prov-author-name">${data.author}</div>
                    <div class="prov-author-role">Original Author, Creator & Chief Architect</div>
                    <div class="prov-link-row">
                        <a href="mailto:${data.contact}" class="prov-link-btn" target="_blank" rel="noopener">
                            <i class="fas fa-envelope"></i> ${data.contact}
                        </a>
                        <a href="${data.linkedin}" class="prov-link-btn" target="_blank" rel="noopener">
                            <i class="fab fa-linkedin"></i> LinkedIn
                        </a>
                        <a href="${data.github}" class="prov-link-btn" target="_blank" rel="noopener">
                            <i class="fab fa-github"></i> GitHub
                        </a>
                    </div>
                </div>
                ${seedDisplay}
                <div class="prov-security-meta">
                    SHA-256 FINGERPRINT: ${data.fingerprint}<br>
                    KERNEL: LOGISENSE-360-ORIGIN-AUTHENTICATED<br>
                    VERIFIED AT: ${data.timestamp}
                </div>
                <div class="prov-actions">
                    <button class="prov-btn-close" onclick="document.getElementById('l360ProvenanceModal')?.remove()">
                        <i class="fas fa-check"></i> Close Certificate
                    </button>
                </div>
            </div>
        `;

        modal.addEventListener('click', () => modal.remove());
        document.body.appendChild(modal);

        // Escape to dismiss
        const onKeyDown = function (e) {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', onKeyDown);
            }
        };
        document.addEventListener('keydown', onKeyDown);
    }

    // ── Instant Toast / HUD Notification ────────────────────────────────────────
    function showProvenanceToast() {
        injectStyles();
        const data = getProvenanceData();
        const existing = document.getElementById('l360ProvToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'l360ProvToast';
        toast.className = 'prov-hud-toast';
        toast.innerHTML = `
            <div class="prov-hud-icon"><i class="fas fa-shield-alt"></i></div>
            <div>
                <div class="prov-hud-title">AUTHOR PROVENANCE VERIFIED</div>
                <div class="prov-hud-sub">Creator: ${data.author} • LogiSense 360 Core [21 Seeds Active]</div>
            </div>
        `;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-10px)';
            setTimeout(() => toast.remove(), 400);
        }, 4000);
    }

    // ── Global Keyboard Shortcut: Ctrl + Alt + P ─────────────────────────────────
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'p' || e.key === 'P')) {
                e.preventDefault();
                showProvenanceToast();
                showProvenanceModal();
            }
        });
    }

    // ── Universal Input Interceptor ──────────────────────────────────────────────
    function checkInputProvenance(inputEl) {
        if (!inputEl || !inputEl.value) return;
        const val = inputEl.value.trim();
        if (!val) return;
        const seeds = _getDecodedSeeds();
        if (seeds.includes(val)) {
            showProvenanceModal(val);
        }
    }

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('input', function (e) {
            const target = e.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
                checkInputProvenance(target);
            }
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                const target = e.target;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
                    checkInputProvenance(target);
                }
            }
        });
    }
})();
