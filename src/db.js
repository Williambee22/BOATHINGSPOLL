const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const seedBands = require('./bands');

function makePool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Add a Railway PostgreSQL service and link it to this app.');
  }

  const ssl = String(process.env.DB_SSL || '').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : false;

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000
  });
}

async function initDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique
      ON users ((LOWER(username)));

    CREATE TABLE IF NOT EXISTS bands (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      city VARCHAR(100) NOT NULL DEFAULT '',
      state VARCHAR(40) NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS bands_identity_unique
      ON bands ((LOWER(name)), (LOWER(city)), (UPPER(state)));

    CREATE TABLE IF NOT EXISTS ballots (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ballot_rankings (
      id BIGSERIAL PRIMARY KEY,
      ballot_id BIGINT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL CONSTRAINT ballot_rankings_rank_positive_check CHECK (rank >= 1),
      band_id BIGINT NOT NULL REFERENCES bands(id),
      UNIQUE (ballot_id, rank),
      UNIQUE (ballot_id, band_id)
    );

    CREATE INDEX IF NOT EXISTS ballot_rankings_ballot_idx
      ON ballot_rankings (ballot_id);

    CREATE INDEX IF NOT EXISTS ballot_rankings_band_idx
      ON ballot_rankings (band_id);

    CREATE TABLE IF NOT EXISTS site_settings (
      key VARCHAR(80) PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Older releases limited rankings to 1-25 at the database level.
  // Remove that legacy cap and replace it with a positive-rank constraint.
  await pool.query(`
    ALTER TABLE ballot_rankings
      DROP CONSTRAINT IF EXISTS ballot_rankings_rank_check;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ballot_rankings_rank_positive_check'
          AND conrelid = 'ballot_rankings'::regclass
      ) THEN
        ALTER TABLE ballot_rankings
          ADD CONSTRAINT ballot_rankings_rank_positive_check CHECK (rank >= 1);
      END IF;
    END
    $$;
  `);

  for (const band of seedBands) {
    await pool.query(
      `INSERT INTO bands (name, city, state, active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT DO NOTHING`,
      [
        String(band.name || '').trim(),
        String(band.city || '').trim(),
        String(band.state || '').trim().toUpperCase()
      ]
    );
  }

  await pool.query(`
    INSERT INTO site_settings (key, value)
    VALUES
      ('graphic_title', 'BOA THINGS TOP 25'),
      ('poll_size', '25')
    ON CONFLICT (key) DO NOTHING
  `);

  await ensureAdmin(pool);
}

async function ensureAdmin(pool) {
  const existing = await pool.query(
    'SELECT id, username FROM users WHERE is_admin = TRUE ORDER BY id ASC LIMIT 1'
  );

  if (existing.rows[0]) return existing.rows[0];

  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password =
    process.env.ADMIN_PASSWORD || 'ChangeMeImmediately123!';
  const displayName =
    (process.env.ADMIN_DISPLAY_NAME || 'Poll Administrator').trim();

  if (!process.env.ADMIN_PASSWORD) {
    console.warn(
      'WARNING: ADMIN_PASSWORD is not set. Set it in Railway before public use.'
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await pool.query(
    `INSERT INTO users (
      username,
      display_name,
      password_hash,
      is_admin,
      active
    )
    VALUES ($1, $2, $3, TRUE, TRUE)
    RETURNING id, username`,
    [username, displayName, passwordHash]
  );

  return result.rows[0];
}

async function getResults(pool, pollSize = 25) {
  const size =
    Math.max(1, Number.parseInt(pollSize, 10) || 25);

  const result = await pool.query(`
    SELECT
      bnd.id,
      bnd.name,
      bnd.city,
      bnd.state,
      SUM(($1::int + 1) - br.rank)::int AS points,
      COUNT(*) FILTER (WHERE br.rank = 1)::int AS first_place_votes,
      COUNT(*)::int AS ballot_mentions
    FROM ballot_rankings br
    JOIN ballots blt
      ON blt.id = br.ballot_id
    JOIN users u
      ON u.id = blt.user_id
      AND u.active = TRUE
    JOIN bands bnd
      ON bnd.id = br.band_id
    WHERE bnd.active = TRUE
      AND br.rank <= $1
    GROUP BY
      bnd.id,
      bnd.name,
      bnd.city,
      bnd.state
    ORDER BY
      points DESC,
      first_place_votes DESC,
      bnd.name ASC
  `, [size]);

  let lastPoints = null;
  let lastRank = 0;

  return result.rows.map((row, index) => {
    const points = Number(row.points);

    if (
      lastPoints === null ||
      points !== lastPoints
    ) {
      lastRank = index + 1;
      lastPoints = points;
    }

    return {
      ...row,
      points,
      first_place_votes:
        Number(row.first_place_votes),
      ballot_mentions:
        Number(row.ballot_mentions),
      rank: lastRank
    };
  });
}

module.exports = {
  makePool,
  initDb,
  getResults
};
