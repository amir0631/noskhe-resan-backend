// index.js (نسخه نهایی و اصلاح شده)
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
  user: 'myuser',
  host: '127.0.0.1',
  database: 'noskheresan_db',
  password: 'mypassword',
  port: 5432,
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
// در فایل index.js
app.post('/api/v1/users/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        // حالا اطلاعات داروخانه را نیز با JOIN دریافت می‌کنیم
        const result = await pool.query(
            `SELECT u.username, u.password_hash, u.role, p.id as pharmacy_id, p.name as pharmacy_name 
             FROM users u 
             LEFT JOIN pharmacies p ON u.pharmacy_id = p.id 
             WHERE u.username = $1`, 
            [username]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'نام کاربری یافت نشد.' });
        }
        
        const user = result.rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
            return res.status(401).json({ message: 'رمز عبور اشتباه است.' });
        }

        const payload = { 
            username: user.username, 
            role: user.role, 
            pharmacyId: user.pharmacy_id 
        };
        const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

        // اطلاعات کاربر و داروخانه را در پاسخ برمی‌گردانیم
        res.json({ 
            accessToken, 
            user: {
                username: user.username,
                role: user.role,
                pharmacyName: user.pharmacy_name
            }
        });
    } catch (error) {
        console.error('Error in /login endpoint:', error);
        res.status(500).json({ message: 'خطای داخلی سرور' });
    }
});

// --- API های مدیریت داروخانه (برای پنل ادمین کل) ---
app.get('/api/v1/pharmacies', async (req, res) => {
    try {
        const result = await pool.query('SELECT p.id, p.name, p.address, u.username FROM pharmacies p LEFT JOIN users u ON p.id = u.pharmacy_id ORDER BY p.id DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error in GET /pharmacies:', error);
        res.status(500).json({ message: 'خطا در دریافت لیست داروخانه‌ها' });
    }
});

aapp.post('/api/v1/pharmacies', async (req, res) => {
     const { name, address, latitude, longitude, username, password } = req.body;
     const client = await pool.connect();
     try {
         await client.query('BEGIN');
         const hashedPassword = await bcrypt.hash(password, 10);
         const pharmacyResult = await client.query(
             'INSERT INTO pharmacies (name, address, latitude, longitude) VALUES ($1, $2, $3, $4) RETURNING id',
             [name, address, latitude || 0, longitude || 0]
         );
         const newPharmacyId = pharmacyResult.rows[0].id;
         
         // --- تغییر اصلی اینجاست: پارامتر چهارم ('pharmacy_admin') به لیست مقادیر اضافه شد ---
         await client.query(
             "INSERT INTO users (username, password_hash, pharmacy_id, role) VALUES ($1, $2, $3, $4)",
             [username, hashedPassword, newPharmacyId, 'pharmacy_admin']
         );

         await client.query('COMMIT');
         res.status(201).json({ message: 'داروخانه با موفقیت ایجاد شد.' });
     } catch (error) {
         await client.query('ROLLBACK');
         console.error('Error in POST /pharmacies:', error);
         if (error.code === '23505') {
             res.status(409).json({ message: 'نام کاربری یا نام داروخانه تکراری است.' });
         } else {
             res.status(500).json({ message: 'خطای داخلی سرور.' });
         }
     } finally {
         client.release();
     }
 });

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
            "SELECT * FROM prescriptions WHERE pharmacy_id = $1 AND status IN ('pharmacy_selected', 'preparing') ORDER BY created_at DESC",
            [pharmacyId]
        );
        res.json(prescriptionsResult.rows);
    } catch (error) {
        console.error('Error fetching pharmacy prescriptions:', error);
        res.status(500).json({ message: 'خطای داخلی سرور' });
    }
});

// --- API های عمومی (PWA کاربر) ---
app.post('/api/v1/prescriptions/submit', async (req, res) => {
    try {
        const { nationalId, trackingCode, insuranceType } = req.body;
        if (!nationalId || !trackingCode || !insuranceType) {
            return res.status(400).json({ success: false, message: 'تمام اطلاعات الزامی است.' });
        }
        const existingPrescription = await pool.query('SELECT id FROM prescriptions WHERE tracking_code = $1', [trackingCode]);
        if (existingPrescription.rows.length > 0) {
            // این خط اصلاح شده است
            return res.status(409).json({ success: false, message: 'این کد رهگیری قبلاً ثبت شده است.' });
        }
        const result = await pool.query(
            'INSERT INTO prescriptions (national_id, tracking_code, insurance_type) VALUES ($1, $2, $3) RETURNING id',
            [nationalId, trackingCode, insuranceType]
        );
        res.status(201).json({ success: true, message: 'نسخه شما با موفقیت ثبت شد.', prescriptionId: result.rows[0].id });
    } catch (error) {
        console.error('Error in /submit endpoint:', error);
        res.status(500).json({ success: false, message: 'خطای داخلی سرور هنگام ثبت نسخه.' });
    }
});

app.post('/api/v1/prescriptions/:id/select-pharmacy', async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        const { pharmacyId } = req.body;
        if (!pharmacyId) return res.status(400).json({ success: false, message: 'شناسه داروخانه الزامی است.' });
        await pool.query("UPDATE prescriptions SET pharmacy_id = $1, status = 'pharmacy_selected' WHERE id = $2", [pharmacyId, prescriptionId]);
        res.status(200).json({ success: true, message: 'داروخانه با موفقیت ثبت شد.' });
    } catch (error) {
        console.error('Error in /select-pharmacy endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در ثبت داروخانه منتخب.' });
    }
});

app.get('/api/v1/prescriptions/:id/status', async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        const result = await pool.query('SELECT status, tracking_code FROM prescriptions WHERE id = $1', [prescriptionId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'سفارش یافت نشد.' });
        res.status(200).json({ success: true, status: result.rows[0].status, trackingCode: result.rows[0].tracking_code });
    } catch (error) {
        console.error('Error in /status endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در دریافت وضعیت سفارش.' });
    }
});

app.get('/api/v1/prescriptions/history/:nationalId', async (req, res) => {
    try {
        const { nationalId } = req.params;
        const result = await pool.query(
            'SELECT id, tracking_code, status, insurance_type, created_at FROM prescriptions WHERE national_id = $1 ORDER BY created_at DESC',
            [nationalId]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error in /history endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در دریافت تاریخچه سفارشات.' });
    }
});

app.put('/api/v1/prescriptions/:id/status', async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        const { newStatus } = req.body;
        const allowedStatuses = ['preparing', 'ready', 'rejected'];
        if (!newStatus || !allowedStatuses.includes(newStatus)) {
            return res.status(400).json({ success: false, message: 'وضعیت جدید نامعتبر است.' });
        }
        await pool.query("UPDATE prescriptions SET status = $1 WHERE id = $2", [newStatus, prescriptionId]);
        res.status(200).json({ success: true, message: 'وضعیت سفارش با موفقیت به‌روز شد.' });
    } catch (error) {
        console.error('Error in status update endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در به‌روزرسانی وضعیت سفارش.' });
    }
});

app.listen(port, () => console.log(`Server with all features listening on http://localhost:${port}`));