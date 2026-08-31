const express = require('express');
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');
const fedapay = require('../config/fedapay');
const { paymentLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
// ✅ Limite explicite de 100 Mo par fichier (au-delà, Multer renverra une erreur claire
// au lieu de saturer silencieusement le disque éphémère de Render)
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ============================================================
// 1. LISTER TOUS LES CONTENUS (public)
// ============================================================
router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection('contents').get();
    const contents = [];
    snapshot.forEach(doc => contents.push({ id: doc.id, ...doc.data() }));
    res.json(contents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. UPLOADER UN CONTENU (admin uniquement)
// ============================================================
router.post('/upload', verifyToken, isAdmin, (req, res, next) => {
  // ✅ Capture l'erreur Multer (ex: fichier trop volumineux) pour renvoyer
  // un message JSON clair au lieu d'une erreur brute non gérée.
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Fichier trop volumineux (maximum 100 Mo)' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  const { title, description, author, type, solutionType, priceType, price, categoryIds } = req.body;
  const file = req.file;

  if (!title || !file) {
    return res.status(400).json({ error: 'Titre et fichier requis' });
  }

  // ✅ categoryIds arrive en JSON stringifié depuis le FormData (ex: '["id1","id2"]')
  let parsedCategoryIds = [];
  try {
    parsedCategoryIds = categoryIds ? JSON.parse(categoryIds) : [];
    if (!Array.isArray(parsedCategoryIds)) parsedCategoryIds = [];
  } catch (e) {
    parsedCategoryIds = [];
  }

  try {
    const result = await cloudinary.uploader.upload(file.path, {
      resource_type: 'auto',
      folder: 'epistrategix',
      // ✅ Indispensable pour les fichiers "raw" (Word, Excel, PowerPoint, ZIP) :
      // le fichier temporaire créé par Multer n'a pas d'extension, donc sans ceci,
      // Cloudinary livre le fichier sans extension. Résultat : l'appareil de
      // l'utilisateur ne sait pas quel programme utiliser pour l'ouvrir, et le
      // fichier semble "corrompu" alors que son contenu est en fait intact.
      use_filename: true,
      unique_filename: true,
      filename_override: file.originalname,
    });

    const content = {
      title,
      description: description || '',
      author: author || '',
      type: type || 'file',
      solutionType: solutionType || 'autre',
      categoryIds: parsedCategoryIds,
      url: result.secure_url,
      publicId: result.public_id,
      priceType: priceType || 'free',
      price: priceType === 'paid' ? parseFloat(price) : null,
      createdAt: new Date().toISOString(),
    };
    const docRef = await db.collection('contents').add(content);
    res.status(201).json({ id: docRef.id, ...content });
  } catch (error) {
    console.error('Erreur Cloudinary:', error);
    res.status(500).json({ error: 'Erreur lors de l\'upload' });
  }
});

// ============================================================
// 2bis. MODIFIER LES MÉTADONNÉES D'UN CONTENU (admin uniquement)
// ============================================================
// ✅ Ne touche jamais au fichier (url/publicId) — uniquement le titre, la
// description, l'auteur, le prix, le type de solution et les catégories.
// Pour remplacer le fichier lui-même, voir la route POST /:id/replace-file.
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, description, author, solutionType, priceType, price, categoryIds } = req.body;

  try {
    const doc = await db.collection('contents').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Contenu non trouvé' });

    const updates = { updatedAt: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (author !== undefined) updates.author = author;
    if (solutionType !== undefined) updates.solutionType = solutionType;
    if (priceType !== undefined) updates.priceType = priceType;
    if (priceType === 'paid' && price !== undefined) updates.price = parseFloat(price);
    if (priceType === 'free') updates.price = null;
    if (Array.isArray(categoryIds)) updates.categoryIds = categoryIds;

    await db.collection('contents').doc(id).update(updates);
    res.json({ message: 'Contenu mis à jour', ...updates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2ter. REMPLACER LE FICHIER D'UN CONTENU (admin uniquement)
// ============================================================
// ✅ Action séparée et explicite : remplace uniquement le fichier physique,
// conserve titre/prix/catégories inchangés, supprime l'ancien fichier Cloudinary.
router.post('/:id/replace-file', verifyToken, isAdmin, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Fichier trop volumineux (maximum 100 Mo)' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  const { id } = req.params;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Fichier requis' });
  }

  try {
    const doc = await db.collection('contents').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Contenu non trouvé' });
    const oldData = doc.data();

    const result = await cloudinary.uploader.upload(file.path, {
      resource_type: 'auto',
      folder: 'epistrategix',
      use_filename: true,
      unique_filename: true,
      filename_override: file.originalname,
    });

    // Supprimer l'ancien fichier Cloudinary une fois le nouveau uploadé avec succès
    if (oldData.publicId) {
      await cloudinary.uploader.destroy(oldData.publicId).catch(err =>
        console.error('⚠️ Impossible de supprimer l\'ancien fichier Cloudinary:', err.message)
      );
    }

    await db.collection('contents').doc(id).update({
      url: result.secure_url,
      publicId: result.public_id,
      updatedAt: new Date().toISOString(),
    });

    res.json({ message: 'Fichier remplacé avec succès', url: result.secure_url });
  } catch (error) {
    console.error('Erreur remplacement fichier:', error);
    res.status(500).json({ error: 'Erreur lors du remplacement du fichier' });
  }
});

// ============================================================
// 3. SUPPRIMER UN CONTENU (admin uniquement)
// ============================================================
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('contents').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Contenu non trouvé' });

    const data = doc.data();
    if (data.publicId) {
      await cloudinary.uploader.destroy(data.publicId);
    }
    await db.collection('contents').doc(id).delete();
    res.json({ message: 'Contenu supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 4. ACHETER UN CONTENU PAYANT (via FedaPay) - VERSION CORRIGÉE
// ============================================================
router.post('/purchase', paymentLimiter, async (req, res) => {
  const { contentId, customerName, customerEmail } = req.body;

  if (!contentId) {
    return res.status(400).json({ error: 'ID du contenu requis' });
  }

  try {
    // 1. Récupérer le contenu
    const doc = await db.collection('contents').doc(contentId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Contenu non trouvé' });
    }

    const content = doc.data();

    // 2. Vérifier que le contenu est payant
    if (content.priceType !== 'paid' || !content.price || content.price <= 0) {
      return res.status(400).json({
        error: 'Ce contenu est gratuit ou n\'a pas de prix défini'
      });
    }

    // 3. Créer la transaction FedaPay
    const amount = content.price;
    const response = await fedapay.post('/v1/transactions', {
      amount: Math.round(amount),
      currency: { iso: 'XOF' },
      description: `Achat de contenu : ${content.title}`,
      customer: {
        email: customerEmail || 'client@exemple.com',
        name: customerName || 'Client',
      },
      callback_url: `${process.env.BASE_URL}/api/contents/callback`,
      // ✅ "metadata" est réservé à l'usage interne de FedaPay (il l'écrase silencieusement).
      //    Les données personnalisées doivent être envoyées dans "custom_metadata".
      custom_metadata: {
        contentId: contentId,
        contentType: 'content_purchase',
        contentTitle: content.title,
        contentPrice: amount
      },
    });

    // ✅ RÉCUPÉRER LA TRANSACTION (dans "v1/transaction")
    const transaction = response.data['v1/transaction'] || response.data;
    const transactionId = String(transaction.id);

    // ✅ Générer le VRAI lien de paiement
    // (l'API FedaPay ne renvoie pas d'URL directement à la création de la transaction,
    //  il faut appeler /v1/transactions/{id}/token pour l'obtenir)
    const tokenResponse = await fedapay.post(`/v1/transactions/${transaction.id}/token`);
    const paymentUrl = tokenResponse.data.url;

    if (!paymentUrl) {
      throw new Error('Impossible de générer le lien de paiement FedaPay');
    }

    console.log('✅ Transaction FedaPay créée:', {
      id: transactionId,
      reference: transaction.reference,
      status: transaction.status,
      payment_url: paymentUrl
    });

    // 4. Enregistrer la transaction
    await db.collection('transactions').doc(transactionId).set({
      contentId: contentId,
      contentTitle: content.title,
      amount: amount,
      status: transaction.status || 'pending',
      fedapayTransaction: transaction,
      paymentUrl,
      createdAt: new Date().toISOString(),
    });

    // 5. Retourner l'URL de paiement
    res.json({
      success: true,
      transactionId: transactionId,
      url: paymentUrl, // ✅ vraie URL de paiement
      contentTitle: content.title,
      contentUrl: content.url
    });

  } catch (error) {
    console.error('❌ Erreur achat contenu:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de l\'achat du contenu',
      details: error.response?.data?.message || error.message
    });
  }
});

// ============================================================
// 5. CALLBACK D'ACHAT DE CONTENU (redirection après paiement)
// ============================================================
router.get('/callback', (req, res) => {
  // ✅ FedaPay renvoie ?id=...&status=... sur le callback_url, pas "transaction_id"
  const { status, id } = req.query;

  if (status === 'success' || status === 'approved') {
    res.redirect(`${process.env.FRONTEND_URL}/confirmation.html?status=success&type=content&transaction=${id || ''}`);
  } else {
    res.redirect(`${process.env.FRONTEND_URL}/confirmation.html?status=failed&type=content`);
  }
});

// ============================================================
// 6. VÉRIFIER SI UN CONTENU A ÉTÉ ACHETÉ
// ============================================================
router.get('/purchased/:contentId', async (req, res) => {
  const { contentId } = req.params;
  const { email } = req.query;

  if (!contentId || !email) {
    return res.status(400).json({ error: 'ContentId et email requis' });
  }

  try {
    const snapshot = await db.collection('purchased_content')
      .where('contentId', '==', contentId)
      .where('customerEmail', '==', email)
      .get();

    const purchased = !snapshot.empty;
    res.json({ purchased });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 7. RÉCUPÉRER LES INFOS D'UN ACHAT PAR TRANSACTION (pour confirmation.html)
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
      // Le webhook n'a peut-être pas encore traité l'événement
      return res.json({ status: tx.status || 'pending' });
    }

    const contentId = tx.contentId;
    if (!contentId) {
      return res.status(400).json({ error: 'Transaction non liée à un contenu' });
    }

    const contentDoc = await db.collection('contents').doc(contentId).get();
    if (!contentDoc.exists) {
      return res.status(404).json({ error: 'Contenu non trouvé' });
    }
    const content = contentDoc.data();

    res.json({
      status: 'approved',
      contentId,
      contentTitle: content.title,
      contentUrl: content.url
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
