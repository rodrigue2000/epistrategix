 // ===== CONFIGURATION =====
const API_URL = 'https://epistrategix-backend.onrender.com';

// Charger les services
fetch(`${API_URL}/api/services`)
    .then(res => res.json())
    .then(services => {
        const select = document.getElementById('serviceSelect');
        services.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name + (s.priceType === 'fixed' ? ` (${s.price}€)` : ' (prix libre)');
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
    document.getElementById('amountToPay').textContent = amount;

    document.getElementById('payButton').onclick = function() {
        initiatePayment(reservationId, amount, clientName, service.name);
    };
});

async function initiatePayment(reservationId, amount, customerName, serviceName) {
    const response = await fetch(`${API_URL}/api/payments/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            reservationId,
            amount,
            customerName,
            customerEmail: 'client@exemple.com',
            serviceName
        })
    });
    const data = await response.json();
    if (data.url) {
        window.location.href = data.url;
    } else {
        alert('Erreur lors de l\'initiation du paiement');
    }
}