 const express = require('express');
const { db } = require('../config/firebase');
const fedapay = require('../config/fedapay');

const router = express.Router();

router.post('/initiate', async (req, res) => {
  const { reservationId, amount, customerEmail, customerName, serviceName } = req.body;
  if (!reservationId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Données de paiement invalides' });
  }

  try {
    const nameParts = (customerName || 'Client').trim().split(' ');
    const firstname = nameParts[0];
    const lastname = nameParts.slice(1).join(' ') || 'Client';

    const response = await fedapay.post('/v1/transactions', {
      amount: Math.round(amount),
      currency: { iso: 'XOF' },
      description: `Paiement pour ${serviceName || 'service'}`,
      customer: {
        email: customerEmail || 'client@exemple.com',
        firstname,
        lastname,
      },
      callback_url: `${process.env.BASE_URL}/api/payments/callback`,
      metadata: {
        reservationId,
      },
    });

    const transaction = response.data;

    await db.collection('transactions').doc(String(transaction.id)).set({
      reservationId,
      amount,
      status: transaction.status,
      fedapayTransaction: transaction,
      createdAt: new Date().toISOString(),
    });

    await db.collection('reservations').doc(reservationId).update({
      transactionId: transaction.id,
      amount,
    });

    res.json({
      transactionId: transaction.id,
      url: transaction.url,
    });
  } catch (error) {
    console.error('Erreur FedaPay - status:', error.response?.status);
    console.error('Erreur FedaPay - data:', JSON.stringify(error.response?.data));
    console.error('Erreur FedaPay - message:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'initialisation du paiement' });
  }
});

router.get('/callback', async (req, res) => {
  res.redirect(`${process.env.FRONTEND_URL}/confirmation.html?status=success`);
});

module.exports = router;