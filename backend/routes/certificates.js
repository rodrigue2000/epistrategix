const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cloudinary = require('../config/cloudinary');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');

const router = express.Router();

// ============================================================
// UPLOAD DES IMAGES (signature, cachet) - en mémoire, jamais sur le disque
// ============================================================
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Format d\'image non supporté (JPG, PNG ou WebP uniquement)'));
  },
}).fields([
  { name: 'signature', maxCount: 1 },
  { name: 'stamp', maxCount: 1 },
]);

function handleImageUpload(req, res, next) {
  imageUpload(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Image trop volumineuse (8 Mo maximum)' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}

// ============================================================
// CADRAGE AUTOMATIQUE D'UNE SIGNATURE / D'UN CACHET PHOTOGRAPHIÉ
// ============================================================
// ✅ "sharp" est chargé à la demande : s'il manque sur le serveur, seules les
// routes qui traitent des images échouent (avec un message clair), pas tout le site.
let sharpLib = null;
function getSharp() {
  if (!sharpLib) {
    try {
      sharpLib = require('sharp');
    } catch (e) {
      throw new Error('Le module "sharp" n\'est pas installé sur le serveur (npm install sharp dans le dossier backend)');
    }
  }
  return sharpLib;
}

// Erreur causée par les données envoyées (et non par le serveur) : renvoyée en 400
function userError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function frameImage(buffer) {
  const sharp = getSharp();

  // 1. Orientation EXIF (photos de téléphone), fond blanc, taille de travail raisonnable
  let data, info;
  try {
    ({ data, info } = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch (e) {
    throw userError('Image illisible ou corrompue. Utilisez une photo JPG, PNG ou WebP.');
  }
  const { width, height } = info;

  // 2. Estimation LOCALE du fond : filtre médian sur une version réduite. Les traits fins
  // (signature, cachet) disparaissent, il reste le papier avec ses ombres et son éclairage
  // inégal. (Chaque étape est un traitement sharp distinct : sharp n'exécute pas les
  // opérations dans l'ordre où on les écrit.)
  const smallW = Math.max(16, Math.round(width / 4));
  const smallH = Math.max(16, Math.round(height / 4));
  const small = await sharp(data, { raw: { width, height, channels: 3 } })
    .resize(smallW, smallH, { fit: 'fill' }).raw().toBuffer();
  const smallMedian = await sharp(small, { raw: { width: smallW, height: smallH, channels: 3 } })
    .median(15).raw().toBuffer();
  const bg = await sharp(smallMedian, { raw: { width: smallW, height: smallH, channels: 3 } })
    .resize(width, height, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();

  // 3. Suppression du fond : on ne garde que l'encre, sur transparent.
  //    pixel = encre × a + fond × (1 − a)   ⇒   encre = (pixel − fond × (1 − a)) / a
  const out = Buffer.alloc(width * height * 4);
  const colCount = new Uint32Array(width);
  const rowCount = new Uint32Array(height);
  const edge = Math.round(Math.min(width, height) * 0.02); // bords de photo ignorés (ombres, table)
  const smooth = (x, e0, e1) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  let solid = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < edge || y < edge || x >= width - edge || y >= height - edge) continue;
      const p = (y * width + x) * 3;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const br = Math.max(bg[p], 1), bgg = Math.max(bg[p + 1], 1), bb = Math.max(bg[p + 2], 1);
      // assombrissement relatif au fond local : 0 = comme le papier, 1 = noir
      const d = Math.max(1 - r / br, 1 - g / bgg, 1 - b / bb);
      const a = smooth(d, 0.12, 0.38);
      if (a <= 0) continue;
      const o = (y * width + x) * 4;
      out[o] = byte((r - br * (1 - a)) / a);
      out[o + 1] = byte((g - bgg * (1 - a)) / a);
      out[o + 2] = byte((b - bb * (1 - a)) / a);
      out[o + 3] = byte(a * 255);
      if (a > 0.5) { colCount[x]++; rowCount[y]++; solid++; }
    }
  }

  if (solid < 150) {
    throw userError('Aucune signature ni aucun cachet détecté dans cette image. Photographiez-le de près, sur une feuille blanche bien éclairée.');
  }

  // 4. Cadrage au plus près de l'encre (les grains de poussière isolés sont ignorés)
  const first = (arr) => arr.findIndex(c => c >= 2);
  const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= 2) return i; return -1; };
  const pad = 8;
  const left = Math.max(0, first(colCount) - pad);
  const right = Math.min(width - 1, last(colCount) + pad);
  const top = Math.max(0, first(rowCount) - pad);
  const bottom = Math.min(height - 1, last(rowCount) + pad);

  const cropped = await sharp(out, { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .png()
    .toBuffer();

  // 5. Ajustement dans un cadre maximal (ratio conservé, jamais agrandie)
  return sharp(cropped)
    .resize({ width: 700, height: 350, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

// ============================================================
// DONNÉES : signataire par défaut, profil membre
// ============================================================
const settingsRef = () => db.collection('settings').doc('certificate');

async function getSignatorySettings() {
  const snap = await settingsRef().get();
  const d = snap.exists ? snap.data() : {};
  return {
    signatoryName: d.signatoryName || '',
    signatoryTitle: d.signatoryTitle || '',
    signatureBuf: d.signatureB64 ? Buffer.from(d.signatureB64, 'base64') : null,
    stampBuf: d.stampB64 ? Buffer.from(d.stampB64, 'base64') : null,
  };
}

async function getMemberProfile(uid) {
  const snap = await db.collection('member_profiles').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

function isProfileComplete(p) {
  return !!(p && p.lastName && p.firstName && p.birthDate && p.birthPlace);
}

// ============================================================
// DATES
// ============================================================
function parseIsoDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

function formatFr(date) {
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ============================================================
// GÉNÉRATION DU PDF
// ============================================================
async function generateCertificatePdfBuffer(data) {
  const qrBuffer = await QRCode.toBuffer(data.verificationUrl, { margin: 1, width: 300 });

  return new Promise((resolve, reject) => {
    try {
      // margin 0 : toutes les positions sont explicites, rien ne peut déclencher une 2e page
      const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;
      const H = doc.page.height;

      // Cadre
      doc.lineWidth(2).rect(20, 20, W - 40, H - 40).stroke('#1e5fb0');
      doc.lineWidth(0.5).rect(28, 28, W - 56, H - 56).stroke('#b9cde8');

      // En-tête
      doc.font('Helvetica').fontSize(11).fillColor('#4d6f94')
        .text('EPISTRATEGIX', 0, 48, { width: W, align: 'center', characterSpacing: 3 });
      doc.font('Helvetica').fontSize(30).fillColor('#0a2647')
        .text('CERTIFICAT DE RÉUSSITE', 0, 70, { width: W, align: 'center' });

      // Bénéficiaire
      doc.font('Helvetica').fontSize(13).fillColor('#3e6188')
        .text('Ce certificat est décerné à', 0, 122, { width: W, align: 'center' });

      const fullName = `${data.firstName} ${data.lastName.toUpperCase()}`;
      doc.font('Helvetica-Bold');
      let nameSize = 26;
      while (nameSize > 14 && doc.fontSize(nameSize).widthOfString(fullName) > W - 160) nameSize -= 1;
      doc.fontSize(nameSize).fillColor('#1e5fb0')
        .text(fullName, 80, 146, { width: W - 160, align: 'center', lineBreak: false });

      doc.font('Helvetica').fontSize(12).fillColor('#3e6188')
        .text(`Né(e) le ${formatFr(data.birthDateObj)} à ${data.birthPlace}`, 80, 184,
          { width: W - 160, align: 'center', height: 16, ellipsis: true });

      doc.font('Helvetica').fontSize(13).fillColor('#3e6188')
        .text('pour avoir complété avec succès', 0, 218, { width: W, align: 'center' });

      // L'intitulé n'est jamais tronqué : sa taille diminue jusqu'à tenir sur 2 lignes
      doc.font('Helvetica');
      let titleSize = 20;
      while (titleSize > 11 && doc.fontSize(titleSize).heightOfString(data.title, { width: W - 200 }) > titleSize * 2.5) {
        titleSize -= 1;
      }
      doc.fontSize(titleSize).fillColor('#0a2647')
        .text(data.title, 100, 240, { width: W - 200, align: 'center', height: 56, ellipsis: true });

      // Mention et observations (facultatives)
      let y = 302;
      if (data.mention) {
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#0a2647')
          .text(`Mention : ${data.mention}`, 80, y, { width: W - 160, align: 'center', height: 18, ellipsis: true });
        y += 26;
      }
      if (data.observations) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#4d6f94')
          .text(data.observations, 130, y, { width: W - 260, align: 'center', height: 40, ellipsis: true });
      }

      // Date et code
      doc.font('Helvetica').fontSize(10).fillColor('#7b95b5')
        .text(`Délivré le ${data.issueDate}`, 0, 388, { width: W, align: 'center' });
      doc.fontSize(9)
        .text(`Code de vérification : ${data.code}`, 0, 402, { width: W, align: 'center' });

      // Bas de page : cachet | signature + signataire | QR code
      const bottomY = 428;
      if (data.stampBuf) {
        doc.image(data.stampBuf, 80, bottomY, { fit: [120, 110], align: 'center', valign: 'center' });
      }

      const sigX = 300;
      const sigW = 240;
      if (data.signatureBuf) {
        doc.image(data.signatureBuf, sigX, bottomY, { fit: [sigW, 70], align: 'center', valign: 'center' });
      }
      if (data.signatoryName) {
        doc.lineWidth(0.7).moveTo(sigX, bottomY + 76).lineTo(sigX + sigW, bottomY + 76).stroke('#7b95b5');
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#0a2647')
          .text(data.signatoryName, sigX, bottomY + 82, { width: sigW, align: 'center', height: 14, ellipsis: true });
        if (data.signatoryTitle) {
          doc.font('Helvetica').fontSize(9.5).fillColor('#4d6f94')
            .text(data.signatoryTitle, sigX, bottomY + 98, { width: sigW, align: 'center', height: 26, ellipsis: true });
        }
      }

      doc.image(qrBuffer, W - 170, bottomY, { width: 100 });
      doc.font('Helvetica').fontSize(7.5).fillColor('#7b95b5')
        .text('Vérifier ce certificat', W - 190, bottomY + 104, { width: 140, align: 'center' });

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
// CRÉATION D'UN CERTIFICAT (commune aux flux automatique et manuel)
// ============================================================
async function createCertificate({
  type, firstName, lastName, birthDate, birthPlace, title, issueDate,
  mention, observations, recipientEmail, clientUid, courseId, signatory,
}) {
  const code = crypto.randomBytes(8).toString('hex').toUpperCase();
  const verificationUrl = `${process.env.FRONTEND_URL}/verifier-certificat.html?code=${code}`;

  const pdfBuffer = await generateCertificatePdfBuffer({
    firstName, lastName, birthPlace, title, issueDate, code, verificationUrl,
    birthDateObj: parseIsoDate(birthDate),
    mention, observations,
    signatoryName: signatory.signatoryName,
    signatoryTitle: signatory.signatoryTitle,
    signatureBuf: signatory.signatureBuf,
    stampBuf: signatory.stampBuf,
  });
  const uploadResult = await uploadPdfBuffer(pdfBuffer, type);

  const record = {
    type,
    code,
    firstName,
    lastName,
    recipientName: `${firstName} ${lastName}`,
    recipientEmail: recipientEmail || null,
    birthDate,
    birthPlace,
    title,
    issueDate,
    mention: mention || '',
    observations: observations || '',
    signatoryName: signatory.signatoryName || '',
    signatoryTitle: signatory.signatoryTitle || '',
    pdfUrl: uploadResult.secure_url,
    createdAt: new Date().toISOString(),
  };
  if (clientUid) record.clientUid = clientUid;
  if (courseId) record.courseId = courseId;

  await db.collection('certificates').doc(code).set(record);
  return { code, pdfUrl: uploadResult.secure_url };
}

// ============================================================
// ÉMISSION AUTOMATIQUE (appelée à la complétion d'une formation certifiante)
// ============================================================
// Lève une erreur de code PROFILE_INCOMPLETE si le membre n'a pas renseigné
// son identité complète : l'appelant met alors le certificat "en attente".
async function issueAutoCertificate({ clientUid, clientEmail, courseId, courseTitle }) {
  const profile = await getMemberProfile(clientUid);
  if (!isProfileComplete(profile)) {
    const err = new Error('Profil du membre incomplet');
    err.code = 'PROFILE_INCOMPLETE';
    throw err;
  }

  // ✅ Un signataire mal configuré ne doit jamais bloquer un apprenant :
  // on émet avec ce qui existe (images et noms facultatifs côté automatique).
  const signatory = await getSignatorySettings();

  const { code } = await createCertificate({
    type: 'auto',
    firstName: profile.firstName,
    lastName: profile.lastName,
    birthDate: profile.birthDate,
    birthPlace: profile.birthPlace,
    title: courseTitle,
    issueDate: formatFr(new Date()),
    recipientEmail: clientEmail,
    clientUid,
    courseId,
    signatory,
  });
  return code;
}

// ============================================================
// CERTIFICATS EN ATTENTE (formation terminée avant que le profil soit complet)
// ============================================================
async function issuePendingCertificatesForClient(clientUid, clientEmail) {
  const snap = await db.collection('enrollments')
    .where('clientUid', '==', clientUid)
    .where('certificatePending', '==', true)
    .get();

  let issued = 0;
  for (const doc of snap.docs) {
    const ref = db.collection('enrollments').doc(doc.id);

    // Réservation atomique : si deux requêtes arrivent en même temps,
    // une seule émet le certificat (évite les doublons).
    const claimed = await db.runTransaction(async (t) => {
      const fresh = await t.get(ref);
      if (!fresh.exists || fresh.data().certificatePending !== true) return false;
      t.update(ref, { certificatePending: false, certificateIssuing: true });
      return true;
    });
    if (!claimed) continue;

    const enrollment = doc.data();
    try {
      let title = enrollment.courseTitle;
      if (!title) {
        const courseDoc = await db.collection('courses').doc(enrollment.courseId).get();
        title = courseDoc.exists ? courseDoc.data().title : 'Formation';
      }
      const code = await issueAutoCertificate({
        clientUid,
        clientEmail: enrollment.clientEmail || clientEmail,
        courseId: enrollment.courseId,
        courseTitle: title,
      });
      await ref.update({ certificateIssuing: false, certificateCode: code });
      issued++;
    } catch (error) {
      await ref.update({ certificateIssuing: false, certificatePending: true });
      if (error.code !== 'PROFILE_INCOMPLETE') {
        console.error('❌ Erreur émission certificat en attente:', error.message);
      }
    }
  }
  return issued;
}

// ============================================================
// 1. SIGNATAIRE PAR DÉFAUT - lecture (admin)
// ============================================================
router.get('/admin/settings', verifyToken, isAdmin, async (req, res) => {
  try {
    const s = await getSignatorySettings();
    res.json({
      signatoryName: s.signatoryName,
      signatoryTitle: s.signatoryTitle,
      signaturePreview: s.signatureBuf ? `data:image/png;base64,${s.signatureBuf.toString('base64')}` : null,
      stampPreview: s.stampBuf ? `data:image/png;base64,${s.stampBuf.toString('base64')}` : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. SIGNATAIRE PAR DÉFAUT - enregistrement (admin)
// ============================================================
router.put('/admin/settings', verifyToken, isAdmin, handleImageUpload, async (req, res) => {
  try {
    const b = req.body;
    const updates = {
      signatoryName: (b.signatoryName || '').trim().slice(0, 80),
      signatoryTitle: (b.signatoryTitle || '').trim().slice(0, 120),
      updatedAt: new Date().toISOString(),
    };

    const files = req.files || {};
    if (files.signature && files.signature[0]) {
      updates.signatureB64 = (await frameImage(files.signature[0].buffer)).toString('base64');
    } else if (b.removeSignature === 'true') {
      updates.signatureB64 = '';
    }
    if (files.stamp && files.stamp[0]) {
      updates.stampB64 = (await frameImage(files.stamp[0].buffer)).toString('base64');
    } else if (b.removeStamp === 'true') {
      updates.stampB64 = '';
    }

    await settingsRef().set(updates, { merge: true });
    res.json({ success: true });
  } catch (error) {
    if (!error.status) console.error('❌ Erreur enregistrement signataire:', error);
    res.status(error.status || 500).json({ error: error.message || 'Erreur lors de l\'enregistrement' });
  }
});

// ============================================================
// 3. CERTIFICAT MANUEL (admin) - formation / accompagnement hors plateforme
// ============================================================
router.post('/admin/manual', verifyToken, isAdmin, handleImageUpload, async (req, res) => {
  try {
    const b = req.body;
    const lastName = (b.lastName || '').trim();
    const firstName = (b.firstName || '').trim();
    const birthPlace = (b.birthPlace || '').trim();
    const title = (b.title || '').trim();
    const mention = (b.mention || '').trim().slice(0, 60);
    const observations = (b.observations || '').trim().slice(0, 300);

    if (!lastName || !firstName) {
      return res.status(400).json({ error: 'Nom et prénom du bénéficiaire requis' });
    }
    const birthDateObj = parseIsoDate(b.birthDate);
    if (!birthDateObj || birthDateObj > new Date() || birthDateObj.getFullYear() < 1900) {
      return res.status(400).json({ error: 'Date de naissance invalide' });
    }
    if (!birthPlace) return res.status(400).json({ error: 'Lieu de naissance requis' });
    if (!title) return res.status(400).json({ error: 'Intitulé de la formation requis' });

    let issueDate = formatFr(new Date());
    if (b.issueDate) {
      const d = parseIsoDate(b.issueDate);
      if (!d) return res.status(400).json({ error: 'Date de délivrance invalide' });
      issueDate = formatFr(d);
    }

    // Signataire : valeurs saisies, sinon signataire par défaut
    const defaults = await getSignatorySettings();
    const signatoryName = (b.signatoryName || '').trim() || defaults.signatoryName;
    const signatoryTitle = (b.signatoryTitle || '').trim() || defaults.signatoryTitle;
    if (!signatoryName || !signatoryTitle) {
      return res.status(400).json({ error: 'Nom et titre du signataire requis (ou définissez le signataire par défaut)' });
    }

    const files = req.files || {};
    const signatureBuf = files.signature && files.signature[0]
      ? await frameImage(files.signature[0].buffer)
      : defaults.signatureBuf;
    const stampBuf = files.stamp && files.stamp[0]
      ? await frameImage(files.stamp[0].buffer)
      : defaults.stampBuf;

    if (!signatureBuf) {
      return res.status(400).json({ error: 'Ajoutez une signature (ou définissez-la dans « Signataire par défaut »)' });
    }
    if (!stampBuf) {
      return res.status(400).json({ error: 'Ajoutez un cachet (ou définissez-le dans « Signataire par défaut »)' });
    }

    const result = await createCertificate({
      type: 'manual',
      firstName, lastName,
      birthDate: b.birthDate,
      birthPlace, title, issueDate, mention, observations,
      recipientEmail: (b.recipientEmail || '').trim(),
      signatory: { signatoryName, signatoryTitle, signatureBuf, stampBuf },
    });

    res.status(201).json(result);
  } catch (error) {
    if (!error.status) console.error('❌ Erreur création certificat manuel:', error);
    res.status(error.status || 500).json({ error: error.message || 'Erreur lors de la génération du certificat' });
  }
});

// ============================================================
// 4. LISTER TOUS LES CERTIFICATS (admin)
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
// 5. VÉRIFIER UN CERTIFICAT PAR CODE (public)
// ============================================================
// ✅ Volontairement minimal : la date et le lieu de naissance ne sont JAMAIS
// exposés publiquement.
router.get('/verify/:code', async (req, res) => {
  try {
    const doc = await db.collection('certificates').doc(req.params.code.toUpperCase()).get();
    if (!doc.exists) return res.json({ valid: false });
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
// 6. MES CERTIFICATS (client connecté)
// ============================================================
router.get('/my-certificates', verifyToken, async (req, res) => {
  try {
    // Auto-réparation : si le profil est complet, on émet d'abord les
    // certificats restés "en attente" (formation terminée avant le profil).
    try {
      const profile = await getMemberProfile(req.user.uid);
      if (isProfileComplete(profile)) {
        await issuePendingCertificatesForClient(req.user.uid, req.user.email);
      }
    } catch (e) {
      console.error('❌ Erreur émission certificats en attente:', e.message);
    }

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
module.exports.issuePendingCertificatesForClient = issuePendingCertificatesForClient;
module.exports.getMemberProfile = getMemberProfile;
module.exports.isProfileComplete = isProfileComplete;
