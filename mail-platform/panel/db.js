const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");

function createPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const useSsl = (process.env.PGSSLMODE || "disable").toLowerCase() === "require";

  return new Pool({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined
  });
}

async function initDatabase(pool) {
  const sqlPath = path.join(__dirname, "db.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
}

async function ensureAdminUser(pool) {
  const username = process.env.ADMIN_USER || "admin";
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    throw new Error("ADMIN_PASSWORD is required");
  }

  const existing = await pool.query(
    "SELECT id, username FROM admin_users ORDER BY id ASC LIMIT 1"
  );

  if (existing.rowCount === 0) {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      "INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)",
      [username, hash]
    );
    return { created: true, username };
  }

  return { created: false, username: existing.rows[0].username };
}

async function auditLog(pool, actor, action, targetType, targetId, status, details = {}) {
  await pool.query(
    `INSERT INTO audit_logs (actor, action, target_type, target_id, status, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actor, action, targetType, targetId, status, JSON.stringify(details)]
  );
}

module.exports = {
  createPool,
  initDatabase,
  ensureAdminUser,
  auditLog
};