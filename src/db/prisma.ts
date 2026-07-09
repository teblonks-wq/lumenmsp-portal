// NOTE: This app queries Postgres via the raw `pg` pool (see ./pool.ts), matching the
// LumenMSP Insights pattern. Prisma is used only as the schema + migration tool, not as a
// runtime client. If a Prisma Client is ever needed under Prisma 7, wire it up with the
// @prisma/adapter-pg driver adapter here. Intentionally left without a PrismaClient import.

export {};
