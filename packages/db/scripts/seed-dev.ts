import "dotenv/config";
import { databaseUrl, runtimeConfig } from "@reservation/shared";
import pg from "pg";

const { Client } = pg;

const ids = {
  restaurant: "10000000-0000-4000-8000-000000000001",
  tables: [
    "20000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
    "20000000-0000-4000-8000-000000000003",
    "20000000-0000-4000-8000-000000000004",
  ],
  combinationTwo: "30000000-0000-4000-8000-000000000001",
  combinationThree: "30000000-0000-4000-8000-000000000002",
  specialDate: "40000000-0000-4000-8000-000000000001",
  policy: "50000000-0000-4000-8000-000000000001",
  schedule: "60000000-0000-4000-8000-000000000001",
} as const;

async function main(): Promise<void> {
  const config = runtimeConfig();
  const url = new URL(databaseUrl());
  if (config.APP_ENV !== "development" || !url.pathname.endsWith("_dev")) {
    throw new Error("Development seed requires APP_ENV=development and a database ending in _dev");
  }

  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO restaurants (id, name, timezone, currency, default_locale)
       VALUES ($1, '서울아저씨 개발 매장', 'Asia/Taipei', 'TWD', 'zh-TW')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         timezone = EXCLUDED.timezone,
         currency = EXCLUDED.currency,
         default_locale = EXCLUDED.default_locale`,
      [ids.restaurant],
    );

    const tableFixtures = [
      [ids.tables[0], "T01", 2, 2, "1층 A구역"],
      [ids.tables[1], "T02", 4, 4, "1층 A구역"],
      [ids.tables[2], "T03", 4, 6, "1층 B구역"],
      [ids.tables[3], "T04", 4, 6, "1층 B구역"],
    ] as const;
    for (const [id, name, defaultSeats, maxSeats, zone] of tableFixtures) {
      await client.query(
        `INSERT INTO dining_tables (id, restaurant_id, name, default_seats, max_seats, zone)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           default_seats = EXCLUDED.default_seats,
           max_seats = EXCLUDED.max_seats,
           zone = EXCLUDED.zone`,
        [id, ids.restaurant, name, defaultSeats, maxSeats, zone],
      );
    }

    await client.query(
      `INSERT INTO table_combinations (id, restaurant_id, name, max_seats)
       VALUES ($1, $3, 'T01 + T02', 6), ($2, $3, 'T02 + T03 + T04', 12)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, max_seats = EXCLUDED.max_seats`,
      [ids.combinationTwo, ids.combinationThree, ids.restaurant],
    );
    await client.query(
      `INSERT INTO table_combination_members (combination_id, table_id, restaurant_id, position)
       VALUES
         ($1, $3, $7, 1), ($1, $4, $7, 2),
         ($2, $4, $7, 1), ($2, $5, $7, 2), ($2, $6, $7, 3)
       ON CONFLICT (combination_id, table_id) DO UPDATE SET position = EXCLUDED.position`,
      [ids.combinationTwo, ids.combinationThree, ...ids.tables, ids.restaurant],
    );

    await client.query(
      `INSERT INTO business_hours (restaurant_id, weekday, opens_at, closes_at, closes_day_offset)
       VALUES
         ($1, 1, '11:30', '14:30', 0),
         ($1, 1, '17:00', '21:30', 0),
         ($1, 5, '22:00', '02:00', 1)
       ON CONFLICT (restaurant_id, weekday, opens_at) DO UPDATE SET
         closes_at = EXCLUDED.closes_at,
         closes_day_offset = EXCLUDED.closes_day_offset`,
      [ids.restaurant],
    );
    await client.query(
      `INSERT INTO special_business_dates (id, restaurant_id, business_date, kind, reason)
       VALUES ($1, $2, DATE '2030-01-01', 'CLOSED', '개발 fixture 임시휴무')
       ON CONFLICT (restaurant_id, business_date) DO UPDATE SET kind = EXCLUDED.kind, reason = EXCLUDED.reason`,
      [ids.specialDate, ids.restaurant],
    );

    await client.query(
      `INSERT INTO policy_versions (id, restaurant_id, version, status, published_at)
       VALUES ($1, $2, 1, 'PUBLISHED', CURRENT_TIMESTAMP)
       ON CONFLICT (restaurant_id, version) DO NOTHING`,
      [ids.policy, ids.restaurant],
    );
    await client.query(
      `INSERT INTO policy_schedules (id, restaurant_id, policy_version_id, valid_during)
       VALUES ($1, $2, $3, daterange(DATE '2026-01-01', NULL, '[)'))
       ON CONFLICT (id) DO NOTHING`,
      [ids.schedule, ids.restaurant, ids.policy],
    );
    await client.query(
      `INSERT INTO reservation_policy_rules
         (policy_version_id, rule_type, priority, duration_minutes, value)
       SELECT $1, 'DURATION', 0, 90, '{"description":"개발 fixture 기본 이용시간"}'::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM reservation_policy_rules
         WHERE policy_version_id = $1 AND rule_type = 'DURATION' AND priority = 0
       )`,
      [ids.policy],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ seeded: true, restaurantId: ids.restaurant, tableCount: ids.tables.length }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown seed error";
  console.error(message);
  process.exitCode = 1;
});
