 // ===== CONFIGURATION =====
const API_URL = 'https://epistrategix-backend.onrender.com';

// ===== FEDAPAY CONFIGURATION =====
const FEDAPAY_PUBLIC_KEY = 'pk_live_5eX9S0e_AnsbuJ0bX7dGo0is';

// Charger les services
fetch(`${API_URL}/api/services`)
    .then(res => res.json())
    .then(services => {
        const select = document.getElementById('serviceSelect');
        services.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name + (s.priceType === 'fixed' ? ` (${s.price} FCFA)` : ' (prix libre)');
            select.appendChild(opt);
        });
    });

// Sélection de la date -> charger les créneaux
document.getElementById('reservationDate').addEventListener('change', function() {
    const date = this.value;
    const serviceId = document.getElementById('serviceSelect').value;
    if (!date || !serviceId) return;
    fetch(`${API_URL}/api/reservations/available?date=${date}&serviceId=${serviceId}`)
        .then(res => res.json())
        .then(slots => {
            const timeSelect = document.getElementById('reservationTime');
            timeSelect.innerHTML = '<option value="">-- Choisir une heure --</option>';
            slots.forEach(slot => {
                const opt = document.createElement('option');
                opt.value = slot;
                opt.textContent = slot;
                timeSelect.appendChild(opt);
            });
        });
});

// Soumission du formulaire
document.getElementById('reservationForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const serviceId = document.getElementById('serviceSelect').value;
    const clientName = document.getElementById('clientName').value;
    const clientPhone = document.getElementById('clientPhone').value;
    const date = document.getElementById('reservationDate').value;
    const time = document.getElementById('reservationTime').value;

    if (!serviceId || !clientName || !clientPhone || !date || !time) {
        alert('Veuillez remplir tous les champs');
        return;
    }

    const response = await fetch(`${API_URL}/api/reservations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId, clientName, clientPhone, date, time })
    });
    const data = await response.json();
    if (!response.ok) {
        alert(data.error || 'Erreur lors de la réservation');
        return;
    }

    const reservationId = data.id;
    const service = await fetch(`${API_URL}/api/services`).then(r => r.json()).then(s => s.find(s => s.id === serviceId));
    const amount = service.priceType === 'fixed' ? service.price : 0;

    document.getElementById('paymentSection').style.display = 'block';
    document.getElementById('amountToPay').textContent = amount + ' FCFA';

    document.getElementById('payButton').onclick = function() {
        initiatePayment(reservationId, amount, clientName, service.name);
    };
});

// ===== INITIATION DU PAIEMENT AVEC FEDAPAY =====
async function initiatePayment(reservationId, amount, customerName, serviceName) {
    // 1. Créer la transaction sur le backend
    const response = await fetch(`${API_URL}/api/payments/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            reservationId,
            amount,
            customerName,
            customerEmail: 'client@exemple.com', // À remplacer par l'email du client
            serviceName
        })
    });

    const data = await response.json();

    if (!response.ok) {
        alert('❌ Erreur: ' + (data.error || 'Impossible d\'initier le paiement'));
        return;
    }

    // 2. Ouvrir le widget FedaPay avec la clé publique
    try {
        const widget = FedaPay.init({
            public_key: FEDAPAY_PUBLIC_KEY,
            transaction: {
                amount: Math.round(amount), // pas de * 100, le XOF n'a pas de sous-unité
                description: `Paiement pour ${serviceName}`
            },
            customer: {
                email: 'client@exemple.com',
                firstname: customerName.split(' ')[0],
                lastname: customerName.split(' ').slice(1).join(' ') || customerName.split(' ')[0]
            },
            onComplete: function(response) {
                if (response.reason === FedaPay.CHECKOUT_COMPLETED) {
                    console.log('✅ Paiement réussi:', response.transaction);
                    alert('✅ Paiement effectué avec succès ! Vous recevrez un email de confirmation.');
                    window.location.href = '/confirmation.html?status=success';
                } else if (response.reason === FedaPay.DIALOG_DISMISSED) {
                    console.log('👆 Fenêtre de paiement fermée');
                }
            }
        });
        widget.open();
    } catch (error) {
        console.error('❌ Erreur FedaPay:', error);
        alert('❌ Erreur lors de l\'ouverture du paiement: ' + error.message);
    }
}