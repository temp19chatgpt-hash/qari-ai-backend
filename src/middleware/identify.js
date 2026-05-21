/**
 * Middleware to extract user identity from the QF OAuth JWT.
 * Decodes (but does NOT verify) the token to get the 'sub' claim.
 * For a hackathon context, this is sufficient — the token came from QF's OAuth flow.
 */
function parseJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      Buffer.from(base64, 'base64')
        .toString()
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function identifyUser(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const decoded = parseJwt(token);

    if (decoded && decoded.exp && decoded.exp * 1000 < Date.now()) {
      return res.status(401).json({ error: 'token_expired', message: 'User access token has expired' });
    }

    if (decoded && decoded.sub) {
      req.userId = decoded.sub;
      req.token = token;
      req.userName = decoded.name || decoded.preferred_username || decoded.nickname || decoded.given_name || (decoded.email ? decoded.email.split('@')[0] : 'Student');
      req.userEmail = decoded.email || '';
    } else {
      req.userId = 'guest';
      req.userName = 'Guest';
      req.userEmail = '';
    }
  } else {
    req.userId = 'guest';
    req.userName = 'Guest';
    req.userEmail = '';
  }

  next();
}

module.exports = { identifyUser };
