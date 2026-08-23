 const admin = require('firebase-admin');

let db, auth;
let firebaseReady = false;

// ✅ Fonction async pour l'initialisation
async function initializeFirebase() {
    try {
        if (!admin.apps.length) {
            console.log('📋 Initialisation Firebase avec le JSON complet...');
            
            let serviceAccount = null;
            
            // Utiliser le JSON complet si disponible
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
        
        // Test de connexion (sans await bloquant)
        try {
            await db.collection('_test').doc('ping').set({ 
                timestamp: new Date().toISOString(),
                source: 'render-test'
            });
            console.log('✅ Firestore connecté avec succès');
            firebaseReady = true;
        } catch (testError) {
            console.error('❌ Erreur test Firestore:', testError.message);
            // On ne bloque pas, mais on note que le test a échoué
            firebaseReady = true; // L'initialisation a réussi même si le test échoue
        }

    } catch (error) {
        console.error('❌ Erreur Firebase config:', error.message);
        console.error('📋 Stack:', error.stack);
        db = null;
        auth = null;
        firebaseReady = false;
    }
}

// Exécuter l'initialisation
initializeFirebase().catch(err => {
    console.error('❌ Erreur lors de l\'initialisation Firebase:', err.message);
});

// Exporter les références (elles seront disponibles après initialisation)
module.exports = { 
    get db() { return db; },
    get auth() { return auth; },
    get firebaseReady() { return firebaseReady; }
};