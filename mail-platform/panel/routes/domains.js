const express = require("express");
const { generateDnsRecords, checkDnsRecords } = require("../dnsCheck");

const DOMAIN_REGEX = /^(?=.{1,253}$)(?!-)([A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}$/;

function parseDkimPayload(payload) {
  if (Array.isArray(payload)) {
    return payload[0] || null;
  }
  return payload;
}

module.exports = function createDomainRoutes({ pool, mailServerApi, auditLog, env }) {
  const router = express.Router();

  async function buildDnsPreview(domain) {
    const dkimPayload = parseDkimPayload(await mailServerApi.getDkim(domain));
    const records = generateDnsRecords(
      domain,
      env.mailHostname,
      dkimPayload,
      env.mailServerIpv4,
      env.mailServerIpv6
    );

    return {
      domain,
      generatedAt: new Date().toISOString(),
      records
    };
  }

  async function loadPageData() {
    const dbDomains = await pool.query(
      `SELECT domain_name, description, status, alias_limit, mailbox_limit, default_quota_mb, max_quota_mb, total_quota_mb, created_at
         FROM managed_domains
        WHERE deleted_at IS NULL
        ORDER BY domain_name ASC`
    );

    const mcDomainsRaw = await mailServerApi.listDomains();
    const mcDomains = Array.isArray(mcDomainsRaw) ? mcDomainsRaw : [];
    const mcMap = new Map(
      mcDomains
        .map((d) => [String(d.domain_name || d.domain || "").toLowerCase(), d])
        .filter(([k]) => k)
    );

    const merged = dbDomains.rows.map((row) => {
      const remote = mcMap.get(String(row.domain_name || "").toLowerCase());
      return {
        ...row,
        remoteActive: remote ? String(remote.active) === "1" : null,
        remoteMailboxes: remote ? Number(remote.mboxes_in_domain || 0) : null,
        remoteQuotaUsedBytes: remote ? Number(remote.quota_used_in_domain || 0) : null
      };
    });

    const known = new Set(merged.map((row) => String(row.domain_name || "").toLowerCase()));
    for (const remote of mcDomains) {
      const remoteName = String(remote.domain_name || remote.domain || "").toLowerCase();
      if (!remoteName || known.has(remoteName)) {
        continue;
      }

      merged.push({
        domain_name: remoteName,
        description: remote.description || "Synced from mail backend",
        status: "active",
        alias_limit: null,
        mailbox_limit: null,
        default_quota_mb: null,
        max_quota_mb: null,
        total_quota_mb: null,
        created_at: null,
        remoteActive: String(remote.active) === "1",
        remoteMailboxes: Number(remote.mboxes_in_domain || 0),
        remoteQuotaUsedBytes: Number(remote.quota_used_in_domain || 0)
      });
    }

    return { domains: merged };
  }

  router.get("/domains", async (req, res) => {
    const previewDomain = String(req.query.preview || "").trim().toLowerCase();

    try {
      const data = await loadPageData();
      let dnsPreview = null;

      if (previewDomain && DOMAIN_REGEX.test(previewDomain)) {
        try {
          dnsPreview = await buildDnsPreview(previewDomain);
        } catch (err) {
          req.session.flash = {
            type: "warning",
            message: `Domain added, but DNS preview failed: ${err.message}`
          };
        }
      }

      res.render("domains", {
        pageTitle: "Domain Manager",
        ...data,
        dnsPreview
      });
    } catch (err) {
      req.session.flash = { type: "error", message: `Failed to load domains: ${err.message}` };
      res.render("domains", {
        pageTitle: "Domain Manager",
        domains: [],
        dnsPreview: null
      });
    }
  });

  router.post("/domains", async (req, res) => {
    const actor = req.session.user.username;
    const domain = String(req.body.domain || "").trim().toLowerCase();
    const description = String(req.body.description || "Managed by internal panel").trim();

    if (!DOMAIN_REGEX.test(domain)) {
      req.session.flash = { type: "error", message: "Invalid domain name" };
      return res.redirect("/domains");
    }

    const aliasLimit = parseInt(process.env.DOMAIN_ALIAS_LIMIT || "400", 10);
    const mailboxLimit = parseInt(process.env.DOMAIN_MAILBOX_LIMIT || "50", 10);
    const defaultQuotaMb = parseInt(process.env.DOMAIN_DEFQUOTA_MB || "3072", 10);
    const maxQuotaMb = parseInt(process.env.DOMAIN_MAXQUOTA_MB || "10240", 10);
    const totalQuotaMb = parseInt(process.env.DOMAIN_TOTAL_QUOTA_MB || "51200", 10);

    try {
      await mailServerApi.createDomain({
        domain,
        description,
        aliasLimit,
        mailboxLimit,
        defaultQuotaMb,
        maxQuotaMb,
        totalQuotaMb,
        ratelimitValue: 50,
        ratelimitFrame: "h"
      });

      await pool.query(
        `INSERT INTO managed_domains
          (domain_name, description, status, alias_limit, mailbox_limit, default_quota_mb, max_quota_mb, total_quota_mb, updated_at)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (domain_name) DO UPDATE SET
          description = EXCLUDED.description,
          status = 'active',
          alias_limit = EXCLUDED.alias_limit,
          mailbox_limit = EXCLUDED.mailbox_limit,
          default_quota_mb = EXCLUDED.default_quota_mb,
          max_quota_mb = EXCLUDED.max_quota_mb,
          total_quota_mb = EXCLUDED.total_quota_mb,
          deleted_at = NULL,
          updated_at = NOW()`,
        [domain, description, aliasLimit, mailboxLimit, defaultQuotaMb, maxQuotaMb, totalQuotaMb]
      );

      await auditLog(pool, actor, "domain_add", "domain", domain, "success", {
        description,
        aliasLimit,
        mailboxLimit
      });

      req.session.flash = { type: "success", message: `Domain ${domain} added` };
      return res.redirect(`/domains?preview=${encodeURIComponent(domain)}`);
    } catch (err) {
      await auditLog(pool, actor, "domain_add", "domain", domain, "error", { error: err.message });
      req.session.flash = { type: "error", message: `Add domain failed: ${err.message}` };
      return res.redirect("/domains");
    }
  });

  router.post("/domains/:domain/delete", async (req, res) => {
    const actor = req.session.user.username;
    const domain = String(req.params.domain || "").trim().toLowerCase();

    try {
      await mailServerApi.deleteDomain(domain);

      await pool.query(
        "UPDATE managed_domains SET status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE domain_name = $1",
        [domain]
      );

      await auditLog(pool, actor, "domain_delete", "domain", domain, "success", {});
      req.session.flash = { type: "success", message: `Domain ${domain} removed` };
    } catch (err) {
      await auditLog(pool, actor, "domain_delete", "domain", domain, "error", { error: err.message });
      req.session.flash = { type: "error", message: `Delete domain failed: ${err.message}` };
    }

    return res.redirect("/domains");
  });

  router.get("/domains/:domain/dns", async (req, res) => {
    const domain = String(req.params.domain || "").trim().toLowerCase();

    try {
      const dnsPreview = await buildDnsPreview(domain);
      return res.json(dnsPreview);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post("/domains/:domain/dns-check", async (req, res) => {
    const domain = String(req.params.domain || "").trim().toLowerCase();

    try {
      const dkimPayload = parseDkimPayload(await mailServerApi.getDkim(domain));
      const records = generateDnsRecords(
        domain,
        env.mailHostname,
        dkimPayload,
        env.mailServerIpv4,
        env.mailServerIpv6
      );

      const results = await checkDnsRecords(domain, records);
      return res.json(results);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
