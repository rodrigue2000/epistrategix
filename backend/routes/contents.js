const express = require('express');
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

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

module.exports = router;