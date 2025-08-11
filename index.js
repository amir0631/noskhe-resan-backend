// index.js (کامل با API های ادمین)
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const port = 3000;
const JWT_SECRET = 'your_super_secret_key_that_should_be_in_env_file'; // کلید امنیتی

app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: 'myuser',
  host: '127.0.0.1',
  database: 'noskheresan_db',
  password: 'mypassword',
  port: 5432,
});

// Middleware برای احراز هویت
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- API جدید و امن برای پنل داروخانه ---
// این Endpoint فقط سفارش‌های داروخانه‌ای که لاگین کرده را برمی‌گرداند
app.get('/api/v1/pharmacy/prescriptions', authenticateToken, async (req, res) => {
    try {
        // اطلاعات کاربر از توکن استخراج می‌شود
        const username = req.user.username;
        
        // ابتدا شناسه داروخانه را از روی نام کاربری پیدا می‌کنیم
        const userResult = await pool.query('SELECT pharmacy_id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0 || !userResult.rows[0].pharmacy_id) {
            return res.status(404).json({ message: 'داروخانه مربوط به این کاربر یافت نشد.' });
        }
        const pharmacyId = userResult.rows[0].pharmacy_id;

        // سپس تمام سفارش‌های مربوط به آن شناسه داروخانه را می‌گیریم
        const prescriptionsResult = await pool.query(
            "SELECT * FROM prescriptions WHERE pharmacy_id = $1 AND status IN ('pharmacy_selected', 'preparing')",
            [pharmacyId]
        );
        
        res.json(prescriptionsResult.rows);

    } catch (error) {
        console.error('Error fetching pharmacy prescriptions:', error);
        res.status(500).json({ message: 'خطای داخلی سرور' });
    }
});

// --- API های کاربران و احراز هویت ---
app.post('/api/v1/users/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'نام کاربری یافت نشد.' });
        
        const user = result.rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) return res.status(401).json({ message: 'رمز عبور اشتباه است.' });

        const accessToken = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ accessToken });
    } catch (error) { res.status(500).json({ message: 'خطای داخلی سرور' }); }
});


// --- API های مدیریت داروخانه (CRUD) ---
// (این بخش‌ها نیازمند authenticateToken با role ادمین هستند که در فاز بعد اضافه می‌شود)

// دریافت لیست تمام داروخانه‌ها
app.get('/api/v1/pharmacies', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM pharmacies ORDER BY id DESC');
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'خطا در دریافت لیست داروخانه‌ها' }); }
});

// افزودن داروخانه جدید
app.post('/api/v1/pharmacies', async (req, res) => {
    const { name, address, latitude, longitude, username, password } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const hashedPassword = await bcrypt.hash(password, 10);
        const pharmacyResult = await client.query(
            'INSERT INTO pharmacies (name, address, latitude, longitude) VALUES ($1, $2, $3, $4) RETURNING id',
            [name, address, latitude, longitude]
        );
        const newPharmacyId = pharmacyResult.rows[0].id;
        await client.query(
            'INSERT INTO users (username, password_hash, pharmacy_id, role) VALUES ($1, $2, $3, $4)',
            [username, hashedPassword, newPharmacyId, 'pharmacy_admin']
        );
        await client.query('COMMIT');
        res.status(201).json({ message: 'داروخانه با موفقیت ایجاد شد.' });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') res.status(409).json({ message: 'نام کاربری یا نام داروخانه تکراری است.' });
        else res.status(500).json({ message: 'خطای داخلی سرور' });
    } finally {
        client.release();
    }
});


// ... سایر API های عمومی و کاربر ...
// (برای اختصار، کدهای بدون تغییر از اینجا حذف شده‌اند)


app.listen(port, () => console.log(`Server with admin features listening on http://localhost:${port}`));