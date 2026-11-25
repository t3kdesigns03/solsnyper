-- SolSnyper paper-trading schema. Everything here is SIMULATED.
-- Money columns are USD unless the name says otherwise. Timestamps are unix ms.

CREATE TABLE IF NOT EXISTS wallet (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  cash_sol         REAL NOT NULL,          -- cash shown in SOL (cash_usd / sol_price_usd)
  cash_usd         REAL NOT NULL,          -- source of truth for cash
  equity_usd       REAL NOT NULL,          -- cash + marked-to-market open positions (net of est. exit fee)
  starting_equity  REAL NOT NULL,
  sol_price_usd    REAL NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

INSERT OR IGNORE INTO wallet (id, cash_sol, cash_usd, equity_usd, starting_equity, sol_price_usd, updated_at)
VALUES (1, 0, 1000, 1000, 1000, 0, 0);

CREATE TABLE IF NOT EXISTS positions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  mint             TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  pair_address     TEXT,
  entry_price      REAL NOT NULL,
  entry_time       INTEGER NOT NULL,
  size_usd         REAL NOT NULL,          -- USD spent on tokens (excl. entry fee)
  quantity         REAL NOT NULL,          -- tokens held = size_usd / entry_price
  entry_fee_usd    REAL NOT NULL,
  entry_liquidity  REAL NOT NULL,
  current_price    REAL NOT NULL,
  current_liquidity REAL,
  peak_price       REAL NOT NULL,          -- highest price seen while open (for give-back rule)
  unrealized_pnl   REAL NOT NULL DEFAULT 0,
  missed_updates   INTEGER NOT NULL DEFAULT 0,
  last_update      INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open','closed')),
  exit_price       REAL,
  exit_time        INTEGER,
  realized_pnl     REAL,
  close_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);

CREATE TABLE IF NOT EXISTS trades (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id      INTEGER,
  mint             TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('buy','sell')),
  price            REAL NOT NULL,
  size_usd         REAL NOT NULL,
  fees_usd         REAL NOT NULL,
  pnl_usd          REAL NOT NULL DEFAULT 0, -- on sells: net of BOTH legs' fees
  reason           TEXT NOT NULL,
  timestamp        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(timestamp);

CREATE TABLE IF NOT EXISTS candidates (
  mint             TEXT PRIMARY KEY,
  symbol           TEXT NOT NULL,
  source           TEXT NOT NULL,
  pair_address     TEXT,
  dex_id           TEXT,
  liquidity        REAL,
  volume           REAL,                   -- h1 volume USD
  age_minutes      REAL,
  price            REAL,
  flagged          INTEGER NOT NULL DEFAULT 0, -- 1 = passed filters
  reject_reason    TEXT,
  score            REAL,
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_last_seen ON candidates(last_seen);

CREATE TABLE IF NOT EXISTS decisions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  mint             TEXT NOT NULL,
  action           TEXT NOT NULL,          -- buy | reject | skip | sell | error
  reason           TEXT NOT NULL,
  score            REAL,
  timestamp        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(timestamp);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  timestamp        INTEGER PRIMARY KEY,
  equity_usd       REAL NOT NULL,
  cash_usd         REAL NOT NULL,
  open_positions   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at       INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  candidates_seen  INTEGER NOT NULL,
  buys             INTEGER NOT NULL,
  sells            INTEGER NOT NULL,
  errors           TEXT
);
