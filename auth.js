function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (!req.session.user.isAdmin) return res.status(403).render('error', {
    title: 'Access denied',
    message: 'Administrator access is required.'
  });
  next();
}

function redirectIfAuth(req, res, next) {
  if (req.session.user) return res.redirect(req.session.user.isAdmin ? '/admin' : '/rankings');
  next();
}

module.exports = { requireAuth, requireAdmin, redirectIfAuth };
