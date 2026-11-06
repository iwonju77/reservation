import { createDatabasePool, type DatabasePool } from "@reservation/db";

const globalDatabase = globalThis as typeof globalThis & { reservationDatabase?: DatabasePool };

export const database = globalDatabase.reservationDatabase ?? createDatabasePool();

if (process.env.NODE_ENV !== "production") globalDatabase.reservationDatabase = database;
