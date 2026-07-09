import 'dotenv/config';
import { backfillDwsCalls } from '../lib/dws-sftp';

// Pull the FULL call history: walks the entire DWS SFTP tree and ingests every itemized-calls
// CSV into call_records (idempotent). Usage: node dist/scripts/ingest-all-calls.js

backfillDwsCalls()
  .then((r) => {
    console.log(`✓ DWS call backfill: ${r.callFiles} call file(s) of ${r.files} total, ${r.inserted} calls (${r.matched} matched to a customer), ${r.errors} errors.`);
    process.exit(0);
  })
  .catch((e) => { console.error('Call backfill failed:', e); process.exit(1); });
