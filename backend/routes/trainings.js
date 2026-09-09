const express = require('express');
const crypto = require('crypto');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');
const fedapay = require('../config/fedapay');
const { paymentLimiter } = require('../middleware/rateLimiter');
const { sendEmail } = require('../config/email');

const router = express.Router();

// ============================================================
// 1. LISTER LES SESSIONS (public) - avec places restantes calculées
// ============================================================
router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection('training_sessions').orderBy('date', 'asc').get();
    const sessions = [];

    for (const doc of snapshot.docs) {
      const session = { id: doc.id, ...doc.data() };

      const regSnapshot = await db.collection('session_registrations')
        .where('sessionId', '==', doc.id)
        .get();

      session.registeredCount = regSnapshot.size;
      session.spotsRemaining = Math.max(0, session.maxParticipants - regSnapshot.size);
      session.registrationClosed = new Date(session.registrationDeadline) < new Date();

      // ✅ Ne jamais exposer le nom de la salle Jitsi publiquement avant paiement
      delete session.jitsiRoomName;

      sessions.push(session);
    }

    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. CRÉER UNE SESSION (admin uniquement)
// ============================================================
router.post('/admin', verifyToken, isAdmin, async (req, res) => {
  const {
    title, description, date, time, durationMinutes,
    priceType, price, promoEnabled, originalPrice,
    maxParticipants, registrationDeadline,
  } = req.body;

  if (!title || !date || !time || !maxParticipants || !registrationDeadline) {
    return res.status(400).json({
      error: 'Titre, date, heure, nombre max de participants et date limite d\'inscription requis'
    });
  }

  if (maxParticipants < 1) {
    return res.status(400).json({ error: 'Le nombre de participants doit être d\'au moins 1' });
  }

  if (promoEnabled && (!originalPrice || parseFloat(originalPrice) <= parseFloat(price))) {
    return res.status(400).json({ error: 'Le prix normal doit être supérieur au prix promo' });
  }

  try {
    // ✅ Nom de salle Jitsi unique et non-devinable (sécurité par obscurité,
    // en complément — pas en remplacement — de la salle d'attente Jitsi)
    const jitsiRoomName = `epistrategix-${crypto.randomBytes(12).toString('hex')}`;

    const session = {
      title,
      description: description || '',
      date, // format YYYY-MM-DD
      time, // format HH:MM
      durationMinutes: durationMinutes || 120,
      priceType: priceType || 'paid',
      price: priceType === 'free' ? 0 : parseFloat(price),
      promoEnabled: !!promoEnabled,
      originalPrice: promoEnabled ? parseFloat(originalPrice) : null,
      maxParticipants: parseInt(maxParticipants),
      registrationDeadline, // ISO datetime string
      jitsiRoomName,
      reminderSentAt: null,
      createdAt: new Date().toISOString(),
    };

    const docRef = await db.collection('training_sessions').add(session);
    res.status(201).json({ id: docRef.id, ...session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 3. MODIFIER UNE SESSION (admin uniquement)
// ============================================================
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    title, description, date, time, durationMinutes,
    price, promoEnabled, originalPrice,
    maxParticipants, registrationDeadline,
  } = req.body;

  if (promoEnabled && (!originalPrice || parseFloat(originalPrice) <= parseFloat(price))) {
    return res.status(400).json({ error: 'Le prix normal doit être supérieur au prix promo' });
  }

  try {
    const doc = await db.collection('training_sessions').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Session non trouvée' });

    const updates = { updatedAt: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (date !== undefined) updates.date = date;
    if (time !== undefined) updates.time = time;
    if (durationMinutes !== undefined) updates.durationMinutes = durationMinutes;
    if (price !== undefined) updates.price = parseFloat(price);
    if (maxParticipants !== undefined) updates.maxParticipants = parseInt(maxParticipants);
    if (registrationDeadline !== undefined) updates.registrationDeadline = registrationDeadline;
    updates.promoEnabled = !!promoEnabled;
    updates.originalPrice = promoEnabled ? parseFloat(originalPrice) : null;

    await db.collection('training_sessions').doc(id).update(updates);
    res.json({ message: 'Session mise à jour', ...updates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 4. SUPPRIMER UNE SESSION (admin uniquement)
// ============================================================
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('training_sessions').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Session non trouvée' });

    await db.collection('training_sessions').doc(id).delete();
    res.json({ message: 'Session supprimée' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 5. LISTER LES INSCRITS D'UNE SESSION (admin uniquement)
// ============================================================
// ✅ C'est cette liste que l'admin compare visuellement aux demandes
// d'entrée dans la salle d'attente Jitsi le jour de la session.
router.get('/:id/registrations', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const sessionDoc = await db.collection('training_sessions').doc(id).get();
    if (!sessionDoc.exists) return res.status(404).json({ error: 'Session non trouvée' });

    const snapshot = await db.collection('session_registrations')
      .where('sessionId', '==', id)
      .orderBy('registeredAt', 'asc')
      .get();

    const registrations = [];
    snapshot.forEach(doc => registrations.push({ id: doc.id, ...doc.data() }));

    res.json({
      session: { id: sessionDoc.id, ...sessionDoc.data() },
      registrations,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 6. ACHETER UNE PLACE (public)
// ============================================================
router.post('/purchase', paymentLimiter, async (req, res) => {
  const { sessionId, customerName, customerEmail } = req.body;

  if (!sessionId || !customerName || !customerName.trim()) {
    return res.status(400).json({ error: 'Nom complet et session requis' });
  }

  if (!customerEmail || !customerEmail.includes('@')) {
    return res.status(400).json({ error: 'Un email valide est requis pour recevoir l\'accès à la session' });
  }

  try {
    const sessionDoc = await db.collection('training_sessions').doc(sessionId).get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ error: 'Session non trouvée' });
    }
    const session = sessionDoc.data();

    // ✅ Vérifier le délai d'inscription
    if (new Date(session.registrationDeadline) < new Date()) {
      return res.status(400).json({ error: 'Les inscriptions pour cette session sont closes' });
    }

    // ✅ Vérifier les places disponibles avant de lancer le paiement.
    // Note : à très forte concurrence sur la toute dernière place, une
    // légère fenêtre de survente reste possible (vérification non-atomique
    // avec le paiement) — acceptable ici vu les volumes et la vérification
    // manuelle des inscrits le jour de la session.
    const regSnapshot = await db.collection('session_registrations')
      .where('sessionId', '==', sessionId)
      .get();

    if (regSnapshot.size >= session.maxParticipants) {
      return res.status(400).json({ error: 'Cette session est complète' });
    }

    const amount = session.price;

    if (amount <= 0) {
      return res.status(400).json({ error: 'Cette session est gratuite, aucun paiement requis' });
    }

    const response = await fedapay.post('/v1/transactions', {
      amount: Math.round(amount),
      currency: { iso: 'XOF' },
      description: `Inscription à la formation : ${session.title}`,
      customer: {
        email: customerEmail,
        name: customerName,
      },
      callback_url: `${process.env.BASE_URL}/api/trainings/callback`,
      custom_metadata: {
        sessionId,
        contentType: 'session_purchase',
        sessionTitle: session.title,
        customerName: customerName.trim(),
      },
    });

    const transaction = response.data['v1/transaction'] || response.data;
    const transactionId = String(transaction.id);

    const tokenResponse = await fedapay.post(`/v1/transactions/${transaction.id}/token`);
    const paymentUrl = tokenResponse.data.url;

    if (!paymentUrl) {
      throw new Error('Impossible de générer le lien de paiement FedaPay');
    }

    console.log('✅ Transaction FedaPay créée (session):', {
      id: transactionId,
      reference: transaction.reference,
      payment_url: paymentUrl
    });

    await db.collection('transactions').doc(transactionId).set({
      sessionId,
      sessionTitle: session.title,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim().toLowerCase(),
      amount: amount,
      status: transaction.status || 'pending',
      fedapayTransaction: transaction,
      paymentUrl,
      createdAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      transactionId: transactionId,
      url: paymentUrl,
      sessionTitle: session.title,
    });

  } catch (error) {
    console.error('❌ Erreur achat session:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de l\'inscription à la session',
      details: error.response?.data?.message || error.message
    });
  }
});

// ============================================================
// 7. CALLBACK (redirection après paiement)
// ============================================================
router.get('/callback', (req, res) => {
  const { status, id } = req.query;

  if (status === 'success' || status === 'approved') {
    res.redirect(`${process.env.FRONTEND_URL}/confirmation.html?status=success&type=session&transaction=${id || ''}`);
  } else {
    res.redirect(`${process.env.FRONTEND_URL}/confirmation.html?status=failed&type=session`);
  }
});

// ============================================================
// 8. RÉCUPÉRER LES INFOS D'INSCRIPTION PAR TRANSACTION (pour confirmation.html)
// ============================================================
router.get('/transaction/:transactionId', async (req, res) => {
  const { transactionId } = req.params;
  try {
    const txDoc = await db.collection('transactions').doc(transactionId).get();
    if (!txDoc.exists) {
      return res.status(404).json({ error: 'Transaction non trouvée' });
    }
    const tx = txDoc.data();

    if (tx.status !== 'approved') {
      return res.json({ status: tx.status || 'pending' });
    }

    const sessionId = tx.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'Transaction non liée à une session' });
    }

    const sessionDoc = await db.collection('training_sessions').doc(sessionId).get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ error: 'Session non trouvée' });
    }
    const session = sessionDoc.data();

    res.json({
      status: 'approved',
      sessionTitle: session.title,
      date: session.date,
      time: session.time,
      jitsiUrl: `https://meet.jit.si/${session.jitsiRoomName}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 9. ENVOYER LES RAPPELS 24H AVANT (appelé par un cron externe)
// ============================================================
// ✅ Protégé par une clé secrète passée en query param, puisqu'il n'y a
// pas d'authentification admin pour un appel automatisé externe.
router.get('/send-reminders', async (req, res) => {
  const { secret } = req.query;
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const snapshot = await db.collection('training_sessions').get();
    let remindersSent = 0;

    for (const doc of snapshot.docs) {
      const session = doc.data();
      const sessionDateTime = new Date(`${session.date}T${session.time}`);

      // ✅ Fenêtre d'1h : ce endpoint est appelé toutes les heures par le cron,
      // donc chaque session ne sera "dans la fenêtre" qu'une seule fois.
      const isInReminderWindow = sessionDateTime >= in24h && sessionDateTime <= in25h;

      if (isInReminderWindow && !session.reminderSentAt) {
        const regSnapshot = await db.collection('session_registrations')
          .where('sessionId', '==', doc.id)
          .get();

        for (const regDoc of regSnapshot.docs) {
          const reg = regDoc.data();
          try {
            await sendEmail({
              to: reg.email,
              subject: `Rappel : votre session "${session.title}" commence dans 24h`,
              html: `
                <p>Bonjour ${reg.name},</p>
                <p>Petit rappel : votre session de formation <strong>${session.title}</strong>
                commence demain à ${session.time}.</p>
                <p><a href="https://meet.jit.si/${session.jitsiRoomName}">Rejoindre la session</a></p>
                <p>Vous devrez patienter dans la salle d'attente le temps que l'hôte valide votre entrée.</p>
              `,
            });
          } catch (emailError) {
            console.error(`❌ Erreur envoi rappel à ${reg.email}:`, emailError.message);
          }
        }

        await db.collection('training_sessions').doc(doc.id).update({
          reminderSentAt: new Date().toISOString(),
        });
        remindersSent += regSnapshot.size;
      }
    }

    res.json({ success: true, remindersSent });
  } catch (error) {
    console.error('❌ Erreur envoi rappels:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
