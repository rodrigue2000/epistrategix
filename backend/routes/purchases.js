const express = require('express');
const crypto = require('crypto');
const { db } = require('../config/firebase');
const { sendEmail } = require('../config/email');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// ✅ Limite stricte : évite qu'un script fasse spammer des emails de vérification
const accessRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de demandes. Merci de réessayer dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// 1. DEMANDER UN LIEN D'ACCÈS (envoi d'email)
// ============================================================
router.post('/request-access', accessRequestLimiter, async (req, res) => {
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email valide requis' });
  }

  try {
    // ✅ Toujours répondre pareil, que l'email ait des achats ou non,
    // pour ne pas révéler si une adresse a déjà acheté quelque chose.
    const normalizedEmail = email.trim().toLowerCase();

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

    await db.collection('access_tokens').doc(token).set({
      email: normalizedEmail,
      expiresAt,
      used: false,
      createdAt: new Date().toISOString(),
    });

    const link = `${process.env.FRONTEND_URL}/mes-achats.html?token=${token}`;

    try {
      await sendEmail({
        to: normalizedEmail,
        subject: 'Retrouvez vos achats EpiStrategix',
        html: `
          <p>Bonjour,</p>
          <p>Vous avez demandé à retrouver vos contenus achetés sur EpiStrategix.</p>
          <p><a href="${link}">Cliquez ici pour accéder à vos achats</a></p>
          <p>Ce lien est valable 30 minutes et ne peut être utilisé qu'une seule fois.</p>
          <p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
        `,
      });
    } catch (emailError) {
      console.error('❌ Erreur envoi email:', emailError.message);
      return res.status(500).json({ error: 'Impossible d\'envoyer l\'email pour le moment. Réessayez plus tard.' });
    }

    res.json({ success: true, message: 'Si cet email a des achats, un lien vient de lui être envoyé.' });
  } catch (error) {
    console.error('❌ Erreur request-access:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. VÉRIFIER LE TOKEN ET LISTER LES ACHATS
// ============================================================
router.get('/verify', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Token requis' });
  }

  try {
    const tokenDoc = await db.collection('access_tokens').doc(token).get();

    if (!tokenDoc.exists) {
      return res.status(404).json({ error: 'Lien invalide ou expiré' });
    }

    const tokenData = tokenDoc.data();

    if (tokenData.used) {
      return res.status(400).json({ error: 'Ce lien a déjà été utilisé. Demandez-en un nouveau.' });
    }

    if (new Date(tokenData.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'Ce lien a expiré. Demandez-en un nouveau.' });
    }

    // ✅ Marquer le token comme utilisé (usage unique)
    await db.collection('access_tokens').doc(token).update({ used: true });

    const email = tokenData.email;

    // Récupérer toutes les transactions approuvées liées à cet email
    const txSnapshot = await db.collection('transactions')
      .where('customerEmail', '==', email)
      .where('status', '==', 'approved')
      .get();

    const purchases = [];

    for (const txDoc of txSnapshot.docs) {
      const tx = txDoc.data();

      if (tx.contentId) {
        // Achat de contenu unique
        const contentDoc = await db.collection('contents').doc(tx.contentId).get();
        if (contentDoc.exists) {
          const c = contentDoc.data();
          purchases.push({
            type: 'content',
            title: c.title,
            url: c.url,
            purchasedAt: tx.createdAt,
          });
        }
      } else if (tx.bundleId) {
        // Achat de pack
        const bundleDoc = await db.collection('bundles').doc(tx.bundleId).get();
        if (bundleDoc.exists) {
          const bundle = bundleDoc.data();
          const items = [];
          for (const contentId of bundle.contentIds || []) {
            const contentDoc = await db.collection('contents').doc(contentId).get();
            if (contentDoc.exists) {
              const c = contentDoc.data();
              items.push({ title: c.title, url: c.url });
            }
          }
          purchases.push({
            type: 'bundle',
            title: bundle.title,
            items,
            purchasedAt: tx.createdAt,
          });
        }
      }
    }

    res.json({ email, purchases });
  } catch (error) {
    console.error('❌ Erreur verify:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
