import express from 'express';
import Database from 'better-sqlite3';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const db = new Database(process.env.DATABASE_FILE || './pharmacy.sqlite');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS medicines(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,generic_name TEXT,unit TEXT NOT NULL DEFAULT 'unit',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS medicines_name_ci ON medicines(lower(name));
CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY AUTOINCREMENT,medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,batch_no TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity >= 0),expiry_date TEXT NOT NULL,received_date TEXT NOT NULL,quarantined INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(medicine_id,batch_no));
CREATE INDEX IF NOT EXISTS batches_medicine_expiry ON batches(medicine_id,expiry_date,received_date,id);
CREATE INDEX IF NOT EXISTS batches_expiry ON batches(expiry_date);
CREATE TABLE IF NOT EXISTS dispense_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,medicine_id INTEGER NOT NULL REFERENCES medicines(id),quantity_requested INTEGER NOT NULL,quantity_dispensed INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('success','rejected')),reason TEXT, idempotency_key TEXT UNIQUE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dispense_lines(id INTEGER PRIMARY KEY AUTOINCREMENT,dispense_transaction_id INTEGER NOT NULL REFERENCES dispense_transactions(id),batch_id INTEGER NOT NULL REFERENCES batches(id),quantity_taken INTEGER NOT NULL CHECK(quantity_taken > 0));
CREATE INDEX IF NOT EXISTS dispense_created ON dispense_transactions(created_at);
`);

try { db.exec(`ALTER TABLE batches ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;`); } catch (e) {}

let simulatedClockDate = null;
export const todayUtc = () => simulatedClockDate || new Date().toISOString().slice(0, 10);
export const isSellable = (batch, today = todayUtc()) => batch.quantity > 0 && batch.expiry_date >= today && (!batch.quarantined);

// Level 3 — Notification Outbox Array
export const outbox = [];
const lowStockAlertActive = new Set();
const checkReorderAlert = (medicineId, today = todayUtc()) => {
  const m = db.prepare('SELECT * FROM medicines WHERE id=?').get(medicineId);
  if (!m) return;
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN quantity > 0 AND expiry_date >= ? AND quarantined = 0 THEN quantity ELSE 0 END),0) sellable_stock FROM batches WHERE medicine_id=?`).get(today, medicineId);
  const sellable = row ? row.sellable_stock : 0;
  const threshold = 10;
  if (sellable >= threshold) {
    lowStockAlertActive.delete(medicineId);
    return;
  }
  if (lowStockAlertActive.has(medicineId)) return;
  if (sellable < threshold) {
    const alert = {
      id: crypto.randomUUID(),
      type: 'reorder_alert',
      medicine_id: medicineId,
      medicine_name: m.name,
      sellable_stock: sellable,
      threshold,
      timestamp: new Date().toISOString()
    };
    outbox.push(alert);
    lowStockAlertActive.add(medicineId);
  }
};
const refreshReorderAlertState = (medicineId, today = todayUtc()) => {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN quantity > 0 AND expiry_date >= ? AND quarantined = 0 THEN quantity ELSE 0 END),0) sellable_stock FROM batches WHERE medicine_id=?`).get(today, medicineId);
  if (row && row.sellable_stock >= 10) lowStockAlertActive.delete(medicineId);
};

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN : true }));
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const dispenseLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const tokens = new Map();
const fail = (res, status, code, message, details = {}) => res.status(status).json({ error: { code, message, details } });
const positiveInt = z.number().int().safe().positive().max(10_000_000);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === v; }, 'must be a real YYYY-MM-DD date');
const auth = (req, res, next) => { const value = req.headers.authorization || ''; const token = value.startsWith('Bearer ') ? value.slice(7) : ''; const expiresAt = token ? tokens.get(token) : null; if (!expiresAt) return fail(res, 401, 'UNAUTHORIZED', 'Pharmacist authentication required'); if (expiresAt <= Date.now()) { tokens.delete(token); return fail(res, 401, 'TOKEN_EXPIRED', 'Pharmacist session has expired'); } next(); };
const stock = (medicineId, today = todayUtc()) => {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN quantity > 0 AND expiry_date >= ? AND quarantined = 0 THEN quantity ELSE 0 END),0) sellable_stock, COALESCE(SUM(quantity),0) total_physical_stock FROM batches WHERE medicine_id=?`).get(today, medicineId);
  return { sellable_stock: row.sellable_stock, total_physical_stock: row.total_physical_stock, in_date: row.sellable_stock > 0 };
};
const medicineView = (m, today) => ({ ...m, ...stock(m.id, today) });

