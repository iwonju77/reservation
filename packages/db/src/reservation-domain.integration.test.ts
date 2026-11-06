import "dotenv/config";
import { randomUUID } from "node:crypto";
import { databaseUrl } from "@reservation/shared";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { Client } = pg;

type Fixture = {
  restaurantId: string;
  tableIds: [string, string, string];
};

let client: InstanceType<typeof Client>;
let fixture: Fixture;

async function createFixture(): Promise<Fixture> {
  const restaurantId = randomUUID();
  const tableIds: Fixture["tableIds"] = [randomUUID(), randomUUID(), randomUUID()];
  await client.query(
    `INSERT INTO restaurants (id, name, timezone, currency)
     VALUES ($1, $2, 'Asia/Taipei', 'TWD')`,
    [restaurantId, `integration-${restaurantId}`],
  );
  for (const [index, tableId] of tableIds.entries()) {
    await client.query(
      `INSERT INTO dining_tables
         (id, restaurant_id, name, default_seats, max_seats)
       VALUES ($1, $2, $3, 4, 4)`,
      [tableId, restaurantId, `T${index + 1}`],
    );
  }
  return { restaurantId, tableIds };
}

async function createReservation(overrides: Partial<{
  restaurantId: string;
  partySize: number;
  startsAt: string;
  endsAt: string;
}> = {}): Promise<string> {
  const id = randomUUID();
  const restaurantId = overrides.restaurantId ?? fixture.restaurantId;
  const partySize = overrides.partySize ?? 4;
  await client.query(
    `INSERT INTO reservations
       (id, restaurant_id, reservation_number, source, status, business_date,
        starts_at, ends_at, party_size, seat_count, chargeable_party_size)
     VALUES ($1, $2, $3, 'STAFF', 'CONFIRMED', DATE '2026-11-10',
             $4::timestamptz, $5::timestamptz, $6, $6, $6)`,
    [
      id,
      restaurantId,
      `R-${randomUUID().slice(0, 8)}`,
      overrides.startsAt ?? "2026-11-10T10:00:00.000Z",
      overrides.endsAt ?? "2026-11-10T11:30:00.000Z",
      partySize,
    ],
  );
  return id;
}

function postgresCode(reason: unknown): string | undefined {
  return typeof reason === "object" && reason !== null && "code" in reason
    ? String(reason.code)
    : undefined;
}

beforeEach(async () => {
  client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  fixture = await createFixture();
});

afterEach(async () => {
  await client.query("DELETE FROM table_occupancies WHERE restaurant_id = $1", [fixture.restaurantId]);
  await client.query("DELETE FROM reservations WHERE restaurant_id = $1", [fixture.restaurantId]);
  await client.query("DELETE FROM restaurants WHERE id = $1", [fixture.restaurantId]);
  await client.end();
});

