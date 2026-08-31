const express = require('express');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');
const { checkAvailability, getAvailableSlots } = require('../utils/availability');
const { reservationLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// ============================================================
// 1. RÉCUPÉRER LES CRÉNEAUX DISPONIBLES
// ============================================================
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

// ============================================================
// 2. CRÉER UNE RÉSERVATION (public)
// ============================================================
router.post('/', reservationLimiter, async (req, res) => {
  const {
    serviceId,
    clientName,
    clientPhone,
    date,
    time,
    durationUnits = 1 // 🆕 Nombre d'unités de temps (par défaut: 1)
  } = req.body;

  // Validation des champs obligatoires
  if (!serviceId || !clientName || !clientPhone || !date || !time) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }

  // Validation de la durée
  if (!durationUnits || durationUnits < 1) {
    return res.status(400).json({ error: 'La durée doit être d\'au moins 1 unité' });
  }

  try {
    // 1. Récupérer le service pour calculer le montant
    const serviceDoc = await db.collection('services').doc(serviceId).get();
    if (!serviceDoc.exists) {
      return res.status(404).json({ error: 'Service non trouvé' });
    }
    const service = serviceDoc.data();

    // 2. Calculer le montant total selon le type de tarification
    let amount = 0;
    let durationMinutes = 0;

    if (service.priceType === 'fixed') {
      // Prix fixe
      amount = service.price || 0;
      durationMinutes = service.duration || 60;
    } else if (service.priceType === 'unit') {
      // Prix par unité de temps
      const unitPrice = service.unitPrice || 0;
      const unitDuration = service.durationUnit || 60;
      amount = unitPrice * durationUnits;
      durationMinutes = unitDuration * durationUnits;

      // Vérifier que la durée est dans les limites
      if (durationUnits < (service.minDuration || 1)) {
        return res.status(400).json({
          error: `Durée minimale: ${service.minDuration} unité(s)`
        });
      }
      if (durationUnits > (service.maxDuration || 10)) {
        return res.status(400).json({
          error: `Durée maximale: ${service.maxDuration} unité(s)`
        });
      }
    } else {
      // Prix libre (free)
      amount = 0;
      durationMinutes = service.duration || 60;
    }

    // 3. 🔥 SUPPRESSION DE L'AUTOBLOCAGE
    // Le créneau reste disponible pour d'autres clients
    // On ne vérifie plus checkAvailability()

    // 4. Créer la réservation
    const reservation = {
      serviceId,
      clientName,
      clientPhone,
      date,
      time,
      durationUnits: durationUnits,
      durationMinutes: durationMinutes,
      amount: amount,
      status: 'pending',
      createdAt: new Date().toISOString(),
      serviceName: service.name,
      servicePriceType: service.priceType,
    };

    const docRef = await db.collection('reservations').add(reservation);
    res.status(201).json({
      id: docRef.id,
      ...reservation,
      message: 'Réservation créée avec succès. En attente de paiement.'
    });

  } catch (error) {
    console.error('❌ Erreur création réservation:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 3. LISTER TOUTES LES RÉSERVATIONS (admin uniquement)
// ============================================================
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

// ============================================================
// 4. RÉCUPÉRER UNE RÉSERVATION PAR ID (admin uniquement)
// ============================================================
router.get('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('reservations').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Réservation non trouvée' });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 5. METTRE À JOUR LE STATUT D'UNE RÉSERVATION (admin uniquement)
// ============================================================
router.put('/:id/status', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['pending', 'paid', 'confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  try {
    // Vérifier que la réservation existe
    const doc = await db.collection('reservations').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Réservation non trouvée' });
    }

    await db.collection('reservations').doc(id).update({
      status: status,
      updatedAt: new Date().toISOString()
    });

    res.json({
      message: `Statut mis à jour : ${status}`,
      status: status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 6. SUPPRIMER UNE RÉSERVATION (admin uniquement)
// ============================================================
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('reservations').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Réservation non trouvée' });
    }
    await db.collection('reservations').doc(id).delete();
    res.json({ message: 'Réservation supprimée' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
