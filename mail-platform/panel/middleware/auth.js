function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect("/login");
  }
  return next();
}

function requireGuest(req, res, next) {
  if (req.session && req.session.user) {
    return res.redirect("/domains");
  }
  return next();
}

module.exports = {
  requireAuth,
  requireGuest
};