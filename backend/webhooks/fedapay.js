const express = require('express');
const crypto = require('crypto');
const { db } = require('../config/firebase');

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-fedapay-signature'];
  const payload = req.body.toString();
  const secret = process.env.FEDAPAY_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return res.status(401).send('Configuration manquante');
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  if (signature !== expected) {
    console.error('Signature invalide');
    return res.status(401).send('Invalid signature');
  }

  try {
    const event = JSON.parse(payload);
    const transaction = event.data;

    if (event.name === 'transaction.approved') {
      await db.collection('transactions').doc(transaction.id).update({
        status: 'approved',
        updatedAt: new Date().toISOString(),
      });

      const metadata = transaction.metadata || {};
      const reservationId = metadata.reservationId;
      if (reservationId) {
        await db.collection('reservations').doc(reservationId).update({
          status: 'paid',
          updatedAt: new Date().toISOString(),
        });
      }
    } else if (event.name === 'transaction.declined') {
      await db.collection('transactions').doc(transaction.id).update({
        status: 'declined',
        updatedAt: new Date().toISOString(),
      });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Erreur webhook:', error);
    res.sendStatus(500);
  }
});

module.exports = router;