const crypto = require("crypto");
const fs = require("fs");
const { spawnSync } = require("child_process");

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

class RateLimitWorker {
  constructor({ pool, mailServerApi, auditLog }) {
    this.pool = pool;
    this.mailServerApi = mailServerApi;
    this.auditLog = auditLog;
    this.intervalMs = parseInt(process.env.RATE_WORKER_INTERVAL_MS || "60000", 10);
    this.windowDays = parseInt(process.env.RATE_WINDOW_DAYS || "7", 10);
    this.rspamdLogPath = process.env.RSPAMD_LOG_PATH || "/var/log/rspamd/rspamd.log";

    this.enableFileLogIngest = (process.env.ENABLE_FILE_LOG_INGEST || "true").toLowerCase() === "true";
    this.enableJournalIngest = (process.env.ENABLE_JOURNAL_LOG_INGEST || "false").toLowerCase() === "true";

    this.fileTailLines = parseInt(process.env.RSPAMD_LOG_TAIL_LINES || "1000", 10);
    this.journalSince = process.env.RSPAMD_JOURNAL_SINCE || "-2 min";

    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[worker] runOnce failed:", err.message);
      });
    }, this.intervalMs);

    this.runOnce().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[worker] initial run failed:", err.message);
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce() {
    if (this.running) {
      return { processed: 0, skipped: true };
    }

    this.running = true;
    try {
      const events = [];

      if (this.enableFileLogIngest) {
        events.push(...this.collectFromRspamdFile());
      }

      if (this.enableJournalIngest) {
        events.push(...this.collectFromJournald());
      }

      let processed = 0;
      for (const event of events) {
        // eslint-disable-next-line no-await-in-loop
        const saved = await this.processEvent(event);
        if (saved) {
          processed += 1;
        }
      }

      return { processed, total: events.length };
    } finally {
      this.running = false;
    }
  }

  collectFromRspamdFile() {
    if (!fs.existsSync(this.rspamdLogPath)) {
      return [];
    }

    const run = spawnSync("tail", ["-n", String(this.fileTailLines), this.rspamdLogPath], {
      encoding: "utf8"
    });

    if (run.error || run.status !== 0) {
      return [];
    }

    return this.parseLines((run.stdout || "").split(/\r?\n/));
  }

  collectFromJournald() {
    const run = spawnSync("journalctl", ["-u", "rspamd", "--since", this.journalSince, "--no-pager", "-o", "short-iso"], {
      encoding: "utf8"
    });

    if (run.error || run.status !== 0) {
      return [];
    }

    return this.parseLines((run.stdout || "").split(/\r?\n/));
  }

  parseLines(lines) {
    const events = [];

    for (const line of lines) {
      if (!line || !/ratelimit|ratelimited|RATELIMIT/i.test(line)) {
        continue;
      }

      const event = this.parseRatelimitLine(line);
      if (event && event.userEmail) {
        events.push(event);
      }
    }

    return events;
  }

  parseRatelimitLine(line) {
    const timestamp = this.extractTimestamp(line);
    const userEmail = this.extractEmail(line);

    if (!userEmail) {
      return null;
    }

    const bucketMatch =
      line.match(/Ratelimit\s+"([^"]+)"/i) ||
      line.match(/bucket[=:]\s*([A-Za-z0-9._-]+)/i) ||
      line.match(/rl_name[=:]\s*([A-Za-z0-9._-]+)/i);

    const qidMatch = line.match(/\bqid[=:]\s*([A-Z0-9]+)/i);
    const messageIdMatch = line.match(/message[_-]?id[=:]\s*<?([^>\s]+)>?/i);

    return {
      userEmail: userEmail.toLowerCase(),
      bucketName: bucketMatch ? bucketMatch[1] || "ratelimit" : "ratelimit",
      action: "ratelimited",
      qid: qidMatch ? qidMatch[1] : null,
      messageId: messageIdMatch ? messageIdMatch[1] : null,
      eventTime: timestamp,
      source: "rspamd_log",
      rawEvent: { line }
    };
  }

  extractTimestamp(line) {
    const token = line.split(" ")[0];
    const parsed = new Date(token);
    if (Number.isNaN(parsed.getTime())) {
      return new Date();
    }
    return parsed;
  }

  extractEmail(text) {
    const match = text.match(EMAIL_REGEX);
    return match ? match[0] : null;
  }

  buildEventHash(event) {
    const minute = Math.floor(event.eventTime.getTime() / 60000);
    const seed = [
      event.userEmail,
      event.bucketName || "ratelimit",
      String(minute),
      event.messageId || event.qid || "none",
      event.action || "ratelimited"
    ].join("|");

    return crypto.createHash("sha256").update(seed).digest("hex");
  }

  async processEvent(event) {
    if (!event.userEmail || !EMAIL_REGEX.test(event.userEmail)) {
      return false;
    }

    const eventHash = this.buildEventHash(event);

    const insert = await this.pool.query(
      `INSERT INTO rate_limit_events
        (event_hash, user_email, bucket_name, action, qid, message_id, source, event_time, raw_event)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (event_hash) DO NOTHING
       RETURNING id`,
      [
        eventHash,
        event.userEmail,
        event.bucketName || "ratelimit",
        event.action || "ratelimited",
        event.qid,
        event.messageId,
        event.source,
        event.eventTime,
        JSON.stringify(event.rawEvent || {})
      ]
    );

    if (insert.rowCount === 0) {
      return false;
    }

    const countRes = await this.pool.query(
      `SELECT COUNT(*)::int AS count
         FROM rate_limit_events
        WHERE user_email = $1
          AND event_time >= NOW() - ($2 || ' days')::interval`,
      [event.userEmail, String(this.windowDays)]
    );

    const count = countRes.rows[0].count;
    const domain = event.userEmail.split("@")[1] || "unknown";

    if (count === 1) {
      await this.pool.query(
        `INSERT INTO mailbox_state (email, domain_name, status, warn_count, last_warn_at, updated_at)
         VALUES ($1, $2, 'warning', 1, NOW(), NOW())
         ON CONFLICT (email) DO UPDATE SET
           status = 'warning',
           warn_count = mailbox_state.warn_count + 1,
           last_warn_at = NOW(),
           updated_at = NOW()`,
        [event.userEmail, domain]
      );

      await this.pool.query(
        "UPDATE rate_limit_events SET warned_at = NOW() WHERE event_hash = $1",
        [eventHash]
      );

      await this.auditLog(
        this.pool,
        "system-worker",
        "mailbox_warned",
        "mailbox",
        event.userEmail,
        "warning",
        { reason: "ratelimit_first_hit", bucket: event.bucketName }
      );

      return true;
    }

    if (count >= 2) {
      const state = await this.pool.query(
        "SELECT status FROM mailbox_state WHERE email = $1",
        [event.userEmail]
      );

      const alreadyDisabled = state.rowCount > 0 && state.rows[0].status === "disabled";

      if (!alreadyDisabled) {
        let disableStatus = "success";
        let disableError = null;

        try {
          await this.mailServerApi.setMailboxActive(event.userEmail, false);
        } catch (err) {
          disableStatus = "error";
          disableError = err.message;
        }

        await this.pool.query(
          `INSERT INTO mailbox_state (email, domain_name, status, disabled_at, updated_at)
           VALUES ($1, $2, 'disabled', NOW(), NOW())
           ON CONFLICT (email) DO UPDATE SET
             status = 'disabled',
             disabled_at = NOW(),
             updated_at = NOW()`,
          [event.userEmail, domain]
        );

        await this.pool.query(
          "UPDATE rate_limit_events SET disabled_at = NOW() WHERE event_hash = $1",
          [eventHash]
        );

        await this.auditLog(
          this.pool,
          "system-worker",
          "mailbox_disabled",
          "mailbox",
          event.userEmail,
          disableStatus,
          {
            reason: "ratelimit_second_hit",
            bucket: event.bucketName,
            error: disableError
          }
        );
      }

      return true;
    }

    return true;
  }
}

module.exports = {
  RateLimitWorker
};