app.post('/api/auth/login', (req,res) => { const body = req.body || {}; const user = process.env.PHARMACY_USER || (process.env.NODE_ENV === 'test' ? 'pharmacist' : null); const pass = process.env.PHARMACY_PASSWORD || (process.env.NODE_ENV === 'test' ? 'change-me' : null); if (!user || !pass) return fail(res, 500, 'AUTH_NOT_CONFIGURED', 'Pharmacist credentials are not configured'); if (body.username !== user || body.password !== pass) return fail(res,401,'INVALID_CREDENTIALS','Invalid pharmacist credentials'); const token = crypto.randomBytes(32).toString('hex'); tokens.set(token, Date.now() + 8*60*60*1000); return res.json({ token, expires_in: 28800 }); });
app.get('/api/medicines', (req,res) => { const page = Math.max(1, Number(req.query.page)||1), limit = Math.min(100, Math.max(1, Number(req.query.limit)||25)), today=todayUtc(); const total=db.prepare('SELECT COUNT(*) n FROM medicines').get().n; const rows=db.prepare('SELECT * FROM medicines ORDER BY name LIMIT ? OFFSET ?').all(limit,(page-1)*limit).map(m=>medicineView(m,today)); res.json({ data:rows,pagination:{page,limit,total,pages:Math.ceil(total/limit)},today }); });
app.post('/api/medicines', auth, (req,res) => { const s=z.object({name:z.string().trim().min(1).max(200),generic_name:z.string().trim().max(200).optional().nullable(),unit:z.string().trim().min(1).max(40).default('unit')}).safeParse(req.body); if(!s.success)return fail(res,400,'VALIDATION_ERROR','Invalid medicine fields',s.error.flatten().fieldErrors); try { const r=db.prepare('INSERT INTO medicines(name,generic_name,unit) VALUES(?,?,?)').run(s.data.name,s.data.generic_name||null,s.data.unit); const newMedId = r.lastInsertRowid; res.status(201).json(medicineView(db.prepare('SELECT * FROM medicines WHERE id=?').get(newMedId),todayUtc())); } catch(e) { if(String(e.message).includes('UNIQUE')) return fail(res,409,'DUPLICATE_MEDICINE','A medicine with this name already exists'); throw e; } });
app.get('/api/medicines/:id', (req,res) => { const id=Number(req.params.id), m=db.prepare('SELECT * FROM medicines WHERE id=?').get(id); if(!m)return fail(res,404,'NOT_FOUND','Medicine not found'); const today=todayUtc(); const batches=db.prepare('SELECT * FROM batches WHERE medicine_id=? ORDER BY expiry_date,received_date,id').all(id); res.json({ ...medicineView(m,today), batches, today }); });
app.get('/api/medicines/:id/batches', (req,res) => { const id=Number(req.params.id); if(!db.prepare('SELECT 1 FROM medicines WHERE id=?').get(id))return fail(res,404,'NOT_FOUND','Medicine not found'); res.json({data:db.prepare('SELECT * FROM batches WHERE medicine_id=? ORDER BY expiry_date,received_date,id').all(id),today:todayUtc()}); });
app.post('/api/medicines/:id/batches', auth, (req,res) => { const id=Number(req.params.id); if(!db.prepare('SELECT 1 FROM medicines WHERE id=?').get(id))return fail(res,404,'NOT_FOUND','Medicine not found'); const s=z.object({batch_no:z.string().trim().min(1).max(100),quantity:positiveInt,expiry_date:dateSchema,received_date:dateSchema.optional()}).safeParse(req.body); if(!s.success)return fail(res,400,'VALIDATION_ERROR','Invalid batch fields',s.error.flatten().fieldErrors); try { const r=db.prepare('INSERT INTO batches(medicine_id,batch_no,quantity,expiry_date,received_date) VALUES(?,?,?,?,?)').run(id,s.data.batch_no,s.data.quantity,s.data.expiry_date,s.data.received_date||todayUtc()); checkReorderAlert(id); const row=db.prepare('SELECT * FROM batches WHERE id=?').get(r.lastInsertRowid); res.status(201).json({batch:row,warning:row.expiry_date<todayUtc()?'Batch is expired and excluded from sellable stock.':null}); } catch(e) { if(String(e.message).includes('UNIQUE'))return fail(res,409,'DUPLICATE_BATCH','Batch number already exists for this medicine'); throw e; } });

