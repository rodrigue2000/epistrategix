 const admin = require('firebase-admin');

// ✅ Vérifier si Firebase est déjà initialisé
let db, auth;

try {
    if (!admin.apps.length) {
        // Firebase n'est pas encore initialisé
        const serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        };

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        console.log('✅ Firebase initialisé depuis config/firebase.js');
    } else {
        console.log('✅ Firebase déjà initialisé, réutilisation');
    }

    db = admin.firestore();
    auth = admin.auth();
} catch (error) {
    console.error('❌ Erreur Firebase config:', error.message);
    // Créer des objets factices pour éviter les crashs
    db = null;
    auth = null;
}

module.exports = { db, auth };