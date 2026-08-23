 // ===== CONFIGURATION =====
const API_URL = 'https://epistrategix-backend.onrender.com';
const FRONTEND_URL = 'https://epistrategix.web.app';

// Configuration Firebase
const firebaseConfig = {
    apiKey: "VOTRE_API_KEY",
    authDomain: "epistrategix.firebaseapp.com",
    projectId: "epistrategix",
    storageBucket: "epistrategix.firebasestorage.app",
    messagingSenderId: "469383955380",
    appId: "1:469383955380:web:b9166a029f49eb5d8468e1"
};

firebase.initializeApp(firebaseConfig);

// Vérifier l'authentification
firebase.auth().onAuthStateChanged(async user => {
    if (!user) {
        window.location.href = '../index.html';
        return;
    }
    
    try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_URL}/api/admin/kpi`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!response.ok) {
            alert('Accès non autorisé');
            firebase.auth().signOut();
            window.location.href = '../index.html';
            return;
        }
        
        const kpi = await response.json();
        document.getElementById('kpiServices').textContent = kpi.totalServices;
        document.getElementById('kpiRevenue').textContent = kpi.totalRevenue + ' FCFA';
        document.getElementById('kpiTransactions').textContent = kpi.totalTransactions;
        document.getElementById('kpiPending').textContent = kpi.reservations.pending;

        // Charger les réservations
        const resResponse = await fetch(`${API_URL}/api/admin/reservations/export`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const reservations = await resResponse.json();
        const tbody = document.querySelector('#reservationsTable tbody');
        tbody.innerHTML = '';
        reservations.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${r.clientName}</td>
                <td>${r.clientPhone}</td>
                <td>${r.serviceId}</td>
                <td>${r.date}</td>
                <td>${r.time}</td>
                <td>${r.status}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (error) {
        console.error('Erreur:', error);
        alert('Erreur de chargement des données');
    }
});

// Déconnexion
document.getElementById('logoutBtn')?.addEventListener('click', () => {
    firebase.auth().signOut();
    window.location.href = '../index.html';
});