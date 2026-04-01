const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'prospecflow-secret-change-in-production';

function generateToken(userId, role = 'client') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Token inválido ou expirado' });

  req.userId = decoded.userId;
  req.userRole = decoded.role;
  next();
}

function adminMiddleware(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

module.exports = { generateToken, verifyToken, authMiddleware, adminMiddleware };
