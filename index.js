// index.js (نسخه کامل، نهایی و یکپارچه)
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
app.get('/api/v1/pharmacies', async (req, res) => {
    try {
        const result = await pool.query('SELECT p.id, p.name, p.address, p.is_active, p.is_24_hours, u.username FROM pharmacies p LEFT JOIN users u ON p.id = u.pharmacy_id ORDER BY p.id DESC');
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'خطا در دریافت لیست داروخانه‌ها' }); }
});

app.post('/api/v1/pharmacies', async (req, res) => {
    const { name, address, latitude, longitude, username, password, is_active, is_24_hours } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const hashedPassword = await bcrypt.hash(password, 10);
        const pharmacyResult = await client.query(
            'INSERT INTO pharmacies (name, address, latitude, longitude, is_active, is_24_hours) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [name, address, latitude || 0, longitude || 0, is_active, is_24_hours]
        );
        const newPharmacyId = pharmacyResult.rows[0].id;
        await client.query("INSERT INTO users (username, password_hash, pharmacy_id, role) VALUES ($1, $2, $3, 'pharmacy_admin')", [username, hashedPassword, newPharmacyId]);
        await client.query('COMMIT');
        res.status(201).json({ message: 'داروخانه با موفقیت ایجاد شد.' });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') res.status(409).json({ message: 'نام کاربری یا نام داروخانه تکراری است.' });
        else res.status(500).json({ message: 'خطای داخلی سرور.' });
    } finally { client.release(); }
});

app.get('/api/v1/pharmacies/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT p.id, p.name, p.address, p.latitude, p.longitude, p.is_active, p.is_24_hours, u.username FROM pharmacies p LEFT JOIN users u ON p.id = u.pharmacy_id WHERE p.id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'داروخانه یافت نشد.' });
        res.json(result.rows[0]);
    } catch (error) { res.status(500).json({ message: 'خطای داخلی سرور' }); }
});

app.put('/api/v1/pharmacies/:id', async (req, res) => {
    const { id } = req.params;
    const { name, address, latitude, longitude, username, password, is_active, is_24_hours } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE pharmacies SET name = $1, address = $2, latitude = $3, longitude = $4, is_active = $5, is_24_hours = $6 WHERE id = $7', [name, address, latitude || 0, longitude || 0, is_active, is_24_hours, id]);
        await client.query('UPDATE users SET username = $1 WHERE pharmacy_id = $2', [username, id]);
        if (password && password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(password, 10);
            await client.query('UPDATE users SET password_hash = $1 WHERE pharmacy_id = $2', [hashedPassword, id]);
        }
        await client.query('COMMIT');
        res.status(200).json({ message: 'داروخانه با موفقیت به‌روز شد.' });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') res.status(409).json({ message: 'این نام کاربری قبلاً استفاده شده است.' });
        else res.status(500).json({ message: 'خطای داخلی سرور.' });
    } finally { client.release(); }
});

// --- API های پنل داروخانه ---
app.get('/api/v1/pharmacy/prescriptions', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const userResult = await pool.query('SELECT pharmacy_id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0 || !userResult.rows[0].pharmacy_id) return res.status(404).json({ message: 'داروخانه مربوط به این کاربر یافت نشد.' });
        const pharmacyId = userResult.rows[0].pharmacy_id;
        const prescriptionsResult = await pool.query(
            `SELECT * FROM prescriptions WHERE pharmacy_id = $1 AND (settled_at IS NULL OR settled_at > NOW() - INTERVAL '24 hours') ORDER BY created_at DESC`,
            [pharmacyId]
        );
        res.json(prescriptionsResult.rows);
    } catch (error) { res.status(500).json({ message: 'خطای داخلی سرور' }); }
});

