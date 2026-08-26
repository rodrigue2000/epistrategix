 // ================================================================
// CONFIGURATION
// ================================================================
const API_URL = 'https://epistrategix-backend.onrender.com';

// ================================================================
// FEDAPAY CONFIGURATION
// ================================================================
const FEDAPAY_PUBLIC_KEY = 'pk_live_5eX9S0e_AnsbuJ0bX7dGo0is';

// ================================================================
// VARIABLES GLOBALES
// ================================================================
let selectedService = null;
let durationUnits = 1;

// ================================================================
// CHARGER LES SERVICES
// ================================================================
fetch(`${API_URL}/api/services`)
    .then(res => res.json())
    .then(services => {
        const select = document.getElementById('serviceSelect');
        services.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            let label = s.name;
            
            if (s.priceType === 'fixed') {
                label += ` (${s.price} FCFA)`;
            } else if (s.priceType === 'free') {
                label += ' (Prix libre)';
            } else if (s.priceType === 'unit') {
                label += ` (${s.unitPrice || 0} FCFA/${s.durationUnit || 60}min)`;
            }
            
            opt.textContent = label;
            select.appendChild(opt);
        });
    });

// ================================================================
// SELECTION DU SERVICE → AFFICHER LES INFOS
// ================================================================
document.getElementById('serviceSelect').addEventListener('change', function() {
    const serviceId = this.value;
    if (!serviceId) return;
    
    fetch(`${API_URL}/api/services/${serviceId}`)
        .then(res => res.json())
        .then(service => {
            selectedService = service;
            updateDurationAndPrice(service);
        })
        .catch(err => console.error('Erreur chargement service:', err));
});

// ================================================================
// METTRE À JOUR LA DURÉE ET LE PRIX
// ================================================================
function updateDurationAndPrice(service) {
    const durationContainer = document.getElementById('durationContainer');
    const durationUnitsInput = document.getElementById('durationUnits');
    const pricePreview = document.getElementById('pricePreview');
    
    if (!service || !durationContainer) return;
    
    if (service.priceType === 'unit') {
        // Tarification à l'unité de temps
        durationContainer.style.display = 'block';
        
        const unitDuration = service.durationUnit || 60;
        const unitPrice = service.unitPrice || 0;
        const minUnits = service.minDuration || 1;
        const maxUnits = service.maxDuration || 10;
        
        // Configurer les limites
        durationUnitsInput.min = minUnits;
        durationUnitsInput.max = maxUnits;
        durationUnitsInput.value = minUnits;
        durationUnitsInput.step = 1;
        
        // Afficher l'unité
        document.getElementById('durationUnitLabel').textContent = 
            `(${unitDuration} min/unité)`;
        document.getElementById('minDurationDisplay').textContent = minUnits;
        document.getElementById('maxDurationDisplay').textContent = maxUnits;
        
        // Calculer le prix initial
        durationUnits = minUnits;
        const totalPrice = unitPrice * durationUnits;
        pricePreview.textContent = `💰 ${totalPrice} FCFA`;
        
        // Mettre à jour le champ caché
        document.getElementById('totalAmount').value = totalPrice;
        
    } else if (service.priceType === 'fixed') {
        // Prix fixe
        durationContainer.style.display = 'none';
        pricePreview.textContent = `💰 ${service.price || 0} FCFA`;
        document.getElementById('totalAmount').value = service.price || 0;
        durationUnits = 1;
        
    } else {
        // Prix libre (gratuit)
        durationContainer.style.display = 'none';
        pricePreview.textContent = `💰 Gratuit`;
        document.getElementById('totalAmount').value = 0;
        durationUnits = 1;
    }
}

// ================================================================
// CHANGEMENT DE LA DURÉE → RECALCULER LE PRIX
// ================================================================
document.getElementById('durationUnits')?.addEventListener('input', function() {
    const units = parseInt(this.value) || 1;
    const pricePreview = document.getElementById('pricePreview');
    const totalAmount = document.getElementById('totalAmount');
    
    if (!selectedService || selectedService.priceType !== 'unit') return;
    
    const unitPrice = selectedService.unitPrice || 0;
    const minUnits = selectedService.minDuration || 1;
    const maxUnits = selectedService.maxDuration || 10;
    
    // Valider les limites
    if (units < minUnits) {
        this.value = minUnits;
        durationUnits = minUnits;
    } else if (units > maxUnits) {
        this.value = maxUnits;
        durationUnits = maxUnits;
    } else {
        durationUnits = units;
    }
    
    const totalPrice = unitPrice * durationUnits;
    pricePreview.textContent = `💰 ${totalPrice} FCFA`;
    totalAmount.value = totalPrice;
});