const dispenseTx = db.transaction((medicineId, quantity, key, today) => {
  if(key){ const prior=db.prepare('SELECT * FROM dispense_transactions WHERE idempotency_key=?').get(key); if(prior){ if(prior.medicine_id !== medicineId || prior.quantity_requested !== quantity) return { conflict:true, prior }; return { prior }; } }
  const m=db.prepare('SELECT id FROM medicines WHERE id=?').get(medicineId); if(!m)return { missing:true };
  const rows=db.prepare('SELECT * FROM batches WHERE medicine_id=? AND quantity>0 AND expiry_date>=? AND quarantined=0 ORDER BY expiry_date,received_date,id').all(medicineId,today);
  let available=rows.reduce((n,b)=>n+b.quantity,0), remaining=quantity, lines=[];
  if(remaining>available){ const r=db.prepare(`INSERT INTO dispense_transactions(medicine_id,quantity_requested,quantity_dispensed,status,reason,idempotency_key) VALUES(?,?,?,?,?,?)`).run(medicineId,quantity,0,'rejected','insufficient in-date stock',key||null); return { rejected:true,id:r.lastInsertRowid,available }; }
  for(const b of rows){ if(!remaining)break; const take=Math.min(b.quantity,remaining); db.prepare('UPDATE batches SET quantity=quantity-? WHERE id=? AND quantity>=?').run(take,b.id,take); remaining-=take; lines.push({batch_id:b.id,batch_no:b.batch_no,quantity_taken:take,expiry_date:b.expiry_date}); }
  const r=db.prepare(`INSERT INTO dispense_transactions(medicine_id,quantity_requested,quantity_dispensed,status,idempotency_key) VALUES(?,?,?,?,?)`).run(medicineId,quantity,quantity,'success',key||null); const add=db.prepare('INSERT INTO dispense_lines(dispense_transaction_id,batch_id,quantity_taken) VALUES(?,?,?)'); for(const l of lines)add.run(r.lastInsertRowid,l.batch_id,l.quantity_taken);
  checkReorderAlert(medicineId, today);
  return { success:true,id:r.lastInsertRowid,lines };
});

app.post('/api/dispense', auth, dispenseLimiter, (req,res) => { const s=z.object({medicine_id:z.coerce.number().int().positive(),quantity:positiveInt,idempotency_key:z.string().trim().min(1).max(120).optional()}).safeParse(req.body); if(!s.success)return fail(res,400,'VALIDATION_ERROR','quantity must be a positive integer and medicine_id is required',s.error.flatten().fieldErrors); try { const out=dispenseTx(s.data.medicine_id,s.data.quantity,s.data.idempotency_key,todayUtc()); if(out.missing)return fail(res,404,'NOT_FOUND','Medicine not found'); if(out.conflict)return fail(res,409,'IDEMPOTENCY_CONFLICT','Idempotency key was already used for a different dispense request',{transaction_id:out.prior.id}); if(out.prior){ if(out.prior.status === 'rejected') return fail(res,409,'INSUFFICIENT_STOCK','Insufficient in-date stock',{transaction_id:out.prior.id,replayed:true}); return res.json({dispensed:out.prior.quantity_dispensed,status:out.prior.status,transaction_id:out.prior.id,replayed:true}); } if(out.rejected)return fail(res,409,'INSUFFICIENT_STOCK','Insufficient in-date stock',{available:out.available,transaction_id:out.id}); res.json({dispensed:s.data.quantity,status:'success',transaction_id:out.id,breakdown:out.lines}); } catch(e){ console.error(e); fail(res,500,'INTERNAL_ERROR','Unable to complete dispense'); } });
app.get('/api/search', (req,res) => { const q=String(req.query.q??'').trim(); if(!q)return fail(res,400,'VALIDATION_ERROR','Search query cannot be empty'); const escaped=q.replace(/[\\%_]/g,c=>'\\'+c); const today=todayUtc(); const rows=db.prepare(`SELECT * FROM medicines WHERE lower(name) LIKE lower(?) ESCAPE '\\' OR lower(COALESCE(generic_name,'')) LIKE lower(?) ESCAPE '\\' ORDER BY name`).all(`%${escaped}%`,`%${escaped}%`).map(m=>medicineView(m,today)); res.json({found:rows.length>0,query:q,data:rows,today}); });

