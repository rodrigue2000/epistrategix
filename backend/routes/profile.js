const express = require('express');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const {
  getMemberProfile,
  isProfileComplete,
  issuePendingCertificatesForClient,
} = require('./certificates');

const router = express.Router();

// ============================================================
// 1. LIRE MON PROFIL
// ============================================================
router.get('/', verifyToken, async (req, res) => {
  try {
    const profile = await getMemberProfile(req.user.uid);
    res.json({
      email: req.user.email,
      profile: profile || null,
      complete: isProfileComplete(profile),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. ENREGISTRER MON PROFIL
// ============================================================
router.put('/', verifyToken, async (req, res) => {
  const lastName = (req.body.lastName || '').trim();
  const firstName = (req.body.firstName || '').trim();
  const birthPlace = (req.body.birthPlace || '').trim();
  const birthDate = (req.body.birthDate || '').trim();

  if (lastName.length < 2 || lastName.length > 60) {
    return res.status(400).json({ error: 'Nom invalide (2 à 60 caractères)' });
  }
  if (firstName.length < 2 || firstName.length > 60) {
    return res.status(400).json({ error: 'Prénom invalide (2 à 60 caractères)' });
  }
  if (birthPlace.length < 2 || birthPlace.length > 80) {
    return res.status(400).json({ error: 'Lieu de naissance invalide (2 à 80 caractères)' });
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  const parsed = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  const validDate = parsed
    && parsed.getFullYear() === Number(match[1])
    && parsed.getMonth() === Number(match[2]) - 1
    && parsed.getDate() === Number(match[3]);
  if (!validDate || parsed > new Date() || parsed.getFullYear() < 1900) {
    return res.status(400).json({ error: 'Date de naissance invalide' });
  }

  try {
    await db.collection('member_profiles').doc(req.user.uid).set({
      lastName,
      firstName,
      birthDate,
      birthPlace,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    // Profil désormais complet : émettre les certificats restés en attente
    let certificatesIssued = 0;
    try {
      certificatesIssued = await issuePendingCertificatesForClient(req.user.uid, req.user.email);
    } catch (e) {
      console.error('❌ Erreur émission certificats en attente:', e.message);
    }

    res.json({ success: true, complete: true, certificatesIssued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
