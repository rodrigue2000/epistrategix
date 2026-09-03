// ================================================================
// admin.js - Script partagé pour toutes les pages admin
// ================================================================

const API_URL = 'https://epistrategix-backend.onrender.com';

// ================================================================
// CONFIGURATION FIREBASE
// ================================================================
const firebaseConfig = {
    apiKey: "AIzaSyBOSqW6uNLITd-ojr9GL_pUwILXRQ6Q-d0",
    authDomain: "epistrategix.firebaseapp.com",
    projectId: "epistrategix",
    storageBucket: "epistrategix.firebasestorage.app",
    messagingSenderId: "469383955380",
    appId: "1:469383955380:web:b9166a029f49eb5d8468e1"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
    console.log('✅ Firebase initialisé depuis admin.js');
} else {
    console.log('✅ Firebase déjà initialisé');
}

firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .then(() => console.log('✅ Persistance activée'))
    .catch(err => console.error('❌ Erreur persistance:', err));

// ================================================================
// VARIABLES GLOBALES
// ================================================================
let servicesMap = {};
let currentFilter = 'paid';

// ================================================================
// CHARGER LA MAP DES SERVICES (ID → NOM)
// ================================================================
async function loadServicesMap() {
    try {
        const response = await fetch(`${API_URL}/api/services`);
        if (!response.ok) throw new Error('Erreur chargement services');
        const services = await response.json();
        servicesMap = {};
        services.forEach(s => { servicesMap[s.id] = s.name; });
        console.log(`✅ ${Object.keys(servicesMap).length} services chargés`);
        return servicesMap;
    } catch (error) {
        console.error('❌ Erreur chargement services:', error);
        return {};
    }
}

// ================================================================
// VÉRIFICATION DE L'AUTHENTIFICATION
// ================================================================
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

        await loadServicesMap();

        // ================================================================
        // PAGE DASHBOARD
        // ================================================================
        if (window.location.pathname.includes('dashboard.html')) {
            const kpi = await response.json();

            document.getElementById('kpiServices').textContent = kpi.totalServices || 0;
            document.getElementById('kpiRevenue').textContent = (kpi.totalRevenue || 0) + ' FCFA';
            document.getElementById('kpiTransactions').textContent = kpi.totalTransactions || 0;
            document.getElementById('kpiPending').textContent = kpi.reservations?.pending || 0;

            // ✅ Nouveaux KPI de suivi des tâches
            if (kpi.taskStats) {
                const kpiAccepted = document.getElementById('kpiAccepted');
                const kpiCompleted = document.getElementById('kpiCompleted');
                const kpiCompletionRate = document.getElementById('kpiCompletionRate');
                if (kpiAccepted) kpiAccepted.textContent = kpi.taskStats.accepted || 0;
                if (kpiCompleted) kpiCompleted.textContent = kpi.taskStats.completed || 0;
                if (kpiCompletionRate) kpiCompletionRate.textContent = (kpi.taskStats.completionRate || '0.0') + '%';
            }

            await loadReservations(token, currentFilter);
            setupFilterButtons(token);
            setupWhatsAppModal();
        }

    } catch (error) {
        console.error('❌ Erreur:', error);
        alert('Erreur de chargement des données: ' + error.message);
    }
});

