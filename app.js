require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { makePool, initDb, getResults } = require('./src/db');
const { requireAuth, requireAdmin, redirectIfAuth } = require('./src/auth');

const app = express();
const pool = makePool();
const PgSession = connectPgSimple(session);
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const siteName = process.env.SITE_NAME || 'National Marching Band Poll';
const pollBrand = process.env.POLL_BRAND || 'BOA THINGS';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '300kb' }));
app.use(express.json({ limit: '300kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '1d' : 0 }));

app.use(session({
  store: new PgSession({ pool, tableName: 'mbpoll_sessions', createTableIfMissing: true }),
  name: 'mbpoll.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-change-this-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  res.locals.siteName = siteName;
  res.locals.pollBrand = pollBrand;
  res.locals.year = new Date().getFullYear();
  delete req.session.flash;
  next();
});

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if (!sent || sent !== req.session.csrfToken) {
    return res.status(403).render('error', {
      title: 'Request blocked',
      message: 'Your security token expired or was invalid. Refresh the page and try again.'
    });
  }
  next();
});

function flash(req, type, message) {
  req.session.flash = { type, message };
}



const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Try again later.'
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many registration attempts. Try again later.'
});

app.get('/health', (req, res) => res.status(200).send('ok'));

app.get('/', async (req, res, next) => {
  try {
    const [results, statsQ, titleQ] = await Promise.all([
      getResults(pool),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users WHERE active = TRUE) AS account_count,
          (SELECT COUNT(*)::int FROM ballots blt JOIN users u ON u.id = blt.user_id WHERE u.active = TRUE) AS ballot_count,
          (SELECT COUNT(*)::int FROM bands WHERE active = TRUE) AS band_count
      `),
      pool.query("SELECT value FROM site_settings WHERE key = 'graphic_title' LIMIT 1")
    ]);
    const stats = statsQ.rows[0] || { account_count: 0, ballot_count: 0, band_count: 0 };
    const graphicTitle = String(titleQ.rows[0]?.value || 'BOA THINGS TOP 25').trim() || 'BOA THINGS TOP 25';
    res.render('home', {
      title: 'Top 25',
      top25: results.slice(0, 25),
      others: results.slice(25),
      accountCount: Number(stats.account_count || 0),
      ballotCount: Number(stats.ballot_count || 0),
      bandCount: Number(stats.band_count || 0),
      graphicTitle
    });
  } catch (err) { next(err); }
});

app.get('/login', redirectIfAuth, (req, res) => res.render('login', { title: 'Sign in' }));

app.post('/login', loginLimiter, redirectIfAuth, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const q = await pool.query(
      'SELECT id, username, display_name, password_hash, is_admin, active FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1',
      [username]
    );
    const user = q.rows[0];
    if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
      flash(req, 'error', 'Invalid username or password.');
      return res.redirect('/login');
    }

    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.user = {
        id: Number(user.id),
        username: user.username,
        displayName: user.display_name,
        isAdmin: Boolean(user.is_admin)
      };
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      res.redirect(user.is_admin ? '/admin' : '/rankings');
    });
  } catch (err) { next(err); }
});

app.get('/register', redirectIfAuth, (req, res) => res.render('register', { title: 'Create account' }));

app.post('/register', registerLimiter, redirectIfAuth, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const displayName = String(req.body.display_name || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirm_password || '');

    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
      flash(req, 'error', 'Username must be 3–64 characters using letters, numbers, dot, underscore, or hyphen.');
      return res.redirect('/register');
    }
    if (displayName.length < 2 || displayName.length > 100) {
      flash(req, 'error', 'Display name must be 2–100 characters.');
      return res.redirect('/register');
    }
    if (password.length < 10) {
      flash(req, 'error', 'Password must be at least 10 characters.');
      return res.redirect('/register');
    }
    if (password !== confirmPassword) {
      flash(req, 'error', 'Passwords do not match.');
      return res.redirect('/register');
    }

    const exists = await pool.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1', [username]);
    if (exists.rowCount > 0) {
      flash(req, 'error', 'That username is already taken.');
      return res.redirect('/register');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const inserted = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, is_admin, active)
       VALUES ($1, $2, $3, FALSE, TRUE)
       RETURNING id, username, display_name`,
      [username, displayName, passwordHash]
    );
    const user = inserted.rows[0];

    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.user = {
        id: Number(user.id),
        username: user.username,
        displayName: user.display_name,
        isAdmin: false
      };
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      res.redirect('/rankings');
    });
  } catch (err) {
    if (err.code === '23505') {
      flash(req, 'error', 'That username is already taken.');
      return res.redirect('/register');
    }
    next(err);
  }
});

