 // ===== VERSION AVEC GESTION CORRECTE DE FIREBASE =====
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

// === INITIALISATION FIREBASE (UNE SEULE FOIS) ===
let firebaseReady = false;
let firebaseError = null;

try {
    const admin = require('firebase-admin');
    console.log('✅ Module firebase-admin chargé');
    
    // VÉRIFIER SI FIREBASE EST DÉJÀ INITIALISÉ
    if (admin.apps.length === 0) {
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
            console.log('✅ Firebase initialisé avec succès (1ère fois)');
        } else {
            console.warn('⚠️ Variables Firebase manquantes');
            firebaseError = 'Variables manquantes';
        }
    } else {
        // Firebase déjà initialisé (par exemple dans un autre fichier)
        firebaseReady = true;
        console.log('✅ Firebase déjà initialisé, réutilisation');
    }
} catch (err) {
    firebaseError = err.message;
    console.error('❌ Erreur Firebase:', err.message);
}

console.log(`📊 Firebase ready: ${firebaseReady}`);

// === ROUTES API ===
if (firebaseReady) {
    try {
        console.log('📦 Chargement des routes...');
        
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
        
        console.log('✅ Routes API chargées avec succès');
    } catch (err) {
        console.error('❌ Erreur chargement routes:', err.message);
        console.error('Stack:', err.stack);
    }
} else {
    console.warn('⚠️ Firebase non disponible - routes API désactivées');
    app.get('/api/*', (req, res) => {
        res.status(503).json({
            error: 'Service non disponible',
            details: firebaseError || 'Firebase non initialisé',
            hint: 'Vérifiez vos variables Firebase sur Render'
        });
    });
    app.post('/api/*', (req, res) => {
        res.status(503).json({
            error: 'Service non disponible',
            details: firebaseError || 'Firebase non initialisé'
        });
    });
}

// === ROUTE DE STATUT POUR DIAGNOSTIC ===
app.get('/api/status', (req, res) => {
    res.json({
        firebase: firebaseReady ? '✅ OK' : '❌ Désactivé',
        error: firebaseError || null,
        timestamp: new Date().toISOString(),
        env: process.env.NODE_ENV || 'development'
    });
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
    console.error('Stack:', err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

// Démarrage
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Serveur démarré sur le port ${port}`);
    console.log(`📊 Firebase: ${firebaseReady ? '✅ OK' : '❌ DÉSACTIVÉ'}`);
    console.log(`🔗 URL: https://epistrategix-backend.onrender.com`);
});