require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");

const { createPool, initDatabase, ensureAdminUser, auditLog } = require("./db");
const { MailServerApi } = require("./mailServerApi");
const { requireAuth } = require("./middleware/auth");
const createAuthRoutes = require("./routes/auth");
const createDomainRoutes = require("./routes/domains");
const createMailboxRoutes = require("./routes/mailboxes");
const createSecurityRoutes = require("./routes/security");
const { RateLimitWorker } = require("./worker");

const PANEL_HOST = process.env.PANEL_HOST || "127.0.0.1";
const PANEL_PORT = parseInt(process.env.PANEL_PORT || "3101", 10);
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-session-secret";
const NODE_ENV = String(process.env.NODE_ENV || "").toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).toLowerCase() === "true";
}

async function bootstrap() {
  if (!process.env.SESSION_SECRET || SESSION_SECRET === "change-me-session-secret") {
    throw new Error("SESSION_SECRET must be set to a strong random value");
  }

  const trustProxyRaw = process.env.TRUST_PROXY;
  const trustProxy = trustProxyRaw === undefined || trustProxyRaw === ""
    ? IS_PRODUCTION
    : (trustProxyRaw === "1" || trustProxyRaw.toLowerCase() === "true" ? true : trustProxyRaw);

  const sessionCookieSecure = parseBoolean(process.env.SESSION_COOKIE_SECURE, IS_PRODUCTION);
  const sessionCookieSameSite = process.env.SESSION_COOKIE_SAMESITE || "lax";
  const sessionCookieMaxAge = parseInt(process.env.SESSION_COOKIE_MAX_AGE_MS || String(1000 * 60 * 60 * 8), 10);
  const sessionCookieName = process.env.SESSION_COOKIE_NAME || "mailpanel.sid";

  const pool = createPool();
  await initDatabase(pool);
  const adminResult = await ensureAdminUser(pool);
  console.log(`[startup] Admin user ${adminResult.created ? "created" : "verified"}: ${adminResult.username}`);

  const mailServerApi = new MailServerApi({ pool });
  await mailServerApi.discover();
  console.log(`[startup] Mail backend discovery source: ${mailServerApi.openapiSource}`);

  const worker = new RateLimitWorker({ pool, mailServerApi, auditLog });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.set("view cache", (process.env.VIEW_CACHE || "false").toLowerCase() === "true");

  app.use(helmet({
    contentSecurityPolicy: false
  }));
  app.use(morgan("combined"));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  const staticMaxAge = process.env.STATIC_MAX_AGE || (process.env.NODE_ENV === "production" ? "1h" : 0);
  app.use(express.static(path.join(__dirname, "public"), { maxAge: staticMaxAge }));

  app.use(session({
    name: sessionCookieName,
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    secret: SESSION_SECRET,
    proxy: Boolean(trustProxy),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: sessionCookieSameSite,
      secure: sessionCookieSecure,
      maxAge: Number.isFinite(sessionCookieMaxAge) ? sessionCookieMaxAge : (1000 * 60 * 60 * 8)
    }
  }));

  app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  });

  app.get("/", (req, res) => {
    if (req.session.user) {
      return res.redirect("/domains");
    }
    return res.redirect("/login");
  });

  app.get("/healthz", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      return res.status(200).json({ status: "ok" });
    } catch (err) {
      return res.status(503).json({ status: "error", message: err.message });
    }
  });

  app.use(createAuthRoutes({ pool, auditLog }));

  app.use(requireAuth);

  app.use(createDomainRoutes({
    pool,
    mailServerApi,
    auditLog,
    env: {
      mailHostname: process.env.MAIL_HOSTNAME || "mail.mailhost.com",
      mailServerIpv4: process.env.MAIL_SERVER_IPV4 || "",
      mailServerIpv6: process.env.MAIL_SERVER_IPV6 || ""
    }
  }));

  app.use(createMailboxRoutes({ pool, mailServerApi, auditLog }));
  app.use(createSecurityRoutes({ pool, worker, auditLog }));

  app.use((req, res) => {
    res.status(404).render("404", { pageTitle: "Not Found" });
  });

  app.use((err, req, res, next) => {
    // eslint-disable-next-line no-unused-vars
    console.error("[error]", err);
    if (res.headersSent) {
      return next(err);
    }
    return res.status(500).render("500", { pageTitle: "Server Error", errorMessage: err.message });
  });

  const server = app.listen(PANEL_PORT, PANEL_HOST, () => {
    console.log(`[startup] Panel listening at http://${PANEL_HOST}:${PANEL_PORT}`);
  });

  worker.start();

  async function shutdown(signal) {
    console.log(`[shutdown] Received ${signal}`);
    worker.stop();
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  console.error("Startup failed:", err.message);
  process.exit(1);
});
