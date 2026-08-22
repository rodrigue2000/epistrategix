const axios = require('axios');

const FEDAPAY_API_URL = process.env.NODE_ENV === 'production' 
  ? 'https://api.fedapay.com' 
  : 'https://sandbox-api.fedapay.com';

const fedapay = axios.create({
  baseURL: FEDAPAY_API_URL,
  headers: {
    'Authorization': `Bearer ${process.env.FEDAPAY_PRIVATE_KEY}`,
    'Content-Type': 'application/json',
  },
});

module.exports = fedapay;