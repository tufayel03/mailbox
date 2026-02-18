require("dotenv").config();
const { createPool, initDatabase, ensureAdminUser } = require("../db");

(async () => {
  const pool = createPool();
  try {
    await initDatabase(pool);
    const adminResult = await ensureAdminUser(pool);
    if (adminResult.created) {
      console.log(`Created admin user: ${adminResult.username}`);
    } else {
      console.log(`Admin user already present: ${adminResult.username}`);
    }
    console.log("Database initialization complete");
    process.exit(0);
  } catch (err) {
    console.error("Database initialization failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();