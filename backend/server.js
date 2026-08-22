 // ===== SERVEUR PRINCIPAL =====
console.log('🚀 Démarrage du serveur...');

const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// === ROUTES DE BASE ===
app.get('/', (req, res) => {
    res.send('✅ EpiStrategix API - en ligne');
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        env: process.env.NODE_ENV || 'development'
    });
});

// === IMPORT DES CONFIGURATIONS ===
let firebaseReady = false;
try {
    // Forcer le chargement de firebase.js qui gère l'initialisation
    const { db } = require('./config/firebase');
    if (db) {
        firebaseReady = true;
        console.log('✅ Firebase connecté avec succès');
    }
} catch (err) {
    console.error('❌ Erreur Firebase:', err.message);
}

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
            hint: 'Vérifiez vos variables Firebase sur Render'
        });
    });
    app.post('/api/*', (req, res) => {
        res.status(503).json({
            error: 'Service non disponible',
            hint: 'Vérifiez vos variables Firebase sur Render'
        });
    });
}

// === ROUTE DE STATUT ===
app.get('/api/status', (req, res) => {
    res.json({
        firebase: firebaseReady ? '✅ OK' : '❌ Désactivé',
        timestamp: new Date().toISOString(),
        env: process.env.NODE_ENV || 'development'
    });
});

// === GESTION DES ERREURS ===
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

// === DÉMARRAGE ===
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Serveur démarré sur le port ${port}`);
    console.log(`📊 Firebase: ${firebaseReady ? '✅ OK' : '❌ DÉSACTIVÉ'}`);
    console.log(`🔗 URL: https://epistrategix-backend.onrender.com`);
});