# SololevelingTrad

SololevelingTrad is a full-stack cryptocurrency trading SaaS project focused on delivering a modern, secure, and intuitive digital asset platform. It combines a premium dark-themed interface with market analytics, portfolio tools, subscription management, and administrative controls.

## ✨ Key Features

- **📊 Trading Dashboard** — Interactive market charts, cryptocurrency data, watchlists, and market insights.
- **🔐 Authentication & Security** — Secure user authentication, email verification, and account management.
- **💼 Wallet Management** — Wallet balance tracking, transaction history, and deposit workflows where supported.
- **📈 Market Analytics** — Visualize cryptocurrency price movements and market trends.
- **💎 Subscription Plans** — Tiered plans for subscription-based platform features.
- **🛡️ Admin Dashboard** — Centralized user management, transaction monitoring, analytics, and pricing controls.
- **🔔 Alerts & Notifications** — Platform updates and market-related notifications.
- **💬 Community Features** — Communication and collaboration features, where implemented.
- **🎨 Premium UI/UX** — Responsive layouts, polished animations, and a modern fintech-inspired visual design.

## 🧰 Technology Stack

Built around the MERN ecosystem. Versions below are those declared in `package.json` and `backend/package.json`.

### Frontend

- **React** 19 with **Vite** for the build and dev server
- **React Router** for client-side routing
- **Tailwind CSS** v4 for styling
- **Charting** — Recharts and TradingView Lightweight Charts
- **3D & motion** — three.js with React Three Fiber/Drei, Framer Motion, GSAP
- **Firebase** client SDK for authentication
- **Realtime** — Socket.IO client
- **Live video** — VideoSDK React SDK and hls.js
- **UI utilities** — lucide-react icons, clsx, tailwind-merge

### Backend

- **Node.js** with **Express**
- **MongoDB** via **Mongoose**
- **Authentication & authorization** — JWT access/refresh tokens (httpOnly cookies), bcrypt password hashing, and Firebase Admin for identity-token verification, with server-side role-based access control
- **Security hardening** — Helmet, CORS allowlisting, rate limiting, Mongo query sanitization, and Zod request validation
- **Payments** — Whop (official server-side SDK) for subscription checkout, with Razorpay and Stripe integrations also present
- **Market data** — CoinGecko (works without a key; an API key raises the rate limit) with optional CoinMarketCap
- **Email** — Nodemailer for OTP and welcome mail
- **Realtime** — Socket.IO server
- **Caching** — optional Redis with an in-process fallback
- **Other** — Multer uploads, Compression, Morgan request logging, dotenv configuration

### Tooling & Testing

- **Oxlint** for linting
- **`node:test`** for the backend unit/integration suite
- **Playwright** (Chromium) for browser-level tests

## 🎯 Project Goal

To build a polished, extensible cryptocurrency SaaS platform that brings trading tools, market insights, account management, and subscription features together in one unified experience.

## 🔒 Security Notice

Never commit API keys, database credentials, Firebase service-account files, private keys, SMTP passwords, payment secrets, or environment files containing sensitive information. Use environment variables and provide a sanitized `.env.example` for configuration.

This repository ships a committed pre-commit guard (`.githooks/pre-commit`) that blocks staged secret-shaped files even when `.gitignore` is bypassed with `git add -f`. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

If a credential ever reaches a commit, **rotate it immediately** — removing the commit does not un-leak the value.

## 🚂 Railway deployment

- If frontend and backend are deployed together and the backend serves the built `dist` folder, leave `VITE_API_URL` unset. The production frontend uses the current site origin for API and Socket.IO requests.
- If deployed as separate Railway services, set `VITE_API_URL` on the **frontend service** to `https://<backend-public-domain>/api`, and set `CLIENT_URL` on the **backend service** to the frontend's public origin. Redeploy/rebuild the frontend after changing `VITE_API_URL`, since Vite embeds it at build time.
- Confirm the backend is reachable at `https://<backend-public-domain>/api/health`.
- **Single-service setup (default).** The repo ships a root `railway.json` that builds the frontend (`npm run build` → `dist/`), installs the backend, then starts `backend/server.js`, which serves both the API (`/api/*`) and the SPA from one origin. Keep the service **Root Directory** at the repo root. Required variables: `NODE_ENV=production`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `MONGODB_URI`, plus any `VITE_*` values (they are baked in at build time). Do **not** set `PORT` — Railway injects it. Health check path: `/api/health`.

## ⚠️ Disclaimer

This project is intended for software development and educational purposes unless otherwise stated. Verify whether trading, wallet, and payment features use live services or simulated data before relying on them for financial activity.
