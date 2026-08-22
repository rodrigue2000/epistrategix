const express = require('express');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');
const { checkAvailability, getAvailableSlots } = require('../utils/availability');

const router = express.Router();

router.get('/available', async (req, res) => {
  const { date, serviceId } = req.query;
  if (!date || !serviceId) {
    return res.status(400).json({ error: 'Date et serviceId requis' });
  }
  try {
    const slots = await getAvailableSlots(date, serviceId);
    res.json(slots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  const { serviceId, clientName, clientPhone, date, time } = req.body;
  if (!serviceId || !clientName || !clientPhone || !date || !time) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }

  const available = await checkAvailability(date, time, serviceId);
  if (!available) {
    return res.status(409).json({ error: 'Créneau non disponible' });
  }

  try {
    const reservation = {
      serviceId,
      clientName,
      clientPhone,
      date,
      time,
      status: 'pending',
      amount: 0,
      createdAt: new Date().toISOString(),
    };
    const docRef = await db.collection('reservations').add(reservation);
    res.status(201).json({ id: docRef.id, ...reservation });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', verifyToken, isAdmin, async (req, res) => {
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

router.put('/:id/status', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['pending', 'paid', 'confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }
  try {
    await db.collection('reservations').doc(id).update({ status });
    res.json({ message: 'Statut mis à jour' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;