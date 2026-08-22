 // ===== SERVEUR ULTRA-ROBUSTE POUR RENDER FREE =====
console.log('🚀 Démarrage du serveur...');

const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;

// Middleware de base (ne plante jamais)
app.use(cors());
app.use(express.json());

console.log('✅ Middlewares chargés');

// === ROUTES DE BASE (TOUJOURS DISPONIBLES) ===
app.get('/', (req, res) => {
    res.send('✅ EpiStrategix API - en ligne');
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        firebase: {
            projectId: !!process.env.FIREBASE_PROJECT_ID,
            privateKey: !!process.env.FIREBASE_PRIVATE_KEY,
            clientEmail: !!process.env.FIREBASE_CLIENT_EMAIL
        }
    });
});

console.log('✅ Routes de base configurées');

// === TENTATIVE D'INITIALISATION FIREBASE ===
let firebaseReady = false;
let firebaseError = null;

try {
    console.log('📦 Chargement de firebase-admin...');
    const admin = require('firebase-admin');
    
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    
    console.log(`📋 Project ID: ${projectId ? '✅ présent' : '❌ manquant'}`);
    console.log(`📋 Private Key: ${privateKey ? `✅ présent (${privateKey.length} caractères)` : '❌ manquant'}`);
    console.log(`📋 Client Email: ${clientEmail ? '✅ présent' : '❌ manquant'}`);
    
    if (privateKey && projectId && clientEmail) {
        console.log('🔄 Tentative d\'initialisation Firebase...');
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: projectId,
                privateKey: privateKey.replace(/\\n/g, '\n'),
                clientEmail: clientEmail,
            })
        });
        firebaseReady = true;
        console.log('✅ FIREBASE INITIALISÉ AVEC SUCCÈS !');
    } else {
        console.warn('⚠️ Variables Firebase incomplètes');
        firebaseError = 'Variables manquantes';
    }
} catch (err) {
    firebaseError = err.message;
    console.error('❌ Erreur Firebase:', err.message);
    console.error('Stack:', err.stack);
}

console.log(`📊 Firebase ready: ${firebaseReady}`);

// === ROUTES API CONDITIONNELLES ===
if (firebaseReady) {
    try {
        console.log('📦 Chargement des routes API...');
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
        app.get('/api/*', (req, res) => {
            res.status(500).json({ error: 'Erreur routes: ' + err.message });
        });
    }
} else {
    console.warn('⚠️ Firebase non initialisé - routes API désactivées');
    app.get('/api/*', (req, res) => {
        res.status(503).json({
            error: 'Service non disponible',
            details: firebaseError || 'Firebase non initialisé',
            hint: 'Vérifiez vos variables d\'environnement sur Render'
        });
    });
    app.post('/api/*', (req, res) => {
        res.status(503).json({
            error: 'Service non disponible',
            details: firebaseError || 'Firebase non initialisé'
        });
    });
}

// === DÉMARRAGE DU SERVEUR ===
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ SERVEUR DÉMARRÉ SUR LE PORT ${port}`);
    console.log(`🔗 URL: https://epistrategix-backend.onrender.com`);
    console.log(`📊 Firebase: ${firebaseReady ? '✅ OK' : '❌ DÉSACTIVÉ'}`);
    if (firebaseError) {
        console.log(`⚠️  Erreur: ${firebaseError}`);
    }
    console.log('💡 Health check disponible sur /health');
});

// === GESTION DES ERREURS FATALES (EMPÊCHE LE CRASH) ===
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
    console.error('Stack:', err.stack);
    // Ne pas quitter le processus
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
    // Ne pas quitter le processus
});

console.log('=== FIN DU SCRIPT D\'INITIALISATION ===');