'use strict';

const express = require('express');
const multer  = require('multer');
const { body, param, query } = require('express-validator');
const router  = express.Router();
const { db }  = require('../services/database');
const { validateFields } = require('../middleware');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { sanitizePhone } = require('../utils/helpers');
const logger = require('../utils/logger').forService('contacts-api');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/', [query('page').optional().isInt({min:1}).toInt(), query('limit').optional().isInt({min:1,max:100}).toInt(), query('search').optional().trim()], validateFields, async (req, res, next) => {
  try {
    const page = req.query.page || 1, limit = req.query.limit || 20, offset = (page-1)*limit;
    const search = req.query.search;
    const conditions = ['1=1'], params = []; let pi = 1;
    if (search) { conditions.push(`(ct.name ILIKE $${pi} OR ct.phone ILIKE $${pi})`); params.push(`%${search}%`); pi++; }
    const where = conditions.join(' AND ');
    const { rows } = await db.query(`SELECT ct.*, co.name AS company_name FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id WHERE ${where} ORDER BY ct.created_at DESC LIMIT $${pi} OFFSET $${pi+1}`, [...params, limit, offset]);
    const { rows: cnt } = await db.query(`SELECT COUNT(*) FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id WHERE ${where}`, params);
    res.json({ success: true, data: rows, pagination: { page, limit, total: parseInt(cnt[0].count,10), pages: Math.ceil(parseInt(cnt[0].count,10)/limit) } });
  } catch(err) { next(err); }
});

router.post('/', [body('name').notEmpty().trim(), body('phone').notEmpty(), body('email').optional().isEmail(), body('preferredLang').optional().isIn(['es','ca','en'])], validateFields, async (req, res, next) => {
  try {
    const { name, phone, email, preferredLang, companyName, position, notes } = req.body;
    const cleanPhone = sanitizePhone(phone);
    let companyId = null;
    if (companyName) {
      await db.query(`INSERT INTO companies (name) VALUES ($1) ON CONFLICT DO NOTHING`, [companyName]);
      const { rows: cr } = await db.query('SELECT id FROM companies WHERE name = $1', [companyName]);
      companyId = cr[0]?.id;
    }
    const { rows } = await db.query(`INSERT INTO contacts (name, phone, email, position, preferred_lang, company_id, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [name, cleanPhone, email||null, position||null, preferredLang||'es', companyId, notes||null]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch(err) { next(err); }
});

router.post('/import/csv', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new ValidationError('No CSV file uploaded');
    const csv = req.file.buffer.toString('utf-8');
    const lines = csv.split('\n').filter(Boolean);
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g,''));
    const nameIdx = headers.findIndex(h => h.includes('nombre')||h.includes('name'));
    const phoneIdx = headers.findIndex(h => h.includes('telefono')||h.includes('phone')||h.includes('tel'));
    const emailIdx = headers.findIndex(h => h.includes('email')||h.includes('correo'));
    const compIdx = headers.findIndex(h => h.includes('empresa')||h.includes('company'));
    const langIdx = headers.findIndex(h => h.includes('idioma')||h.includes('lang'));
    if (nameIdx===-1||phoneIdx===-1) throw new ValidationError('CSV must have nombre and telefono columns');
    let imported=0, skipped=0, errors=0;
    for (let i=1; i<lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/"/g,''));
      try {
        const name = cols[nameIdx], phone = sanitizePhone(cols[phoneIdx]||'');
        if (!name||!phone) { skipped++; continue; }
        const email = emailIdx>=0?cols[emailIdx]:null, company = compIdx>=0?cols[compIdx]:null, lang = langIdx>=0?cols[langIdx]:'es';
        let companyId = null;
        if (company) { await db.query(`INSERT INTO companies (name) VALUES ($1) ON CONFLICT DO NOTHING`,[company]); const {rows:cr} = await db.query('SELECT id FROM companies WHERE name=$1',[company]); companyId=cr[0]?.id; }
        await db.query(`INSERT INTO contacts (name,phone,email,preferred_lang,company_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (phone) DO NOTHING`,[name,phone,email||null,['es','ca','en'].includes(lang)?lang:'es',companyId]);
        imported++;
      } catch { errors++; }
    }
    res.json({ success: true, data: { imported, skipped, errors, total: lines.length-1 } });
  } catch(err) { next(err); }
});

router.patch('/:id', [param('id').isUUID()], validateFields, async (req, res, next) => {
  try {
    const allowed = ['name','email','position','preferred_lang','notes','do_not_call'];
    const updates=[], values=[]; let pi=1;
    for (const key of allowed) { if (req.body[key]!==undefined) { updates.push(`${key}=$${pi++}`); values.push(req.body[key]); } }
    if (!updates.length) throw new ValidationError('No fields to update');
    values.push(req.params.id);
    const {rows} = await db.query(`UPDATE contacts SET ${updates.join(',')},updated_at=NOW() WHERE id=$${pi} RETURNING *`,values);
    if (!rows.length) throw new NotFoundError('Contact');
    res.json({ success: true, data: rows[0] });
  } catch(err) { next(err); }
});

router.delete('/:id', [param('id').isUUID()], validateFields, async (req, res, next) => {
  try {
    const {rows} = await db.query('DELETE FROM contacts WHERE id=$1 RETURNING id',[req.params.id]);
    if (!rows.length) throw new NotFoundError('Contact');
    res.json({ success: true, message: 'Contact deleted' });
  } catch(err) { next(err); }
});

module.exports = router;
