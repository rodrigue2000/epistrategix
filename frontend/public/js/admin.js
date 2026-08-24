 // ===== CONFIGURATION =====
const API_URL = 'https://epistrategix-backend.onrender.com';

// Configuration Firebase
const firebaseConfig = {
    apiKey: "AIzaSyBOSqW6uNLITd-ojr9GL_pUwILXRQ6Q-d0",
    authDomain: "epistrategix.firebaseapp.com",
    projectId: "epistrategix",
    storageBucket: "epistrategix.firebasestorage.app",
    messagingSenderId: "469383955380",
    appId: "1:469383955380:web:b9166a029f49eb5d8468e1"
};

firebase.initializeApp(firebaseConfig);
firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);

// ===== VÉRIFICATION DE L'AUTHENTIFICATION =====
firebase.auth().onAuthStateChanged(async user => {
    console.log('🔍 Auth state changed:', user ? 'Connecté' : 'Déconnecté');
    
    if (!user) {
        console.log('🔴 Non authentifié, redirection vers login.html');
        window.location.href = 'login.html';
        return;
    }

    try {
        console.log('🟢 Utilisateur connecté:', user.email);
        const token = await user.getIdToken();
        console.log('✅ Token obtenu');
        
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
        
        console.log('✅ Admin vérifié, chargement des données...');
        
        // ===== CHARGEMENT DES KPI =====
        const kpi = await response.json();
        
        // Mettre à jour les éléments du dashboard
        const kpiServices = document.getElementById('kpiServices');
        const kpiRevenue = document.getElementById('kpiRevenue');
        const kpiTransactions = document.getElementById('kpiTransactions');
        const kpiPending = document.getElementById('kpiPending');
        
        if (kpiServices) kpiServices.textContent = kpi.totalServices || 0;
        if (kpiRevenue) kpiRevenue.textContent = (kpi.totalRevenue || 0) + ' FCFA';
        if (kpiTransactions) kpiTransactions.textContent = kpi.totalTransactions || 0;
        if (kpiPending) kpiPending.textContent = kpi.reservations?.pending || 0;

        // ===== CHARGEMENT DES RÉSERVATIONS =====
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
        
        console.log('✅ Données chargées avec succès');
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