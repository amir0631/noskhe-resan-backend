const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// --- تنظیمات ---
const ADMIN_USERNAME = 'superadmin';
const ADMIN_PASSWORD = 'admin123';
// --- پایان تنظیمات ---

const pool = new Pool({
  user: 'myuser',
  host: '127.0.0.1',
  database: 'noskheresan_db',
  password: 'mypassword',
  port: 5432,
});

async function seedAdmin() {
  const client = await pool.connect();
  try {
    console.log('در حال بررسی وجود کاربر ادمین...');
    const existingUser = await client.query('SELECT * FROM users WHERE username = $1', [ADMIN_USERNAME]);

    const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);

    if (existingUser.rows.length > 0) {
      console.log('کاربر ادمین از قبل وجود دارد. رمز عبور به‌روزرسانی می‌شود...');
      await client.query('UPDATE users SET password_hash = $1 WHERE username = $2', [hashedPassword, ADMIN_USERNAME]);
      console.log('✅ رمز عبور کاربر ادمین با موفقیت به‌روز شد.');
    } else {
      console.log('کاربر ادمین وجود ندارد. در حال ساخت کاربر جدید...');
      await client.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'super_admin')",
        [ADMIN_USERNAME, hashedPassword]
      );
      console.log('✅ کاربر ادمین با موفقیت ساخته شد.');
    }
  } catch (error) {
    console.error('❌ خطا در هنگام ساخت یا به‌روزرسانی کاربر ادمین:', error);
  } finally {
    await client.release();
    await pool.end();
    console.log('اتصال به دیتابیس بسته شد.');
  }
}

seedAdmin();