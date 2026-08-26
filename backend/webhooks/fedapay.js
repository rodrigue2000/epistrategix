 const express = require('express');
const crypto = require('crypto');
const { db } = require('../config/firebase');

const router = express.Router();

// ============================================================
// WEBHOOK FEDAPAY
// ============================================================
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-fedapay-signature'];
  const payload = req.body.toString();
  const secret = process.env.FEDAPAY_WEBHOOK_SECRET;

  console.log('📦 Webhook FedaPay reçu');

  // 1. Vérifier la signature
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
    // ✅ Récupérer la transaction (peut être dans v1/transaction)
    const transaction = event.data['v1/transaction'] || event.data;

    console.log(`📋 Événement reçu: ${event.name} - Transaction: ${transaction.id}`);

    // ✅ Convertir le montant (centimes → FCFA)
    // FedaPay retourne toujours en centimes, donc on divise par 100
    const amountInFCFA = transaction.amount ;

    // ============================================================
    // 2. TRANSACTION APPROUVÉE (paiement réussi)
    // ============================================================
    if (event.name === 'transaction.approved') {
      console.log('✅ Transaction approuvée:', transaction.id);

      // 2.1 Mettre à jour la transaction dans Firestore
      await db.collection('transactions').doc(String(transaction.id)).update({
        status: 'approved',
        amount: amountInFCFA,
        updatedAt: new Date().toISOString(),
        webhookReceivedAt: new Date().toISOString(),
      });
      console.log(`✅ Transaction ${transaction.id} mise à jour (${amountInFCFA} FCFA)`);

      // 2.2 Récupérer les métadonnées
      const metadata = transaction.metadata || {};
      const reservationId = metadata.reservationId;
      const contentType = metadata.contentType;
      const contentId = metadata.contentId;

      // ============================================================
      // 2.3 CAS: Réservation de service
      // ============================================================
      if (reservationId) {
        console.log(`📋 Mise à jour de la réservation: ${reservationId}`);
        
        const reservationDoc = await db.collection('reservations').doc(reservationId).get();
        if (reservationDoc.exists) {
          await db.collection('reservations').doc(reservationId).update({
            status: 'paid',
            amount: amountInFCFA,
            transactionId: String(transaction.id),
            paidAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          console.log(`✅ Réservation ${reservationId} marquée comme payée (${amountInFCFA} FCFA)`);
        } else {
          console.warn(`⚠️ Réservation ${reservationId} non trouvée`);
        }
      }

      // ============================================================
      // 2.4 CAS: Achat de contenu
      // ============================================================
      if (contentType === 'content_purchase' && contentId) {
        console.log(`📋 Achat de contenu: ${contentId}`);
        
        const contentDoc = await db.collection('contents').doc(contentId).get();
        if (contentDoc.exists) {
          const content = contentDoc.data();
          
          await db.collection('purchased_content').add({
            contentId: contentId,
            contentTitle: content.title || 'Contenu',
            transactionId: String(transaction.id),
            customerEmail: transaction.customer?.email || 'client@exemple.com',
            customerName: transaction.customer?.name || 'Client',
            amount: amountInFCFA,
            purchasedAt: new Date().toISOString(),
          });
          console.log(`✅ Contenu ${contentId} acheté avec succès (${amountInFCFA} FCFA)`);
          
          // ✅ Mettre à jour le compteur de ventes (sans admin.firestore)
          await db.collection('contents').doc(contentId).update({
            salesCount: (content.salesCount || 0) + 1,
            updatedAt: new Date().toISOString(),
          });
        } else {
          console.warn(`⚠️ Contenu ${contentId} non trouvé`);
        }
      }

      // ============================================================
      // 2.5 CAS: Autre type de transaction
      // ============================================================
      if (!reservationId && !contentId) {
        console.log('ℹ️ Transaction sans réservation ni contenu associé');
      }

    // ============================================================
    // 3. TRANSACTION DÉCLINÉE
    // ============================================================
    } else if (event.name === 'transaction.declined') {
      console.log(`⚠️ Transaction déclinée: ${transaction.id}`);
      
      await db.collection('transactions').doc(String(transaction.id)).update({
        status: 'declined',
        updatedAt: new Date().toISOString(),
        webhookReceivedAt: new Date().toISOString(),
      });
      console.log('✅ Transaction marquée comme déclinée');

    // ============================================================
    // 4. AUTRES ÉVÉNEMENTS
    // ============================================================
    } else if (event.name === 'transaction.created') {
      console.log(`📋 Transaction créée: ${transaction.id}`);
      
    } else if (event.name === 'transaction.refunded') {
      console.log(`💰 Transaction remboursée: ${transaction.id}`);
      await db.collection('transactions').doc(String(transaction.id)).update({
        status: 'refunded',
        updatedAt: new Date().toISOString(),
      });
      
    } else {
      console.log(`ℹ️ Événement non géré: ${event.name}`);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error('❌ Erreur webhook:', error.message);
    console.error('📋 Stack:', error.stack);
    res.sendStatus(500);
  }
});

// ============================================================
// ROUTE DE TEST DU WEBHOOK
// ============================================================
router.get('/test', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Webhook FedaPay fonctionnel',
    timestamp: new Date().toISOString(),
    config: {
      hasWebhookSecret: !!process.env.FEDAPAY_WEBHOOK_SECRET,
      environment: process.env.NODE_ENV || 'development'
    }
  });
});

module.exports = router;