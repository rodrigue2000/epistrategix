 // ===== VERSION MINIMALISTE ET ROBUSTE =====
console.log('🚀 Étape 1 : Démarrage du serveur...');

try {
    const express = require('express');
    const cors = require('cors');
    console.log('✅ Modules chargés avec succès');
    
    const app = express();
    const port = process.env.PORT || 5000;
    
    // Middleware de base
    app.use(cors());
    app.use(express.json());
    
    // Routes de base
    app.get('/', (req, res) => {
        res.send('✅ Serveur EpiStrategix en ligne');
    });
    
    app.get('/health', (req, res) => {
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            env: process.env.NODE_ENV || 'development'
        });
    });
    
    // Démarrer le serveur
    app.listen(port, '0.0.0.0', () => {
        console.log(`✅ Serveur démarré avec succès sur le port ${port}`);
        console.log(`🔗 URL: http://localhost:${port}`);
    });
    
} catch (error) {
    console.error('❌ Erreur fatale :', error.message);
    console.error('Stack :', error.stack);
    process.exit(1);
}