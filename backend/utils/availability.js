const { db } = require('../config/firebase');

const checkAvailability = async (date, time, serviceId) => {
  const snapshot = await db.collection('reservations')
    .where('date', '==', date)
    .where('serviceId', '==', serviceId)
    .where('status', 'in', ['pending', 'paid', 'confirmed'])
    .get();

  const occupied = [];
  snapshot.forEach(doc => {
    occupied.push(doc.data().time);
  });

  return !occupied.includes(time);
};

const getAvailableSlots = async (date, serviceId) => {
  const serviceDoc = await db.collection('services').doc(serviceId).get();
  if (!serviceDoc.exists) throw new Error('Service introuvable');
  const service = serviceDoc.data();
  const duration = service.duration || 60;

  const startHour = 9;
  const endHour = 18;
  const slots = [];
  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += duration) {
      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      slots.push(time);
    }
  }

  const available = [];
  for (const time of slots) {
    const free = await checkAvailability(date, time, serviceId);
    if (free) available.push(time);
  }
  return available;
};

module.exports = { checkAvailability, getAvailableSlots };