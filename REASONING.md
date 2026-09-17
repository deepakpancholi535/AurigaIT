# System Architecture & Technical Reasoning

This document outlines the architectural principles, domain model rationale, concurrency guarantees, and UX/accessibility decisions behind the **Apotheca Pharmacy FEFO Counter System**.

---

## 1. Domain Problem Context & FEFO Invariant

In pharmaceutical dispensing, selling expired or near-expiry inventory represents both a serious patient safety hazard and a significant financial loss. 

### First-Expired-First-Out (FEFO) Rule
Unlike general retail (which often uses FIFO/LIFO), pharmacy dispensing MUST follow strict **FEFO**:
- Inventory MUST be consumed from the batch with the earliest expiration date (`expiry_date`), regardless of when the batch arrived at the pharmacy (`received_date`).
- Ties in expiration date are resolved deterministically by earliest `received_date`, then by internal `id`.

---

## 2. Core Architectural Principles

### A. Server-Authoritative UTC Date Single-Source-of-Truth
- **Problem**: Client devices running web applications often suffer from inaccurate system clocks, timezone mismatches, or user clock manipulation.
- **Solution**: The canonical date (`YYYY-MM-DD`) is calculated strictly on the backend in UTC per request via `todayUtc()`.
- **Invariant**: `isSellable(batch, today)` is evaluated as `batch.quantity > 0 && batch.expiry_date >= today`. Client date values are never trusted for stock calculation or dispensing logic.

### B. Concurrency & Atomic Race Condition Protection
- **Problem**: In busy environments, multiple pharmacists or automated dispensers might attempt to dispense from the same batch simultaneously, leading to overselling or negative stock quantities.
- **Solution**: 
  - SQLite is configured in **WAL (Write-Ahead Logging)** mode with `foreign_keys = ON`.
  - The dispensing transaction (`dispenseTx`) executes inside an explicit SQLite `IMMEDIATE` transaction block.
  - SQLite serializes write transactions across the application. Stock levels are verified and decremented atomically in SQL (`UPDATE batches SET quantity = quantity - ? WHERE id = ? AND quantity >= ?`).
  - Audit log entries (`dispense_transactions` and `dispense_lines`) are written inside the exact same database transaction as the inventory deduction. If any step fails, the entire transaction rolls back cleanly.

### C. Idempotency Support
- **Problem**: Unstable network connections may cause client retries for dispensing requests.
- **Solution**: `POST /api/dispense` accepts an optional `idempotency_key`. Prior transactions matching the key immediately return the original transaction result without re-deducting inventory.

---

## 3. Frontend & UX Architectural Decisions

### A. Elimination of Legacy Browser Prompts/Alerts
- **Problem**: Native browser calls (`window.prompt()` and `window.alert()`) block the browser main thread, look unappealing, lack styling, cannot be keyboard navigated, and fail inside automated test runners or embedded webviews.
- **Solution**: Built custom modal dialog components (`#dispenseDialog`, `#batchViewDialog`) with focus trapping, ARIA roles, and smooth entry animations (`@keyframes modalSlideUp`).

### B. Resilient Cross-Origin API Host Resolution
- **Problem**: Development environments frequently host frontend static files on dev servers (e.g. VS Code Live Server on port `5500`) while the backend runs on port `3000`. Direct relative requests to `/api` hit the static server and return `HTTP 405 Method Not Allowed`.
- **Solution**:
  - Implemented dynamic `API_BASE` resolution in [app.js](file:///c:/Users/deepa/Downloads/AurigaIT_Round2-main/AurigaIT_Round2-main/public/app.js) that automatically routes API requests to `http://localhost:3000/api` when served from external static ports.
  - Updated backend `cors` configuration to allow development origins while respecting `process.env.FRONTEND_ORIGIN` in production.

### C. Defensive HTTP Response Parsing
- **Problem**: Calling `.json()` directly on empty responses (`204 No Content`), network dropouts, or non-JSON HTML error pages causes JavaScript syntax crashes (`Unexpected end of JSON input`).
- **Solution**: Wrapped response reading with `await r.text()` and safe `JSON.parse` fallback. Unsuccessful HTTP status codes (`!r.ok`) throw readable error messages containing the exact HTTP status code.

---

## 4. Accessibility (a11y) & UX Enhancements

1. **WAI-ARIA Tab Navigation**: Full tabbed interface implementation using `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, and keyboard arrow navigation (`ArrowRight` / `ArrowLeft`).
2. **Accessible Form Pairing**: Connected all `<label>` tags to `<input>` controls via explicit `for`/`id` pairs and `aria-describedby` error bindings.
3. **High Contrast & Visible Focus**: Applied high-contrast color tokens and explicit `:focus-visible` outline rings for screen reader and keyboard power-users.
4. **Non-blocking Toast System**: Added a container (`#toastContainer`) with `aria-live="polite"` for non-disruptive user feedback on actions.

---

## 5. Technical Trade-Offs & Scalability

| Aspect | Current Architecture | Scalability Consideration |
| :--- | :--- | :--- |
| **Database Engine** | Embedded SQLite (WAL Mode) | Ideal for single-instance, high-performance edge/local pharmacy deployments. For horizontal multi-node clusters, replace with PostgreSQL / MySQL using row-level locking (`SELECT ... FOR UPDATE`). |
| **Session Management** | In-Memory Token Map | Fast and lightweight for counter terminals. Can be backed by Redis for multi-server token revocation. |
| **Frontend Framework** | Vanilla JS / CSS Design System | Zero dependency overhead, instant loading speed (< 10ms), and zero build steps required. |

---

## 6. 2026-09-17 Implementation Reasoning Update

### Daily Job Feedback

The `/clock` operation changes sellability by quarantining expired batches; it does not reduce physical quantities. The frontend now reflects that distinction by updating the simulated date, refreshing active search results, reloading inventory and expiry alerts, and displaying the last-run counts beside the control.

### Notification Outbox Behavior

Low-stock notifications are emitted when sellable stock is below the threshold of 10 after a batch is added, imported, or dispensed. A per-medicine active-alert set prevents repeated notifications while stock remains below the threshold. Once stock returns to 10 or more, the state resets and a future threshold crossing can notify again.

### Validation and Safety Decisions

- ISO and `DD/MM/YYYY` dates are accepted only after real calendar validation.
- Idempotency keys are bound to medicine and requested quantity, preventing accidental replay of a different dispense request.
- Rejected idempotent dispenses retain HTTP `409` behavior on replay.
- Production authentication requires explicit environment credentials; the documented `pharmacist` / `change-me` pair is for demo and test usage only.
- The UI keeps server-provided dates authoritative so browser clock differences do not change inventory decisions.

### Latest Verification

The complete automated suite passes **16/16 tests** with no diagnostics in the backend, frontend JavaScript, HTML, or CSS files.
