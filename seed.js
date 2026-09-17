import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_FILE || path.join(__dirname, 'pharmacy.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
CREATE TABLE IF NOT EXISTS medicines(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,generic_name TEXT,unit TEXT NOT NULL DEFAULT 'unit',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS medicines_name_ci ON medicines(lower(name));
CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY AUTOINCREMENT,medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,batch_no TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity >= 0),expiry_date TEXT NOT NULL,received_date TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(medicine_id,batch_no));
CREATE INDEX IF NOT EXISTS batches_medicine_expiry ON batches(medicine_id,expiry_date,received_date,id);
CREATE INDEX IF NOT EXISTS batches_expiry ON batches(expiry_date);
CREATE TABLE IF NOT EXISTS dispense_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,medicine_id INTEGER NOT NULL REFERENCES medicines(id),quantity_requested INTEGER NOT NULL,quantity_dispensed INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('success','rejected')),reason TEXT, idempotency_key TEXT UNIQUE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dispense_lines(id INTEGER PRIMARY KEY AUTOINCREMENT,dispense_transaction_id INTEGER NOT NULL REFERENCES dispense_transactions(id),batch_id INTEGER NOT NULL REFERENCES batches(id),quantity_taken INTEGER NOT NULL CHECK(quantity_taken > 0));
CREATE INDEX IF NOT EXISTS dispense_created ON dispense_transactions(created_at);
`);

console.log('Seeding pharmacy dataset into:', dbPath);

const today = new Date();
const fmt = (d) => d.toISOString().slice(0, 10);

const addDays = (n) => {
  const d = new Date(today);
  d.setDate(d.getDate() + n);
  return fmt(d);
};

const medicines = [
  {
    name: 'Paracetamol 500mg',
    generic_name: 'Acetaminophen',
    unit: 'tablet',
    batches: [
      { batch_no: 'PCM-2026-A', quantity: 150, expiry_date: addDays(15), received_date: addDays(-60) },
      { batch_no: 'PCM-2026-B', quantity: 300, expiry_date: addDays(90), received_date: addDays(-30) },
      { batch_no: 'PCM-2025-EX', quantity: 50, expiry_date: addDays(-10), received_date: addDays(-365) }
    ]
  },
  {
    name: 'Amoxicillin 250mg',
    generic_name: 'Amoxicillin Trihydrate',
    unit: 'capsule',
    batches: [
      { batch_no: 'AMX-9901', quantity: 80, expiry_date: addDays(5), received_date: addDays(-40) },
      { batch_no: 'AMX-9902', quantity: 200, expiry_date: addDays(120), received_date: addDays(-10) }
    ]
  },
  {
    name: 'Ibuprofen 400mg',
    generic_name: 'Ibuprofen',
    unit: 'tablet',
    batches: [
      { batch_no: 'IBU-101', quantity: 500, expiry_date: addDays(180), received_date: addDays(-20) },
      { batch_no: 'IBU-OLD', quantity: 100, expiry_date: addDays(-45), received_date: addDays(-400) }
    ]
  },
  {
    name: 'Cetirizine 10mg',
    generic_name: 'Cetirizine Dihydrochloride',
    unit: 'tablet',
    batches: [
      { batch_no: 'CET-001', quantity: 120, expiry_date: addDays(25), received_date: addDays(-15) },
      { batch_no: 'CET-002', quantity: 250, expiry_date: addDays(200), received_date: addDays(-5) }
    ]
  },
  {
    name: 'Metformin 500mg',
    generic_name: 'Metformin Hydrochloride',
    unit: 'tablet',
    batches: [
      { batch_no: 'MET-801', quantity: 400, expiry_date: addDays(300), received_date: addDays(-50) }
    ]
  },
  {
    name: 'Omeprazole 20mg',
    generic_name: 'Omeprazole',
    unit: 'capsule',
    batches: [
      { batch_no: 'OMP-404', quantity: 60, expiry_date: addDays(10), received_date: addDays(-30) },
      { batch_no: 'OMP-405', quantity: 180, expiry_date: addDays(150), received_date: addDays(-10) }
    ]
  }
];

const insertMed = db.prepare('INSERT OR IGNORE INTO medicines (name, generic_name, unit) VALUES (?, ?, ?)');
const getMed = db.prepare('SELECT id FROM medicines WHERE lower(name) = lower(?)');
const insertBatch = db.prepare('INSERT OR IGNORE INTO batches (medicine_id, batch_no, quantity, expiry_date, received_date) VALUES (?, ?, ?, ?, ?)');

for (const m of medicines) {
  insertMed.run(m.name, m.generic_name, m.unit);
  const med = getMed.get(m.name);
  if (med) {
    for (const b of m.batches) {
      insertBatch.run(med.id, b.batch_no, b.quantity, b.expiry_date, b.received_date);
    }
  }
}

console.log('Sample pharmacy dataset seeded successfully!');
db.close();
