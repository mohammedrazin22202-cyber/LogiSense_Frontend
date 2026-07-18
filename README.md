# LogiSense 360 — Frontend

Static web application for the LogiSense 360 fleet management platform.  
Pure HTML + CSS + JavaScript — no build step required.

---

## Folder Structure

```
frontend/
├── index.html              # Main application shell
├── script.js               # All app logic (13 modules)
├── style.css               # Full design system & animations
├── config.js               # ← API URL config (edit for production)
├── demo-data.js            # Demo/offline data helpers
├── favicon.png             # App icon
├── logo.png                # Brand logo
├── start.bat               # Windows startup script (serves on port 8080)
└── Customer_ChatBot/       # Standalone keyword-matching chatbot
    ├── index.html
    └── Headache/           # Response text files
```

---

## Setup & Running

### Prerequisites

- **Node.js** (for `npx http-server`) — download from [nodejs.org](https://nodejs.org)
- Backend must be running first — see `backend/README.md`

### 1. Configure the API URL

Open **`config.js`** and set the backend URL:

```js
// Local development (default)
window.FLEET_API_BASE = 'http://localhost:1995';

// Production (after deploying backend to Render)
window.FLEET_API_BASE = 'https://your-app.onrender.com';
```

**This is the only file you need to change when deploying to production.**

### 2. Start the static server (Windows)

Double-click **`start.bat`** — it will:
- Check for Node.js / npx
- Serve the frontend on **http://localhost:8080**
- Auto-open your browser

### 3. Manual startup

```bash
npx http-server . -p 8080 --cors -c-1
```

---

## Pages & Features

| Section | Description |
|---|---|
| **Dashboard** | Live vehicle map, KPIs, alert feed via SSE |
| **Fleet** | Vehicle registry, status, maintenance tracking |
| **Orders / Shipments** | Order lifecycle, POD, dispatch |
| **Routes** | Route planning and optimisation |
| **Warehouses** | Inventory, inbound/outbound, stock counts |
| **Drivers** | Driver profiles, scoring, performance |
| **Analytics** | Charts and reports |
| **ChatBot** | Customer-facing keyword chatbot (`/Customer_ChatBot/`) |

---

## Deployment (Netlify / Vercel / GitHub Pages)

1. Update `config.js` with your Render backend URL
2. Drag and drop the `frontend/` folder onto [netlify.com/drop](https://app.netlify.com/drop)  
   — or connect your GitHub repo on Vercel/Netlify for automatic deploys

> No build step needed. Every file is served as-is.
