// index.js (نهایی با ثبت زمان و تسویه)
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ... (بخش‌های اولیه بدون تغییر) ...
const app = express();
const port = 3000;
const JWT_SECRET = 'your_super_secret_key_that_should_be_in_env_file';
app.use(cors());
app.use(express.json());
const pool = new Pool({ /* ... */ });
const authenticateToken = (req, res, next) => { /* ... */ };

// --- API های کاربران و احراز هویت (بدون تغییر) ---
app.post('/api/v1/users/login', async (req, res) => { /* ... */ });

// --- API های مدیریت داروخانه (بدون تغییر) ---
app.get('/api/v1/pharmacies', async (req, res) => { /* ... */ });
app.post('/api/v1/pharmacies', async (req, res) => { /* ... */ });

// --- API های پنل داروخانه (به‌روز شده) ---
app.get('/api/v1/pharmacy/prescriptions', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const userResult = await pool.query('SELECT pharmacy_id FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0 || !userResult.rows[0].pharmacy_id) {
            return res.status(404).json({ message: 'داروخانه مربوط به این کاربر یافت نشد.' });
        }
        const pharmacyId = userResult.rows[0].pharmacy_id;
        
        // حالا سفارش‌های تکمیل شده را نیز برمی‌گردانیم تا دکمه تسویه نمایش داده شود
        const prescriptionsResult = await pool.query(
            "SELECT * FROM prescriptions WHERE pharmacy_id = $1 AND settled_at IS NULL ORDER BY created_at DESC",
            [pharmacyId]
        );
        res.json(prescriptionsResult.rows);
    } catch (error) {
        console.error('Error fetching pharmacy prescriptions:', error);
        res.status(500).json({ message: 'خطای داخلی سرور' });
    }
});

// به‌روزرسانی وضعیت توسط داروخانه (به‌روز شده)
app.put('/api/v1/prescriptions/:id/status', async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        const { newStatus } = req.body;
        const allowedStatuses = ['preparing', 'ready', 'rejected'];
        if (!newStatus || !allowedStatuses.includes(newStatus)) {
            return res.status(400).json({ success: false, message: 'وضعیت جدید نامعتبر است.' });
        }
        
        // اگر وضعیت نهایی است، زمان تکمیل را ثبت کن
        if (newStatus === 'ready' || newStatus === 'rejected') {
            await pool.query("UPDATE prescriptions SET status = $1, completed_at = NOW() WHERE id = $2", [newStatus, prescriptionId]);
        } else {
            await pool.query("UPDATE prescriptions SET status = $1 WHERE id = $2", [newStatus, prescriptionId]);
        }

        res.status(200).json({ success: true, message: 'وضعیت سفارش با موفقیت به‌روز شد.' });
    } catch (error) {
        console.error('Error in status update endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در به‌روزرسانی وضعیت سفارش.' });
    }
});

// --- API جدید برای تسویه حساب ---
app.post('/api/v1/prescriptions/:id/settle', authenticateToken, async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        await pool.query("UPDATE prescriptions SET settled_at = NOW() WHERE id = $1", [prescriptionId]);
        res.status(200).json({ success: true, message: 'سفارش با موفقیت تسویه شد.' });
    } catch (error) {
        console.error('Error in settle endpoint:', error);
        res.status(500).json({ message: 'خطا در تسویه حساب.' });
    }
});


// --- API های عمومی (PWA کاربر) (به‌روز شده) ---
app.post('/api/v1/prescriptions/submit', async (req, res) => { /* ... */ });

// انتخاب داروخانه (به‌روز شده برای ثبت زمان)
app.post('/api/v1/prescriptions/:id/select-pharmacy', async (req, res) => {
    try {
        const prescriptionId = req.params.id;
        const { pharmacyId } = req.body;
        if (!pharmacyId) return res.status(400).json({ success: false, message: 'شناسه داروخانه الزامی است.' });
        
        // زمان تایید داروخانه را ثبت می‌کنیم
        await pool.query("UPDATE prescriptions SET pharmacy_id = $1, status = 'pharmacy_selected', pharmacy_assigned_at = NOW() WHERE id = $2", [pharmacyId, prescriptionId]);
        
        res.status(200).json({ success: true, message: 'داروخانه با موفقیت ثبت شد.' });
    } catch (error) {
        console.error('Error in /select-pharmacy endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در ثبت داروخانه منتخب.' });
    }
});

app.get('/api/v1/prescriptions/:id/status', async (req, res) => { /* ... */ });
app.get('/api/v1/prescriptions/history/:nationalId', async (req, res) => { /* ... */ });

app.listen(port, () => console.log(`Server with timestamp features listening on http://localhost:${port}`));