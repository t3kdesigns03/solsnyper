-- Feature store for prediction work. Additive only.
--   candidate_snapshots: every ~3 min, the market features of each tracked coin
--                        (traded or not). Forward returns / rugs are computed
--                        later from this time series (worker/scripts/analyze.ts).
--   watchlist:           coins we keep pricing after first sight, so their
--                        outcome can be measured (sniper ~70 min, stable ~4h).
--   token_risk:          RugCheck summary per mint, fetched once (cache).

CREATE TABLE IF NOT EXISTS candidate_snapshots (
  lane         TEXT NOT NULL,
  mint         TEXT NOT NULL,
  t            INTEGER NOT NULL,          -- tick time, unix ms
  symbol       TEXT,
  dex_id       TEXT,
  source       TEXT,
  price        REAL,
  liquidity    REAL,
  fdv          REAL,
  vol_m5       REAL,
  vol_h1       REAL,
  vol_h6       REAL,
  vol_h24      REAL,
  buys_m5      INTEGER,
  sells_m5     INTEGER,
  buys_h1      INTEGER,
  sells_h1     INTEGER,
  buyers_h1    INTEGER,
  sellers_h1   INTEGER,
  chg_m5       REAL,
  chg_h1       REAL,
  chg_h6       REAL,
  chg_h24      REAL,
  age_min      REAL,
  score        REAL,
  verdict      TEXT,                      -- pass | reject | watch (no longer a candidate, still tracked)
  reason       TEXT,
  PRIMARY KEY (lane, mint, t)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_t ON candidate_snapshots(t);

CREATE TABLE IF NOT EXISTS watchlist (
  lane         TEXT NOT NULL,
  mint         TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  until        INTEGER NOT NULL,          -- keep pricing until this time
  PRIMARY KEY (lane, mint)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_until ON watchlist(until);

CREATE TABLE IF NOT EXISTS token_risk (
  mint             TEXT PRIMARY KEY,
  fetched_at       INTEGER NOT NULL,
  score            REAL,
  score_normalised REAL,
  lp_locked_pct    REAL,
  risks            TEXT                   -- JSON [{name, level}]
);
