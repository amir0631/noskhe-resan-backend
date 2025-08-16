// index.js (نسخه نهایی با تمام قابلیت‌ها از جمله ثبت زمان)
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const port = 3000;
const JWT_SECRET = 'your_super_secret_key_that_should_be_in_env_file';

// --- Middlewares ---
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Received ${req.method} request for ${req.originalUrl}`);
  next();
});

// --- Database Pool ---
const pool = new Pool({
  user: 'myuser', host: '127.0.0.1', database: 'noskheresan_db', password: 'mypassword', port: 5432,
});

// --- Middleware برای احراز هویت ---
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

// --- API های کاربران و احراز هویت ---
app.post('/api/v1/users/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query(
            `SELECT u.username, u.password_hash, u.role, p.id as pharmacy_id, p.name as pharmacy_name 
             FROM users u LEFT JOIN pharmacies p ON u.pharmacy_id = p.id WHERE u.username = $1`, 
            [username]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'نام کاربری یافت نشد.' });
        const user = result.rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) return res.status(401).json({ message: 'رمز عبور اشتباه است.' });
        const payload = { username: user.username, role: user.role, pharmacyId: user.pharmacy_id };
        const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
        res.json({ accessToken, user: { username: user.username, role: user.role, pharmacyName: user.pharmacy_name }});
    } catch (error) { res.status(500).json({ message: 'خطای داخلی سرور' }); }
});

// --- API های پنل ادمین کل ---
app.get('/api/v1/pharmacies', async (req, res) => { /* ... کد قبلی ... */ });
app.post('/api/v1/pharmacies', async (req, res) => { /* ... کد قبلی ... */ });


// --- API های پنل داروخانه ---
app.get('/api/v1/pharmacy/prescriptions', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const userResult = await pool.query('SELECT pharmacy_id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0 || !userResult.rows[0].pharmacy_id) {
            return res.status(404).json({ message: 'داروخانه مربوط به این کاربر یافت نشد.' });
        }
        const pharmacyId = userResult.rows[0].pharmacy_id;
        const prescriptionsResult = await pool.query(
            "SELECT * FROM prescriptions WHERE pharmacy_id = $1 AND settled_at IS NULL ORDER BY created_at DESC",
            [pharmacyId]
        );
        res.json(prescriptionsResult.rows);
    } catch (error) { res.status(500).json({ message: 'خطای داخلی سرور' }); }
});

app.get('/api/v1/prescriptions/:id/status', async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        // با استفاده از JOIN، اطلاعات داروخانه را نیز از دیتابیس می‌خوانیم
        const result = await pool.query(
            `SELECT p.status, p.tracking_code, ph.name as pharmacy_name, ph.address as pharmacy_address, ph.latitude, ph.longitude
             FROM prescriptions p
             LEFT JOIN pharmacies ph ON p.pharmacy_id = ph.id
             WHERE p.id = $1`, 
            [prescriptionId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'سفارش یافت نشد.' });
        }
        res.status(200).json({ success: true, ...result.rows[0] });
    } catch (error) {
        console.error('Error in /status endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در دریافت وضعیت سفارش.' });
    }
});

app.post('/api/v1/prescriptions/:id/settle', authenticateToken, async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        // هم زمان و هم وضعیت را آپدیت می‌کنیم
        await pool.query("UPDATE prescriptions SET settled_at = NOW(), status = 'settled' WHERE id = $1", [prescriptionId]);
        res.status(200).json({ success: true, message: 'سفارش با موفقیت تسویه شد.' });
    } catch (error) {
        res.status(500).json({ message: 'خطا در تسویه حساب.' });
    }
});


// --- API های عمومی (PWA) ---
app.post('/api/v1/prescriptions/:id/select-pharmacy', async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        const { pharmacyId } = req.body;
        if (!pharmacyId) return res.status(400).json({ success: false, message: 'شناسه داروخانه الزامی است.' });
        await pool.query("UPDATE prescriptions SET pharmacy_id = $1, status = 'pharmacy_selected', pharmacy_assigned_at = NOW() WHERE id = $2", [pharmacyId, prescriptionId]);
        res.status(200).json({ success: true, message: 'داروخانه با موفقیت ثبت شد.' });
    } catch (error) { res.status(500).json({ success: false, message: 'خطا در ثبت داروخانه منتخب.' }); }
});


app.listen(port, () => console.log(`Server with full features listening on http://localhost:${port}`));