


console.log('DEBUG env:', {
  JWT_SECRET: !!process.env.JWT_SECRET,
  ADMIN_KEY: !!process.env.ADMIN_KEY,
  clesTrouvees: Object.keys(process.env).filter(k => /jwt|admin|secret|key/i.test(k)).map(k => JSON.stringify(k))
});
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { Pool } = require('pg');

const {
  DATABASE_URL, JWT_SECRET, ADMIN_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, PORT = 3000
} = process.env;

if (!JWT_SECRET || !ADMIN_KEY) { console.error('JWT_SECRET et ADMIN_KEY sont obligatoires'); process.exit(1); }

const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !/localhost|127\.0\.0\.1|host=\//.test(DATABASE_URL) ? { rejectUnauthorized: false } : false
});
const mailer = SMTP_HOST ? nodemailer.createTransport({
  host: SMTP_HOST, port: +(SMTP_PORT || 587), secure: +(SMTP_PORT || 587) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;

async function sendMail(to, subject, text) {
  if (!mailer) { console.log(`[MAIL non configuré] à ${to} — ${subject} — ${text}`); return; }
  await mailer.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text });
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      prenom TEXT NOT NULL, nom TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      mot_de_passe TEXT NOT NULL,
      discipline TEXT DEFAULT '',
      telephone TEXT DEFAULT '', adresse TEXT DEFAULT '',
      code_postal TEXT DEFAULT '', ville TEXT DEFAULT '',
      avatar TEXT DEFAULT '🍔',
      verifie BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS codes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      type TEXT NOT NULL,            -- 'inscription' | 'reset'
      expire_at TIMESTAMPTZ NOT NULL,
      tentatives INT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS commandes (
      id SERIAL PRIMARY KEY,
      client_id INT REFERENCES clients(id) ON DELETE SET NULL,
      email TEXT,
      stripe_id TEXT UNIQUE,
      articles TEXT,
      montant NUMERIC(10,2) NOT NULL,
      statut TEXT DEFAULT 'En traitement',
      nom TEXT, telephone TEXT, adresse TEXT, code_postal TEXT, ville TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS produits (
      id SERIAL PRIMARY KEY,
      nom TEXT NOT NULL,
      categorie TEXT NOT NULL,
      prix NUMERIC(10,2) NOT NULL DEFAULT 0,
      stock INT NOT NULL DEFAULT 0,
      actif BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS mouvements (
      id SERIAL PRIMARY KEY,
      produit_id INT REFERENCES produits(id) ON DELETE SET NULL,
      produit_nom TEXT,
      type TEXT NOT NULL,            -- ajout | retrait | perte | vente | reset
      qte INT NOT NULL,              -- toujours positif
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ventes (
      id SERIAL PRIMARY KEY,
      articles JSONB NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      mode TEXT DEFAULT 'Espèces',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Liens avec le site client
  await pool.query(`
    ALTER TABLE produits ADD COLUMN IF NOT EXISTS section TEXT;          -- menu | kids | tunisien
    ALTER TABLE produits ADD COLUMN IF NOT EXISTS site_id INT;           -- id du produit dans index.html
    ALTER TABLE produits ADD COLUMN IF NOT EXISTS ancien_prix NUMERIC(10,2);
    ALTER TABLE produits ADD COLUMN IF NOT EXISTS badge TEXT;
    ALTER TABLE produits ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE produits ADD COLUMN IF NOT EXISTS image TEXT DEFAULT '';
    ALTER TABLE produits ADD COLUMN IF NOT EXISTS suivi BOOLEAN DEFAULT FALSE; -- stock suivi ? (sinon toujours dispo)
    ALTER TABLE commandes ADD COLUMN IF NOT EXISTS items JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS produits_site ON produits(section, site_id);
    CREATE TABLE IF NOT EXISTS produits_supprimes (section TEXT, site_id INT, PRIMARY KEY (section, site_id));
    CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT);
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY, categorie TEXT DEFAULT 'Autre', fournisseur TEXT DEFAULT '', numero TEXT DEFAULT '',
      montant NUMERIC(10,2), date_doc DATE DEFAULT CURRENT_DATE, echeance DATE,
      statut TEXT DEFAULT 'À vérifier', fichier TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  // Catalogue du site (seed.json) : ajoute seulement ce qui manque, ne touche pas à ce que tu modifies dans l'admin
  const seed = require('./seed.json');
  for (const s of seed) {
    const ex = (await pool.query('SELECT id FROM produits WHERE section=$1 AND site_id=$2', [s.section, s.site_id])).rows[0];
    if (ex) continue;
    const gone = (await pool.query('SELECT 1 FROM produits_supprimes WHERE section=$1 AND site_id=$2', [s.section, s.site_id])).rows[0];
    if (gone) continue;   // supprimé volontairement dans l'admin : on ne le recrée pas
    const old = (await pool.query('SELECT id FROM produits WHERE section IS NULL AND nom=$1 LIMIT 1', [s.nom])).rows[0];
    if (old) { await pool.query('UPDATE produits SET section=$1, site_id=$2 WHERE id=$3', [s.section, s.site_id, old.id]); continue; }
    await pool.query(
      `INSERT INTO produits (nom,categorie,prix,section,site_id,ancien_prix,badge,description,image) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.nom, s.categorie, s.prix, s.section, s.site_id, s.ancien_prix, s.badge, s.description, s.image]);
  }
  await pool.query(`UPDATE produits SET section='menu' WHERE section IS NULL`);
}

const REF = 'COALESCE(site_id, 100000 + id)';   // identifiant utilisé par le site pour ce produit
const PROMOS = { BURGER25: 0.25 };

/* Suppléments par formule (en €, ajoutés au prix du produit). Clé = catégorie du produit.
   >>> VALEURS PAR DÉFAUT À AJUSTER : mets tes vrais prix. La formule de base vaut 0. <<< */
const MENU3 = { 'Seul': 0, 'Menu': 3, 'Maxi Menu': 5 };
const SUPPLEMENTS = {
  Burgers: MENU3, Tacos: MENU3,
  Poulet:   { '6 pièces': 0, '9 pièces': 2.5, '12 pièces': 5 },
  Sides:    { 'Petite': 0, 'Moyenne': 1, 'Grande': 2 },
  Boissons: { '33 cl': 0, '50 cl': 1, '1 L': 2.5 },
  Desserts: { 'Seul': 0, 'Duo': 2.5 },
  Menus:    { 'Normal': 0, 'Maxi': 2 },
  _kids:    { 'Seul': 0, 'Menu Kids': 2.5 },
  _default: MENU3
};
const suppTable = (sec, cat) => sec === 'kids' ? SUPPLEMENTS._kids : (SUPPLEMENTS[cat] || SUPPLEMENTS._default);               // codes promo valables (même liste que sur le site)

/* Réduit le stock selon les articles d'une commande (items = [{sec,id,qty}]) */
async function appliquerVenteSite(db, items, sens = -1) {
  for (const it of items) {
    const p = (await db.query(`SELECT id,nom,suivi FROM produits WHERE section=$1 AND ${REF}=$2`, [it.sec, it.id])).rows[0];
    if (!p) continue;
    if (p.suivi) await db.query('UPDATE produits SET stock=GREATEST(0,stock+$1) WHERE id=$2', [sens * it.qty, p.id]);
    await db.query('INSERT INTO mouvements (produit_id,produit_nom,type,qte) VALUES ($1,$2,$3,$4)',
      [p.id, p.nom, sens < 0 ? 'vente_site' : 'retour_site', it.qty]);
  }
}

const app = express();

/* ---------- Webhook Stripe (corps brut, AVANT express.json) ---------- */
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).send('Stripe non configuré');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).send('Signature invalide'); }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object, m = pi.metadata || {};
    const email = (m.email || pi.receipt_email || '').toLowerCase();
    const cl = email ? (await pool.query('SELECT id FROM clients WHERE email=$1', [email])).rows[0] : null;
    const items = parseItems(m.items);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const ins = await db.query(
        `INSERT INTO commandes (client_id,email,stripe_id,articles,montant,nom,telephone,adresse,code_postal,ville,items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (stripe_id) DO NOTHING RETURNING id`,
        [cl?.id || null, email, pi.id, m.articles || '', pi.amount / 100, m.name, m.phone, m.address, m.zip, m.city, JSON.stringify(items)]
      );
      if (ins.rows[0]) await appliquerVenteSite(db, items, -1);   // stock mis à jour une seule fois par commande
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); console.error(e); return res.status(500).send('Erreur'); }
    finally { db.release(); }
  }
  res.json({ received: true });
});

