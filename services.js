 const express = require('express');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');

const router = express.Router();

// ============================================================
// 1. LISTER TOUS LES SERVICES (public)
// ============================================================
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

// ============================================================
// 2. RÉCUPÉRER UN SERVICE PAR ID (public)
// ============================================================
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('services').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Service non trouvé' });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 3. CRÉER UN SERVICE (admin uniquement)
// ============================================================
router.post('/', verifyToken, isAdmin, async (req, res) => {
  const { 
    name, 
    description, 
    provider,
    priceType, 
    price, 
    duration,
    // 🆕 Nouveaux champs pour la tarification unitaire
    unitPrice,
    durationUnit,
    minDuration,
    maxDuration
  } = req.body;
  
  // Validation de base
  if (!name || !priceType) {
    return res.status(400).json({ error: 'Nom et type de tarif requis' });
  }
  
  // Validation selon le type de tarif
  if (priceType === 'fixed' && (price === undefined || price < 0)) {
    return res.status(400).json({ error: 'Prix requis pour tarif fixe' });
  }
  
  // Validation pour la tarification unitaire
  if (priceType === 'unit') {
    if (unitPrice === undefined || unitPrice < 0) {
      return res.status(400).json({ error: 'Prix unitaire requis pour tarification à l\'unité' });
    }
    if (!durationUnit || durationUnit < 15) {
      return res.status(400).json({ error: 'Durée d\'unité requise (minimum 15 minutes)' });
    }
    if (!minDuration || minDuration < 1) {
      return res.status(400).json({ error: 'Durée minimale requise (minimum 1 unité)' });
    }
    if (!maxDuration || maxDuration < minDuration) {
      return res.status(400).json({ error: 'Durée maximale doit être supérieure à la durée minimale' });
    }
  }
  
  try {
    const newService = {
      name,
      description: description || '',
      provider: provider || '',
      priceType, // 'fixed', 'free', 'unit'
      price: priceType === 'fixed' ? parseFloat(price) : null,
      duration: duration || 60,
      // 🆕 Champs pour la tarification unitaire
      unitPrice: priceType === 'unit' ? parseFloat(unitPrice) : null,
      durationUnit: priceType === 'unit' ? parseInt(durationUnit) : null,
      minDuration: priceType === 'unit' ? parseInt(minDuration) : null,
      maxDuration: priceType === 'unit' ? parseInt(maxDuration) : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    const docRef = await db.collection('services').add(newService);
    res.status(201).json({ id: docRef.id, ...newService });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 4. MODIFIER UN SERVICE (admin uniquement)
// ============================================================
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  // S'assurer que les champs de tarification unitaire sont cohérents
  if (updates.priceType === 'unit') {
    if (updates.unitPrice === undefined || updates.unitPrice < 0) {
      return res.status(400).json({ error: 'Prix unitaire requis pour tarification à l\'unité' });
    }
    if (!updates.durationUnit || updates.durationUnit < 15) {
      return res.status(400).json({ error: 'Durée d\'unité requise (minimum 15 minutes)' });
    }
    if (!updates.minDuration || updates.minDuration < 1) {
      return res.status(400).json({ error: 'Durée minimale requise (minimum 1 unité)' });
    }
    if (!updates.maxDuration || updates.maxDuration < updates.minDuration) {
      return res.status(400).json({ error: 'Durée maximale doit être supérieure à la durée minimale' });
    }
  }
  
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

// ============================================================
// 5. SUPPRIMER UN SERVICE (admin uniquement)
// ============================================================
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    // Vérifier si le service existe
    const doc = await db.collection('services').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Service non trouvé' });
    }
    await db.collection('services').doc(id).delete();
    res.json({ message: 'Service supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;