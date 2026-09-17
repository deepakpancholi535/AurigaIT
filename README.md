# Apotheca · Pharmacy FEFO Inventory & Dispensing System

A production-oriented, high-performance pharmacy inventory management and FEFO (First-Expired-First-Out) dispensing counter application. Built with **Node.js, Express, SQLite (WAL mode)**, and a modern **WAI-ARIA accessible Vanilla JS/CSS** frontend.

---

## Key Features

- **Strict FEFO Dispensing Engine**: Server-side calculation automatically picks in-date stock sorted deterministically by earliest expiry date, earliest received date, and batch ID.
- **Level 1 — T2 Automation (`POST /clock`)**: Daily job that flags batches expiring within 7 days, automatically quarantines expired batches (`quarantined = 1`), and reports counts.
- **Level 2 — T4 Messy Data Import (`POST /api/batches/import`)**: Normalization parser handling dirty strings (e.g. `'10 units'`), mixed date formats (`DD/MM/YYYY` vs ISO `YYYY-MM-DD`), nulls, and duplicate row deduplication with a `{ imported, deduped, rejected }` report.
- **Level 3 — T1 Notification Service (`/outbox`)**: Low-stock re-order trigger that emits notification events to `/outbox` whenever sellable stock drops below threshold.
- **Atomic Transaction Safety**: SQLite `IMMEDIATE` write transactions serialize concurrent dispense requests, guaranteeing zero overselling and zero race conditions.
- **Server-Authoritative UTC Dates**: Expiry dates and sellability predicates are calculated in UTC (`YYYY-MM-DD`). Client system clock drift never compromises patient safety.
- **Audit Compliance Logging**: Every dispensing action (successful or rejected) writes an immutable audit log with full line-item batch breakdowns and idempotency key support.

---

## Quick Start Guide

### Prerequisites
- Node.js (v18.x or higher)
- npm (v9.x or higher)

### 1. Installation & Environment Setup
```bash
# Clone the repository and install dependencies
npm install

# Copy environment variables configuration
cp .env.example .env
```

### 2. Seed Database with Sample Dataset
Populate the database with sample medicines, active FEFO batches, expiring-soon alerts, and expired stock:
```bash
npm run seed
```

### 3. Start the Application Server
```bash
npm start
# Server will listen at http://localhost:3000
```

### 4. Default Login Credentials
- **Username**: `pharmacist`
- **Password**: `change-me`

*(Credentials can be customized in `.env` via `PHARMACY_USER` and `PHARMACY_PASSWORD`).*

### 5. Running Automated Tests
```bash
npm test
```

---

## Project Structure

```
AurigaIT_Round2/
├── public/                     # Frontend Client Files
│   ├── index.html              # WAI-ARIA Accessible HTML markup & Modals
│   ├── styles.css              # Custom CSS Design System, Tokens & Animations
│   └── app.js                  # Frontend Application Logic, Fetch & Modals
├── test/
│   └── fefo.test.js            # Vitest Integration & Invariant Test Suite (13 tests)
├── .env.example                # Sample Environment Variables
├── package.json                # Project Dependencies & Scripts
├── pharmacy.sqlite             # SQLite Database (Auto-created on start/seed)
├── README.md                   # Full Setup & Project Overview
├── REASONING.md                # System Design, Architecture & Trade-Offs
├── AI_LOGS.md                  # Development History, Bug Fixes & AI Logs
├── seed.js                     # Sample Dataset Seeder
└── server.js                   # Express Backend & FEFO Database Engine
```

---

## REST API Reference

All mutating endpoints require an authentication header:  
`Authorization: Bearer <token>` (obtained via `POST /api/auth/login`).

### Authentication
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Authenticate pharmacist (`{ username, password }`) |

### Medicines & Batches
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/medicines` | Paginated list of medicines (`?page=1&limit=25`) |
| `POST` | `/api/medicines` | Create a new medicine entry |
| `GET` | `/api/medicines/:id` | Fetch medicine details and FEFO-ordered batch list |
| `GET` | `/api/medicines/:id/batches` | List batches for a specific medicine |
| `POST` | `/api/medicines/:id/batches` | Create a new batch for a medicine |

### Dispensing & Search
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/dispense` | Execute FEFO dispense (`{ medicine_id, quantity, idempotency_key? }`) |
| `GET` | `/api/search` | Search stock by medicine or generic name (`?q=paracetamol`) |

### Advanced Twist Levels (1, 2, and 3)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/clock` | Level 1: Flag 7-day expiring stock, quarantine expired stock, report counts |
| `POST` | `/api/batches/import` | Level 2: Import messy batch list returning `{ imported, deduped, rejected }` |
| `GET` | `/outbox` | Level 3: Notification Service outbox queue for low-stock re-order alerts |

---

## Security & Architecture Summary

1. **Helmet & Security Headers**: Sets HTTP security headers to protect against common web vulnerabilities.
2. **CORS Flexibility**: Supports production origins while permitting static dev server preflight requests.
3. **Parameterized SQL Queries**: All SQLite queries use prepared statements, eliminating SQL injection.
4. **Idempotency**: Dispense requests accept an optional `idempotency_key` to prevent accidental double-deduction during network retries.
5. **Rate Limiting**: `express-rate-limit` protects sensitive dispensing routes against abuse.