app.post('/logout', requireAuth, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('mbpoll.sid');
    res.redirect('/');
  });
});

app.get('/rankings', requireAuth, async (req, res, next) => {
  try {
    const [bandsQ, ballotQ] = await Promise.all([
      pool.query('SELECT id, name, city, state FROM bands WHERE active = TRUE ORDER BY name ASC, state ASC, city ASC'),
      pool.query(`
        SELECT br.band_id, br.rank, blt.updated_at
        FROM ballots blt
        JOIN ballot_rankings br ON br.ballot_id = blt.id
        WHERE blt.user_id = $1
        ORDER BY br.rank ASC
      `, [req.session.user.id])
    ]);

    const rankingIds = ballotQ.rows.map(r => Number(r.band_id));
    const requiredCount = Math.min(25, bandsQ.rows.length);
    res.render('rankings', {
      title: 'My rankings',
      bands: bandsQ.rows,
      rankingIds,
      requiredCount,
      updatedAt: ballotQ.rows[0]?.updated_at || null
    });
  } catch (err) { next(err); }
});

app.post('/rankings', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    let rankings;
    try {
      rankings = JSON.parse(String(req.body.rankings_json || '[]')).map(Number);
    } catch {
      rankings = [];
    }

    const activeCountQ = await client.query('SELECT COUNT(*)::int AS count FROM bands WHERE active = TRUE');
    const requiredCount = Math.min(25, Number(activeCountQ.rows[0].count || 0));

    if (requiredCount === 0) {
      flash(req, 'error', 'No bands have been added yet.');
      return res.redirect('/rankings');
    }
    if (rankings.length !== requiredCount || new Set(rankings).size !== requiredCount || rankings.some(id => !Number.isInteger(id) || id <= 0)) {
      flash(req, 'error', `Your rankings must contain exactly ${requiredCount} different band${requiredCount === 1 ? '' : 's'}.`);
      return res.redirect('/rankings');
    }

    const validQ = await client.query('SELECT id FROM bands WHERE active = TRUE AND id = ANY($1::bigint[])', [rankings]);
    if (validQ.rows.length !== requiredCount) {
      flash(req, 'error', 'One or more selected bands are invalid or inactive.');
      return res.redirect('/rankings');
    }

    await client.query('BEGIN');
    const ballotQ = await client.query(
      `INSERT INTO ballots (user_id, updated_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [req.session.user.id]
    );
    const ballotId = ballotQ.rows[0].id;
    await client.query('DELETE FROM ballot_rankings WHERE ballot_id = $1', [ballotId]);
    for (let i = 0; i < rankings.length; i++) {
      await client.query(
        'INSERT INTO ballot_rankings (ballot_id, rank, band_id) VALUES ($1, $2, $3)',
        [ballotId, i + 1, rankings[i]]
      );
    }
    await client.query('COMMIT');

    flash(req, 'success', 'Your rankings were saved and the composite has been updated.');
    res.redirect('/rankings');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

app.get('/account', requireAuth, (req, res) => res.render('account', { title: 'Account' }));

app.post('/account/password', requireAuth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    if (newPassword.length < 10) {
      flash(req, 'error', 'New password must be at least 10 characters.');
      return res.redirect('/account');
    }
    const q = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.user.id]);
    if (!q.rows[0] || !(await bcrypt.compare(currentPassword, q.rows[0].password_hash))) {
      flash(req, 'error', 'Current password is incorrect.');
      return res.redirect('/account');
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.user.id]);
    flash(req, 'success', 'Password updated.');
    res.redirect('/account');
  } catch (err) { next(err); }
});

app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const [bandsQ, usersQ, titleQ] = await Promise.all([
      pool.query(`
        SELECT b.id, b.name, b.city, b.state, b.active, b.created_at,
               COUNT(br.id)::int AS ranking_mentions
        FROM bands b
        LEFT JOIN ballot_rankings br ON br.band_id = b.id
        GROUP BY b.id
        ORDER BY b.active DESC, b.name ASC, b.state ASC, b.city ASC
      `),
      pool.query(`
        SELECT u.id, u.username, u.display_name, u.is_admin, u.active, u.created_at,
               CASE WHEN blt.id IS NULL THEN FALSE ELSE TRUE END AS has_ballot,
               blt.updated_at,
               COALESCE((SELECT COUNT(*)::int FROM ballot_rankings br WHERE br.ballot_id = blt.id), 0) AS ranked_count
        FROM users u
        LEFT JOIN ballots blt ON blt.user_id = u.id
        ORDER BY u.is_admin DESC, u.active DESC, u.display_name ASC
      `),
      pool.query("SELECT value FROM site_settings WHERE key = 'graphic_title' LIMIT 1")
    ]);
    const graphicTitle = String(titleQ.rows[0]?.value || 'BOA THINGS TOP 25').trim() || 'BOA THINGS TOP 25';
    res.render('admin', {
      title: 'Admin',
      bands: bandsQ.rows,
      accounts: usersQ.rows,
      graphicTitle
    });
  } catch (err) { next(err); }
});

app.post('/admin/settings/graphic-title', requireAdmin, async (req, res, next) => {
  try {
    const value = String(req.body.graphic_title || '').trim();
    if (value.length < 3 || value.length > 100) {
      flash(req, 'error', 'Graphic title must be between 3 and 100 characters.');
      return res.redirect('/admin#graphic-title');
    }
    await pool.query(`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ('graphic_title', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [value]);
    flash(req, 'success', 'Homepage graphic title updated.');
    res.redirect('/admin#graphic-title');
  } catch (err) { next(err); }
});