app.use(cors());
app.use((req, res, next) => req.path.startsWith('/api/admin/documents') ? next() : express.json({ limit: '100kb' })(req, res, next));

/* ---------- Helpers ---------- */
// "menu:3x2,kids:102x1"  <->  [{sec,id,qty}]
const parseItems = s => String(s || '').split(',').filter(Boolean).map(t => {
  const m = t.match(/^(\w+):(\d+)x(\d+)$/);
  return m ? { sec: m[1], id: +m[2], qty: +m[3] } : null;
}).filter(Boolean);
const fmtItems = items => items.map(i => `${i.sec}:${i.id}x${i.qty}`).join(',');

const sign = id => jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' });
const genCode = () => String(crypto.randomInt(100000, 1000000));
const validEmail = e => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function saveCode(email, type) {
  const code = genCode();
  await pool.query('DELETE FROM codes WHERE email=$1 AND type=$2', [email, type]);
  await pool.query(`INSERT INTO codes (email,code,type,expire_at) VALUES ($1,$2,$3, NOW() + INTERVAL '15 minutes')`, [email, code, type]);
  return code;
}
async function checkCode(email, code, type) {
  const r = (await pool.query('SELECT * FROM codes WHERE email=$1 AND type=$2', [email, type])).rows[0];
  if (!r) return false;
  if (new Date(r.expire_at) < new Date() || r.tentatives >= 5) { await pool.query('DELETE FROM codes WHERE id=$1', [r.id]); return false; }
  if (r.code !== String(code)) { await pool.query('UPDATE codes SET tentatives=tentatives+1 WHERE id=$1', [r.id]); return false; }
  await pool.query('DELETE FROM codes WHERE id=$1', [r.id]);
  return true;
}

