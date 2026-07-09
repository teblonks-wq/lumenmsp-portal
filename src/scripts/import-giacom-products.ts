import 'dotenv/config';
import { Pool } from 'pg';

// Imports the Giacom broadband product-ID list into the portal catalogue so the
// products are quotable. The Giacom Product ID is stored in asset_products.code,
// the supplier in .supplier, speeds/term in .description, tagged source_tag='giacom'.
// Idempotent — re-running updates prices/names by code.
//
// Source: Giacom knowledgebase "Product ID codes for use with APIs" (reviewed 24/03/2026).
// Usage (after build):  node dist/scripts/import-giacom-products.js

// [name, productId, supplier, tech, downMbps, upMbps, monthlyRental, termMonths]
type BB = [string, string, string, string, number, number, number, number];
// [name, productId, supplier, tech, charge]
type SVR = [string, string, string, string, number];

const BROADBAND: BB[] = [
  // FTTP — CityFibre
  ['CF Business FTTP 1Gb Premium', 'DCF102-845-59065', 'CityFibre', 'FTTP', 1000, 1000, 37.00, 1],
  ['CF Business FTTP 1Gb', 'DCF102-845-59406', 'CityFibre', 'FTTP', 1000, 1000, 31.75, 1],
  ['CF Business FTTP 160Mb', 'DCF102-845-59408', 'CityFibre', 'FTTP', 160, 160, 25.50, 1],
  // FTTP — BT Wholesale
  ['BTW FTTP 0.5/0.5', 'BF-973-60953', 'BT Wholesale', 'FTTP', 0.5, 0.5, 16.00, 12],
  ['BTW FTTP 40/10', 'BF-973-60954', 'BT Wholesale', 'FTTP', 40, 10, 25.00, 12],
  ['BTW FTTP 40/10 ELEVATED', 'DFBSR262-851-59309', 'BT Wholesale', 'FTTP', 40, 10, 29.50, 12],
  ['BTW FTTP 80/20', 'BF-973-60955', 'BT Wholesale', 'FTTP', 80, 20, 25.00, 12],
  ['BTW FTTP 80/20', 'BF-973-60963', 'BT Wholesale', 'FTTP', 80, 20, 24.50, 24],
  ['BTW FTTP 80/20', 'BF-973-60975', 'BT Wholesale', 'FTTP', 80, 20, 24.00, 36],
  ['BTW FTTP 80/20 ELEVATED', 'DFBSR262-851-59310', 'BT Wholesale', 'FTTP', 80, 20, 29.50, 12],
  ['BTW FTTP 115/20', 'BF-973-60956', 'BT Wholesale', 'FTTP', 115, 20, 26.00, 12],
  ['BTW FTTP 115/20', 'BF-973-60964', 'BT Wholesale', 'FTTP', 115, 20, 25.50, 24],
  ['BTW FTTP 115/20', 'BF-973-60976', 'BT Wholesale', 'FTTP', 115, 20, 25.00, 36],
  ['BTW FTTP 115/20 ELEVATED', 'DFBSR262-851-59311', 'BT Wholesale', 'FTTP', 115, 20, 30.50, 12],
  ['BTW FTTP 160/30', 'BF-973-60958', 'BT Wholesale', 'FTTP', 160, 30, 28.50, 12],
  ['BTW FTTP 160/30', 'BF-973-60965', 'BT Wholesale', 'FTTP', 160, 30, 27.50, 24],
  ['BTW FTTP 160/30', 'BF-973-60977', 'BT Wholesale', 'FTTP', 160, 30, 27.25, 36],
  ['BTW FTTP 160/30 ELEVATED', 'DFBSR262-851-59312', 'BT Wholesale', 'FTTP', 160, 30, 33.00, 12],
  ['BTW FTTP 220/30', 'BF-973-60959', 'BT Wholesale', 'FTTP', 220, 30, 28.50, 12],
  ['BTW FTTP 220/30', 'BF-973-60966', 'BT Wholesale', 'FTTP', 220, 30, 27.50, 24],
  ['BTW FTTP 220/30', 'BF-973-60978', 'BT Wholesale', 'FTTP', 220, 30, 27.00, 36],
  ['BTW FTTP 220/30 ELEVATED', 'DFBSR262-851-59313', 'BT Wholesale', 'FTTP', 220, 30, 33.00, 12],
  ['BTW FTTP 330/50', 'BF-973-60960', 'BT Wholesale', 'FTTP', 330, 50, 30.50, 12],
  ['BTW FTTP 330/50', 'BF-973-60967', 'BT Wholesale', 'FTTP', 330, 50, 30.00, 24],
  ['BTW FTTP 330/50', 'BF-973-60980', 'BT Wholesale', 'FTTP', 330, 50, 29.50, 36],
  ['BTW FTTP 330/50 ELEVATED', 'DFBSR262-851-59314', 'BT Wholesale', 'FTTP', 330, 50, 35.00, 12],
  ['BTW FTTP 550/75', 'BF-973-60961', 'BT Wholesale', 'FTTP', 550, 75, 36.50, 12],
  ['BTW FTTP 550/75', 'BF-973-60968', 'BT Wholesale', 'FTTP', 550, 75, 36.00, 24],
  ['BTW FTTP 550/75', 'BF-973-60982', 'BT Wholesale', 'FTTP', 550, 75, 35.50, 36],
  ['BTW FTTP 1,000/115', 'BF-973-60962', 'BT Wholesale', 'FTTP', 1000, 115, 41.00, 12],
  ['BTW FTTP 1,000/115', 'BF-973-60969', 'BT Wholesale', 'FTTP', 1000, 115, 40.50, 24],
  ['BTW FTTP 1,000/115', 'BF-973-60983', 'BT Wholesale', 'FTTP', 1000, 115, 40.00, 36],
  // FTTP — Sky
  ['SKY FTTP 80/20', 'SFS-1642-72302', 'Sky', 'FTTP', 80, 20, 24.30, 1],
  ['SKY FTTP 80/20', 'SFS-1642-72307', 'Sky', 'FTTP', 80, 20, 23.40, 24],
  ['SKY FTTP 80/20', 'SFS-1642-72312', 'Sky', 'FTTP', 80, 20, 22.50, 36],
  ['SKY FTTP 160/30', 'SFS-1642-72303', 'Sky', 'FTTP', 160, 30, 27.00, 1],
  ['SKY FTTP 160/30', 'SFS-1642-72308', 'Sky', 'FTTP', 160, 30, 26.10, 24],
  ['SKY FTTP 160/30', 'SFS-1642-72313', 'Sky', 'FTTP', 160, 30, 25.20, 36],
  ['SKY FTTP 330/50', 'SFS-1642-72304', 'Sky', 'FTTP', 330, 50, 28.80, 1],
  ['SKY FTTP 330/50', 'SFS-1642-72309', 'Sky', 'FTTP', 330, 50, 27.90, 24],
  ['SKY FTTP 330/50', 'SFS-1642-72314', 'Sky', 'FTTP', 330, 50, 27.00, 36],
  ['SKY FTTP 550/75', 'SFS-1642-72305', 'Sky', 'FTTP', 550, 75, 34.65, 1],
  ['SKY FTTP 550/75', 'SFS-1642-72310', 'Sky', 'FTTP', 550, 75, 33.75, 24],
  ['SKY FTTP 550/75', 'SFS-1642-72315', 'Sky', 'FTTP', 550, 75, 32.85, 36],
  ['SKY FTTP 1,000/115', 'SFS-1642-72306', 'Sky', 'FTTP', 1000, 115, 38.25, 1],
  ['SKY FTTP 1,000/115', 'SFS-1642-72311', 'Sky', 'FTTP', 1000, 115, 37.35, 24],
  ['SKY FTTP 1,000/115', 'SFS-1642-72316', 'Sky', 'FTTP', 1000, 115, 36.45, 36],
  // FTTP — Vodafone
  ['VODA FTTP 0.5/0.5', 'DVBF-725-53998', 'Vodafone', 'FTTP', 0.5, 0.5, 15.00, 1],
  ['VODA FTTP 40/10', 'DVBF-725-53733', 'Vodafone', 'FTTP', 40, 10, 22.00, 1],
  ['VODA FTTP 80/20', 'DFVSR182-852-59294', 'Vodafone', 'FTTP', 80, 20, 23.50, 1],
  ['VODA FTTP 115/20', 'DFVSR182-852-59295', 'Vodafone', 'FTTP', 115, 20, 24.50, 1],
  ['VODA FTTP 220/30', 'DFVSR182-852-59296', 'Vodafone', 'FTTP', 220, 30, 27.50, 1],
  ['VODA FTTP 550/75', 'DFVSR182-852-59297', 'Vodafone', 'FTTP', 550, 75, 35.50, 1],
  ['VODA FTTP 1,000/115', 'DFVSR182-852-59298', 'Vodafone', 'FTTP', 1000, 115, 40.00, 1],
  // SOGEA — BT Wholesale
  ['BTW SOGEA 0.5/0.5', 'BS-974-60941', 'BT Wholesale', 'SOGEA', 0.5, 0.5, 15.00, 1],
  ['BTW SOGEA 40/10', 'BS-974-60942', 'BT Wholesale', 'SOGEA', 40, 10, 23.75, 1],
  ['BTW SOGEA 40/10 ELEVATED', 'DFSSR002-808-59489', 'BT Wholesale', 'SOGEA', 40, 10, 28.25, 1],
  ['BTW SOGEA 80/20', 'BS-974-60947', 'BT Wholesale', 'SOGEA', 80, 20, 23.75, 1],
  ['BTW SOGEA 80/20', 'BS-974-60948', 'BT Wholesale', 'SOGEA', 80, 20, 23.25, 24],
  ['BTW SOGEA 80/20', 'BS-974-60949', 'BT Wholesale', 'SOGEA', 80, 20, 22.75, 36],
  ['BTW SOGEA 80/20 ELEVATED', 'BSR-974-72530', 'BT Wholesale', 'SOGEA', 80, 20, 28.25, 1],
  // SOGEA — Sky
  ['SKY SOGEA 80/20', 'SSS-1637-72301', 'Sky', 'SOGEA', 80, 20, 23.40, 1],
  ['SKY SOGEA 80/20', 'SSS-1637-72300', 'Sky', 'SOGEA', 80, 20, 22.50, 24],
  ['SKY SOGEA 80/20', 'SSS-1637-72299', 'Sky', 'SOGEA', 80, 20, 21.60, 36],
  // SOGEA — Vodafone
  ['VODA SOGEA 0.5/0.5', 'DVBS-721-55387', 'Vodafone', 'SOGEA', 0.5, 0.5, 15.50, 1],
  ['VODA SOGEA 40/10', 'VBT-721-53555', 'Vodafone', 'SOGEA', 40, 10, 23.00, 1],
  ['VODA SOGEA 80/20', 'DFVSR182-852-59299', 'Vodafone', 'SOGEA', 80, 20, 23.50, 1],
  // SOADSL & MPF
  ['BTW SOADSL', 'BS-975-60790', 'BT Wholesale', 'SOADSL', 24, 1.3, 22.75, 1],
  ['TTB MPF ADSL2+', 'DFA-622-55453', 'PXC', 'MPF', 24, 1.3, 26.50, 1],
];