describe("reservation domain constraints", () => {
  it("allows exactly one of ten concurrent allocations for the last table", async () => {
    const reservationIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      reservationIds.push(await createReservation());
    }
    const attempts = await Promise.all(reservationIds.map(async (reservationId) => {
      const connection = new Client({ connectionString: databaseUrl() });
      await connection.connect();
      try {
        await connection.query(
          `INSERT INTO reservation_allocations
             (restaurant_id, reservation_id, table_id, occupied_period)
           VALUES ($1, $2, $3, tstzrange($4, $5, '[)'))`,
          [
            fixture.restaurantId,
            reservationId,
            fixture.tableIds[0],
            "2026-11-10T10:00:00.000Z",
            "2026-11-10T11:45:00.000Z",
          ],
        );
        return "success";
      } catch (error) {
        return postgresCode(error) ?? "unknown";
      } finally {
        await connection.end().catch(() => undefined);
      }
    }));

    expect(attempts.filter((result) => result === "success")).toHaveLength(1);
    expect(attempts.filter((result) => result === "23P01")).toHaveLength(9);
  });

  it("blocks a single-table booking that overlaps a combined-table allocation", async () => {
    const combinedReservation = await createReservation();
    const singleReservation = await createReservation();
    for (const tableId of fixture.tableIds.slice(0, 2)) {
      await client.query(
        `INSERT INTO reservation_allocations
           (restaurant_id, reservation_id, table_id, occupied_period)
         VALUES ($1, $2, $3, tstzrange($4, $5, '[)'))`,
        [
          fixture.restaurantId,
          combinedReservation,
          tableId,
          "2026-11-10T10:00:00.000Z",
          "2026-11-10T11:45:00.000Z",
        ],
      );
    }

    await expect(client.query(
      `INSERT INTO reservation_allocations
         (restaurant_id, reservation_id, table_id, occupied_period)
       VALUES ($1, $2, $3, tstzrange($4, $5, '[)'))`,
      [
        fixture.restaurantId,
        singleReservation,
        fixture.tableIds[0],
        "2026-11-10T11:00:00.000Z",
        "2026-11-10T12:00:00.000Z",
      ],
    )).rejects.toMatchObject({ code: "23P01" });
  });

  it("allows a boundary-touching booking and reuses a released allocation", async () => {
    const first = await createReservation();
    const boundary = await createReservation({ startsAt: "2026-11-10T11:45:00.000Z", endsAt: "2026-11-10T12:45:00.000Z" });
    const replacement = await createReservation();
    const allocation = await client.query<{ id: string }>(
      `INSERT INTO reservation_allocations
         (restaurant_id, reservation_id, table_id, occupied_period)
       VALUES ($1, $2, $3, tstzrange($4, $5, '[)')) RETURNING id`,
      [fixture.restaurantId, first, fixture.tableIds[0], "2026-11-10T10:00:00.000Z", "2026-11-10T11:45:00.000Z"],
    );
    await expect(client.query(
      `INSERT INTO reservation_allocations
         (restaurant_id, reservation_id, table_id, occupied_period)
       VALUES ($1, $2, $3, tstzrange($4, $5, '[)'))`,
      [fixture.restaurantId, boundary, fixture.tableIds[0], "2026-11-10T11:45:00.000Z", "2026-11-10T12:45:00.000Z"],
    )).resolves.toBeDefined();

    await client.query("UPDATE reservation_allocations SET released_at = CURRENT_TIMESTAMP WHERE id = $1", [allocation.rows[0]?.id]);
    await expect(client.query(
      `INSERT INTO reservation_allocations
         (restaurant_id, reservation_id, table_id, occupied_period)
       VALUES ($1, $2, $3, tstzrange($4, $5, '[)'))`,
      [fixture.restaurantId, replacement, fixture.tableIds[0], "2026-11-10T10:00:00.000Z", "2026-11-10T11:45:00.000Z"],
    )).resolves.toBeDefined();
  });

  it("rejects invalid party sizes and cross-restaurant allocations", async () => {
    await expect(createReservation({ partySize: 0 })).rejects.toMatchObject({ code: "23514" });

    const otherRestaurantId = randomUUID();
    const otherTableId = randomUUID();
    await client.query(
      `INSERT INTO restaurants (id, name, timezone, currency)
       VALUES ($1, $2, 'Asia/Taipei', 'TWD')`,
      [otherRestaurantId, `integration-${otherRestaurantId}`],
    );
    await client.query(
      `INSERT INTO dining_tables (id, restaurant_id, name, default_seats, max_seats)
       VALUES ($1, $2, 'OTHER', 4, 4)`,
      [otherTableId, otherRestaurantId],
    );
    const reservation = await createReservation();
    await expect(client.query(
      `INSERT INTO reservation_allocations
         (restaurant_id, reservation_id, table_id, occupied_period)
       VALUES ($1, $2, $3, tstzrange($4, $5, '[)'))`,
      [fixture.restaurantId, reservation, otherTableId, "2026-11-10T10:00:00.000Z", "2026-11-10T11:45:00.000Z"],
    )).rejects.toMatchObject({ code: "23503" });
    await client.query("DELETE FROM restaurants WHERE id = $1", [otherRestaurantId]);
  });

  it("allows only one active seating per physical table", async () => {
    const first = await createReservation();
    const second = await createReservation();
    await client.query(
      `INSERT INTO table_occupancies (restaurant_id, reservation_id, table_id, seated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [fixture.restaurantId, first, fixture.tableIds[1]],
    );
    await expect(client.query(
      `INSERT INTO table_occupancies (restaurant_id, reservation_id, table_id, seated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [fixture.restaurantId, second, fixture.tableIds[1]],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("prevents overlapping policy schedules and preserves publication time on retirement", async () => {
    const firstPolicy = randomUUID();
    const secondPolicy = randomUUID();
    await client.query(
      `INSERT INTO policy_versions
         (id, restaurant_id, version, status, published_at)
       VALUES
         ($1, $3, 1, 'PUBLISHED', CURRENT_TIMESTAMP),
         ($2, $3, 2, 'PUBLISHED', CURRENT_TIMESTAMP)`,
      [firstPolicy, secondPolicy, fixture.restaurantId],
    );
    await client.query(
      `INSERT INTO policy_schedules (restaurant_id, policy_version_id, valid_during)
       VALUES ($1, $2, daterange(DATE '2026-11-01', DATE '2026-12-01', '[)'))`,
      [fixture.restaurantId, firstPolicy],
    );
    await expect(client.query(
      `INSERT INTO policy_schedules (restaurant_id, policy_version_id, valid_during)
       VALUES ($1, $2, daterange(DATE '2026-11-15', DATE '2026-12-15', '[)'))`,
      [fixture.restaurantId, secondPolicy],
    )).rejects.toMatchObject({ code: "23P01" });

    await expect(client.query(
      "UPDATE policy_versions SET status = 'RETIRED' WHERE id = $1",
      [firstPolicy],
    )).resolves.toBeDefined();
  });
});
