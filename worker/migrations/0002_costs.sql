-- Realistic trading costs + delayed fills. Additive only: no columns dropped or renamed.
-- Money is USD. "signal" price = observed price when the decision was made;
-- entry_price / exit_price are now the FILL prices (after slippage).

ALTER TABLE positions ADD COLUMN dex_id TEXT;
ALTER TABLE positions ADD COLUMN entry_signal_price REAL;
ALTER TABLE positions ADD COLUMN entry_dex_fee_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN entry_network_fee_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN entry_slippage_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN exit_signal_price REAL;
ALTER TABLE positions ADD COLUMN exit_dex_fee_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN exit_network_fee_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN exit_slippage_usd REAL NOT NULL DEFAULT 0;

ALTER TABLE trades ADD COLUMN signal_price REAL;
ALTER TABLE trades ADD COLUMN dex_fee_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN network_fee_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN slippage_usd REAL NOT NULL DEFAULT 0;

-- Rows from the old flat-fee model: their fee was a flat 0.4% per leg. Count it
-- as a DEX fee so cost totals stay complete.
UPDATE trades SET dex_fee_usd = fees_usd WHERE signal_price IS NULL;
UPDATE positions SET entry_dex_fee_usd = entry_fee_usd WHERE entry_signal_price IS NULL;

-- Orders decided on one tick and filled on a later one (CONFIG.costs.fillDelayTicks).
CREATE TABLE IF NOT EXISTS pending_orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  side             TEXT NOT NULL CHECK (side IN ('buy','sell')),
  mint             TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  position_id      INTEGER,               -- sells only
  signal_price     REAL NOT NULL,
  signal_time      INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  score            REAL,
  ticks_waited     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pending_side ON pending_orders(side);
