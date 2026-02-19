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

    const defaultStorageBase =
      process.platform === "win32" ? path.join(defaultRuntimeDir, "mailstore") : "/var/mail/vhosts";
    this.mailStorageBase = process.env.MAIL_STORAGE_BASE || defaultStorageBase;
    this.mailStorageBases =
      process.platform === "win32"
        ? [this.mailStorageBase]
        : Array.from(new Set([this.mailStorageBase, "/var/mail/vhosts", "/var/vmail"]));
    this.mailboxStatsCmd = process.env.MAILBOX_STATS_CMD || "";
    this.mailboxPurgeCmd = process.env.MAILBOX_PURGE_CMD || "";
    this.mailboxStatsTimeoutMs = parseInt(process.env.MAILBOX_STATS_TIMEOUT_MS || "15000", 10);
    this.mailboxPurgeTimeoutMs = parseInt(process.env.MAILBOX_PURGE_TIMEOUT_MS || "30000", 10);
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

  runShellCommand(shellCommand, errorContext, options = {}) {
    const timeoutMs =
      Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : undefined;
    let run = spawnSync("bash", ["-lc", shellCommand], { encoding: "utf8", timeout: timeoutMs });

    if (run.error && run.error.code === "ENOENT") {
      run = spawnSync("sh", ["-lc", shellCommand], { encoding: "utf8", timeout: timeoutMs });
    }

    if (run.error || run.status !== 0) {
      const detail = (run.stderr || run.stdout || run.error?.message || "unknown error").trim();
      throw new Error(`${errorContext}: ${detail}`);
    }

    return run.stdout || "";
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

  parseMailboxIdentity(emailInput) {
    const email = String(emailInput || "").trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      throw new Error("Invalid email");
    }

    const [localPart, domain] = email.split("@");
    if (!localPart || !domain) {
      throw new Error("Invalid mailbox identity");
    }

    return { email, localPart, domain };
  }

  shellQuote(input) {
    return `'${String(input).replace(/'/g, `'\\''`)}'`;
  }

  resolveMailboxRootPath(identity) {
    const candidates = [];
    for (const baseDir of this.mailStorageBases) {
      candidates.push(path.join(baseDir, identity.domain, identity.localPart, "Maildir"));
      candidates.push(path.join(baseDir, identity.domain, identity.localPart));
      candidates.push(path.join(baseDir, identity.email, "Maildir"));
      candidates.push(path.join(baseDir, identity.email));
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch (_) {
        // Keep probing candidates.
      }
    }

    return candidates[0];
  }

  applyMailboxCommandTemplate(template, identity, mailboxRoot) {
    return String(template)
      .replaceAll("{{EMAIL}}", this.shellQuote(identity.email))
      .replaceAll("{{DOMAIN}}", this.shellQuote(identity.domain))
      .replaceAll("{{LOCAL_PART}}", this.shellQuote(identity.localPart))
      .replaceAll("{{MAILDIR}}", this.shellQuote(mailboxRoot));
  }

  parseMailboxStatsOutput(rawOutput, mailboxRoot) {
    const lines = String(rawOutput || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      throw new Error("Mailbox stats command returned no output");
    }

    let parsed;
    try {
      parsed = JSON.parse(lines[lines.length - 1]);
    } catch (err) {
      throw new Error("Mailbox stats command did not return valid JSON");
    }

    if (!parsed || typeof parsed !== "object" || parsed.ok === false) {
      throw new Error(parsed?.error || "Mailbox stats command reported failure");
    }

    return {
      usedBytes: Number.isFinite(Number(parsed.usedBytes)) ? Number(parsed.usedBytes) : null,
      inboxCount: Number.isFinite(Number(parsed.inboxCount)) ? Number(parsed.inboxCount) : null,
      sentCount: Number.isFinite(Number(parsed.sentCount)) ? Number(parsed.sentCount) : null,
      mailboxPath: parsed.path || mailboxRoot,
      source: "command"
    };
  }

  collectMailboxStatsFromFilesystem(mailboxRoot) {
    if (!fs.existsSync(mailboxRoot)) {
      return {
        usedBytes: 0,
        inboxCount: 0,
        sentCount: 0,
        mailboxPath: mailboxRoot,
        source: "filesystem"
      };
    }

    const inboxCur = path.join(mailboxRoot, "cur");
    const inboxNew = path.join(mailboxRoot, "new");

    const stack = [mailboxRoot];
    let usedBytes = 0;
    let inboxCount = 0;
    let sentCount = 0;

    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (err) {
        if (err?.code === "EACCES") {
          throw new Error(`Permission denied reading mailbox path: ${current}`);
        }
        throw err;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        let fileSize = 0;
        try {
          fileSize = fs.statSync(fullPath).size;
        } catch (err) {
          if (err?.code === "EACCES") {
            throw new Error(`Permission denied reading mailbox file: ${fullPath}`);
          }
          throw err;
        }
        usedBytes += fileSize;

        const parentDir = path.dirname(fullPath);
        if (parentDir === inboxCur || parentDir === inboxNew) {
          inboxCount += 1;
          continue;
        }

        const folderName = path.basename(path.dirname(parentDir)).toLowerCase();
        if (folderName.includes("sent")) {
          sentCount += 1;
        }
      }
    }

    return {
      usedBytes,
      inboxCount,
      sentCount,
      mailboxPath: mailboxRoot,
      source: "filesystem"
    };
  }

  purgeMailboxStorageFromFilesystem(mailboxRoot) {
    if (!fs.existsSync(mailboxRoot)) {
      return {
        deletedFiles: 0,
        deletedBytes: 0,
        mailboxPath: mailboxRoot,
        source: "filesystem"
      };
    }

    const stack = [mailboxRoot];
    const messageDirs = [];

    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (err) {
        if (err?.code === "EACCES") {
          throw new Error(`Permission denied reading mailbox path: ${current}`);
        }
        throw err;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const next = path.join(current, entry.name);
        const lowerName = entry.name.toLowerCase();
        if (lowerName === "cur" || lowerName === "new") {
          messageDirs.push(next);
        }
        stack.push(next);
      }
    }

    let deletedFiles = 0;
    let deletedBytes = 0;

    for (const dirPath of messageDirs) {
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch (err) {
        if (err?.code === "EACCES") {
          throw new Error(`Permission denied reading mailbox folder: ${dirPath}`);
        }
        throw err;
      }

      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const filePath = path.join(dirPath, entry.name);
        try {
          deletedBytes += fs.statSync(filePath).size;
          fs.unlinkSync(filePath);
          deletedFiles += 1;
        } catch (err) {
          if (err?.code === "EACCES") {
            throw new Error(`Permission denied deleting mailbox file: ${filePath}`);
          }
          throw err;
        }
      }
    }

    return {
      deletedFiles,
      deletedBytes,
      mailboxPath: mailboxRoot,
      source: "filesystem"
    };
  }

  async getMailboxStats(emailInput) {
    this.assertReady();
    const identity = this.parseMailboxIdentity(emailInput);
    const mailboxRoot = this.resolveMailboxRootPath(identity);

    if (this.mailboxStatsCmd) {
      const command = this.applyMailboxCommandTemplate(this.mailboxStatsCmd, identity, mailboxRoot);
      const output = this.runShellCommand(command, "Failed collecting mailbox stats", {
        timeoutMs: this.mailboxStatsTimeoutMs
      });
      return this.parseMailboxStatsOutput(output, mailboxRoot);
    }

    return this.collectMailboxStatsFromFilesystem(mailboxRoot);
  }

  async purgeMailboxStorage(emailInput) {
    this.assertReady();
    const identity = this.parseMailboxIdentity(emailInput);
    const mailboxRoot = this.resolveMailboxRootPath(identity);

    if (this.mailboxPurgeCmd) {
      const command = this.applyMailboxCommandTemplate(this.mailboxPurgeCmd, identity, mailboxRoot);
      const output = this.runShellCommand(command, "Failed purging mailbox storage", {
        timeoutMs: this.mailboxPurgeTimeoutMs
      });

      if (output.trim().length === 0) {
        return {
          deletedFiles: null,
          deletedBytes: null,
          mailboxPath: mailboxRoot,
          source: "command"
        };
      }

      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      let parsed;
      try {
        parsed = JSON.parse(lines[lines.length - 1]);
      } catch (err) {
        return {
          deletedFiles: null,
          deletedBytes: null,
          mailboxPath: mailboxRoot,
          source: "command"
        };
      }

      if (parsed?.ok === false) {
        throw new Error(parsed.error || "Mailbox purge command reported failure");
      }

      return {
        deletedFiles: Number.isFinite(Number(parsed.deletedFiles)) ? Number(parsed.deletedFiles) : null,
        deletedBytes: Number.isFinite(Number(parsed.deletedBytes)) ? Number(parsed.deletedBytes) : null,
        mailboxPath: parsed.path || mailboxRoot,
        source: "command"
      };
    }

    return this.purgeMailboxStorageFromFilesystem(mailboxRoot);
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
