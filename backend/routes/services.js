const express = require('express');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');

const router = express.Router();

// GET /api/services - public
router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection('services').get();
    const services = [];
    snapshot.forEach(doc => services.push({ id: doc.id, ...doc.data() }));
    res.json(services);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/services - admin only
router.post('/', verifyToken, isAdmin, async (req, res) => {
  const { name, description, priceType, price, duration } = req.body;
  if (!name || !priceType) {
    return res.status(400).json({ error: 'Nom et type de tarif requis' });
  }
  if (priceType === 'fixed' && (price === undefined || price < 0)) {
    return res.status(400).json({ error: 'Prix requis pour tarif fixe' });
  }
  try {
    const newService = {
      name,
      description: description || '',
      priceType,
      price: priceType === 'fixed' ? parseFloat(price) : null,
      duration: duration || 60,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const docRef = await db.collection('services').add(newService);
    res.status(201).json({ id: docRef.id, ...newService });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/services/:id - admin only
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  try {
    await db.collection('services').doc(id).update({
      ...updates,
      updatedAt: new Date().toISOString(),
    });
    res.json({ message: 'Service mis à jour' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/services/:id - admin only
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await db.collection('services').doc(id).delete();
    res.json({ message: 'Service supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;