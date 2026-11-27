-- Entry features, recorded so future analysis can compare what winners and
-- rugs looked like at the moment we bought. Additive only.

ALTER TABLE pending_orders ADD COLUMN signal_liquidity REAL;

ALTER TABLE positions ADD COLUMN entry_score REAL;
ALTER TABLE positions ADD COLUMN entry_signal_liquidity REAL;   -- liquidity when the buy was decided
ALTER TABLE positions ADD COLUMN entry_age_minutes REAL;        -- pool age at fill
ALTER TABLE positions ADD COLUMN entry_fdv_usd REAL;
ALTER TABLE positions ADD COLUMN entry_volume_h1_usd REAL;
ALTER TABLE positions ADD COLUMN entry_buys_h1 INTEGER;
ALTER TABLE positions ADD COLUMN entry_sells_h1 INTEGER;
ALTER TABLE positions ADD COLUMN entry_change_m5_pct REAL;
ALTER TABLE positions ADD COLUMN entry_change_h1_pct REAL;
