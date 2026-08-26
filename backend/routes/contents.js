 const express = require('express');
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');
const fedapay = require('../config/fedapay');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

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
router.post('/upload', verifyToken, isAdmin, upload.single('file'), async (req, res) => {
  const { title, type, priceType, price } = req.body;
  const file = req.file;

  if (!title || !file) {
    return res.status(400).json({ error: 'Titre et fichier requis' });
  }

  try {
    const result = await cloudinary.uploader.upload(file.path, {
      resource_type: 'auto',
      folder: 'epistrategix',
    });

    const content = {
      title,
      type: type || 'file',
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
// 4. ACHETER UN CONTENU PAYANT (via FedaPay)
// ============================================================
router.post('/purchase', async (req, res) => {
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
      amount: Math.round(amount * 100),
      currency: 'XOF',
      description: `Achat de contenu : ${content.title}`,
      customer: {
        email: customerEmail || 'client@exemple.com',
        name: customerName || 'Client',
      },
      callback_url: `${process.env.BASE_URL}/api/contents/callback`,
      metadata: {
        contentId: contentId,
        contentType: 'content_purchase',
        contentTitle: content.title,
        contentPrice: amount
      },
    });

    const transaction = response.data;
    
    // 4. Enregistrer la transaction
    await db.collection('transactions').doc(transaction.id).set({
      contentId: contentId,
      contentTitle: content.title,
      amount: amount,
      status: transaction.status,
      fedapayTransaction: transaction,
      createdAt: new Date().toISOString(),
    });

    // 5. Retourner l'URL de paiement
    res.json({
      success: true,
      transactionId: transaction.id,
      url: transaction.url,
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
  const { status, transaction_id } = req.query;
  
  if (status === 'success' || status === 'approved') {
    res.redirect(`${process.env.FRONTEND_URL}/confirmation.html?status=success&type=content&transaction=${transaction_id || ''}`);
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

module.exports = router;