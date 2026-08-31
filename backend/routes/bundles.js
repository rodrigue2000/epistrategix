const express = require('express');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');
const fedapay = require('../config/fedapay');
const { paymentLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// ============================================================
// 1. LISTER TOUS LES PACKS (public) - avec le détail des contenus inclus
// ============================================================
router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection('bundles').get();
    const bundles = [];

    for (const doc of snapshot.docs) {
      const bundle = { id: doc.id, ...doc.data() };

      // Récupérer les infos (titre, type) de chaque contenu inclus,
      // pour que le client sache ce qu'il achète avant de payer.
      const items = [];
      for (const contentId of bundle.contentIds || []) {
        const contentDoc = await db.collection('contents').doc(contentId).get();
        if (contentDoc.exists) {
          const c = contentDoc.data();
          items.push({ id: contentId, title: c.title, type: c.type });
        }
      }
      bundle.items = items;
      bundles.push(bundle);
    }

    res.json(bundles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. CRÉER UN PACK (admin uniquement)
// ============================================================
router.post('/admin', verifyToken, isAdmin, async (req, res) => {
  const { title, description, priceType, price, contentIds, categoryIds } = req.body;

  if (!title || !Array.isArray(contentIds) || contentIds.length < 2) {
    return res.status(400).json({
      error: 'Titre requis et au moins 2 contenus à inclure dans le pack'
    });
  }

  if (priceType === 'paid' && (!price || price <= 0)) {
    return res.status(400).json({ error: 'Prix requis pour un pack payant' });
  }

  try {
    // Vérifier que tous les contentIds existent bel et bien
    for (const contentId of contentIds) {
      const doc = await db.collection('contents').doc(contentId).get();
      if (!doc.exists) {
        return res.status(400).json({ error: `Contenu introuvable: ${contentId}` });
      }
    }

    const bundle = {
      title,
      description: description || '',
      priceType: priceType || 'paid',
      price: priceType === 'paid' ? parseFloat(price) : null,
      contentIds,
      categoryIds: Array.isArray(categoryIds) ? categoryIds : [],
      createdAt: new Date().toISOString(),
    };

    const docRef = await db.collection('bundles').add(bundle);
    res.status(201).json({ id: docRef.id, ...bundle });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 3bis. MODIFIER UN PACK (admin uniquement)
// ============================================================
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, description, price, contentIds, categoryIds } = req.body;

  try {
    const doc = await db.collection('bundles').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Pack non trouvé' });

    const updates = { updatedAt: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (price !== undefined) updates.price = parseFloat(price);
    if (Array.isArray(contentIds)) {
      if (contentIds.length < 2) {
        return res.status(400).json({ error: 'Un pack doit contenir au moins 2 contenus' });
      }
      updates.contentIds = contentIds;
    }
    if (Array.isArray(categoryIds)) updates.categoryIds = categoryIds;

    await db.collection('bundles').doc(id).update(updates);
    res.json({ message: 'Pack mis à jour', ...updates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 3. SUPPRIMER UN PACK (admin uniquement)
// ============================================================
// Note : supprime uniquement le pack, pas les contenus individuels qui le composent
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('bundles').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Pack non trouvé' });

    await db.collection('bundles').doc(id).delete();
    res.json({ message: 'Pack supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 4. ACHETER UN PACK (via FedaPay)
// ============================================================
router.post('/purchase', paymentLimiter, async (req, res) => {
  const { bundleId, customerName, customerEmail } = req.body;

  if (!bundleId) {
    return res.status(400).json({ error: 'ID du pack requis' });
  }

  try {
    const doc = await db.collection('bundles').doc(bundleId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Pack non trouvé' });
    }

    const bundle = doc.data();

    if (bundle.priceType !== 'paid' || !bundle.price || bundle.price <= 0) {
      return res.status(400).json({ error: 'Ce pack est gratuit ou n\'a pas de prix défini' });
    }

    const amount = bundle.price;
    const response = await fedapay.post('/v1/transactions', {
      amount: Math.round(amount),
      currency: { iso: 'XOF' },
      description: `Achat du pack : ${bundle.title}`,
      customer: {
        email: customerEmail || 'client@exemple.com',
        name: customerName || 'Client',
      },
      callback_url: `${process.env.BASE_URL}/api/bundles/callback`,
      custom_metadata: {
        bundleId: bundleId,
        contentType: 'bundle_purchase',
        bundleTitle: bundle.title,
      },
    });

    const transaction = response.data['v1/transaction'] || response.data;
    const transactionId = String(transaction.id);

    const tokenResponse = await fedapay.post(`/v1/transactions/${transaction.id}/token`);
    const paymentUrl = tokenResponse.data.url;

    if (!paymentUrl) {
      throw new Error('Impossible de générer le lien de paiement FedaPay');
    }

    console.log('✅ Transaction FedaPay créée (pack):', {
      id: transactionId,
      reference: transaction.reference,
      status: transaction.status,
      payment_url: paymentUrl
    });

    await db.collection('transactions').doc(transactionId).set({
      bundleId: bundleId,
      bundleTitle: bundle.title,
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
      bundleTitle: bundle.title,
    });

  } catch (error) {
    console.error('❌ Erreur achat pack:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de l\'achat du pack',
      details: error.response?.data?.message || error.message
    });
  }
});

// ============================================================
// 5. CALLBACK D'ACHAT DE PACK (redirection après paiement)
// ============================================================
router.get('/callback', (req, res) => {
  const { status, id } = req.query;

  if (status === 'success' || status === 'approved') {
    res.redirect(`${process.env.FRONTEND_URL}/confirmation.html?status=success&type=bundle&transaction=${id || ''}`);
  } else {
    res.redirect(`${process.env.FRONTEND_URL}/confirmation.html?status=failed&type=bundle`);
  }
});

// ============================================================
// 6. RÉCUPÉRER LES INFOS D'UN ACHAT DE PACK PAR TRANSACTION (pour confirmation.html)
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

    const bundleId = tx.bundleId;
    if (!bundleId) {
      return res.status(400).json({ error: 'Transaction non liée à un pack' });
    }

    const bundleDoc = await db.collection('bundles').doc(bundleId).get();
    if (!bundleDoc.exists) {
      return res.status(404).json({ error: 'Pack non trouvé' });
    }
    const bundle = bundleDoc.data();

    // Récupérer le détail (titre + url) de chaque contenu du pack
    const items = [];
    for (const contentId of bundle.contentIds || []) {
      const contentDoc = await db.collection('contents').doc(contentId).get();
      if (contentDoc.exists) {
        const c = contentDoc.data();
        items.push({ title: c.title, url: c.url, type: c.type });
      }
    }

    res.json({
      status: 'approved',
      bundleId,
      bundleTitle: bundle.title,
      items,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
