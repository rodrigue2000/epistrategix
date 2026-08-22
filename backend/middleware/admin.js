const { db } = require('../config/firebase');

const isAdmin = async (req, res, next) => {
  const uid = req.user.uid;
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(403).json({ error: 'Accès administrateur requis' });
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Erreur vérification rôle' });
  }
};

module.exports = isAdmin;