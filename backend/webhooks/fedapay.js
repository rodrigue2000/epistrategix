const express = require('express');
const { Webhook } = require('fedapay');
const { db } = require('../config/firebase');

const router = express.Router();

// ✅ Le secret est spécifique à CETTE URL de webhook (visible dans le
//    dashboard FedaPay → Webhooks → sélectionner l'endpoint → "Click to reveal")
const endpointSecret = process.env.FEDAPAY_WEBHOOK_SECRET;

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-fedapay-signature'];

  if (!signature || !endpointSecret) {
    console.error('❌ Configuration webhook manquante');
    return res.status(401).send('Configuration manquante');
  }

  let event;
  try {
    // ✅ Utilise la librairie officielle FedaPay pour vérifier la signature.
    //    Elle gère correctement le timestamp inclus dans X-FEDAPAY-SIGNATURE,
    //    qu'un calcul HMAC manuel ne reproduit pas fidèlement.
    event = Webhook.constructEvent(req.body, signature, endpointSecret);
  } catch (err) {
    console.error('❌ Signature invalide:', err.message);
    return res.status(401).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ✅ La transaction se trouve dans event.entity (pas event.data)
    const transaction = event.entity;
    const transactionId = String(transaction.id);
    const metadata = transaction.custom_metadata || {};

    console.log(`📦 Webhook reçu: ${event.name} - Transaction: ${transactionId}`);

    // ✅ IMPORTANT : le même compte FedaPay peut être partagé entre plusieurs
    // projets (chacun avec son propre webhook enregistré). FedaPay envoie
    // l'événement à TOUS les webhooks du compte pour CHAQUE transaction,
    // qu'elle appartienne à ce projet ou non. On ignore donc silencieusement
    // toute transaction qui ne porte pas les métadonnées propres à EpiStrategix,
    // au lieu d'essayer de mettre à jour un document Firestore qui n'existe
    // pas ici (ce qui provoquait une erreur avant ce correctif).
    const belongsToEpiStrategix = !!(metadata.reservationId || metadata.contentId || metadata.bundleId || metadata.sessionId || metadata.courseId);
    if (!belongsToEpiStrategix) {
      console.log(`ℹ️ Transaction ${transactionId} ignorée — ne concerne pas EpiStrategix (compte FedaPay partagé)`);
      return res.status(200).json({ received: true, ignored: true });
    }

    if (event.name === 'transaction.approved') {
      // ✅ IDEMPOTENCE : si cette transaction est déjà marquée "approved",
      // on ne retraite pas l'événement (FedaPay peut renvoyer le même
      // webhook plusieurs fois en cas de retry réseau).
      const txDoc = await db.collection('transactions').doc(transactionId).get();
      if (txDoc.exists && txDoc.data().status === 'approved') {
        console.log(`ℹ️ Transaction ${transactionId} déjà traitée, on ignore ce doublon`);
        return res.status(200).json({ received: true, duplicate: true });
      }

      const amount = transaction.amount;

      // ✅ set(..., { merge: true }) au lieu de update() : reste robuste même
      // si le document n'existait pas encore pour une raison quelconque,
      // au lieu de planter avec une erreur Firestore NOT_FOUND.
      await db.collection('transactions').doc(transactionId).set({
        status: 'approved',
        amount: amount,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      console.log(`✅ Transaction ${transactionId} approuvée - Montant: ${amount}`);

      const reservationId = metadata.reservationId;

      // ✅ Pour les réservations
      if (reservationId) {
        await db.collection('reservations').doc(reservationId).update({
          status: 'paid',
          amount: amount,
          paidAt: new Date().toISOString(),
        });
        console.log(`✅ Réservation ${reservationId} marquée comme payée`);
      }

      // ✅ Pour les achats de contenu unique
      if (metadata.contentType === 'content_purchase' && metadata.contentId) {
        await db.collection('purchased_content').doc(transactionId).set({
          contentId: metadata.contentId,
          contentTitle: metadata.contentTitle || 'Contenu',
          transactionId: transactionId,
          amount: amount,
          purchasedAt: new Date().toISOString(),
        });
        console.log(`✅ Contenu ${metadata.contentId} acheté`);
      }

      // ✅ Pour les achats de pack (plusieurs contenus regroupés)
      if (metadata.contentType === 'bundle_purchase' && metadata.bundleId) {
        await db.collection('purchased_bundles').doc(transactionId).set({
          bundleId: metadata.bundleId,
          bundleTitle: metadata.bundleTitle || 'Pack',
          transactionId: transactionId,
          amount: amount,
          purchasedAt: new Date().toISOString(),
        });
        console.log(`✅ Pack ${metadata.bundleId} acheté`);
      }

      // ✅ Pour les inscriptions à une session de formation
      if (metadata.contentType === 'session_purchase' && metadata.sessionId) {
        await db.collection('session_registrations').doc(transactionId).set({
          sessionId: metadata.sessionId,
          sessionTitle: metadata.sessionTitle || 'Session',
          name: metadata.customerName || 'Participant',
          email: transaction.customer?.email || '',
          transactionId: transactionId,
          amount: amount,
          registeredAt: new Date().toISOString(),
        });
        console.log(`✅ Inscription à la session ${metadata.sessionId} confirmée`);
      }

      // ✅ Pour les inscriptions à une formation vidéo (avec suivi de progression)
      if (metadata.contentType === 'course_purchase' && metadata.courseId && metadata.clientUid) {
        await db.collection('enrollments').doc(transactionId).set({
          courseId: metadata.courseId,
          courseTitle: metadata.courseTitle || 'Formation',
          clientUid: metadata.clientUid,
          clientEmail: transaction.customer?.email || '',
          enrolledAt: new Date().toISOString(),
          completed: false,
        });
        console.log(`✅ Inscription à la formation ${metadata.courseId} confirmée pour ${metadata.clientUid}`);
      }
    } else if (event.name === 'transaction.declined' || event.name === 'transaction.canceled') {
      await db.collection('transactions').doc(transactionId).set({
        status: event.name === 'transaction.canceled' ? 'canceled' : 'declined',
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      console.log(`⚠️ Transaction ${transactionId} ${event.name === 'transaction.canceled' ? 'annulée' : 'déclinée'}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Erreur traitement webhook:', error);
    res.sendStatus(500);
  }
});

module.exports = router;