// ================================================================
// SÉLECTION DE LA DATE → CHARGER LES CRÉNEAUX
// ================================================================
document.getElementById('reservationDate').addEventListener('change', function() {
    const date = this.value;
    const serviceId = document.getElementById('serviceSelect').value;
    if (!date || !serviceId) return;
    
    fetch(`${API_URL}/api/reservations/available?date=${date}&serviceId=${serviceId}`)
        .then(res => res.json())
        .then(slots => {
            const timeSelect = document.getElementById('reservationTime');
            timeSelect.innerHTML = '<option value="">-- Choisir une heure --</option>';
            
            if (slots.length === 0) {
                timeSelect.innerHTML += '<option value="" disabled>Aucun créneau disponible</option>';
                return;
            }
            
            slots.forEach(slot => {
                const opt = document.createElement('option');
                opt.value = slot;
                opt.textContent = slot;
                timeSelect.appendChild(opt);
            });
        })
        .catch(err => console.error('Erreur chargement créneaux:', err));
});

// ================================================================
// SOUMISSION DU FORMULAIRE DE RÉSERVATION
// ================================================================
document.getElementById('reservationForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    const serviceId = document.getElementById('serviceSelect').value;
    const clientName = document.getElementById('clientName').value.trim();
    const clientPhone = document.getElementById('clientPhone').value.trim();
    const date = document.getElementById('reservationDate').value;
    const time = document.getElementById('reservationTime').value;
    const durationUnits = parseInt(document.getElementById('durationUnits')?.value) || 1;
    const totalAmount = parseFloat(document.getElementById('totalAmount')?.value) || 0;

    // Validation
    if (!serviceId) {
        alert('Veuillez sélectionner un service');
        return;
    }
    if (!clientName || !clientPhone || !date || !time) {
        alert('Veuillez remplir tous les champs obligatoires');
        return;
    }

    // Vérifier que le service est chargé
    if (!selectedService || selectedService.id !== serviceId) {
        try {
            const res = await fetch(`${API_URL}/api/services/${serviceId}`);
            selectedService = await res.json();
        } catch (err) {
            alert('Erreur de chargement du service. Veuillez réessayer.');
            return;
        }
    }

    // Construire la réservation
    const reservationData = {
        serviceId,
        clientName,
        clientPhone,
        date,
        time,
        durationUnits: durationUnits
    };

    try {
        const response = await fetch(`${API_URL}/api/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reservationData)
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            alert(data.error || 'Erreur lors de la réservation');
            return;
        }

        const reservationId = data.id;
        const amount = data.amount || totalAmount || 0;

        // Afficher la section paiement
        document.getElementById('paymentSection').style.display = 'block';
        document.getElementById('amountToPay').textContent = amount + ' FCFA';
        document.getElementById('reservationId').value = reservationId;

        // Configurer le bouton de paiement
        document.getElementById('payButton').onclick = function() {
            initiatePayment(reservationId, amount, clientName, selectedService.name);
        };

    } catch (error) {
        console.error('❌ Erreur:', error);
        alert('Erreur lors de la réservation: ' + error.message);
    }
});

// ================================================================
// INITIATION DU PAIEMENT AVEC FEDAPAY
// ================================================================
async function initiatePayment(reservationId, amount, customerName, serviceName) {
    // 1. Créer la transaction sur le backend
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

    if (!response.ok) {
        alert('❌ Erreur: ' + (data.error || 'Impossible d\'initier le paiement'));
        return;
    }

    // 2. Ouvrir le widget FedaPay
    try {
        const widget = FedaPay.init({
            public_key: FEDAPAY_PUBLIC_KEY,
            transaction: {
                amount: Math.round(amount), // XOF n'a pas de sous-unité
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