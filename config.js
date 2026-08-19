/**
 * LogiSense 360 – API Configuration
 * ────────────────────────────────────────────────────────────────────────────
 * Set FLEET_API_BASE to the URL of your backend server.
 *
 *  LOCAL DEVELOPMENT  →  http://localhost:1995   (default, no change needed)
 *  PRODUCTION (Render) →  https://your-app.onrender.com
 *
 * This file is intentionally simple so it can be updated without touching
 * any business logic in script.js.
 * ────────────────────────────────────────────────────────────────────────────
 */
window.FLEET_API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:1995'
    : 'https://logisense-backend-srcz.onrender.com';
