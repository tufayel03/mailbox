const express = require("express");
const bcrypt = require("bcrypt");
const { loadRelaySettings, saveRelaySettings, applyRelaySettings } = require("../relayConfig");

module.exports = function createSecurityRoutes({ pool, worker, auditLog }) {
  const router = express.Router();

  router.get("/security/events", async (req, res) => {
    try {
      const eventsResult = await pool.query(
        `SELECT user_email, bucket_name, action, source, event_time, warned_at, disabled_at
           FROM rate_limit_events
          ORDER BY event_time DESC
          LIMIT 200`
      );

      const stateResult = await pool.query(
        `SELECT email, status, warn_count, last_warn_at, disabled_at, updated_at
           FROM mailbox_state
          ORDER BY updated_at DESC
          LIMIT 200`
      );
      const relaySettings = await loadRelaySettings(pool);

      res.render("security", {
        pageTitle: "Security Events",
        events: eventsResult.rows,
        mailboxStates: stateResult.rows,
        relaySettings: {
          relay_host: relaySettings.relay_host || "",
          relay_port: relaySettings.relay_port || 587,
          relay_user: relaySettings.relay_user || "",
          enabled: Boolean(relaySettings.enabled),
          hasPassword: Boolean(relaySettings.relay_password),
          updated_by: relaySettings.updated_by || "system",
          updated_at: relaySettings.updated_at || null
        }
      });
    } catch (err) {
      req.session.flash = { type: "error", message: `Failed to load security view: ${err.message}` };
      res.render("security", {
        pageTitle: "Security Events",
        events: [],
        mailboxStates: [],
        relaySettings: {
          relay_host: "",
          relay_port: 587,
          relay_user: "",
          enabled: false,
          hasPassword: false,
          updated_by: "system",
          updated_at: null
        }
      });
    }
  });

  router.post("/security/check-now", async (req, res) => {
    try {
      const result = await worker.runOnce();
      req.session.flash = { type: "success", message: `Worker run complete. Processed: ${result.processed || 0}` };
      return res.redirect("/security/events");
    } catch (err) {
      req.session.flash = { type: "error", message: `Worker run failed: ${err.message}` };
      return res.redirect("/security/events");
    }
  });

  router.post("/security/admin-password", async (req, res) => {
    const actor = req.session.user ? req.session.user.username : "unknown";
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    if (!currentPassword || !newPassword || !confirmPassword) {
      req.session.flash = { type: "error", message: "All password fields are required" };
      return res.redirect("/security/events");
    }

    if (newPassword.length < 8) {
      req.session.flash = { type: "error", message: "New password must be at least 8 characters" };
      return res.redirect("/security/events");
    }

    if (newPassword !== confirmPassword) {
      req.session.flash = { type: "error", message: "New password and confirm password do not match" };
      return res.redirect("/security/events");
    }

    if (newPassword === currentPassword) {
      req.session.flash = { type: "error", message: "New password must be different from current password" };
      return res.redirect("/security/events");
    }

    try {
      const adminResult = await pool.query(
        "SELECT id, password_hash FROM admin_users WHERE username = $1",
        [actor]
      );

      if (adminResult.rowCount === 0) {
        req.session.flash = { type: "error", message: "Admin account not found" };
        if (typeof auditLog === "function") {
          await auditLog(pool, actor, "admin_password_change", "admin", actor, "error", { reason: "admin_not_found" });
        }
        return res.redirect("/security/events");
      }

      const admin = adminResult.rows[0];
      const validCurrent = await bcrypt.compare(currentPassword, admin.password_hash);
      if (!validCurrent) {
        req.session.flash = { type: "error", message: "Current password is incorrect" };
        if (typeof auditLog === "function") {
          await auditLog(pool, actor, "admin_password_change", "admin", actor, "error", { reason: "current_password_invalid" });
        }
        return res.redirect("/security/events");
      }

      const nextHash = await bcrypt.hash(newPassword, 12);
      await pool.query(
        "UPDATE admin_users SET password_hash = $2 WHERE username = $1",
        [actor, nextHash]
      );

      if (typeof auditLog === "function") {
        await auditLog(pool, actor, "admin_password_change", "admin", actor, "success", {});
      }

      req.session.flash = { type: "success", message: "Admin password updated successfully" };
      return res.redirect("/security/events");
    } catch (err) {
      if (typeof auditLog === "function") {
        try {
          await auditLog(pool, actor, "admin_password_change", "admin", actor, "error", { error: err.message });
        } catch (_) {
          // Ignore audit errors in error path.
        }
      }
      req.session.flash = { type: "error", message: `Password update failed: ${err.message}` };
      return res.redirect("/security/events");
    }
  });

  router.post("/security/relay-settings", async (req, res) => {
    const actor = req.session.user ? req.session.user.username : "unknown";
    const relayHostInput = String(req.body.relayHost || "").trim().toLowerCase();
    const relayPortInput = String(req.body.relayPort || "587").trim();
    const relayUserInput = String(req.body.relayUser || "").trim();
    const relayPasswordInput = String(req.body.relayPassword || "");
    const relayEnabled = req.body.relayEnabled === "on";
    const applyNow = req.body.applyNow === "on";

    try {
      const existing = await loadRelaySettings(pool);
      const relayHost = relayHostInput || existing.relay_host || "";
      const relayUser = relayUserInput || existing.relay_user || "";
      const relayPassword = relayPasswordInput || existing.relay_password || "";

      const saved = await saveRelaySettings(pool, {
        relayHost,
        relayPort: relayPortInput || existing.relay_port || 587,
        relayUser,
        relayPassword,
        enabled: relayEnabled,
        actor
      });

      if (typeof auditLog === "function") {
        await auditLog(pool, actor, "relay_settings_update", "relay", saved.relay_host, "success", {
          relayHost: saved.relay_host,
          relayPort: saved.relay_port,
          relayUser: saved.relay_user,
          enabled: saved.enabled
        });
      }

      if (applyNow && relayEnabled) {
        const applyResult = await applyRelaySettings(saved);
        if (typeof auditLog === "function") {
          await auditLog(pool, actor, "relay_settings_apply", "relay", saved.relay_host, "success", {
            relayHost: saved.relay_host,
            relayPort: saved.relay_port,
            relayUser: saved.relay_user,
            output: applyResult.stdout ? applyResult.stdout.slice(0, 500) : ""
          });
        }
        req.session.flash = { type: "success", message: "Relay settings saved and applied to Postfix." };
      } else if (applyNow && !relayEnabled) {
        req.session.flash = {
          type: "success",
          message: "Relay settings saved. Relay is disabled, so apply step was skipped."
        };
      } else {
        req.session.flash = { type: "success", message: "Relay settings saved." };
      }

      return res.redirect("/security/events");
    } catch (err) {
      if (typeof auditLog === "function") {
        try {
          await auditLog(pool, actor, "relay_settings_update", "relay", relayHostInput || "unknown", "error", {
            error: err.message,
            relayPort: relayPortInput,
            relayUser: relayUserInput,
            enabled: relayEnabled,
            applyNow
          });
        } catch (_) {
          // Ignore audit failures in error path.
        }
      }
      let message = `Relay settings failed: ${err.message}`;
      if (/sudo: a password is required|not allowed to run sudo|permission denied/i.test(String(err.message || ""))) {
        message += " Grant NOPASSWD sudo for configure-relayhost.sh and postqueue to the panel user.";
      }
      req.session.flash = { type: "error", message };
      return res.redirect("/security/events");
    }
  });

  return router;
};
