 // ===== VERSION COMPLÈTE AVEC TOUTES LES ROUTES =====
console.log('🚀 Démarrage du serveur complet...');

const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes de base
app.get('/', (req, res) => {
    res.send('✅ EpiStrategix API - complète');
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        env: process.env.NODE_ENV || 'development'
    });
});

// === INITIALISATION FIREBASE ===
let firebaseReady = false;
try {
    const admin = require('firebase-admin');
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

    if (privateKey && projectId && clientEmail) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: projectId,
                privateKey: privateKey.replace(/\\n/g, '\n'),
                clientEmail: clientEmail,
            })
        });
        firebaseReady = true;
        console.log('✅ Firebase initialisé avec succès');
    } else {
        console.warn('⚠️ Variables Firebase manquantes');
    }
} catch (err) {
    console.error('❌ Erreur Firebase:', err.message);
}

// === ROUTES API (si Firebase est prêt) ===
if (firebaseReady) {
    try {
        const servicesRoutes = require('./routes/services');
        const reservationsRoutes = require('./routes/reservations');
        const paymentsRoutes = require('./routes/payments');
        const contentsRoutes = require('./routes/contents');
        const adminRoutes = require('./routes/admin');
        const webhookRoutes = require('./webhooks/fedapay');

        app.use('/api/services', servicesRoutes);
        app.use('/api/reservations', reservationsRoutes);
        app.use('/api/payments', paymentsRoutes);
        app.use('/api/contents', contentsRoutes);
        app.use('/api/admin', adminRoutes);
        app.use('/webhook/fedapay', webhookRoutes);
        
        console.log('✅ Routes API chargées');
    } catch (err) {
        console.error('❌ Erreur chargement routes:', err.message);
    }
} else {
    // Routes temporaires en attendant Firebase
    app.get('/api/*', (req, res) => {
        res.status(503).json({
            error: 'Service non disponible',
            hint: 'Vérifiez les variables Firebase sur Render'
        });
    });
    app.post('/api/*', (req, res) => {
        res.status(503).json({
            error: 'Service non disponible',
            hint: 'Vérifiez les variables Firebase sur Render'
        });
    });
}

// Gestion des erreurs
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

// Démarrage
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Serveur démarré sur le port ${port}`);
    console.log(`📊 Firebase: ${firebaseReady ? '✅ OK' : '❌ DÉSACTIVÉ'}`);
});