const SVRS: SVR[] = [
  // CityFibre
  ['Standard', 'CFBCF-989-73900', 'CityFibre', 'FTTP', 57.50],
  ['Extended Standard (subject to survey)', 'DCF102-845-59242', 'CityFibre', 'FTTP', 0],
  ['Non-Standard', 'DCF102-845-59243', 'CityFibre', 'FTTP', 119.25],
  // BT Wholesale
  ['FTTP - No Site Visit', 'DFF-617-56361', 'BT Wholesale', 'FTTP', 67.00],
  ['FTTP - Standard', 'DFF-617-56428', 'BT Wholesale', 'FTTP', 67.50],
  ['FTTP - Premium', 'DFF-617-56438', 'BT Wholesale', 'FTTP', 93.00],
  ['FTTP - Advanced', 'DFF-617-59089', 'BT Wholesale', 'FTTP', 305.75],
  ['SOGEA - No Site Visit', 'DFS-620-51886', 'BT Wholesale', 'SOGEA', 16.75],
  ['SOGEA - Standard', 'DFS-620-57070', 'BT Wholesale', 'SOGEA', 67.50],
  ['SOGEA - Premium', 'DFS-620-57071', 'BT Wholesale', 'SOGEA', 103.00],
  ['SOGEA - Advanced', 'DFS-620-58760', 'BT Wholesale', 'SOGEA', 305.75],
  ['SOADSL - No Site Visit', 'BS-986-62554', 'BT Wholesale', 'SOADSL', 16.75],
  ['SOADSL - Standard', 'BS-986-62555', 'BT Wholesale', 'SOADSL', 67.50],
  ['SOADSL - Premium', 'BS-986-62556', 'BT Wholesale', 'SOADSL', 93.00],
  // Sky
  ['FTTP - No Site Visit (Restart of stopped line)', 'BF-984-62685', 'Sky', 'FTTP', 67.00],
  ['FTTP - No Site Visit (Migration)', 'BF-984-62689', 'Sky', 'FTTP', 16.00],
  ['FTTP - Standard', 'BF-984-62686', 'Sky', 'FTTP', 69.00],
  ['FTTP - Premium', 'BF-984-62687', 'Sky', 'FTTP', 95.50],
  ['FTTP - Advanced', 'SF-991-72062', 'Sky', 'FTTP', 275.00],
  ['SOGEA - No Site Visit', 'BS-985-62694', 'Sky', 'SOGEA', 0.00],
  ['SOGEA - Standard', 'BS-985-62700', 'Sky', 'SOGEA', 67.50],
  ['SOGEA - Premium', 'SS-992-62701', 'Sky', 'SOGEA', 93.00],
  ['SOGEA - Advanced', 'SS-992-72060', 'Sky', 'SOGEA', 275.00],
  // Vodafone
  ['FTTP - No Site Visit', 'DVBF-725-53767', 'Vodafone', 'FTTP', 0.00],
  ['FTTP - Standard', 'DVBF-725-53765', 'Vodafone', 'FTTP', 67.50],
  ['FTTP - Premium', 'DVBF-725-53760', 'Vodafone', 'FTTP', 108.00],
  ['SOGEA - No Site Visit', 'DVBS-721-53759', 'Vodafone', 'SOGEA', 0.00],
  ['SOGEA - Standard', 'DVBS-721-55712', 'Vodafone', 'SOGEA', 67.50],
  ['SOGEA - Premium', 'DVBS-721-53751', 'Vodafone', 'SOGEA', 108.00],
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set (check .env).'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Category
  const cat = await pool.query(
    `INSERT INTO asset_categories (code, name) VALUES ('GIACOM-BB','Connectivity — Broadband')
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`
  );
  const categoryId = cat.rows[0].id;

  let created = 0, updated = 0;
  // `cost` = the Giacom wholesale rental (our cost). Sell price is set separately
  // (custom / standard costs + markup), so we never overwrite an existing sell price here.
  async function upsert(code: string, name: string, supplier: string, description: string, freq: string, cost: number): Promise<void> {
    const ex = await pool.query("SELECT id FROM asset_products WHERE code=$1 AND source_tag='giacom' LIMIT 1", [code]);
    if (ex.rows.length) {
      await pool.query(
        `UPDATE asset_products SET category_id=$1, name=$2, supplier=$3, description=$4, item_type='service',
           billing_frequency=$5, cost_price=$6, vat_rate=20, is_active=true, updated_at=NOW() WHERE id=$7`,
        [categoryId, name, supplier, description, freq, cost, ex.rows[0].id]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO asset_products (category_id, code, name, supplier, description, item_type, billing_frequency, cost_price, unit_price, vat_rate, source_tag, is_active)
         VALUES ($1,$2,$3,$4,$5,'service',$6,$7,0,20,'giacom',true)`,
        [categoryId, code, name, supplier, description, freq, cost]
      );
      created++;
    }
  }

  // Descriptions are customer-facing — never name the wholesaler (Giacom). Keep the useful
  // detail only; the supplier is recorded in the dedicated supplier field.
  for (const [name, code, supplier, tech, down, up, price, term] of BROADBAND) {
    await upsert(code, `${name} (${term}m)`, supplier, `${tech} · ${down}/${up} Mbps · ${term}-month term`, 'monthly', price);
  }
  for (const [name, code, supplier, tech, charge] of SVRS) {
    await upsert(code, `${supplier} ${tech} site visit — ${name}`, supplier, `Site Visit Reason (${tech})`, 'one_off', charge);
  }

  console.log(`✓ Giacom catalogue import: ${created} created, ${updated} updated (${BROADBAND.length} broadband + ${SVRS.length} SVRs).`);
  await pool.end();
}

main().catch((err) => { console.error('Giacom import failed:', err); process.exit(1); });