app.post('/admin/bands', requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const city = String(req.body.city || '').trim();
    const state = String(req.body.state || '').trim().toUpperCase();
    if (name.length < 2) {
      flash(req, 'error', 'Enter a school or band name.');
      return res.redirect('/admin#bands');
    }
    await pool.query(
      `INSERT INTO bands (name, city, state, active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT DO NOTHING`,
      [name, city, state]
    );
    flash(req, 'success', `${name} added.`);
    res.redirect('/admin#bands');
  } catch (err) { next(err); }
});

function parseBandImport(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = (line.includes('|') ? line.split('|') : line.split(',')).map(v => v.trim());
    const [name = '', city = '', state = ''] = parts;
    if (name.length >= 2) rows.push({ name, city, state: state.toUpperCase() });
  }
  return rows;
}

app.post('/admin/bands/import', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const rows = parseBandImport(req.body.band_list);
    if (!rows.length) {
      flash(req, 'error', 'Paste at least one band. Use School | City | State, one per line.');
      return res.redirect('/admin#bands');
    }
    await client.query('BEGIN');
    let added = 0;
    for (const row of rows) {
      const result = await client.query(
        `INSERT INTO bands (name, city, state, active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [row.name, row.city, row.state]
      );
      added += result.rowCount;
    }
    await client.query('COMMIT');
    flash(req, 'success', `${added} band${added === 1 ? '' : 's'} added. ${rows.length - added} duplicate${rows.length - added === 1 ? '' : 's'} skipped.`);
    res.redirect('/admin#bands');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

app.post('/admin/bands/:id/toggle', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid band id.');
    await pool.query('UPDATE bands SET active = NOT active WHERE id = $1', [id]);
    flash(req, 'success', 'Band status updated.');
    res.redirect('/admin#band-list');
  } catch (err) { next(err); }
});

app.post('/admin/users/:id/delete-ballot', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid user id.');
    const whoQ = await pool.query('SELECT display_name, username FROM users WHERE id = $1 LIMIT 1', [id]);
    if (!whoQ.rows[0]) {
      flash(req, 'error', 'Account not found.');
      return res.redirect('/admin#accounts');
    }
    const deleted = await pool.query('DELETE FROM ballots WHERE user_id = $1 RETURNING id', [id]);
    if (!deleted.rowCount) {
      flash(req, 'error', `${whoQ.rows[0].display_name} does not currently have a saved ballot.`);
      return res.redirect('/admin#accounts');
    }
    flash(req, 'success', `${whoQ.rows[0].display_name}'s ballot was deleted and removed from the composite.`);
    res.redirect('/admin#accounts');
  } catch (err) { next(err); }
});

app.post('/admin/users/:id/toggle', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await pool.query('UPDATE users SET active = NOT active WHERE id = $1 AND is_admin = FALSE', [id]);
    flash(req, 'success', 'Account status updated.');
    res.redirect('/admin#accounts');
  } catch (err) { next(err); }
});

app.post('/admin/users/:id/reset-password', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const password = String(req.body.password || '');
    if (password.length < 10) {
      flash(req, 'error', 'Temporary password must be at least 10 characters.');
      return res.redirect('/admin#accounts');
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 AND is_admin = FALSE', [hash, id]);
    flash(req, 'success', 'Password reset.');
    res.redirect('/admin#accounts');
  } catch (err) { next(err); }
});

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render('error', {
    title: 'Something went wrong',
    message: isProduction ? 'The server could not complete that request.' : err.message
  });
});

(async () => {
  try {
    await initDb(pool);
    app.listen(PORT, () => console.log(`Marching Band Poll listening on port ${PORT}`));
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();
