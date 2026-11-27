-- Lanes: separately tracked paper wallets running side by side ("sniper" =
-- brand-new pools, "stable" = established pools). Additive only: existing rows
-- become the sniper lane; the sniper keeps the `wallet` / `equity_snapshots`
-- tables, other lanes use `lane_wallets` / `lane_equity`.

ALTER TABLE positions ADD COLUMN lane TEXT NOT NULL DEFAULT 'sniper';
ALTER TABLE trades ADD COLUMN lane TEXT NOT NULL DEFAULT 'sniper';
ALTER TABLE decisions ADD COLUMN lane TEXT NOT NULL DEFAULT 'sniper';
ALTER TABLE pending_orders ADD COLUMN lane TEXT NOT NULL DEFAULT 'sniper';
ALTER TABLE candidates ADD COLUMN lane TEXT NOT NULL DEFAULT 'sniper';
ALTER TABLE runs ADD COLUMN lane TEXT NOT NULL DEFAULT 'sniper';

CREATE INDEX IF NOT EXISTS idx_positions_lane ON positions(lane, status);
CREATE INDEX IF NOT EXISTS idx_trades_lane ON trades(lane, timestamp);
CREATE INDEX IF NOT EXISTS idx_decisions_lane ON decisions(lane, id);

CREATE TABLE IF NOT EXISTS lane_wallets (
  lane             TEXT PRIMARY KEY,
  cash_usd         REAL NOT NULL,
  equity_usd       REAL NOT NULL,
  starting_equity  REAL NOT NULL,
  updated_at       INTEGER NOT NULL
);
INSERT OR IGNORE INTO lane_wallets (lane, cash_usd, equity_usd, starting_equity, updated_at) VALUES ('stable', 10000, 10000, 10000, 0);

CREATE TABLE IF NOT EXISTS lane_equity (
  lane             TEXT NOT NULL,
  timestamp        INTEGER NOT NULL,
  equity_usd       REAL NOT NULL,
  cash_usd         REAL NOT NULL,
  open_positions   INTEGER NOT NULL,
  PRIMARY KEY (lane, timestamp)
);