app.get('/api/v1/pharmacy/reports/full', authenticateToken, async (req, res) => {
    try {
        const { username } = req.user;
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) return res.status(400).json({ message: 'بازه زمانی (startDate, endDate) الزامی است.' });
        const userResult = await pool.query('SELECT pharmacy_id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0 || !userResult.rows[0].pharmacy_id) return res.status(404).json({ message: 'داروخانه یافت نشد.' });
        const pharmacyId = userResult.rows[0].pharmacy_id;
        const reportResult = await pool.query(
            `SELECT * FROM prescriptions WHERE pharmacy_id = $1 AND settled_at IS NOT NULL AND DATE(settled_at) BETWEEN $2 AND $3 ORDER BY settled_at DESC`,
            [pharmacyId, startDate, endDate]
        );
        res.json(reportResult.rows);
    } catch (error) { res.status(500).json({ message: 'خطای داخلی سرور' }); }
});

// --- API های عمومی (PWA کاربر) ---
app.post('/api/v1/prescriptions/submit', async (req, res) => {
    try {
        const { nationalId, trackingCode, insuranceType } = req.body;
        if (!nationalId || !trackingCode || !insuranceType) return res.status(400).json({ success: false, message: 'تمام اطلاعات الزامی است.' });
        const existingPrescription = await pool.query('SELECT id FROM prescriptions WHERE tracking_code = $1', [trackingCode]);
        if (existingPrescription.rows.length > 0) return res.status(409).json({ success: false, message: 'این کد رهگیری قبلاً ثبت شده است.' });
        const result = await pool.query('INSERT INTO prescriptions (national_id, tracking_code, insurance_type) VALUES ($1, $2, $3) RETURNING id', [nationalId, trackingCode, insuranceType]);
        res.status(201).json({ success: true, message: 'نسخه شما با موفقیت ثبت شد.', prescriptionId: result.rows[0].id });
    } catch (error) { res.status(500).json({ success: false, message: 'خطای داخلی سرور هنگام ثبت نسخه.' }); }
});

app.post('/api/v1/prescriptions/:id/select-pharmacy', async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        const { pharmacyId } = req.body;
        if (!pharmacyId) return res.status(400).json({ success: false, message: 'شناسه داروخانه الزامی است.' });
        await pool.query("UPDATE prescriptions SET pharmacy_id = $1, status = 'pharmacy_selected', pharmacy_assigned_at = NOW() WHERE id = $2", [pharmacyId, prescriptionId]);
        res.status(200).json({ success: true, message: 'داروخانه با موفقیت ثبت شد.' });
    } catch (error) { res.status(500).json({ success: false, message: 'خطا در ثبت داروخانه منتخب.' }); }
});

app.get('/api/v1/prescriptions/:id/status', async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        const result = await pool.query(
            `SELECT p.status, p.tracking_code, ph.name as pharmacy_name, ph.address as pharmacy_address, ph.latitude, ph.longitude
             FROM prescriptions p LEFT JOIN pharmacies ph ON p.pharmacy_id = ph.id WHERE p.id = $1`, 
            [prescriptionId]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'سفارش یافت نشد.' });
        res.status(200).json({ success: true, ...result.rows[0] });
    } catch (error) { res.status(500).json({ success: false, message: 'خطا در دریافت وضعیت سفارش.' }); }
});

app.get('/api/v1/prescriptions/history/:nationalId', async (req, res) => {
    try {
        const { nationalId } = req.params;
        const result = await pool.query('SELECT id, tracking_code, status, insurance_type, created_at FROM prescriptions WHERE national_id = $1 ORDER BY created_at DESC', [nationalId]);
        res.status(200).json(result.rows);
    } catch (error) { res.status(500).json({ success: false, message: 'خطا در دریافت تاریخچه سفارشات.' }); }
});

app.put('/api/v1/prescriptions/:id/status', authenticateToken, async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        const { newStatus } = req.body;
        const allowedStatuses = ['preparing', 'ready', 'rejected'];
        if (!newStatus || !allowedStatuses.includes(newStatus)) return res.status(400).json({ success: false, message: 'وضعیت جدید نامعتبر است.' });
        let queryText;
        if (newStatus === 'preparing') {
            queryText = "UPDATE prescriptions SET status = $1, processing_started_at = NOW() WHERE id = $2";
        } else if (newStatus === 'ready' || newStatus === 'rejected') {
            queryText = "UPDATE prescriptions SET status = $1, completed_at = NOW() WHERE id = $2";
        } else {
            queryText = "UPDATE prescriptions SET status = $1 WHERE id = $2";
        }
        await pool.query(queryText, [newStatus, prescriptionId]);
        res.status(200).json({ success: true, message: 'وضعیت سفارش با موفقیت به‌روز شد.' });
    } catch (error) { res.status(500).json({ success: false, message: 'خطا در به‌روزرسانی وضعیت سفارش.' }); }
});

