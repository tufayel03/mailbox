const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const RELAY_HOST_REGEX = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[A-Za-z]{2,63}$/;

function getSecretKey() {
  const seed = process.env.RELAY_ENCRYPTION_KEY || process.env.SESSION_SECRET || "";
  if (!seed) {
    throw new Error("RELAY_ENCRYPTION_KEY or SESSION_SECRET is required for relay credential encryption");
  }
  return crypto.createHash("sha256").update(seed).digest();
}

function encryptSecret(value) {
  const key = getSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(payload) {
  if (!payload) {
    return "";
  }
  const parts = String(payload).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload format");
  }

  const [ivB64, tagB64, dataB64] = parts;
  const key = getSecretKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

function splitCommand(commandText, fallback = []) {
  const raw = String(commandText || "").trim();
  if (!raw) {
    return fallback;
  }
  return raw.split(/\s+/).filter(Boolean);
}

function runCommand(parts, extraArgs = [], options = {}) {
  return new Promise((resolve, reject) => {
    const allParts = [...parts, ...extraArgs];
    if (allParts.length === 0) {
      return reject(new Error("No command configured"));
    }

    const command = allParts[0];
    const args = allParts.slice(1);
    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      ...options
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(err);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      const message = stderr.trim() || stdout.trim() || `Exit code ${code}`;
      reject(new Error(message));
    });
  });
}

function parseRelayPort(value, fallback = 587) {
  const port = Number.parseInt(String(value || fallback), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("Relay port must be between 1 and 65535");
  }
  return port;
}

function validateRelayHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  if (!RELAY_HOST_REGEX.test(normalized)) {
    throw new Error("Invalid relay host");
  }
  return normalized;
}

async function loadRelaySettings(pool) {
  const result = await pool.query(
    `SELECT relay_host, relay_port, relay_user, relay_pass_enc, enabled, updated_by, updated_at
       FROM smtp_relay_settings
      WHERE id = 1`
  );

  if (result.rowCount === 0) {
    return {
      relay_host: "",
      relay_port: 587,
      relay_user: "",
      relay_pass_enc: "",
      relay_password: "",
      enabled: false,
      updated_by: "system",
      updated_at: null
    };
  }

  const row = result.rows[0];
  let relayPassword = "";
  if (row.relay_pass_enc) {
    try {
      relayPassword = decryptSecret(row.relay_pass_enc);
    } catch (_) {
      relayPassword = "";
    }
  }

  return {
    ...row,
    relay_password: relayPassword
  };
}

async function saveRelaySettings(pool, input) {
  const relayHost = validateRelayHost(input.relayHost);
  const relayPort = parseRelayPort(input.relayPort, 587);
  const relayUser = String(input.relayUser || "").trim();
  const relayPassword = String(input.relayPassword || "");
  const enabled = Boolean(input.enabled);
  const actor = String(input.actor || "system");

  if (!relayUser) {
    throw new Error("Relay username is required");
  }
  if (!relayPassword) {
    throw new Error("Relay password is required");
  }

  const relayPassEnc = encryptSecret(relayPassword);
  await pool.query(
    `INSERT INTO smtp_relay_settings (id, relay_host, relay_port, relay_user, relay_pass_enc, enabled, updated_by, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       relay_host = EXCLUDED.relay_host,
       relay_port = EXCLUDED.relay_port,
       relay_user = EXCLUDED.relay_user,
       relay_pass_enc = EXCLUDED.relay_pass_enc,
       enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [relayHost, relayPort, relayUser, relayPassEnc, enabled, actor]
  );

  return {
    relay_host: relayHost,
    relay_port: relayPort,
    relay_user: relayUser,
    relay_password: relayPassword,
    enabled
  };
}

function getRelayScriptPath() {
  const custom = process.env.RELAY_CONFIG_SCRIPT;
  if (custom && String(custom).trim()) {
    return custom.trim();
  }
  return path.resolve(__dirname, "..", "configure-relayhost.sh");
}

async function applyRelaySettings(settings) {
  const scriptPath = getRelayScriptPath();
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Relay script not found at ${scriptPath}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pass-"));
  const passFile = path.join(tempDir, "smtp-pass.txt");
  fs.writeFileSync(passFile, `${settings.relay_password}\n`, { mode: 0o600 });

  try {
    const prefix = splitCommand(process.env.RELAY_APPLY_CMD, ["sudo", "-n"]);
    const commandParts = prefix.length > 0 ? prefix : [scriptPath];
    const extraArgs = prefix.length > 0
      ? [scriptPath]
      : [];

    extraArgs.push(
      "--host", settings.relay_host,
      "--port", String(settings.relay_port),
      "--user", settings.relay_user,
      "--pass-file", passFile,
      "--force-ipv4", "on"
    );

    const result = await runCommand(commandParts, extraArgs, {
      cwd: path.dirname(scriptPath)
    });

    const queuePrefix = splitCommand(process.env.RELAY_FLUSH_CMD, ["sudo", "-n", "postqueue", "-f"]);
    if (queuePrefix.length > 0) {
      try {
        await runCommand(queuePrefix);
      } catch (_) {
        // Queue flush failure is non-fatal for relay apply.
      }
    }

    return result;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
      // Ignore cleanup errors.
    }
  }
}

module.exports = {
  loadRelaySettings,
  saveRelaySettings,
  applyRelaySettings
};

