-- Gates Down NYC — Cloudflare D1 Schema
-- Stores community Street Truth observations, wishlist votes, and auto-sync snapshots.

CREATE TABLE IF NOT EXISTS street_truth (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    normalized_address TEXT NOT NULL,
    street_name TEXT,
    zip_code TEXT,
    borough TEXT DEFAULT 'MANHATTAN',
    nta_code TEXT,
    nta_name TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    bbl TEXT,
    former_business TEXT,
    tag TEXT NOT NULL, -- padlock_smoke, dead_bank, for_lease_forever, papered_over, rip_favorite, other
    wishlist TEXT,     -- bagels, bookshop, diner, coffee, hardware, green_grocer, anything_not_vape
    note TEXT,
    dof_claimed_status TEXT, -- e.g. 'OCCUPIED', 'UNREPORTED', 'VACANT'
    corroborations INTEGER NOT NULL DEFAULT 1,
    wishlist_votes INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reporter_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_street_truth_zip ON street_truth(zip_code);
CREATE INDEX IF NOT EXISTS idx_street_truth_nta ON street_truth(nta_code);
CREATE INDEX IF NOT EXISTS idx_street_truth_created ON street_truth(created_at DESC);

CREATE TABLE IF NOT EXISTS wishlist_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    truth_id TEXT NOT NULL,
    wish TEXT NOT NULL,
    voter_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (truth_id) REFERENCES street_truth(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wishlist_truth ON wishlist_votes(truth_id);

CREATE TABLE IF NOT EXISTS sync_cache (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    source_quarter TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed starter Street Truth observations in Chelsea so visitors immediately see the Reality Gap in action
INSERT OR IGNORE INTO street_truth (
    id, address, normalized_address, street_name, zip_code, borough, nta_code, nta_name,
    lat, lng, bbl, former_business, tag, wishlist, note, dof_claimed_status, corroborations, wishlist_votes
) VALUES
(
    'seed-w15-weed',
    '218 West 15th Street',
    '218 WEST 15 STREET',
    'WEST 15 STREET',
    '10011',
    'MANHATTAN',
    'MN0401',
    'Chelsea-Hudson Yards',
    40.73978,
    -73.99998,
    '1007640048',
    'Unlicensed Smoke & Weed Shop (200 Block W 15th)',
    'padlock_smoke',
    'bookshop',
    'Former illegal weed shop on the 200 block of W 15th St (near 214 W 15th). Shut down & sitting empty — yet DOF 2025 landlord filings report 0 vacancies on this entire block!',
    'UNREPORTED / 0% ON BLOCK',
    14,
    9
),
(
    'seed-8ave-17',
    '142 8th Avenue',
    '142 8 AVENUE',
    '8 AVENUE',
    '10011',
    'MANHATTAN',
    'MN0401',
    'Chelsea-Hudson Yards',
    40.74172,
    -74.00051,
    '1007670001',
    'Former Retail / Vacant Gate on 8th Ave (16th–19th St Corridor)',
    'for_lease_forever',
    'diner',
    'Part of the noticeable cluster of rolled-down shutters walking north up 8th Ave from 15th St — DOF filings only show 3.8% vacant along 8th Ave in 10011, vastly undercounting what neighbors pass every day.',
    'LANDLORD REPORTED OCCUPIED',
    11,
    7
),
(
    'seed-w14-202',
    '202 West 14th Street',
    '202 WEST 14 STREET',
    'WEST 14 STREET',
    '10011',
    'MANHATTAN',
    'MN0401',
    'Chelsea-Hudson Yards',
    40.73862,
    -74.00025,
    '1007630042',
    'Corner Retail Near 7th–8th Ave',
    'papered_over',
    'bagels',
    'Confirmed vacant in 2025 DOF filings (part of West 14th St''s 19.0% vacancy rate in 10011). Papered-over corner right by the 14th St subway hub.',
    'DOF CONFIRMED VACANT',
    8,
    12
);