app.post('/api/v1/prescriptions/:id/settle', authenticateToken, async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        await pool.query("UPDATE prescriptions SET settled_at = NOW(), status = 'settled' WHERE id = $1", [prescriptionId]);
        res.status(200).json({ success: true, message: 'سفارش با موفقیت تسویه شد.' });
    } catch (error) { res.status(500).json({ message: 'خطا در تسویه حساب.' }); }
});

// --- API جدید برای لغو سفارش توسط کاربر ---
app.put('/api/v1/prescriptions/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        
        // ابتدا وضعیت فعلی را چک می‌کنیم
        const current = await pool.query('SELECT status FROM prescriptions WHERE id = $1', [id]);
        if (current.rows.length === 0) {
            return res.status(404).json({ message: 'سفارش یافت نشد.' });
        }
        
        const currentStatus = current.rows[0].status;
        // فقط در این وضعیت‌ها امکان لغو وجود دارد
        if (['pending', 'pharmacy_selected', 'preparing'].includes(currentStatus)) {
            await pool.query("UPDATE prescriptions SET status = 'cancelled_by_user' WHERE id = $1", [id]);
            res.status(200).json({ success: true, message: 'سفارش با موفقیت لغو شد.' });
        } else {
            // اگر وضعیت 'ready' یا بالاتر بود، دیگر امکان لغو نیست
            res.status(403).json({ success: false, message: 'امکان لغو این سفارش وجود ندارد.' });
        }
    } catch (error) {
        console.error('Error in /cancel endpoint:', error);
        res.status(500).json({ success: false, message: 'خطای داخلی سرور.' });
    }
});

// --- API جدید: دریافت آمار کلی برای داشبورد ادمین ---
app.get('/api/v1/admin/dashboard-stats', async (req, res) => {
    try {
        // شمارش کل سفارش‌ها
        const totalPrescriptionsQuery = await pool.query('SELECT COUNT(*) FROM prescriptions;');
        const totalPrescriptions = parseInt(totalPrescriptionsQuery.rows[0].count, 10);

        // شمارش داروخانه‌های ثبت شده
        const totalPharmaciesQuery = await pool.query('SELECT COUNT(*) FROM pharmacies;');
        const totalPharmacies = parseInt(totalPharmaciesQuery.rows[0].count, 10);

        // شمارش سفارش‌های در انتظار تایید
        const pendingPrescriptionsQuery = await pool.query("SELECT COUNT(*) FROM prescriptions WHERE status = 'pharmacy_selected';");
        const pendingPrescriptions = parseInt(pendingPrescriptionsQuery.rows[0].count, 10);

        // دریافت ۵ سفارش آخر برای نمایش در جدول
        const recentPrescriptionsQuery = await pool.query(
            `SELECT p.id, p.status, p.created_at, ph.name as pharmacy_name 
             FROM prescriptions p
             LEFT JOIN pharmacies ph ON p.pharmacy_id = ph.id
             ORDER BY p.created_at DESC 
             LIMIT 5;`
        );
        const recentPrescriptions = recentPrescriptionsQuery.rows;

        // ارسال تمام آمار در یک پکیج JSON
        res.status(200).json({
            success: true,
            stats: {
                totalOrders: totalPrescriptions,
                totalPharmacies: totalPharmacies,
                pendingOrders: pendingPrescriptions,
            },
            recentOrders: recentPrescriptions,
        });

    } catch (error) {
        console.error('Error fetching admin dashboard stats:', error);
        res.status(500).json({ success: false, message: 'خطا در دریافت اطلاعات داشبورد.' });
    }
});


app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