// ================================================================
// CHARGER LES RÉSERVATIONS (avec filtrage)
// ================================================================
async function loadReservations(token, filter = 'paid') {
    try {
        console.log('🔍 Chargement réservations - Filtre:', filter);

        const url = filter === 'all'
            ? `${API_URL}/api/admin/reservations/export?filter=all`
            : `${API_URL}/api/admin/reservations/export`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 401) {
            console.error('❌ Token invalide ou expiré');
            await firebase.auth().signOut();
            window.location.href = 'login.html';
            return;
        }

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erreur chargement réservations');
        }

        const reservations = await response.json();
        console.log(`✅ ${reservations.length} réservations chargées`);

        const tbody = document.querySelector('#reservationsTable tbody');
        if (!tbody) return;

        tbody.innerHTML = '';

        if (reservations.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:#4d6f94; padding:2rem;">
                Aucune réservation ${filter === 'paid' ? 'à traiter' : ''} trouvée.
            </td></tr>`;
            return;
        }

        reservations.forEach(r => {
            const tr = document.createElement('tr');
            const serviceName = servicesMap[r.serviceId] || r.serviceId || 'Service inconnu';

            const statusColors = {
                pending: { bg: '#fff3cd', color: '#856404', label: 'En attente' },
                paid: { bg: '#d4edda', color: '#155724', label: 'Payée - à traiter' },
                confirmed: { bg: '#cce5ff', color: '#004085', label: 'Acceptée' },
                cancelled: { bg: '#f8d7da', color: '#721c24', label: 'Refusée' },
                completed: { bg: '#e2e3e5', color: '#383d41', label: 'Traitée' }
            };
            const statusInfo = statusColors[r.status] || statusColors.pending;

            const durationDisplay = r.durationMinutes ? `${r.durationMinutes} min` : '-';
            const amountDisplay = r.amount ? `${r.amount} FCFA` : '-';

            tr.innerHTML = `
                <td>${r.clientName || 'N/A'}</td>
                <td>${r.clientPhone || 'N/A'}</td>
                <td><strong>${serviceName}</strong></td>
                <td>${r.date || 'N/A'}</td>
                <td>${r.time || 'N/A'}</td>
                <td>${durationDisplay}</td>
                <td>${amountDisplay}</td>
                <td>
                    <span style="padding:0.2rem 0.8rem; border-radius:40px; font-size:0.75rem; font-weight:600; background:${statusInfo.bg}; color:${statusInfo.color};">
                        ${statusInfo.label}
                    </span>
                </td>
                <td>
                    ${r.status === 'pending' || r.status === 'paid' ? `
                        <button onclick="handleReservationAction('${r.id}', 'confirmed')" class="btn btn-success btn-sm" style="margin-right:4px;">
                            <i class="fas fa-check"></i> Accepter
                        </button>
                        <button onclick="handleReservationAction('${r.id}', 'cancelled')" class="btn btn-danger btn-sm">
                            <i class="fas fa-times"></i> Refuser
                        </button>
                    ` : `
                        <span style="font-size:0.7rem; color:#4d6f94;">
                            ${r.status === 'confirmed' ? '✅ Acceptée — à traiter au calendrier' : r.status === 'completed' ? '☑️ Traitée' : '❌ Refusée'}
                        </span>
                    `}
                </td>
            `;
            tbody.appendChild(tr);
        });

        const filterStatus = document.getElementById('filterStatus');
        if (filterStatus) {
            filterStatus.textContent = `Affichage : ${filter === 'paid' ? 'Payées uniquement (à traiter)' : 'Toutes'}`;
        }

    } catch (error) {
        console.error('❌ Erreur chargement réservations:', error);
        throw error;
    }
}

// ================================================================
// CONFIGURER LES BOUTONS DE FILTRE
// ================================================================
function setupFilterButtons(token) {
    const btnPaid = document.getElementById('filterPaid');
    const btnAll = document.getElementById('filterAll');

    if (btnPaid) {
        btnPaid.addEventListener('click', () => {
            currentFilter = 'paid';
            loadReservations(token, 'paid');
            btnPaid.className = 'btn btn-sm btn-primary';
            btnPaid.style.background = '#1f9a6e';
            btnAll.className = 'btn btn-sm btn-outline';
        });
    }

    if (btnAll) {
        btnAll.addEventListener('click', () => {
            currentFilter = 'all';
            loadReservations(token, 'all');
            btnAll.className = 'btn btn-sm btn-primary';
            btnAll.style.background = '#1e5fb0';
            btnPaid.className = 'btn btn-sm btn-outline';
            btnPaid.style.background = '';
        });
    }
}

// ================================================================
// GÉRER UNE ACTION SUR UNE RÉSERVATION (accepter / refuser)
// ================================================================
window.handleReservationAction = async function(id, status) {
    const user = firebase.auth().currentUser;
    if (!user) return;

    const actionText = status === 'confirmed' ? 'accepter' : 'refuser';
    if (!confirm(`Voulez-vous ${actionText} cette réservation ?`)) return;

    try {
        const token = await user.getIdToken();

        const response = await fetch(`${API_URL}/api/admin/reservations/${id}/status`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ status })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erreur lors de la mise à jour');
        }

        const data = await response.json();
        console.log('✅ Statut mis à jour:', data);

        await openWhatsAppModal(id, status, token);
        await loadReservations(token, currentFilter);
        alert(`✅ Réservation ${status === 'confirmed' ? 'acceptée' : 'refusée'} avec succès !`);

    } catch (error) {
        console.error('❌ Erreur:', error);
        alert('❌ Erreur: ' + error.message);
    }
};

// ================================================================
// OUVRIR LA MODALE WHATSAPP
// ================================================================
async function openWhatsAppModal(reservationId, status, token) {
    try {
        const response = await fetch(`${API_URL}/api/admin/whatsapp-link/${reservationId}/${status}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            console.warn('Erreur génération lien WhatsApp:', data.error);
            return;
        }

        const modal = document.getElementById('whatsappModal');
        const phoneEl = document.getElementById('whatsappPhone');
        const messageEl = document.getElementById('whatsappMessage');
        const linkEl = document.getElementById('whatsappLink');

        if (modal && phoneEl && messageEl && linkEl) {
            phoneEl.textContent = data.phone || 'Numéro non disponible';
            messageEl.textContent = data.message || '';
            linkEl.href = data.whatsappLink || '#';
            modal.style.display = 'flex';
        }
    } catch (error) {
        console.error('Erreur WhatsApp:', error);
    }
}

// ================================================================
// CONFIGURER LA MODALE WHATSAPP
// ================================================================
function setupWhatsAppModal() {
    const modal = document.getElementById('whatsappModal');
    const closeBtn = document.getElementById('closeWhatsappModal');

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }

    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        });
    }
}

// ================================================================
// DÉCONNEXION
// ================================================================
document.getElementById('logoutBtn')?.addEventListener('click', () => {
    if (confirm('Voulez-vous vous déconnecter ?')) {
        firebase.auth().signOut();
        window.location.href = 'login.html';
    }
});

console.log('✅ admin.js chargé avec succès');
