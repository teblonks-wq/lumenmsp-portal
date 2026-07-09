import 'dotenv/config';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

// Create or update a local admin account — the break-glass login for when
// Microsoft SSO is unavailable. Local login is handled by POST /login/local.
//
// Usage (after build):
//   node dist/scripts/create-admin.js <email> <password> "<display name>"

async function main(): Promise<void> {
  const [email, password, ...nameParts] = process.argv.slice(2);
  const displayName = nameParts.join(' ').trim() || email;

  if (!email || !password) {
    console.error('Usage: node dist/scripts/create-admin.js <email> <password> "<display name>"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (check .env).');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const passwordHash = await bcrypt.hash(password, 10);

  const result = await pool.query(
    `INSERT INTO users (email, display_name, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'admin', true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           display_name  = EXCLUDED.display_name,
           role          = 'admin',
           is_active     = true
     RETURNING id, email, role, is_active`,
    [email.toLowerCase().trim(), displayName, passwordHash]
  );

  console.log('✓ Admin account ready:', result.rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error('Failed to create admin:', err);
  process.exit(1);
});
