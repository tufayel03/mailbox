const express = require("express");

const EMAIL_REGEX = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

module.exports = function createMailboxRoutes({ pool, mailServerApi, auditLog }) {
  const router = express.Router();

  router.get("/mailboxes", async (req, res) => {
    const selectedDomain = String(req.query.domain || "all").toLowerCase();

    try {
      const domainsRaw = await mailServerApi.listDomains();
      const domains = (Array.isArray(domainsRaw) ? domainsRaw : []).map((item) => item.domain_name || item.domain).filter(Boolean);
      const mailboxesRaw = await mailServerApi.listMailboxes(selectedDomain === "all" ? null : selectedDomain);
      const mailboxes = Array.isArray(mailboxesRaw) ? mailboxesRaw : [];

      const stateResult = await pool.query("SELECT email, status, warn_count, disabled_at FROM mailbox_state");
      const stateMap = new Map(stateResult.rows.map((row) => [row.email, row]));

      const merged = mailboxes.map((mb) => {
        const state = stateMap.get(mb.username) || null;
        return {
          ...mb,
          localState: state
        };
      });

      res.render("mailboxes", {
        pageTitle: "Mailbox Manager",
        domains,
        selectedDomain,
        mailboxes: merged
      });
    } catch (err) {
      req.session.flash = { type: "error", message: `Failed to load mailboxes: ${err.message}` };
      res.render("mailboxes", {
        pageTitle: "Mailbox Manager",
        domains: [],
        selectedDomain,
        mailboxes: []
      });
    }
  });

  router.post("/mailboxes", async (req, res) => {
    const actor = req.session.user.username;
    const localPart = String(req.body.localPart || "").trim();
    const domain = String(req.body.domain || "").trim().toLowerCase();
    const name = String(req.body.name || "").trim();
    const password = String(req.body.password || "");
    const quotaMb = parseInt(req.body.quotaMb || "3072", 10);

    if (!localPart || !domain || !name || !password || Number.isNaN(quotaMb) || quotaMb <= 0) {
      req.session.flash = { type: "error", message: "Missing mailbox fields" };
      return res.redirect("/mailboxes");
    }

    const email = `${localPart}@${domain}`.toLowerCase();

    try {
      await mailServerApi.createMailbox({ localPart, domain, name, password, quotaMb });
      await pool.query(
        `INSERT INTO mailbox_state (email, domain_name, status, warn_count, updated_at)
         VALUES ($1, $2, 'active', 0, NOW())
         ON CONFLICT (email) DO UPDATE SET status = 'active', updated_at = NOW()`,
        [email, domain]
      );

      await auditLog(pool, actor, "mailbox_create", "mailbox", email, "success", { quotaMb, name });
      req.session.flash = { type: "success", message: `Mailbox ${email} created` };
    } catch (err) {
      await auditLog(pool, actor, "mailbox_create", "mailbox", email, "error", { error: err.message });
      req.session.flash = { type: "error", message: `Create mailbox failed: ${err.message}` };
    }

    return res.redirect(`/mailboxes?domain=${encodeURIComponent(domain)}`);
  });

  router.post("/mailboxes/:email/delete", async (req, res) => {
    const actor = req.session.user.username;
    const email = decodeURIComponent(String(req.params.email || "")).toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      req.session.flash = { type: "error", message: "Invalid mailbox" };
      return res.redirect("/mailboxes");
    }

    try {
      await mailServerApi.deleteMailbox(email);
      await pool.query("DELETE FROM mailbox_state WHERE email = $1", [email]);
      await auditLog(pool, actor, "mailbox_delete", "mailbox", email, "success", {});
      req.session.flash = { type: "success", message: `Mailbox ${email} removed` };
    } catch (err) {
      await auditLog(pool, actor, "mailbox_delete", "mailbox", email, "error", { error: err.message });
      req.session.flash = { type: "error", message: `Delete mailbox failed: ${err.message}` };
    }

    return res.redirect("/mailboxes");
  });

  router.post("/mailboxes/:email/password", async (req, res) => {
    const actor = req.session.user.username;
    const email = decodeURIComponent(String(req.params.email || "")).toLowerCase();
    const newPassword = String(req.body.newPassword || "");

    if (!EMAIL_REGEX.test(email) || newPassword.length < 8) {
      req.session.flash = { type: "error", message: "Invalid mailbox or weak password" };
      return res.redirect("/mailboxes");
    }

    try {
      await mailServerApi.resetMailboxPassword(email, newPassword);
      await auditLog(pool, actor, "mailbox_password_reset", "mailbox", email, "success", {});
      req.session.flash = { type: "success", message: `Password reset for ${email}` };
    } catch (err) {
      await auditLog(pool, actor, "mailbox_password_reset", "mailbox", email, "error", { error: err.message });
      req.session.flash = { type: "error", message: `Password reset failed: ${err.message}` };
    }

    return res.redirect("/mailboxes");
  });

  router.post("/mailboxes/:email/quota", async (req, res) => {
    const actor = req.session.user.username;
    const email = decodeURIComponent(String(req.params.email || "")).toLowerCase();
    const quotaMb = parseInt(req.body.quotaMb || "0", 10);

    if (!EMAIL_REGEX.test(email) || Number.isNaN(quotaMb) || quotaMb <= 0) {
      req.session.flash = { type: "error", message: "Invalid mailbox or quota" };
      return res.redirect("/mailboxes");
    }

    try {
      await mailServerApi.setMailboxQuota(email, quotaMb);
      await auditLog(pool, actor, "mailbox_quota_set", "mailbox", email, "success", { quotaMb });
      req.session.flash = { type: "success", message: `Quota updated for ${email}` };
    } catch (err) {
      await auditLog(pool, actor, "mailbox_quota_set", "mailbox", email, "error", { error: err.message });
      req.session.flash = { type: "error", message: `Quota update failed: ${err.message}` };
    }

    return res.redirect("/mailboxes");
  });

  router.post("/mailboxes/:email/enable", async (req, res) => {
    const actor = req.session.user.username;
    const email = decodeURIComponent(String(req.params.email || "")).toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      req.session.flash = { type: "error", message: "Invalid mailbox" };
      return res.redirect("/mailboxes");
    }

    try {
      await mailServerApi.setMailboxActive(email, true);
      const domain = email.split("@")[1] || "unknown";
      await pool.query(
        `INSERT INTO mailbox_state (email, domain_name, status, warn_count, disabled_at, updated_at)
         VALUES ($1, $2, 'active', 0, NULL, NOW())
         ON CONFLICT (email) DO UPDATE SET
           status = 'active',
           warn_count = 0,
           disabled_at = NULL,
           updated_at = NOW()`,
        [email, domain]
      );
      await auditLog(pool, actor, "mailbox_enable", "mailbox", email, "success", {});
      req.session.flash = { type: "success", message: `Mailbox enabled: ${email}` };
    } catch (err) {
      await auditLog(pool, actor, "mailbox_enable", "mailbox", email, "error", { error: err.message });
      req.session.flash = { type: "error", message: `Enable mailbox failed: ${err.message}` };
    }

    return res.redirect("/mailboxes");
  });

  router.post("/mailboxes/:email/disable", async (req, res) => {
    const actor = req.session.user.username;
    const email = decodeURIComponent(String(req.params.email || "")).toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      req.session.flash = { type: "error", message: "Invalid mailbox" };
      return res.redirect("/mailboxes");
    }

    try {
      await mailServerApi.setMailboxActive(email, false);
      const domain = email.split("@")[1] || "unknown";
      await pool.query(
        `INSERT INTO mailbox_state (email, domain_name, status, disabled_at, updated_at)
         VALUES ($1, $2, 'disabled', NOW(), NOW())
         ON CONFLICT (email) DO UPDATE SET
           status = 'disabled',
           disabled_at = NOW(),
           updated_at = NOW()`,
        [email, domain]
      );
      await auditLog(pool, actor, "mailbox_disable", "mailbox", email, "success", {});
      req.session.flash = { type: "success", message: `Mailbox disabled: ${email}` };
    } catch (err) {
      await auditLog(pool, actor, "mailbox_disable", "mailbox", email, "error", { error: err.message });
      req.session.flash = { type: "error", message: `Disable mailbox failed: ${err.message}` };
    }

    return res.redirect("/mailboxes");
  });

  return router;
};
