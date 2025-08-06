// index.js (نسخه نهایی با شنودگر سراسری برای عیب‌یابی)
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = 3000;

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- Middleware جدید برای لاگ‌گیری تمام درخواست‌ها ---
// این بخش هر درخواستی که به سرور می‌رسد را قبل از هر چیز دیگری لاگ می‌کند
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Received ${req.method} request for ${req.originalUrl}`);
  next(); // درخواست را به مسیر بعدی هدایت می‌کند
});
// --- پایان بخش جدید ---

// --- Database Pool ---
const pool = new Pool({
  user: 'myuser',
  host: '127.0.0.1',
  database: 'noskheresan_db',
  password: 'mypassword',
  port: 5432,
});

// --- API Endpoints ---
app.get('/', (req, res) => res.send('Noskhe-Resan Backend - MVP v1.2 (Debugging Mode) - All Systems Go!'));

// 1. ثبت اولیه نسخه توسط کاربر
app.post('/api/v1/prescriptions/submit', async (req, res) => {
    try {
        const { nationalId, trackingCode, insuranceType } = req.body;
        if (!nationalId || !trackingCode || !insuranceType) {
            return res.status(400).json({ success: false, message: 'تمام اطلاعات الزامی است.' });
        }
        const existingPrescription = await pool.query('SELECT id FROM prescriptions WHERE tracking_code = $1', [trackingCode]);
        if (existingPrescription.rows.length > 0) {
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

// 2. دریافت لیست داروخانه‌ها
app.get('/api/v1/pharmacies', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, address, latitude, longitude, working_hours FROM pharmacies');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error in /pharmacies endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در دریافت لیست داروخانه‌ها.' });
    }
});

// 3. انتخاب داروخانه برای یک نسخه
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

//4. دریافت وضعیت یک سفارش (نسخه بهبودیافته)
app.get('/api/v1/prescriptions/:id/status', async (req, res) => {
    const prescriptionId = req.params.id;
    console.log(`Request for status of prescription ${prescriptionId}`);
    try {
        // حالا علاوه بر وضعیت، کد رهگیری را هم از دیتابیس می‌خوانیم
        const result = await pool.query('SELECT status, tracking_code FROM prescriptions WHERE id = $1', [prescriptionId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'سفارش یافت نشد.' });
        }
        
        // هر دو مقدار را در پاسخ برمی‌گردانیم
        res.status(200).json({ 
            success: true, 
            status: result.rows[0].status,
            trackingCode: result.rows[0].tracking_code 
        });
    } catch (error) {
        console.error('Error in /status endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در دریافت وضعیت سفارش.' });
    }
});

// 5. دریافت تمام سفارش‌ها برای پنل داروخانه
app.get('/api/v1/prescriptions', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, national_id, tracking_code, status, insurance_type FROM prescriptions ORDER BY created_at DESC');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error in /prescriptions (all) endpoint:', error);
        res.status(500).json({ success: false, message: 'خطا در دریافت لیست سفارش‌ها.' });
    }
});

// 6. به‌روزرسانی وضعیت یک سفارش توسط داروخانه
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

app.get('/api/v1/prescriptions/history/:nationalId', async (req, res) => {
    const { nationalId } = req.params;
    console.log(`Request received for history of national ID: ${nationalId}`);
    try {
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


app.listen(port, () => console.log(`Final server v1.2 listening at http://localhost:${port}`));
