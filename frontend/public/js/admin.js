 // ===== admin.js - Script partagé pour toutes les pages admin =====
const API_URL = 'https://epistrategix-backend.onrender.com';

const firebaseConfig = {
    apiKey: "AIzaSyBOSqW6uNLITd-ojr9GL_pUwILXRQ6Q-d0",
    authDomain: "epistrategix.firebaseapp.com",
    projectId: "epistrategix",
    storageBucket: "epistrategix.firebasestorage.app",
    messagingSenderId: "469383955380",
    appId: "1:469383955380:web:b9166a029f49eb5d8468e1"
};

// ✅ Initialiser UNE SEULE FOIS
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
    console.log('✅ Firebase initialisé depuis admin.js');
} else {
    console.log('✅ Firebase déjà initialisé');
}

// ✅ Persistance de session (reste connecté entre les pages)
firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .then(() => console.log('✅ Persistance activée'))
    .catch(err => console.error('❌ Erreur persistance:', err));

// ===== VÉRIFICATION DE L'AUTHENTIFICATION =====
firebase.auth().onAuthStateChanged(async user => {
    console.log('🔍 Auth state changed:', user ? '✅ Connecté' : '❌ Déconnecté');
    
    if (!user) {
        console.log('🔴 Redirection vers login.html');
        window.location.href = 'login.html';
        return;
    }

    try {
        const token = await user.getIdToken();
        console.log('🟢 Utilisateur connecté:', user.email);
        
        // Vérifier le rôle admin
        const response = await fetch(`${API_URL}/api/admin/kpi`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!response.ok) {
            console.log('⚠️ Accès non autorisé (pas admin)');
            alert('Accès non autorisé. Vous devez être administrateur.');
            firebase.auth().signOut();
            window.location.href = 'login.html';
            return;
        }
        
        console.log('✅ Admin vérifié');
        
        // ===== SI ON EST SUR DASHBOARD.HTML =====
        if (window.location.pathname.includes('dashboard.html')) {
            const kpi = await response.json();
            
            // Mettre à jour les KPI
            document.getElementById('kpiServices').textContent = kpi.totalServices || 0;
            document.getElementById('kpiRevenue').textContent = (kpi.totalRevenue || 0) + ' FCFA';
            document.getElementById('kpiTransactions').textContent = kpi.totalTransactions || 0;
            document.getElementById('kpiPending').textContent = kpi.reservations?.pending || 0;

            // Charger les réservations
            const resResponse = await fetch(`${API_URL}/api/admin/reservations/export`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const reservations = await resResponse.json();
            const tbody = document.querySelector('#reservationsTable tbody');
            if (tbody) {
                tbody.innerHTML = '';
                reservations.forEach(r => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${r.clientName || 'N/A'}</td>
                        <td>${r.clientPhone || 'N/A'}</td>
                        <td>${r.serviceId || 'N/A'}</td>
                        <td>${r.date || 'N/A'}</td>
                        <td>${r.time || 'N/A'}</td>
                        <td>${r.status || 'pending'}</td>
                    `;
                    tbody.appendChild(tr);
                });
            }
            console.log('✅ Dashboard chargé');
        }
    } catch (error) {
        console.error('❌ Erreur:', error);
        alert('Erreur de chargement des données: ' + error.message);
    }
});

// ===== DÉCONNEXION =====
document.getElementById('logoutBtn')?.addEventListener('click', () => {
    firebase.auth().signOut();
    window.location.href = 'login.html';
});