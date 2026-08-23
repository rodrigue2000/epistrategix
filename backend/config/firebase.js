 const admin = require('firebase-admin');

let db, auth;

try {
    if (!admin.apps.length) {
        console.log('📋 Initialisation Firebase avec le JSON complet...');
        
        let serviceAccount = null;
        
        // ✅ Utiliser le JSON complet si disponible
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                console.log('✅ Service account chargé depuis JSON complet');
            } catch (e) {
                console.error('❌ Erreur parsing JSON:', e.message);
            }
        }
        
        // Fallback : variables individuelles
        if (!serviceAccount) {
            console.log('📋 Utilisation des variables individuelles...');
            let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
            privateKey = privateKey.replace(/\\n/g, '\n').trim();
            
            serviceAccount = {
                projectId: process.env.FIREBASE_PROJECT_ID,
                privateKey: privateKey,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            };
        }
        
        if (!serviceAccount || !serviceAccount.privateKey) {
            throw new Error('Aucune configuration Firebase valide trouvée');
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        
        console.log('✅ Firebase initialisé avec succès');
    } else {
        console.log('✅ Firebase déjà initialisé');
    }

    db = admin.firestore();
    auth = admin.auth();
    
    // Test de connexion
    console.log('📋 Test de connexion Firestore...');
    await db.collection('_test').doc('ping').set({ 
        timestamp: new Date().toISOString(),
        source: 'render-test'
    });
    console.log('✅ Firestore connecté avec succès');

} catch (error) {
    console.error('❌ Erreur Firebase config:', error.message);
    console.error('📋 Stack:', error.stack);
    db = null;
    auth = null;
}

module.exports = { db, auth };