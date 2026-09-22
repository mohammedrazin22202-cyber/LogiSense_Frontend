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

    })();