// Level 1 — T2 (Automation: POST /clock)
const handleClockPost = (req, res) => {
  const body = req.body || {};
  const date = body.date ? String(body.date).trim() : todayUtc();
  const parsed = dateSchema.safeParse(date);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'date must be a real YYYY-MM-DD date', parsed.error.flatten().formErrors);

  const end7Days = new Date(`${date}T00:00:00Z`);
  end7Days.setUTCDate(end7Days.getUTCDate() + 7);
  const end7DaysStr = end7Days.toISOString().slice(0, 10);
  simulatedClockDate = date;

  const expiringSoonCount = db.prepare(`
    SELECT COUNT(*) n FROM batches 
    WHERE quantity > 0 AND quarantined = 0 AND expiry_date >= ? AND expiry_date <= ?
  `).get(date, end7DaysStr).n;

  const quarantineRes = db.prepare(`
    UPDATE batches SET quarantined = 1 WHERE quantity > 0 AND expiry_date < ? AND quarantined = 0
  `).run(date);

  const quarantinedCount = quarantineRes.changes;

  res.json({
    date,
    expiring_soon_count: expiringSoonCount,
    quarantined_count: quarantinedCount
  });
};
app.post('/clock', handleClockPost);
app.post('/api/clock', auth, handleClockPost);

// Level 2 — T4 (Messy Data Import: POST /api/batches/import)
const parseMessyDate = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  if (dateSchema.safeParse(s).success) return s;
  const m1 = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m1) {
    const day = m1[1].padStart(2, '0');
    const month = m1[2].padStart(2, '0');
    const year = m1[3];
    const normalized = `${year}-${month}-${day}`;
    return dateSchema.safeParse(normalized).success ? normalized : null;
  }
  return null;
};

const parseMessyQuantity = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  const m = String(raw).match(/\d+/);
  if (m) {
    const n = parseInt(m[0], 10);
    return n > 0 ? n : null;
  }
  return null;
};

