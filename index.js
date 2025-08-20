// index.js (نسخه کامل و نهایی با قابلیت ثبت مبلغ فاکتور)
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
            `SELECT * FROM prescriptions WHERE pharmacy_id = $1 AND status IN ('settled', 'rejected', 'cancelled_by_user') AND DATE(completed_at) BETWEEN $2 AND $3 ORDER BY completed_at DESC`,
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
        const existingPrescription = await pool.query('SELECT id, status FROM prescriptions WHERE tracking_code = $1', [trackingCode]);
        if (existingPrescription.rows.length > 0) {
            return res.status(409).json({ success: false, isDuplicate: true, message: 'این کد رهگیری قبلاً ثبت شده است.', prescription: existingPrescription.rows[0] });
        }
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
        const { newStatus, invoiceAmount } = req.body;
        
        const validTransitions = {
            pharmacy_selected: ['preparing', 'rejected'],
            preparing: ['ready']
        };

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const currentResult = await client.query('SELECT status FROM prescriptions WHERE id = $1 FOR UPDATE', [prescriptionId]);
            if (currentResult.rows.length === 0) return res.status(404).json({ message: 'سفارش یافت نشد.' });
            const currentStatus = currentResult.rows[0].status;

            if (!validTransitions[currentStatus] || !validTransitions[currentStatus].includes(newStatus)) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: `عملیات مجاز نیست. وضعیت فعلی سفارش "${translateStatus(currentStatus)}" است.` });
            }
            
            let queryText, queryParams;
            if (newStatus === 'preparing') {
                queryText = "UPDATE prescriptions SET status = $1, processing_started_at = NOW() WHERE id = $2";
                queryParams = [newStatus, prescriptionId];
            } else if (newStatus === 'ready') {
                queryText = "UPDATE prescriptions SET status = $1, completed_at = NOW(), invoice_amount = $2 WHERE id = $3";
                queryParams = [newStatus, invoiceAmount, prescriptionId];
            } else if (newStatus === 'rejected') {
                queryText = "UPDATE prescriptions SET status = $1, completed_at = NOW() WHERE id = $2";
                queryParams = [newStatus, prescriptionId];
            }
            
            if (queryText) await client.query(queryText, queryParams);
            await client.query('COMMIT');
            res.status(200).json({ success: true, message: 'وضعیت سفارش با موفقیت به‌روز شد.' });

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error in status update endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در به‌روزرسانی وضعیت سفارش.' });
    }
});

app.post('/api/v1/prescriptions/:id/settle', authenticateToken, async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        await pool.query("UPDATE prescriptions SET settled_at = NOW(), status = 'settled' WHERE id = $1", [prescriptionId]);
        res.status(200).json({ success: true, message: 'سفارش با موفقیت تسویه شد.' });
    } catch (error) { res.status(500).json({ message: 'خطا در تسویه حساب.' }); }
});

app.put('/api/v1/prescriptions/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        const current = await pool.query('SELECT status FROM prescriptions WHERE id = $1', [id]);
        if (current.rows.length === 0) return res.status(404).json({ message: 'سفارش یافت نشد.' });
        const currentStatus = current.rows[0].status;
        if (['pharmacy_selected'].includes(currentStatus)) {
            await pool.query("UPDATE prescriptions SET status = 'cancelled_by_user', completed_at = NOW() WHERE id = $1", [id]);
            res.status(200).json({ success: true, message: 'سفارش با موفقیت لغو شد.' });
        } else {
            res.status(403).json({ success: false, message: 'امکان لغو این سفارش وجود ندارد.' });
        }
    } catch (error) { res.status(500).json({ success: false, message: 'خطای داخلی سرور.' }); }
});

app.put('/api/v1/prescriptions/:id/resubmit', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(
            `UPDATE prescriptions SET status = 'pending', pharmacy_id = NULL, pharmacy_assigned_at = NULL, processing_started_at = NULL, completed_at = NULL, settled_at = NULL, invoice_amount = NULL WHERE id = $1 AND status IN ('rejected', 'cancelled_by_user')`,
            [id]
        );
        res.status(200).json({ success: true, message: 'نسخه برای ثبت مجدد آماده شد.' });
    } catch (error) { res.status(500).json({ success: false, message: 'خطای داخلی سرور.' }); }
});


app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
