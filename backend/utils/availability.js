 const { db } = require('../config/firebase');

// ============================================================
// 1. VÉRIFIER LA DISPONIBILITÉ D'UN CRÉNEAU
// ============================================================
const checkAvailability = async (date, time, serviceId) => {
  // 1.1 Vérifier les réservations existantes
  const reservationsSnap = await db.collection('reservations')
    .where('date', '==', date)
    .where('serviceId', '==', serviceId)
    .where('status', 'in', ['pending', 'paid', 'confirmed'])
    .get();

  const occupiedTimes = [];
  reservationsSnap.forEach(doc => {
    occupiedTimes.push(doc.data().time);
  });

  // Si l'heure est déjà réservée, retourner false
  if (occupiedTimes.includes(time)) {
    return false;
  }

  // 1.2 🆕 Vérifier les blocages (plages horaires)
  const blocksSnap = await db.collection('blocks')
    .where('date', '==', date)
    .get();

  // Vérifier si l'heure demandée tombe dans une plage bloquée
  for (const doc of blocksSnap.docs) {
    const block = doc.data();
    const blockStart = block.startTime;
    const blockEnd = block.endTime;
    
    // Si le bloc n'a pas de startTime/endTime (ancien format), ignorer
    if (!blockStart || !blockEnd) continue;
    
    // Vérifier si l'heure demandée est dans la plage [startTime, endTime[
    if (time >= blockStart && time < blockEnd) {
      return false; // Créneau bloqué
    }
  }

  return true; // Créneau disponible
};

// ============================================================
// 2. RÉCUPÉRER TOUS LES CRÉNEAUX DISPONIBLES POUR UN SERVICE
// ============================================================
const getAvailableSlots = async (date, serviceId) => {
  // 2.1 Récupérer le service
  const serviceDoc = await db.collection('services').doc(serviceId).get();
  if (!serviceDoc.exists) throw new Error('Service introuvable');
  const service = serviceDoc.data();

  // 2.2 Déterminer la durée d'un créneau
  let slotDuration = service.duration || 60;
  
  // 🆕 Si le service est en tarification unitaire, utiliser durationUnit
  if (service.priceType === 'unit' && service.durationUnit) {
    slotDuration = service.durationUnit;
  }

  // 2.3 Générer tous les créneaux possibles (9h → 18h avec pas = slotDuration)
  const startHour = 9;
  const endHour = 18;
  const allSlots = [];
  
  // Utiliser un pas de 15 minutes minimum pour plus de précision
  const step = Math.min(slotDuration, 15);
  
  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += step) {
      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      allSlots.push(time);
    }
  }

  // 2.4 Filtrer les créneaux disponibles
  const availableSlots = [];
  for (const time of allSlots) {
    const free = await checkAvailability(date, time, serviceId);
    if (free) availableSlots.push(time);
  }
  
  return availableSlots;
};

// ============================================================
// 3. 🆕 VÉRIFIER SI UNE DATE EST COMPLÈTEMENT BLOQUÉE
// ============================================================
const isDateFullyBlocked = async (date) => {
  const blocksSnap = await db.collection('blocks')
    .where('date', '==', date)
    .get();
  
  // Vérifier si un bloc couvre toute la journée (09:00 → 18:00)
  for (const doc of blocksSnap.docs) {
    const block = doc.data();
    if (block.startTime <= '09:00' && block.endTime >= '18:00') {
      return true;
    }
  }
  return false;
};

// ============================================================
// 4. 🆕 RÉCUPÉRER LES CRÉNEAUX BLOQUÉS POUR UNE DATE
// ============================================================
const getBlockedSlotsForDate = async (date) => {
  const blocksSnap = await db.collection('blocks')
    .where('date', '==', date)
    .get();
  
  const blockedRanges = [];
  blocksSnap.forEach(doc => {
    const block = doc.data();
    if (block.startTime && block.endTime) {
      blockedRanges.push({
        startTime: block.startTime,
        endTime: block.endTime,
        reason: block.reason || 'Blocage'
      });
    }
  });
  return blockedRanges;
};

// ============================================================
// 5. 🆕 VÉRIFIER SI UNE PLAGE HORAIRE EST DISPONIBLE
// ============================================================
const isTimeRangeAvailable = async (date, startTime, endTime, serviceId) => {
  // Générer tous les créneaux dans la plage [startTime, endTime[
  const slots = [];
  let current = startTime;
  
  while (current < endTime) {
    // Ajouter le créneau actuel
    slots.push(current);
    
    // Incrémenter de 15 minutes
    const [h, m] = current.split(':').map(Number);
    const next = new Date(0, 0, 0, h, m + 15);
    current = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
  }
  
  // Vérifier chaque créneau
  for (const time of slots) {
    const available = await checkAvailability(date, time, serviceId);
    if (!available) return false;
  }
  
  return true;
};

module.exports = { 
  checkAvailability, 
  getAvailableSlots,
  isDateFullyBlocked,
  getBlockedSlotsForDate,
  isTimeRangeAvailable
};