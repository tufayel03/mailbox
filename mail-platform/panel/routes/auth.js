const express = require("express");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const { requireGuest } = require("../middleware/auth");

module.exports = function createAuthRoutes({ pool, auditLog }) {
  const router = express.Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many login attempts. Try again later."
  });

  router.get("/login", requireGuest, (req, res) => {
    res.render("login", {
      pageTitle: "Admin Login"
    });
  });

  router.post("/login", requireGuest, loginLimiter, async (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!username || !password) {
      req.session.flash = { type: "error", message: "Username and password are required" };
      return res.redirect("/login");
    }

    try {
      const result = await pool.query(
        "SELECT id, username, password_hash FROM admin_users WHERE username = $1",
        [username]
      );

      if (result.rowCount === 0) {
        req.session.flash = { type: "error", message: "Invalid credentials" };
        await auditLog(pool, username, "login", "admin", username, "error", { reason: "user_not_found" });
        return res.redirect("/login");
      }

      const admin = result.rows[0];
      const matches = await bcrypt.compare(password, admin.password_hash);

      if (!matches) {
        req.session.flash = { type: "error", message: "Invalid credentials" };
        await auditLog(pool, username, "login", "admin", username, "error", { reason: "password_mismatch" });
        return res.redirect("/login");
      }

      req.session.user = {
        id: admin.id,
        username: admin.username
      };

      await auditLog(pool, admin.username, "login", "admin", admin.username, "success", {});
      req.session.flash = { type: "success", message: "Login successful" };
      return res.redirect("/domains");
    } catch (err) {
      req.session.flash = { type: "error", message: `Login failed: ${err.message}` };
      return res.redirect("/login");
    }
  });

  router.post("/logout", async (req, res) => {
    const actor = req.session.user ? req.session.user.username : "unknown";
    try {
      await auditLog(pool, actor, "logout", "admin", actor, "success", {});
    } catch (_) {
      // Ignore audit errors on logout.
    }
    req.session.destroy(() => {
      res.redirect("/login");
    });
  });

  return router;
};
