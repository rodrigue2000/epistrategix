const express = require('express');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');

const router = express.Router();

// ============================================================
// 1. KPI - Indicateurs clés
// ============================================================
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
    console.error('❌ Erreur KPI:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. EXPORT DES RÉSERVATIONS
// ============================================================
router.get('/reservations/export', verifyToken, isAdmin, async (req, res) => {
  try {
    const { filter } = req.query;
    console.log('🔍 Export réservations - Token valide - Filtre:', filter || 'paid (défaut)');
    console.log('👤 User ID:', req.user?.uid);

    let query = db.collection('reservations').orderBy('createdAt', 'desc');

    // ✅ Le filtre est maintenant réellement appliqué : par défaut on ne
    // renvoie que les réservations payées ; ?filter=all renvoie tout.
    if (filter !== 'all') {
      query = query.where('status', '==', 'paid');
    }

    const snapshot = await query.get();
    const reservations = [];
    snapshot.forEach(doc => reservations.push({ id: doc.id, ...doc.data() }));
    console.log(`✅ ${reservations.length} réservations exportées`);
    res.json(reservations);
  } catch (error) {
    console.error('❌ Erreur export réservations:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 3. RÉCUPÉRER UNE RÉSERVATION PAR ID
// ============================================================
router.get('/reservations/:id', verifyToken, isAdmin, async (req, res) => {
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
// 4. METTRE À JOUR LE STATUT D'UNE RÉSERVATION
// ============================================================
router.put('/reservations/:id/status', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  try {
    const doc = await db.collection('reservations').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Réservation non trouvée' });
    }
    const reservation = doc.data();

    const serviceDoc = await db.collection('services').doc(reservation.serviceId).get();
    const serviceName = serviceDoc.exists ? serviceDoc.data().name : 'Service';

    await db.collection('reservations').doc(id).update({
      status: status,
      updatedAt: new Date().toISOString()
    });

    const statusText = status === 'confirmed' ? 'confirmée ✅' : 'annulée ❌';
    const message = `
${status === 'confirmed' ? '✅' : '❌'} Votre réservation a été ${statusText} !

📋 Service : ${serviceName}
📅 Date : ${reservation.date}
⏰ Heure : ${reservation.time}
👤 Client : ${reservation.clientName}

${status === 'confirmed' ? 'Merci pour votre confiance ! 🙏' : 'Nous sommes désolés pour ce contretemps.'}
    `.trim();

    const phone = (reservation.clientPhone || '').replace(/[\s\-\(\)]/g, '');
    const whatsappLink = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : null;

    res.json({
      success: true,
      message: `Réservation ${status}`,
      status: status,
      whatsapp: {
        link: whatsappLink,
        message: message,
        phone: phone
      }
    });

  } catch (error) {
    console.error('❌ Erreur mise à jour statut:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 5. BLOCAGE MANUEL (PLAGE HORAIRE)
// ============================================================
router.post('/block', verifyToken, isAdmin, async (req, res) => {
  const { date, startTime, endTime, reason } = req.body;

  if (!date || !startTime || !endTime) {
    return res.status(400).json({
      error: 'Date, heure de début et heure de fin requises'
    });
  }

  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);
  const startTotal = startH * 60 + startM;
  const endTotal = endH * 60 + endM;

  if (startTotal >= endTotal) {
    return res.status(400).json({
      error: 'L\'heure de début doit être avant l\'heure de fin'
    });
  }

  try {
    const block = {
      date,
      startTime,
      endTime,
      reason: reason || 'Blocage administratif',
      createdAt: new Date().toISOString(),
      createdBy: req.user.uid,
    };

    const docRef = await db.collection('blocks').add(block);
    res.status(201).json({ id: docRef.id, ...block });
  } catch (error) {
    console.error('❌ Erreur blocage:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 6. LISTER LES BLOCAGES
// ============================================================
router.get('/blocks', verifyToken, isAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('blocks')
      .orderBy('date', 'asc')
      .get();
    const blocks = [];
    snapshot.forEach(doc => blocks.push({ id: doc.id, ...doc.data() }));
    res.json(blocks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 7. SUPPRIMER UN BLOCAGE
// ============================================================
router.delete('/block/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('blocks').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Blocage non trouvé' });
    }
    await db.collection('blocks').doc(id).delete();
    res.json({ message: 'Blocage supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 8. GÉNÉRER UN LIEN WHATSAPP
// ============================================================
router.get('/whatsapp-link/:reservationId/:status', verifyToken, isAdmin, async (req, res) => {
  const { reservationId, status } = req.params;

  if (!['confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  try {
    const doc = await db.collection('reservations').doc(reservationId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Réservation non trouvée' });
    }
    const reservation = doc.data();

    const serviceDoc = await db.collection('services').doc(reservation.serviceId).get();
    const serviceName = serviceDoc.exists ? serviceDoc.data().name : 'Service';

    const statusText = status === 'confirmed' ? 'confirmée ✅' : 'annulée ❌';
    const message = `
${status === 'confirmed' ? '✅' : '❌'} Votre réservation a été ${statusText} !

📋 Service : ${serviceName}
📅 Date : ${reservation.date}
⏰ Heure : ${reservation.time}
👤 Client : ${reservation.clientName}

${status === 'confirmed' ? 'Merci pour votre confiance ! 🙏' : 'Nous sommes désolés pour ce contretemps.'}
    `.trim();

    const phone = (reservation.clientPhone || '').replace(/[\s\-\(\)]/g, '');
    const whatsappLink = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : null;

    res.json({
      success: true,
      whatsappLink: whatsappLink,
      message: message,
      phone: phone,
      reservation: reservation,
      serviceName: serviceName
    });

  } catch (error) {
    console.error('❌ Erreur génération lien WhatsApp:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
