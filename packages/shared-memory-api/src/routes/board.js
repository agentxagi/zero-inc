const express = require('express');
const path = require('path');

const router = express.Router();

router.get('/memory', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'memory.html'));
});

module.exports = router;
