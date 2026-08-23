 const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes de base
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

// Importer la configuration Firebase
const firebaseConfig = require('./config/firebase');

// Route de statut
app.get('/api/status', (req, res) => {
    res.json({
        firebase: firebaseConfig.firebaseReady ? '✅ OK' : '❌ Désactivé',
        timestamp: new Date().toISOString(),
        env: process.env.NODE_ENV || 'development'
    });
});

// Routes API (si Firebase est prêt)
if (firebaseConfig.firebaseReady) {
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
        
        console.log('✅ Routes API chargées');
    } catch (err) {
        console.error('❌ Erreur chargement routes:', err.message);
    }
} else {
    console.warn('⚠️ Firebase non disponible - routes API désactivées');
    app.get('/api/*', (req, res) => {
        res.status(503).json({
            error: 'Service non disponible',
            hint: 'Vérifiez les logs pour l\'erreur Firebase'
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
    console.log(`📊 Firebase: ${firebaseConfig.firebaseReady ? '✅ OK' : '❌ DÉSACTIVÉ'}`);
});