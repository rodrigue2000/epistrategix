const express = require('express');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');

const router = express.Router();

router.get('/kpi', verifyToken, isAdmin, async (req, res) => {
  try {
    const servicesSnap = await db.collection('services').get();
    const totalServices = servicesSnap.size;

    const txSnap = await db.collection('transactions').get();
    let totalRevenue = 0;
    let totalTransactions = 0;
    txSnap.forEach(doc => {
      const data = doc.data();
      if (data.status === 'approved') {
        totalRevenue += data.amount || 0;
        totalTransactions++;
      }
    });

    const resSnap = await db.collection('reservations').get();
    let pending = 0, paid = 0, confirmed = 0, cancelled = 0;
    resSnap.forEach(doc => {
      const status = doc.data().status || 'pending';
      if (status === 'pending') pending++;
      else if (status === 'paid') paid++;
      else if (status === 'confirmed') confirmed++;
      else if (status === 'cancelled') cancelled++;
    });

    res.json({
      totalServices,
      totalRevenue: totalRevenue.toFixed(2),
      totalTransactions,
      reservations: { pending, paid, confirmed, cancelled },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reservations/export', verifyToken, isAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('reservations')
      .orderBy('createdAt', 'desc')
      .get();
    const reservations = [];
    snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));
    res.json(reservations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ===== BLOCAGE MANUEL D'UN CRÉNEAU =====
router.post('/block', verifyToken, isAdmin, async (req, res) => {
  const { date, time, reason } = req.body;
  
  if (!date || !time) {
    return res.status(400).json({ error: 'Date et heure requises' });
  }
  
  try {
    const block = {
      date,
      time,
      reason: reason || 'Blocage manuel',
      createdAt: new Date().toISOString(),
      createdBy: req.user.uid,
    };
    
    const docRef = await db.collection('blocks').add(block);
    res.status(201).json({ id: docRef.id, ...block });
  } catch (error) {
    console.error('Erreur blocage:', error);
    res.status(500).json({ error: error.message });
  }
});
module.exports = router;