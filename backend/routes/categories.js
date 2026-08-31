const express = require('express');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');

const router = express.Router();

// ============================================================
// 1. LISTER TOUTES LES CATÉGORIES (public)
// ============================================================
router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection('categories').get();
    const categories = [];
    snapshot.forEach(doc => categories.push({ id: doc.id, ...doc.data() }));
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. CRÉER UNE CATÉGORIE (admin uniquement)
// ============================================================
router.post('/', verifyToken, isAdmin, async (req, res) => {
  const { name, description } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nom de catégorie requis' });
  }

  try {
    const category = {
      name: name.trim(),
      description: description || '',
      createdAt: new Date().toISOString(),
    };
    const docRef = await db.collection('categories').add(category);
    res.status(201).json({ id: docRef.id, ...category });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 3. SUPPRIMER UNE CATÉGORIE (admin uniquement)
// ============================================================
// Note : ne supprime pas les contenus/packs qui y étaient rattachés,
// ils redeviennent simplement "non classés" pour cette catégorie.
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('categories').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Catégorie non trouvée' });

    await db.collection('categories').doc(id).delete();
    res.json({ message: 'Catégorie supprimée' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
