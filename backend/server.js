require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

// Middleware CORS amélioré pour Firebase Hosting
const allowedOrigins = [
    'https://epistrategix.web.app',
    'https://epistrategix.firebaseapp.com',
    'http://localhost:3000',
    'http://localhost:5500'
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
            callback(null, true);
        } else {
            console.log('Origine bloquée:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    optionsSuccessStatus: 200,
    credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
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

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

app.get('/', (req, res) => {
    res.send('EpiStrategix API — en ligne');
});

// Gestion des erreurs
app.use((err, req, res, next) => {
    console.error('Erreur:', err.stack);
    res.status(500).json({ error: 'Erreur interne du serveur' });
});

app.listen(port, () => {
    console.log(`🚀 Serveur démarré sur le port ${port}`);
    console.log(`🌐 URL: http://localhost:${port}`);
});