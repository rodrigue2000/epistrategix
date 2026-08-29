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

    // 1. Créer la transaction
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
      // ✅ "metadata" est réservé à l'usage interne de FedaPay (il l'écrase silencieusement,
      //    comme le confirme le log FedaPay : expire_schedule_jobid, paid_customer, etc.)
      //    Les données personnalisées doivent être envoyées dans "custom_metadata".
      custom_metadata: {
        reservationId, // ✅ indispensable pour que le webhook retrouve la réservation
      },
    });

    const transaction = response.data['v1/transaction'];
    if (!transaction || !transaction.id) {
      throw new Error('Réponse FedaPay inattendue: ' + JSON.stringify(response.data));
    }

    // 2. ✅ Générer le VRAI lien de paiement
    // (l'API FedaPay ne renvoie pas d'URL directement à la création de la transaction,
    //  il faut appeler /v1/transactions/{id}/token pour l'obtenir)
    const tokenResponse = await fedapay.post(`/v1/transactions/${transaction.id}/token`);
    const paymentUrl = tokenResponse.data.url;

    if (!paymentUrl) {
      throw new Error('Impossible de générer le lien de paiement FedaPay');
    }

    console.log('✅ Transaction FedaPay créée:', {
      id: transaction.id,
      reference: transaction.reference,
      status: transaction.status,
      payment_url: paymentUrl,
    });

    // 3. Enregistrer la transaction
    await db.collection('transactions').doc(String(transaction.id)).set({
      reservationId,
      amount,
      status: transaction.status,
      fedapayTransaction: transaction,
      paymentUrl,
      createdAt: new Date().toISOString(),
    });

    await db.collection('reservations').doc(reservationId).update({
      transactionId: transaction.id,
      amount,
    });

    res.json({
      transactionId: transaction.id,
      url: paymentUrl, // ✅ vraie URL de paiement
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
