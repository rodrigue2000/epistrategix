const express = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cloudinary = require('../config/cloudinary');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');

const router = express.Router();

// ============================================================
// GÉNÉRATION DU PDF DU CERTIFICAT (vidéo/texte, pas de fichier à uploader)
// ============================================================
function generateCertificatePdfBuffer({ recipientName, title, issueDate, code, verificationUrl }) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const qrDataUrl = await QRCode.toDataURL(verificationUrl, { margin: 1, width: 150 });
      const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

      // ✅ Mise en page simple mais soignée — à affiner visuellement plus tard si besoin
      doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).stroke('#1e5fb0');

      doc.fontSize(12).fillColor('#4d6f94').text('EPISTRATEGIX', 0, 60, { align: 'center' });
      doc.moveDown(1);
      doc.fontSize(32).fillColor('#0a2647').text('CERTIFICAT DE RÉUSSITE', { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(14).fillColor('#3e6188').text('Ce certificat est décerné à', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(26).fillColor('#1e5fb0').text(recipientName, { align: 'center' });
      doc.moveDown(1);
      doc.fontSize(14).fillColor('#3e6188').text('pour avoir complété avec succès', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(20).fillColor('#0a2647').text(title, { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(11).fillColor('#7b95b5').text(`Délivré le ${issueDate}`, { align: 'center' });
      doc.fontSize(9).fillColor('#7b95b5').text(`Code de vérification : ${code}`, { align: 'center' });

      doc.image(qrBuffer, doc.page.width - 150, doc.page.height - 150, { width: 100 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function uploadPdfBuffer(buffer, publicIdPrefix) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image', // ✅ Cloudinary traite les PDF comme des images paginées
        folder: 'epistrategix/certificates',
        public_id: `${publicIdPrefix}-${crypto.randomBytes(6).toString('hex')}`,
        format: 'pdf',
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    uploadStream.end(buffer);
  });
}

// ============================================================
// FONCTION PARTAGÉE : émission automatique d'un certificat
// (appelée par routes/courses.js à la complétion d'une formation certifiante)
// ============================================================
async function issueAutoCertificate({ clientUid, clientEmail, courseId, courseTitle }) {
  const code = crypto.randomBytes(8).toString('hex').toUpperCase();
  const issueDate = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const verificationUrl = `${process.env.FRONTEND_URL}/verifier-certificat.html?code=${code}`;

  const recipientName = clientEmail; // ✅ on n'a que l'email du compte client, pas de "nom complet" déclaré

  const pdfBuffer = await generateCertificatePdfBuffer({
    recipientName, title: courseTitle, issueDate, code, verificationUrl,
  });
  const uploadResult = await uploadPdfBuffer(pdfBuffer, 'auto');

  await db.collection('certificates').doc(code).set({
    type: 'auto',
    code,
    recipientName,
    recipientEmail: clientEmail,
    clientUid,
    title: courseTitle,
    courseId,
    issueDate,
    pdfUrl: uploadResult.secure_url,
    createdAt: new Date().toISOString(),
  });

  return code;
}

// ============================================================
// 1. CRÉER UN CERTIFICAT MANUEL (admin uniquement) - formation hors plateforme
// ============================================================
router.post('/admin/manual', verifyToken, isAdmin, async (req, res) => {
  const { recipientName, recipientEmail, title, issueDate: issueDateInput } = req.body;

  if (!recipientName || !title) {
    return res.status(400).json({ error: 'Nom du bénéficiaire et intitulé requis' });
  }

  try {
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    const issueDate = issueDateInput
      ? new Date(issueDateInput).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
      : new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const verificationUrl = `${process.env.FRONTEND_URL}/verifier-certificat.html?code=${code}`;

    const pdfBuffer = await generateCertificatePdfBuffer({
      recipientName, title, issueDate, code, verificationUrl,
    });
    const uploadResult = await uploadPdfBuffer(pdfBuffer, 'manual');

    await db.collection('certificates').doc(code).set({
      type: 'manual',
      code,
      recipientName,
      recipientEmail: recipientEmail || null,
      title,
      issueDate,
      pdfUrl: uploadResult.secure_url,
      createdAt: new Date().toISOString(),
    });

    res.status(201).json({ code, pdfUrl: uploadResult.secure_url });
  } catch (error) {
    console.error('❌ Erreur création certificat manuel:', error);
    res.status(500).json({ error: 'Erreur lors de la génération du certificat' });
  }
});

// ============================================================
// 2. LISTER TOUS LES CERTIFICATS (admin uniquement)
// ============================================================
router.get('/admin', verifyToken, isAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('certificates').orderBy('createdAt', 'desc').get();
    const certificates = [];
    snapshot.forEach(doc => certificates.push(doc.data()));
    res.json(certificates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 3. VÉRIFIER UN CERTIFICAT PAR CODE (public)
// ============================================================
router.get('/verify/:code', async (req, res) => {
  try {
    const doc = await db.collection('certificates').doc(req.params.code.toUpperCase()).get();
    if (!doc.exists) {
      return res.json({ valid: false });
    }
    const cert = doc.data();
    res.json({
      valid: true,
      recipientName: cert.recipientName,
      title: cert.title,
      issueDate: cert.issueDate,
      type: cert.type,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 4. MES CERTIFICATS (client connecté)
// ============================================================
router.get('/my-certificates', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('certificates')
      .where('clientUid', '==', req.user.uid)
      .get();
    const certificates = [];
    snapshot.forEach(doc => certificates.push(doc.data()));
    res.json(certificates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.issueAutoCertificate = issueAutoCertificate;
