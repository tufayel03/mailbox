const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const DOMAIN_REGEX = /^(?=.{1,253}$)(?!-)([A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}$/;
const EMAIL_REGEX = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class MailServerApi {
  constructor({ pool }) {
    this.pool = pool;
    this.ready = false;
    this.openapiSource = "native-mail-backend";
    this.endpointAvailability = new Map();

    this.dkimSelector = process.env.DKIM_SELECTOR || "mail";
    const defaultRuntimeDir = path.join(__dirname, ".runtime");
    const defaultDkimDir = process.platform === "win32" ? path.join(defaultRuntimeDir, "dkim") : "/etc/rspamd/dkim";
    const defaultSelectorMap =
      process.platform === "win32"
        ? path.join(defaultRuntimeDir, "dkim_selectors.map")
        : "/etc/rspamd/local.d/dkim_selectors.map";

    this.dkimKeysDir = process.env.DKIM_KEYS_DIR || defaultDkimDir;
    this.dkimSelectorMap = process.env.DKIM_SELECTOR_MAP || defaultSelectorMap;
    this.rspamdReloadCmd = process.env.RSPAMD_RELOAD_CMD || "systemctl reload rspamd";
    this.skipRspamdReload =
      (process.env.SKIP_RSPAMD_RELOAD || (process.platform === "win32" ? "true" : "false")).toLowerCase() === "true";
  }

  async discover() {
    await this.assertTables();
    this.ensureDkimSelectorMap();

    [
      "listDomains",
      "createDomain",
      "deleteDomain",
      "listAllMailboxes",
      "listMailboxesByDomain",
      "createMailbox",
      "deleteMailbox",
      "editMailbox",
      "getDkim"
    ].forEach((key) => this.endpointAvailability.set(key, true));

    this.endpointAvailability.set("ratelimitLogs", false);
    this.ready = true;
  }

  async assertTables() {
    const required = ["mail_domains", "mail_users", "mail_aliases"];

    for (const table of required) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.pool.query(
        `SELECT EXISTS (
           SELECT 1
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = $1
         ) AS present`,
        [table]
      );
      if (!result.rows[0].present) {
        throw new Error(`Required table missing: ${table}`);
      }
    }
  }

  assertReady() {
    if (!this.ready) {
      throw new Error("Mail server API not initialized. Call discover() first.");
    }
  }

  isEndpointAvailable(key) {
    return this.endpointAvailability.get(key) === true;
  }

  ensureDkimSelectorMap() {
    const dir = path.dirname(this.dkimSelectorMap);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.dkimSelectorMap)) {
      fs.writeFileSync(this.dkimSelectorMap, "", { mode: 0o640 });
    }
  }

  runCommand(command, args, errorContext) {
    const run = spawnSync(command, args, { encoding: "utf8" });
    if (run.error || run.status !== 0) {
      const detail = (run.stderr || run.stdout || run.error?.message || "unknown error").trim();
      throw new Error(`${errorContext}: ${detail}`);
    }
    return run.stdout || "";
  }

  runShellCommand(shellCommand, errorContext) {
    let run = spawnSync("bash", ["-lc", shellCommand], { encoding: "utf8" });

    if (run.error && run.error.code === "ENOENT") {
      run = spawnSync("sh", ["-lc", shellCommand], { encoding: "utf8" });
    }

    if (run.error || run.status !== 0) {
      const detail = (run.stderr || run.stdout || run.error?.message || "unknown error").trim();
      throw new Error(`${errorContext}: ${detail}`);
    }
  }

  ensureDkimKey(domain, selector) {
    if (!fs.existsSync(this.dkimKeysDir)) {
      fs.mkdirSync(this.dkimKeysDir, { recursive: true, mode: 0o750 });
    }

    const privateKeyPath = path.join(this.dkimKeysDir, `${domain}.${selector}.key`);
    let pubPem = "";

    if (!fs.existsSync(privateKeyPath)) {
      const generated = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: "spki",
          format: "pem"
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem"
        }
      });
      fs.writeFileSync(privateKeyPath, generated.privateKey, { mode: 0o600 });
      pubPem = generated.publicKey;
    } else {
      const keyPem = fs.readFileSync(privateKeyPath, "utf8");
      const keyObj = crypto.createPrivateKey(keyPem);
      pubPem = crypto.createPublicKey(keyObj).export({
        type: "spki",
        format: "pem"
      });
    }

    const pubBody = pubPem
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "")
      .trim();

    if (!pubBody) {
      throw new Error("DKIM public key extraction returned empty output");
    }

    return {
      privateKeyPath,
      dkimTxt: `v=DKIM1; k=rsa; p=${pubBody}`
    };
  }

  updateDkimSelectorMap(domain, selector, active) {
    this.ensureDkimSelectorMap();
    const raw = fs.readFileSync(this.dkimSelectorMap, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const domainMatcher = new RegExp(`^${escapeRegex(domain)}\\s+`);
    const kept = lines.filter((line) => !line.trim().startsWith("#")).filter((line) => !domainMatcher.test(line));

    if (active) {
      kept.push(`${domain} ${selector}`);
    }

    const output = `${kept.join("\n")}${kept.length ? "\n" : ""}`;
    fs.writeFileSync(this.dkimSelectorMap, output);
  }

  reloadRspamd() {
    if (this.skipRspamdReload) {
      return;
    }

    try {
      this.runShellCommand(this.rspamdReloadCmd, "Failed reloading rspamd");
    } catch (err) {
      throw new Error(`${err.message}. Ensure panel user can reload rspamd.`);
    }
  }

  async listDomains() {
    this.assertReady();
    const result = await this.pool.query(
      `SELECT
         d.domain_name,
         d.active,
         d.description,
         (
           SELECT COUNT(*)::int
             FROM mail_users u
            WHERE u.domain_name = d.domain_name
              AND u.active = true
         ) AS mboxes_in_domain,
         (
           SELECT COALESCE(SUM(u.quota_mb), 0)::bigint
             FROM mail_users u
            WHERE u.domain_name = d.domain_name
              AND u.active = true
         ) AS quota_mb_total
       FROM mail_domains d
      WHERE d.deleted_at IS NULL
      ORDER BY d.domain_name ASC`
    );

    return result.rows.map((row) => ({
      domain_name: row.domain_name,
      domain: row.domain_name,
      active: row.active ? "1" : "0",
      description: row.description,
      mboxes_in_domain: row.mboxes_in_domain,
      quota_used_in_domain: Number(row.quota_mb_total || 0) * 1024 * 1024
    }));
  }

  async createDomain(input) {
    this.assertReady();
    const domain = String(input.domain || "").trim().toLowerCase();
    if (!DOMAIN_REGEX.test(domain)) {
      throw new Error("Invalid domain");
    }

    const selector = this.dkimSelector;
    const dkimMaterial = this.ensureDkimKey(domain, selector);

    await this.pool.query(
      `INSERT INTO mail_domains
         (domain_name, description, active, dkim_selector, dkim_public_key, dkim_private_key_path, updated_at)
       VALUES ($1, $2, true, $3, $4, $5, NOW())
       ON CONFLICT (domain_name) DO UPDATE SET
         description = EXCLUDED.description,
         active = true,
         dkim_selector = EXCLUDED.dkim_selector,
         dkim_public_key = EXCLUDED.dkim_public_key,
         dkim_private_key_path = EXCLUDED.dkim_private_key_path,
         deleted_at = NULL,
         updated_at = NOW()`,
      [domain, input.description || "Managed by internal panel", selector, dkimMaterial.dkimTxt, dkimMaterial.privateKeyPath]
    );

    this.updateDkimSelectorMap(domain, selector, true);
    this.reloadRspamd();

    return [{ type: "success", msg: `Domain ${domain} configured` }];
  }

  async deleteDomain(domainInput) {
    this.assertReady();
    const domain = String(domainInput || "").trim().toLowerCase();
    if (!DOMAIN_REGEX.test(domain)) {
      throw new Error("Invalid domain");
    }

    await this.pool.query("DELETE FROM mail_users WHERE domain_name = $1", [domain]);
    const update = await this.pool.query(
      "UPDATE mail_domains SET active = false, deleted_at = NOW(), updated_at = NOW() WHERE domain_name = $1",
      [domain]
    );
    if (update.rowCount === 0) {
      throw new Error(`Domain not found: ${domain}`);
    }
    this.updateDkimSelectorMap(domain, this.dkimSelector, false);
    this.reloadRspamd();

    return [{ type: "success", msg: `Domain ${domain} removed` }];
  }

  async listMailboxes(domainInput) {
    this.assertReady();
    const domain = domainInput ? String(domainInput).trim().toLowerCase() : null;

    const whereClause = domain && domain !== "all" ? "WHERE domain_name = $1" : "";
    const params = domain && domain !== "all" ? [domain] : [];

    const result = await this.pool.query(
      `SELECT email, local_part, domain_name, display_name, quota_mb, active, created_at
         FROM mail_users
         ${whereClause}
        ORDER BY email ASC`,
      params
    );

    return result.rows.map((row) => ({
      username: row.email,
      local_part: row.local_part,
      domain: row.domain_name,
      name: row.display_name,
      quota: Number(row.quota_mb) * 1024 * 1024,
      active: row.active ? "1" : "0",
      created: row.created_at
    }));
  }

  async createMailbox(input) {
    this.assertReady();
    const localPart = String(input.localPart || "").trim().toLowerCase();
    const domain = String(input.domain || "").trim().toLowerCase();
    const name = String(input.name || "").trim();
    const password = String(input.password || "");
    const quotaMb = Number(input.quotaMb || 0);
    const email = `${localPart}@${domain}`;

    if (!localPart || !DOMAIN_REGEX.test(domain) || !EMAIL_REGEX.test(email) || password.length < 8 || quotaMb <= 0) {
      throw new Error("Invalid mailbox payload");
    }

    const domainCheck = await this.pool.query(
      "SELECT 1 FROM mail_domains WHERE domain_name = $1 AND active = true AND deleted_at IS NULL",
      [domain]
    );
    if (domainCheck.rowCount === 0) {
      throw new Error(`Domain not found or inactive: ${domain}`);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await this.pool.query(
      `INSERT INTO mail_users
         (email, domain_name, local_part, display_name, password_hash, quota_mb, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
       ON CONFLICT (email) DO UPDATE SET
         domain_name = EXCLUDED.domain_name,
         local_part = EXCLUDED.local_part,
         display_name = EXCLUDED.display_name,
         password_hash = EXCLUDED.password_hash,
         quota_mb = EXCLUDED.quota_mb,
         active = true,
         disabled_at = NULL,
         updated_at = NOW()`,
      [email, domain, localPart, name, passwordHash, quotaMb]
    );

    return [{ type: "success", msg: `Mailbox ${email} created` }];
  }

  async deleteMailbox(emailInput) {
    this.assertReady();
    const email = String(emailInput || "").trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      throw new Error("Invalid email");
    }

    const removed = await this.pool.query("DELETE FROM mail_users WHERE email = $1", [email]);
    if (removed.rowCount === 0) {
      throw new Error(`Mailbox not found: ${email}`);
    }
    return [{ type: "success", msg: `Mailbox ${email} deleted` }];
  }

  async setMailboxQuota(emailInput, quotaMbInput) {
    this.assertReady();
    const email = String(emailInput || "").trim().toLowerCase();
    const quotaMb = Number(quotaMbInput || 0);
    if (!EMAIL_REGEX.test(email) || !Number.isFinite(quotaMb) || quotaMb <= 0) {
      throw new Error("Invalid quota update payload");
    }

    const result = await this.pool.query(
      "UPDATE mail_users SET quota_mb = $2, updated_at = NOW() WHERE email = $1",
      [email, quotaMb]
    );
    if (result.rowCount === 0) {
      throw new Error(`Mailbox not found: ${email}`);
    }
  }

  async resetMailboxPassword(emailInput, passwordInput) {
    this.assertReady();
    const email = String(emailInput || "").trim().toLowerCase();
    const password = String(passwordInput || "");

    if (!EMAIL_REGEX.test(email) || password.length < 8) {
      throw new Error("Invalid password reset payload");
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await this.pool.query(
      "UPDATE mail_users SET password_hash = $2, updated_at = NOW() WHERE email = $1",
      [email, hash]
    );
    if (result.rowCount === 0) {
      throw new Error(`Mailbox not found: ${email}`);
    }
  }

  async setMailboxActive(emailInput, enabled) {
    this.assertReady();
    const email = String(emailInput || "").trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      throw new Error("Invalid mailbox");
    }

    const result = await this.pool.query(
      `UPDATE mail_users
          SET active = $2,
              disabled_at = CASE WHEN $2 THEN NULL ELSE NOW() END,
              updated_at = NOW()
        WHERE email = $1`,
      [email, Boolean(enabled)]
    );
    if (result.rowCount === 0) {
      throw new Error(`Mailbox not found: ${email}`);
    }
  }

  async getDkim(domainInput) {
    this.assertReady();
    const domain = String(domainInput || "").trim().toLowerCase();
    if (!DOMAIN_REGEX.test(domain)) {
      throw new Error("Invalid domain");
    }

    const result = await this.pool.query(
      "SELECT dkim_selector, dkim_public_key FROM mail_domains WHERE domain_name = $1 AND deleted_at IS NULL",
      [domain]
    );

    if (result.rowCount === 0) {
      throw new Error(`Domain not found: ${domain}`);
    }

    return {
      domain,
      dkim_selector: result.rows[0].dkim_selector || this.dkimSelector,
      dkim_txt: result.rows[0].dkim_public_key || ""
    };
  }

  async getRatelimitLogs() {
    return [];
  }
}

module.exports = {
  MailServerApi
};
