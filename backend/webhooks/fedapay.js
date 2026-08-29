const express = require('express');
const crypto = require('crypto');
const { db } = require('../config/firebase');

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-fedapay-signature'];
  const payload = req.body.toString();
  const secret = process.env.FEDAPAY_WEBHOOK_SECRET;

  if (!signature || !secret) {
    console.error('❌ Configuration webhook manquante');
    return res.status(401).send('Configuration manquante');
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  if (signature !== expected) {
    console.error('❌ Signature invalide');
    return res.status(401).send('Invalid signature');
  }

  try {
    const event = JSON.parse(payload);
    const transaction = event.data['v1/transaction'] || event.data;

    console.log(`📦 Webhook reçu: ${event.name} - Transaction: ${transaction.id}`);

    if (event.name === 'transaction.approved') {
      const amount = transaction.amount;
      const transactionId = String(transaction.id);

      // ✅ Mettre à jour la transaction
      await db.collection('transactions').doc(transactionId).update({
        status: 'approved',
        amount: amount,
        updatedAt: new Date().toISOString(),
      });
      console.log(`✅ Transaction ${transactionId} approuvée - Montant: ${amount}`);

      // ✅ IMPORTANT : les données personnalisées sont dans "custom_metadata",
      //    pas dans "metadata" (réservé à l'usage interne de FedaPay).
      const metadata = transaction.custom_metadata || {};
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

      // ✅ Pour les achats de contenu
      if (metadata.contentType === 'content_purchase' && metadata.contentId) {
        await db.collection('purchased_content').add({
          contentId: metadata.contentId,
          contentTitle: metadata.contentTitle || 'Contenu',
          transactionId: transactionId,
          amount: amount,
          purchasedAt: new Date().toISOString(),
        });
        console.log(`✅ Contenu ${metadata.contentId} acheté`);
      }
    } else if (event.name === 'transaction.declined') {
      await db.collection('transactions').doc(String(transaction.id)).update({
        status: 'declined',
        updatedAt: new Date().toISOString(),
      });
      console.log(`⚠️ Transaction ${transaction.id} déclinée`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    res.sendStatus(500);
  }
});

module.exports = router;