async function clientComplet(id) {
  const c = (await pool.query('SELECT * FROM clients WHERE id=$1', [id])).rows[0];
  if (!c) return null;
  const commandes = (await pool.query('SELECT * FROM commandes WHERE client_id=$1 OR (client_id IS NULL AND email=$2) ORDER BY created_at DESC', [id, c.email])).rows;
  const total = commandes.reduce((s, o) => s + parseFloat(o.montant), 0);
  delete c.mot_de_passe;
  return { ...c, commandes, total_depense: total.toFixed(2), points: Math.floor(total) };
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try { req.userId = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET).id; next(); }
  catch { res.status(401).json({ error: 'Non connecté' }); }
}
function adminOnly(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Mot de passe admin incorrect' });
  next();
}

/* ---------- Auth ---------- */
app.post('/api/auth/inscription', async (req, res) => {
  try {
    const { prenom, nom, mot_de_passe, discipline } = req.body;
    const email = (req.body.email || '').trim().toLowerCase();
    if (!prenom || !nom) return res.status(400).json({ error: 'Prénom et nom requis' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Email invalide' });
    if (!mot_de_passe || mot_de_passe.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });

    const ex = (await pool.query('SELECT id, verifie FROM clients WHERE email=$1', [email])).rows[0];
    if (ex && ex.verifie) return res.status(409).json({ error: 'Cet email a déjà un compte' });

    const hash = await bcrypt.hash(mot_de_passe, 10);
    if (ex) await pool.query('UPDATE clients SET prenom=$1,nom=$2,mot_de_passe=$3,discipline=$4 WHERE id=$5', [prenom, nom, hash, discipline || '', ex.id]);
    else await pool.query('INSERT INTO clients (prenom,nom,email,mot_de_passe,discipline) VALUES ($1,$2,$3,$4,$5)', [prenom, nom, email, hash, discipline || '']);

    const code = await saveCode(email, 'inscription');
    await sendMail(email, 'Ton code de vérification', `Bienvenue ${prenom} ! Ton code : ${code} (valable 15 minutes)`);
    res.json({ ok: true, email });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/auth/verifier-code', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!(await checkCode(email, req.body.code, 'inscription'))) return res.status(400).json({ error: 'Code invalide ou expiré' });
    const c = (await pool.query('UPDATE clients SET verifie=TRUE WHERE email=$1 RETURNING id', [email])).rows[0];
    if (!c) return res.status(404).json({ error: 'Compte introuvable' });
    res.json({ token: sign(c.id), client: await clientComplet(c.id) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/auth/connexion', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const c = (await pool.query('SELECT * FROM clients WHERE email=$1', [email])).rows[0];
    if (!c || !(await bcrypt.compare(req.body.mot_de_passe || '', c.mot_de_passe))) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    if (!c.verifie) return res.status(403).json({ error: "Compte non activé : termine l'inscription avec le code reçu par email" });
    res.json({ token: sign(c.id), client: await clientComplet(c.id) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/auth/mot-de-passe-oublie', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return res.status(400).json({ error: 'Email invalide' });
    const c = (await pool.query('SELECT id FROM clients WHERE email=$1 AND verifie=TRUE', [email])).rows[0];
    if (c) { const code = await saveCode(email, 'reset'); await sendMail(email, 'Réinitialisation du mot de passe', `Ton code : ${code} (valable 15 minutes)`); }
    res.json({ ok: true }); // même réponse que le compte existe ou non
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/auth/reinitialiser-mot-de-passe', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const { code, nouveau_mot_de_passe } = req.body;
    if (!nouveau_mot_de_passe || nouveau_mot_de_passe.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
    if (!(await checkCode(email, code, 'reset'))) return res.status(400).json({ error: 'Code invalide ou expiré' });
    await pool.query('UPDATE clients SET mot_de_passe=$1 WHERE email=$2', [await bcrypt.hash(nouveau_mot_de_passe, 10), email]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

/* ---------- Profil ---------- */
app.get('/api/profil', auth, async (req, res) => {
  const c = await clientComplet(req.userId);
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  res.json(c);
});

app.put('/api/profil', auth, async (req, res) => {
  try {
    const { prenom, nom, telephone, adresse, code_postal, ville, discipline } = req.body;
    await pool.query(
      `UPDATE clients SET prenom=COALESCE($1,prenom), nom=COALESCE($2,nom), telephone=COALESCE($3,telephone),
       adresse=COALESCE($4,adresse), code_postal=COALESCE($5,code_postal), ville=COALESCE($6,ville), discipline=COALESCE($7,discipline) WHERE id=$8`,
      [prenom, nom, telephone, adresse, code_postal, ville, discipline, req.userId]);
    res.json(await clientComplet(req.userId));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

/* ---------- Catalogue public (le site le lit : prix, stock, produits masqués) ---------- */
app.get('/api/produits', async (req, res) => {
  const r = await pool.query(
    `SELECT id, section, ${REF} AS ref, site_id, nom, categorie, prix, ancien_prix, badge, description, image, stock, suivi, actif
     FROM produits ORDER BY id`);
  res.set('Cache-Control', 'no-store');
  res.json({ supplements: SUPPLEMENTS, produits: r.rows.map(p => ({ ...p, prix: parseFloat(p.prix), ancien_prix: p.ancien_prix == null ? null : parseFloat(p.ancien_prix) })) });
});

/* ---------- Paiement Stripe ---------- */
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe non configuré' });
    const { items, promo } = req.body;
    const clean = (v, n) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n);   // jamais de HTML dans les champs libres
    const email = clean(req.body.email, 120).toLowerCase(), name = clean(req.body.name, 100), phone = clean(req.body.phone, 30),
          address = clean(req.body.address, 150), zip = clean(req.body.zip, 12), city = clean(req.body.city, 80);
    if (!name || !validEmail(email)) return res.status(400).json({ error: 'Nom et email valides requis' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Panier vide' });

    // Une ligne par (produit, formule)
    const lignesBrutes = new Map();
    for (const it of items) {
      const qty = parseInt(it.qty, 10), id = parseInt(it.id, 10), size = clean(it.size, 30);
      if (!['menu', 'kids', 'tunisien'].includes(it.sec) || !(id >= 0) || !(qty >= 1 && qty <= 50)) return res.status(400).json({ error: 'Article invalide' });
      const k = `${it.sec}:${id}:${size}`;
      lignesBrutes.set(k, { sec: it.sec, id, size, qty: (lignesBrutes.get(k)?.qty || 0) + qty });
    }

    // Les prix, formules et stock viennent TOUJOURS de la base / du serveur, jamais du navigateur
    const rows = (await pool.query(`SELECT *, ${REF} AS ref FROM produits`)).rows;
    let total = 0; const parProduit = new Map(); const libelles = [];
    for (const l of lignesBrutes.values()) {
      const p = rows.find(r => r.section === l.sec && +r.ref === l.id);
      if (!p || !p.actif) return res.status(400).json({ error: 'Produit indisponible : pense à l\'ajouter dans Catalogue (admin)' });
      const table = suppTable(l.sec, p.categorie);
      if (l.size && !(l.size in table)) return res.status(400).json({ error: `Formule invalide pour « ${p.nom} »` });
      total += (parseFloat(p.prix) + (table[l.size] || 0)) * l.qty;
      libelles.push(`${p.nom}${l.size ? ' ' + l.size : ''} x${l.qty}`);
      const k = `${l.sec}:${l.id}`;
      parProduit.set(k, { sec: l.sec, id: l.id, qty: (parProduit.get(k)?.qty || 0) + l.qty });
    }
    // Stock contrôlé sur le total par produit (toutes formules confondues)
    for (const l of parProduit.values()) {
      const p = rows.find(r => r.section === l.sec && +r.ref === l.id);
      if (p.suivi && p.stock < l.qty) return res.status(409).json({ error: p.stock > 0 ? `Plus que ${p.stock} « ${p.nom} » en stock` : `« ${p.nom} » est épuisé` });
    }
    const lignes = [...parProduit.values()];
    const articles = libelles.join(', ').slice(0, 450);   // texte construit par le serveur
    const remise = PROMOS[String(promo || '').toUpperCase()] || 0;
    const amt = Math.round(total * (1 - remise) * 100);
    if (amt < 50 || amt > 100000) return res.status(400).json({ error: 'Montant invalide' });
    const meta = fmtItems(lignes);
    if (meta.length > 480) return res.status(400).json({ error: 'Panier trop grand' });

    const pi = await stripe.paymentIntents.create({
      amount: amt, currency: 'eur', receipt_email: email,
      automatic_payment_methods: { enabled: true },
      metadata: { email, name, phone, address, zip, city, articles, items: meta }
    });
    res.json({ clientSecret: pi.client_secret, amount: amt });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur paiement' }); }
});

/* ---------- Admin ---------- */
app.get('/api/admin/clients', adminOnly, async (req, res) => {
  const r = await pool.query(`
    SELECT c.id, c.prenom, c.nom, c.email, c.discipline, c.avatar,
           COUNT(o.id) AS nb_commandes, COALESCE(SUM(o.montant),0) AS total_depense, MAX(o.created_at) AS dernier_achat
    FROM clients c LEFT JOIN commandes o ON o.client_id=c.id
    WHERE c.verifie=TRUE GROUP BY c.id ORDER BY total_depense DESC`);
  res.json({ clients: r.rows });
});

app.get('/api/admin/commandes', adminOnly, async (req, res) => {
  res.json({ commandes: (await pool.query('SELECT * FROM commandes ORDER BY created_at DESC LIMIT 200')).rows });
});

app.patch('/api/admin/commandes/:id', adminOnly, async (req, res) => {
  const ok = ['En traitement', 'Expédié', 'Livré', 'Annulé'];
  if (!ok.includes(req.body.statut)) return res.status(400).json({ error: 'Statut invalide' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const o = (await db.query('SELECT statut, items FROM commandes WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!o) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Commande introuvable' }); }
    await db.query('UPDATE commandes SET statut=$1 WHERE id=$2', [req.body.statut, req.params.id]);
    // Annulation : les articles reviennent en stock ; ré-activation : ils en ressortent
    if (o.items && req.body.statut === 'Annulé' && o.statut !== 'Annulé') await appliquerVenteSite(db, o.items, +1);
    if (o.items && o.statut === 'Annulé' && req.body.statut !== 'Annulé') await appliquerVenteSite(db, o.items, -1);
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await db.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
  finally { db.release(); }
});

/* ---------- Admin : catalogue ---------- */
app.get('/api/admin/produits', adminOnly, async (req, res) => {
  res.json({ produits: (await pool.query('SELECT * FROM produits ORDER BY categorie, nom')).rows });
});

app.post('/api/admin/produits', adminOnly, async (req, res) => {
  const { nom, categorie, prix, section, ancien_prix, badge, description, image } = req.body;
  if (!nom || !categorie || !(Number(prix) >= 0)) return res.status(400).json({ error: 'Nom, catégorie et prix requis' });
  const sec = ['menu', 'kids', 'tunisien'].includes(section) ? section : 'menu';
  const r = await pool.query(
    `INSERT INTO produits (nom,categorie,prix,section,ancien_prix,badge,description,image) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [nom.trim(), categorie.trim(), Number(prix), sec, ancien_prix ? Number(ancien_prix) : null, ['new', 'promo', 'hot'].includes(badge) ? badge : null, description || '', image || '']);
  res.json(r.rows[0]);
});

app.put('/api/admin/produits/:id', adminOnly, async (req, res) => {
  const { nom, categorie, prix, actif, ancien_prix, badge, description, image, suivi } = req.body;
  const has = k => Object.prototype.hasOwnProperty.call(req.body, k);
  const r = await pool.query(
    `UPDATE produits SET nom=COALESCE($1,nom), categorie=COALESCE($2,categorie), prix=COALESCE($3,prix), actif=COALESCE($4,actif),
       ancien_prix = CASE WHEN $6 THEN $7::numeric ELSE ancien_prix END,
       badge = CASE WHEN $8 THEN $9 ELSE badge END,
       description = COALESCE($10,description), image = COALESCE($11,image), suivi = COALESCE($12,suivi)
     WHERE id=$5 RETURNING *`,
    [nom, categorie, prix === undefined ? null : Number(prix), actif, req.params.id,
     has('ancien_prix'), ancien_prix ? Number(ancien_prix) : null,
     has('badge'), ['new', 'promo', 'hot'].includes(badge) ? badge : null,
     description ?? null, image ?? null, suivi ?? null]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Produit introuvable' });
  res.json(r.rows[0]);
});

app.delete('/api/admin/produits/:id', adminOnly, async (req, res) => {
  const d = await pool.query('DELETE FROM produits WHERE id=$1 RETURNING section, site_id', [req.params.id]);
  const g = d.rows[0];
  if (g && g.site_id != null) await pool.query('INSERT INTO produits_supprimes (section, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.section, g.site_id]);
  res.json({ ok: true });
});

/* ---------- Admin : stock ---------- */
app.post('/api/admin/produits/:id/stock', adminOnly, async (req, res) => {
  const type = req.body.type;                       // ajout | retrait | perte
  const qte = Math.abs(parseInt(req.body.qte || 1, 10));
  if (!['ajout', 'retrait', 'perte'].includes(type) || !qte) return res.status(400).json({ error: 'Mouvement invalide' });
  const delta = type === 'ajout' ? qte : -qte;
  // Dès qu'on ajoute du stock, le produit est « suivi » : le site affiche Épuisé à 0 et bloque la vente
  const r = await pool.query('UPDATE produits SET stock=GREATEST(0,stock+$1), suivi = suivi OR $3 WHERE id=$2 RETURNING *', [delta, req.params.id, type === 'ajout']);
  if (!r.rows[0]) return res.status(404).json({ error: 'Produit introuvable' });
  await pool.query('INSERT INTO mouvements (produit_id,produit_nom,type,qte) VALUES ($1,$2,$3,$4)', [r.rows[0].id, r.rows[0].nom, type, qte]);
  res.json(r.rows[0]);
});

app.post('/api/admin/stock/reset', adminOnly, async (req, res) => {
  const cat = req.body.categorie || null;
  const rows = (await pool.query('SELECT id,nom,stock FROM produits WHERE stock>0 AND ($1::text IS NULL OR categorie=$1)', [cat])).rows;
  for (const p of rows) await pool.query('INSERT INTO mouvements (produit_id,produit_nom,type,qte) VALUES ($1,$2,$3,$4)', [p.id, p.nom, 'reset', p.stock]);
  await pool.query('UPDATE produits SET stock=0 WHERE $1::text IS NULL OR categorie=$1', [cat]);
  res.json({ ok: true, remis_a_zero: rows.length });
});

/* ---------- Admin : street vente (caisse) ---------- */
app.post('/api/admin/street-vente', adminOnly, async (req, res) => {
  const items = (req.body.items || []).filter(i => i.qte > 0);
  const mode = ['Espèces', 'Carte', 'Twint'].includes(req.body.mode) ? req.body.mode : 'Espèces';
  if (!items.length) return res.status(400).json({ error: 'Panier vide' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    let total = 0; const lignes = [];
    for (const it of items) {
      const p = (await db.query('SELECT * FROM produits WHERE id=$1 FOR UPDATE', [it.id])).rows[0];
      const q = parseInt(it.qte, 10);
      if (!p || !p.actif) throw new Error('Produit indisponible');
      if (!(q >= 1 && q <= 200)) throw new Error('Quantité invalide');
      const size = String(it.size || '').slice(0, 30), table = suppTable(p.section, p.categorie);
      if (size && !(size in table)) throw new Error(`Formule invalide : ${p.nom}`);
      if (p.suivi && p.stock < q) throw new Error(`Stock insuffisant : ${p.nom} (reste ${p.stock})`);
      await db.query('UPDATE produits SET stock=GREATEST(0,stock-$1) WHERE id=$2', [q, p.id]);
      await db.query('INSERT INTO mouvements (produit_id,produit_nom,type,qte) VALUES ($1,$2,$3,$4)', [p.id, p.nom, 'vente', q]);
      const unit = parseFloat(p.prix) + (table[size] || 0);
      total += unit * q;
      lignes.push({ id: p.id, nom: p.nom + (size ? ' ' + size : ''), qte: q, prix: unit });
    }
    const v = await db.query('INSERT INTO ventes (articles,total,mode) VALUES ($1,$2,$3) RETURNING *', [JSON.stringify(lignes), total.toFixed(2), mode]);
    await db.query('COMMIT');
    res.json(v.rows[0]);
  } catch (e) {
    await db.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { db.release(); }
});

/* ---------- Admin : journal & récap ---------- */
function periode(q) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 24 * 3600 * 1000);
  return [from.toISOString(), to.toISOString()];
}

app.get('/api/admin/journal', adminOnly, async (req, res) => {
  const [f, t] = periode(req.query);
  const ventes = (await pool.query('SELECT * FROM ventes WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at DESC', [f, t])).rows;
  const mouvements = (await pool.query(`SELECT * FROM mouvements WHERE type NOT IN ('vente','vente_site') AND created_at BETWEEN $1 AND $2 ORDER BY created_at DESC`, [f, t])).rows;
  const commandes = (await pool.query(`SELECT id,stripe_id,articles,montant,statut,nom,created_at FROM commandes WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at DESC`, [f, t])).rows;
  res.json({ ventes, mouvements, commandes });
});

app.get('/api/admin/recap', adminOnly, async (req, res) => {
  const [f, t] = periode(req.query);
  const street = (await pool.query('SELECT COALESCE(SUM(total),0) AS ca, COUNT(*)::int AS nb FROM ventes WHERE created_at BETWEEN $1 AND $2', [f, t])).rows[0];
  const site = (await pool.query(`SELECT COALESCE(SUM(montant),0) AS ca, COUNT(*)::int AS nb FROM commandes WHERE statut<>'Annulé' AND created_at BETWEEN $1 AND $2`, [f, t])).rows[0];
  const vendus = (await pool.query(`SELECT produit_nom AS nom, SUM(CASE WHEN type='retour_site' THEN -qte ELSE qte END)::int AS qte FROM mouvements WHERE type IN ('vente','vente_site','retour_site') AND created_at BETWEEN $1 AND $2 GROUP BY produit_nom HAVING SUM(CASE WHEN type='retour_site' THEN -qte ELSE qte END)>0 ORDER BY qte DESC`, [f, t])).rows;
  const pertes = (await pool.query(
    `SELECT m.produit_nom AS nom, SUM(m.qte)::int AS qte, COALESCE(SUM(m.qte*p.prix),0) AS valeur
     FROM mouvements m LEFT JOIN produits p ON p.id=m.produit_id
     WHERE m.type='perte' AND m.created_at BETWEEN $1 AND $2 GROUP BY m.produit_nom ORDER BY qte DESC`, [f, t])).rows;
  res.json({ street, site, vendus, pertes });
});

/* ---------- Admin : réglages (cuisine) ---------- */
const REGL = { ouverture: '20:30', prep_min: '90', adresse: '' };
app.get('/api/admin/reglages', adminOnly, async (req, res) => {
  const o = { ...REGL };
  for (const r of (await pool.query('SELECT cle, valeur FROM reglages')).rows) if (r.cle in REGL) o[r.cle] = r.valeur;
  res.json(o);
});
app.put('/api/admin/reglages', adminOnly, async (req, res) => {
  for (const k of Object.keys(REGL)) if (k in req.body)
    await pool.query('INSERT INTO reglages (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=$2', [k, String(req.body[k]).slice(0, 200)]);
  res.json({ ok: true });
});

/* ---------- Admin : documents / factures / HACCP ---------- */
const DOC_CAT = ['Alimentaire / HACCP', 'Facture', 'Autre'], DOC_ST = ['À vérifier', 'À régler', 'Payée'];
const DOC_COLS = 'id,categorie,fournisseur,numero,montant,date_doc,echeance,statut,created_at,(fichier IS NOT NULL) AS has_file';
const bigJson = express.json({ limit: '8mb' });
app.get('/api/admin/documents', adminOnly, async (req, res) => {
  res.json({ documents: (await pool.query(`SELECT ${DOC_COLS} FROM documents ORDER BY created_at DESC LIMIT 500`)).rows });
});
app.get('/api/admin/documents/:id/fichier', adminOnly, async (req, res) => {
  const r = (await pool.query('SELECT fichier FROM documents WHERE id=$1', [req.params.id])).rows[0];
  if (!r || !r.fichier) return res.status(404).json({ error: 'Pas de fichier' });
  res.json({ fichier: r.fichier });
});
app.post('/api/admin/documents', adminOnly, bigJson, async (req, res) => {
  const b = req.body || {}, t = v => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, 120);
  const f = b.fichier ? String(b.fichier) : null;
  if (f && (!/^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/.test(f) || f.length > 6e6)) return res.status(400).json({ error: 'Fichier invalide (image ou PDF, 4 Mo max)' });
  const r = await pool.query(
    `INSERT INTO documents (categorie,fournisseur,numero,montant,date_doc,echeance,statut,fichier)
     VALUES ($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),$6::date,$7,$8) RETURNING ${DOC_COLS}`,
    [DOC_CAT.includes(b.categorie) ? b.categorie : 'Autre', t(b.fournisseur), t(b.numero), b.montant === '' || b.montant == null ? null : Number(b.montant),
     b.date_doc || null, b.echeance || null, DOC_ST.includes(b.statut) ? b.statut : 'À vérifier', f]);
  res.json(r.rows[0]);
});
app.put('/api/admin/documents/:id', adminOnly, bigJson, async (req, res) => {
  if (!DOC_ST.includes(req.body.statut)) return res.status(400).json({ error: 'Statut invalide' });
  const r = await pool.query(`UPDATE documents SET statut=$1 WHERE id=$2 RETURNING ${DOC_COLS}`, [req.body.statut, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Introuvable' });
  res.json(r.rows[0]);
});
app.delete('/api/admin/documents/:id', adminOnly, async (req, res) => {
  await pool.query('DELETE FROM documents WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

/* ---------- Site (index.html dans /public) ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.send('ok'));

initDb().then(() => app.listen(PORT, () => console.log('Serveur prêt sur le port ' + PORT)))
  .catch(e => { console.error('Erreur base de données', e); process.exit(1); });
