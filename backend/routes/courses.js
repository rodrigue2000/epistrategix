const express = require('express');
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');
const fedapay = require('../config/fedapay');
const { paymentLimiter } = require('../middleware/rateLimiter');
const { issueAutoCertificate } = require('./certificates');

const router = express.Router();
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ✅ "video" → resource_type vidéo ; "document" (PDF) → resource_type image
// (Cloudinary traite les PDF comme des images paginées). Les deux sont
// uploadés en type "authenticated" : accès uniquement via URL signée.
function buildModuleUploadOptions(originalname, moduleType) {
  return {
    resource_type: moduleType === 'video' ? 'video' : 'image',
    type: 'authenticated',
    folder: 'epistrategix/courses',
    use_filename: true,
    unique_filename: true,
    filename_override: originalname,
  };
}

function getSignedModuleUrl(publicId, moduleType) {
  return cloudinary.url(publicId, {
    resource_type: moduleType === 'video' ? 'video' : 'image',
    type: 'authenticated',
    sign_url: true,
    secure: true,
    expires_at: Math.floor(Date.now() / 1000) + 15 * 60,
  });
}

// ============================================================
// 1. LISTER LES FORMATIONS (public)
// ============================================================
router.get('/', async (req, res) => {
  try {
    const snapshot = await db.collection('courses').get();
    const courses = [];
    snapshot.forEach(doc => {
      const c = doc.data();
      courses.push({
        id: doc.id,
        title: c.title,
        description: c.description,
        priceType: c.priceType,
        price: c.price,
        promoEnabled: c.promoEnabled,
        originalPrice: c.originalPrice,
        certifying: !!c.certifying,
        moduleCount: (c.modules || []).length,
      });
    });
    res.json(courses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. UPLOADER UN MODULE (vidéo ou document) - admin uniquement
// ============================================================
router.post('/admin/upload-module', verifyToken, isAdmin, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Fichier trop volumineux (maximum 500 Mo)' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  const file = req.file;
  const { title, moduleType } = req.body; // moduleType: 'video' | 'document'

  if (!file || !title || !moduleType) {
    return res.status(400).json({ error: 'Titre, type de module et fichier requis' });
  }

  try {
    const result = await cloudinary.uploader.upload(file.path, buildModuleUploadOptions(file.originalname, moduleType));
    res.status(201).json({
      title,
      type: moduleType,
      publicId: result.public_id,
      duration: result.duration || null,
      pageCount: result.pages || null,
    });
  } catch (error) {
    console.error('Erreur upload module:', error);
    res.status(500).json({ error: 'Erreur lors de l\'upload du module' });
  }
});

// ============================================================
// 3. CRÉER UNE FORMATION (admin uniquement)
// ============================================================
router.post('/admin', verifyToken, isAdmin, async (req, res) => {
  const { title, description, priceType, price, promoEnabled, originalPrice, certifying, modules } = req.body;

  if (!title || !Array.isArray(modules) || modules.length === 0) {
    return res.status(400).json({ error: 'Titre et au moins un module requis' });
  }

  if (promoEnabled && (!originalPrice || parseFloat(originalPrice) <= parseFloat(price))) {
    return res.status(400).json({ error: 'Le prix normal doit être supérieur au prix promo' });
  }

  try {
    const course = {
      title,
      description: description || '',
      priceType: priceType || 'paid',
      price: priceType === 'free' ? 0 : parseFloat(price),
      promoEnabled: priceType === 'paid' && !!promoEnabled,
      originalPrice: priceType === 'paid' && promoEnabled ? parseFloat(originalPrice) : null,
      certifying: !!certifying,
      modules: modules.map((m, i) => ({ ...m, order: i })),
      createdAt: new Date().toISOString(),
    };

    const docRef = await db.collection('courses').add(course);
    res.status(201).json({ id: docRef.id, ...course });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 4. MODIFIER UNE FORMATION (admin uniquement) - métadonnées + modules
// ============================================================
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, description, priceType, price, promoEnabled, originalPrice, certifying, modules } = req.body;

  if (priceType === 'paid' && promoEnabled && (!originalPrice || parseFloat(originalPrice) <= parseFloat(price))) {
    return res.status(400).json({ error: 'Le prix normal doit être supérieur au prix promo' });
  }

  try {
    const doc = await db.collection('courses').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Formation non trouvée' });

    const updates = { updatedAt: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (priceType !== undefined) updates.priceType = priceType;
    if (certifying !== undefined) updates.certifying = !!certifying;
    if (Array.isArray(modules) && modules.length > 0) {
      updates.modules = modules.map((m, i) => ({ ...m, order: i }));
    }

    if (priceType === 'free') {
      updates.price = 0;
      updates.promoEnabled = false;
      updates.originalPrice = null;
    } else {
      if (price !== undefined) updates.price = parseFloat(price);
      updates.promoEnabled = !!promoEnabled;
      updates.originalPrice = promoEnabled ? parseFloat(originalPrice) : null;
    }

    await db.collection('courses').doc(id).update(updates);
    res.json({ message: 'Formation mise à jour', ...updates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 5. RÉCUPÉRER UNE FORMATION (admin uniquement) - pour pré-remplir l'édition
// ============================================================
router.get('/admin/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const doc = await db.collection('courses').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Formation non trouvée' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 6. SUPPRIMER UNE FORMATION (admin uniquement)
// ============================================================
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('courses').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Formation non trouvée' });
    await db.collection('courses').doc(id).delete();
    res.json({ message: 'Formation supprimée' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 7. ACHETER / S'INSCRIRE À UNE FORMATION (client connecté requis)
// ============================================================
router.post('/purchase', verifyToken, paymentLimiter, async (req, res) => {
  const { courseId } = req.body;
  const clientUid = req.user.uid;
  const clientEmail = req.user.email;

  if (!courseId) return res.status(400).json({ error: 'ID de la formation requis' });

  try {
    const courseDoc = await db.collection('courses').doc(courseId).get();
    if (!courseDoc.exists) return res.status(404).json({ error: 'Formation non trouvée' });
    const course = courseDoc.data();

    const existing = await db.collection('enrollments')
      .where('courseId', '==', courseId)
      .where('clientUid', '==', clientUid)
      .get();
    if (!existing.empty) return res.status(400).json({ error: 'Vous êtes déjà inscrit à cette formation' });

    const amount = course.price;

    if (amount <= 0) {
      await db.collection('enrollments').add({
        courseId, courseTitle: course.title, clientUid, clientEmail,
        enrolledAt: new Date().toISOString(), completed: false,
      });
      return res.json({ success: true, free: true });
    }

    const response = await fedapay.post('/v1/transactions', {
      amount: Math.round(amount),
      currency: { iso: 'XOF' },
      description: `Inscription à la formation : ${course.title}`,
      customer: { email: clientEmail, name: clientEmail },
      callback_url: `${process.env.BASE_URL}/api/courses/callback`,
      custom_metadata: { courseId, contentType: 'course_purchase', courseTitle: course.title, clientUid },
    });

    const transaction = response.data['v1/transaction'] || response.data;
    const transactionId = String(transaction.id);

    const tokenResponse = await fedapay.post(`/v1/transactions/${transaction.id}/token`);
    const paymentUrl = tokenResponse.data.url;
    if (!paymentUrl) throw new Error('Impossible de générer le lien de paiement FedaPay');

    await db.collection('transactions').doc(transactionId).set({
      courseId, courseTitle: course.title, clientUid, customerEmail: clientEmail,
      amount, status: transaction.status || 'pending', fedapayTransaction: transaction,
      paymentUrl, createdAt: new Date().toISOString(),
    });

    res.json({ success: true, url: paymentUrl });
  } catch (error) {
    console.error('❌ Erreur achat formation:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erreur lors de l\'inscription', details: error.message });
  }
});

router.get('/callback', (req, res) => {
  const ok = req.query.status === 'success' || req.query.status === 'approved';
  res.redirect(`${process.env.FRONTEND_URL}/mon-compte.html?enrollment=${ok ? 'success' : 'failed'}`);
});

// ============================================================
// 8. MES FORMATIONS (client connecté) - avec progression
// ============================================================
router.get('/my-courses', verifyToken, async (req, res) => {
  try {
    const clientUid = req.user.uid;
    const enrollSnap = await db.collection('enrollments').where('clientUid', '==', clientUid).get();

    const results = [];
    for (const doc of enrollSnap.docs) {
      const enrollment = doc.data();
      const courseDoc = await db.collection('courses').doc(enrollment.courseId).get();
      if (!courseDoc.exists) continue;
      const course = courseDoc.data();

      const progressSnap = await db.collection('module_progress')
        .where('clientUid', '==', clientUid)
        .where('courseId', '==', enrollment.courseId)
        .get();

      results.push({
        enrollmentId: doc.id,
        courseId: enrollment.courseId,
        courseTitle: course.title,
        totalModules: (course.modules || []).length,
        completedModules: progressSnap.size,
        completed: !!enrollment.completed,
      });
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 9. RÉCUPÉRER LES MODULES D'UNE FORMATION (client inscrit uniquement)
// ============================================================
router.get('/:id/modules', verifyToken, async (req, res) => {
  const { id } = req.params;
  const clientUid = req.user.uid;

  try {
    const enrollSnap = await db.collection('enrollments')
      .where('courseId', '==', id).where('clientUid', '==', clientUid).get();
    if (enrollSnap.empty) return res.status(403).json({ error: 'Vous n\'êtes pas inscrit à cette formation' });

    const courseDoc = await db.collection('courses').doc(id).get();
    if (!courseDoc.exists) return res.status(404).json({ error: 'Formation non trouvée' });
    const course = courseDoc.data();

    const progressSnap = await db.collection('module_progress')
      .where('clientUid', '==', clientUid).where('courseId', '==', id).get();
    const completedIds = new Set(progressSnap.docs.map(d => d.data().moduleId));

    const modules = (course.modules || [])
      .sort((a, b) => a.order - b.order)
      .map(m => ({
        publicId: m.publicId,
        title: m.title,
        type: m.type || 'video',
        url: getSignedModuleUrl(m.publicId, m.type),
        completed: completedIds.has(m.publicId),
      }));

    res.json({ courseTitle: course.title, modules });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 10. MARQUER UN MODULE COMME TERMINÉ (client inscrit)
// ============================================================
router.post('/:id/modules/complete', verifyToken, async (req, res) => {
  const { id } = req.params;
  const clientUid = req.user.uid;
  const { publicId } = req.body;

  if (!publicId) return res.status(400).json({ error: 'publicId du module requis' });

  try {
    const enrollSnap = await db.collection('enrollments')
      .where('courseId', '==', id).where('clientUid', '==', clientUid).get();
    if (enrollSnap.empty) return res.status(403).json({ error: 'Vous n\'êtes pas inscrit à cette formation' });
    const enrollmentDoc = enrollSnap.docs[0];

    const progressId = `${clientUid}_${id}_${publicId}`.replace(/\//g, '-');
    await db.collection('module_progress').doc(progressId).set({
      clientUid, courseId: id, moduleId: publicId, completedAt: new Date().toISOString(),
    });

    const courseDoc = await db.collection('courses').doc(id).get();
    const course = courseDoc.data();
    const progressSnap = await db.collection('module_progress')
      .where('clientUid', '==', clientUid).where('courseId', '==', id).get();

    const allCompleted = (course.modules || []).length > 0 &&
      progressSnap.size >= (course.modules || []).length;

    let certificateIssued = false;
    if (allCompleted && !enrollmentDoc.data().completed) {
      await db.collection('enrollments').doc(enrollmentDoc.id).update({ completed: true });

      if (course.certifying) {
        try {
          await issueAutoCertificate({
            clientUid,
            clientEmail: req.user.email,
            courseId: id,
            courseTitle: course.title,
          });
          certificateIssued = true;
        } catch (certError) {
          console.error('❌ Erreur génération certificat auto:', certError);
        }
      }
    }

    res.json({ success: true, courseCompleted: allCompleted, certificateIssued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