const handleImportBatches = (req, res) => {
  const body = req.body || {};
  const defaultMedId = body.medicine_id ? Number(body.medicine_id) : null;
  const items = Array.isArray(body.items) ? body.items : (Array.isArray(body) ? body : []);

  let imported = 0;
  let deduped = 0;
  let rejected = 0;
  let importedItems = [];
  let rejectedItems = [];
  const seenKeys = new Set();
  const affectedMedicineIds = new Set();

  for (const rawItem of items) {
    const medId = Number(rawItem.medicine_id || defaultMedId);
    const medExists = medId && db.prepare('SELECT 1 FROM medicines WHERE id=?').get(medId);
    const batchNo = rawItem.batch_no ? String(rawItem.batch_no).trim() : null;
    const qty = parseMessyQuantity(rawItem.quantity);
    const expiryDate = parseMessyDate(rawItem.expiry_date);
    const receivedDate = rawItem.received_date ? parseMessyDate(rawItem.received_date) : todayUtc();

    if (!medExists || !batchNo || !qty || !expiryDate) {
      rejected++;
      rejectedItems.push({ item: rawItem, reason: 'Invalid or missing fields' });
      continue;
    }

    affectedMedicineIds.add(medId);

    const dupKey = `${medId}:${batchNo.toLowerCase()}`;
    const dbExisting = db.prepare('SELECT * FROM batches WHERE medicine_id=? AND lower(batch_no)=lower(?)').get(medId, batchNo);

    if (seenKeys.has(dupKey) || dbExisting) {
      deduped++;
      if (dbExisting) {
        db.prepare('UPDATE batches SET quantity = quantity + ? WHERE id=?').run(qty, dbExisting.id);
      }
      continue;
    }

    try {
      db.prepare('INSERT INTO batches(medicine_id, batch_no, quantity, expiry_date, received_date) VALUES(?, ?, ?, ?, ?)')
        .run(medId, batchNo, qty, expiryDate, receivedDate);
      seenKeys.add(dupKey);
      imported++;
      importedItems.push({ medicine_id: medId, batch_no: batchNo, quantity: qty, expiry_date: expiryDate });
    } catch (e) {
      deduped++;
    }
  }

  for (const medicineId of affectedMedicineIds) checkReorderAlert(medicineId);

  res.json({
    imported,
    deduped,
    rejected,
    details: {
      imported_items: importedItems,
      rejected_items: rejectedItems
    }
  });
};
app.post('/api/batches/import', auth, handleImportBatches);
app.post('/batches/import', auth, handleImportBatches);

// Level 3 — T1 (Integration: /outbox Notification Service)
const handleOutboxGet = (req, res) => res.json({ outbox, total: outbox.length });
const handleOutboxDelete = (req, res) => { outbox.length = 0; lowStockAlertActive.clear(); res.json({ cleared: true, outbox: [] }); };

app.get('/outbox', auth, handleOutboxGet);
app.get('/api/outbox', auth, handleOutboxGet);
app.delete('/outbox', auth, handleOutboxDelete);
app.delete('/api/outbox', auth, handleOutboxDelete);

const alertDays=(raw)=>{const n=raw===undefined?30:Number(raw); if(!Number.isInteger(n)||n<0||n>365)throw new Error('days must be an integer from 0 to 365'); return n;};
app.get('/api/alerts/expiring-soon',(req,res)=>{try{const days=alertDays(req.query.days),today=todayUtc(),end=new Date(`${today}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+days);const data=db.prepare(`SELECT b.*,m.name medicine_name FROM batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.quantity>0 AND b.expiry_date>=? AND b.expiry_date<=? AND b.quarantined=0 ORDER BY b.expiry_date,b.received_date,b.id`).all(today,end.toISOString().slice(0,10));res.json({days,today,data});}catch(e){return fail(res,400,'VALIDATION_ERROR',e.message);}});
app.get('/api/alerts/expired',(req,res)=>res.json({today:todayUtc(),data:db.prepare(`SELECT b.*,m.name medicine_name FROM batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.quantity>0 AND (b.expiry_date<? OR b.quarantined=1) ORDER BY b.expiry_date,b.id`).all(todayUtc())}));
app.get('/api/dispense-log',auth,(req,res)=>{const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||25)),total=db.prepare('SELECT COUNT(*) n FROM dispense_transactions').get().n;const data=db.prepare(`SELECT d.*,m.name medicine_name,COALESCE((SELECT json_group_array(json_object('batch_id',l.batch_id,'quantity_taken',l.quantity_taken)) FROM dispense_lines l WHERE l.dispense_transaction_id=d.id),'[]') lines FROM dispense_transactions d JOIN medicines m ON m.id=d.medicine_id ORDER BY d.id DESC LIMIT ? OFFSET ?`).all(limit,(page-1)*limit);res.json({data,pagination:{page,limit,total,pages:Math.ceil(total/limit)}});});
app.use((err,req,res,next)=>{console.error(err);if(!res.headersSent)fail(res,500,'INTERNAL_ERROR','Unexpected server error');});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
export default app;
if(process.env.NODE_ENV!=='test')app.listen(process.env.PORT||3000,()=>console.log(`Pharmacy FEFO listening on ${process.env.PORT||3000}`));
